export const ANALYSIS_MODES = Object.freeze(["sol_adaptive", "sol_double"]);
export const ANALYSIS_CONTRACT_VERSION = "analysis-v2-sol-low-conditional-high";

export function normalizeAnalysisMode(value, legacySolAnalysis) {
  if (ANALYSIS_MODES.includes(value)) return value;
  if (legacySolAnalysis === true || legacySolAnalysis === "true") return "sol_double";
  return "sol_adaptive";
}

export function latinScriptSegments(value) {
  return String(value ?? "").match(/\p{Script=Latin}[\p{Script=Latin}\p{N}._'’&+\-]*(?:[ \t]+\p{Script=Latin}[\p{Script=Latin}\p{N}._'’&+\-]*)*/gu) || [];
}

export function isLatinOnlyTextOccurrence(value) {
  const letters = Array.from(String(value ?? "")).filter((character) => /\p{L}/u.test(character));
  return letters.length > 0 && letters.every((character) => /\p{Script=Latin}/u.test(character));
}

export function preservesLatinSegments(source, translated) {
  let offset = 0;
  return latinScriptSegments(source).every((segment) => {
    const position = String(translated ?? "").indexOf(segment, offset);
    if (position < 0) return false;
    offset = position + segment.length;
    return true;
  });
}

const ZONES = new Set(["top-left", "top-center", "top-right", "middle-left", "middle-center", "middle-right", "bottom-left", "bottom-center", "bottom-right"]);
const ROLES = new Set(["speech", "caption", "sign", "sound_effect", "narration", "other"]);
const COLORS = new Set(["none", "red", "blue", "green", "purple", "pink", "yellow", "orange", "multicolor", "white_on_dark", "colored_on_dark", "other"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const isComic = (presetId) => presetId === "comic" || presetId === "manga_jp";

export function inspectAnalysis(result, presetId) {
  const issues = [];
  const add = (reason, index = null, blocking = false) => issues.push({ reason, index, blocking });
  const comic = isComic(presetId);
  const entries = comic ? result?.reading_order : result?.blocks;
  if (!Array.isArray(entries) || !entries.length) add("번역할 텍스트 목록이 비어 있음", null, true);
  const audit = result?.audit;
  if (!audit || typeof audit !== "object") add("페이지 검토 결과가 없음", null, true);
  else {
    if (audit.visible_occurrence_count !== entries?.length) add("보고한 텍스트 수와 목록 길이가 다름", null, true);
    for (const [key, label] of [["coverage_confidence", "텍스트 누락 여부"], ["reading_order_confidence", "읽기 순서"]]) {
      if (audit[key] !== "high") add(`${label}: ${CONFIDENCES.has(audit[key]) ? audit[key] : "신뢰도 없음"}`);
    }
    if (typeof audit.needs_review !== "boolean") add("페이지 검토 여부가 없음", null, true);
    if (audit.needs_review === true || String(audit.review_reason || "").trim()) add(String(audit.review_reason || "페이지에 미해결 의문이 있음"));
  }
  if (Array.isArray(entries)) entries.forEach((item, index) => {
    if (!item || typeof item !== "object") { add("잘못된 번역 항목", index, true); return; }
    if (comic) {
      if (typeof item.source_text !== "string" || !item.source_text.trim()) add("원문이 비어 있음", index, true);
      if (typeof item.translated_text !== "string" || !item.translated_text.trim()) add("번역문이 비어 있음", index, true);
      if (!ZONES.has(item.page_zone) || !ROLES.has(item.container_type) || !COLORS.has(item.text_color_hint)) add("위치·역할·글자색 분류가 올바르지 않음", index, true);
      for (const [key, label] of [["source_confidence", "원문 판독"], ["translation_confidence", "번역"]]) {
        if (item[key] !== "high") add(`${label}: ${CONFIDENCES.has(item[key]) ? item[key] : "신뢰도 없음"}`, index);
      }
      if (typeof item.needs_review !== "boolean") add("항목 검토 여부가 없음", index, true);
      if (item.needs_review === true || String(item.review_reason || "").trim()) add(String(item.review_reason || "해당 항목의 판독·번역이 불확실함"), index);
      if (presetId === "manga_jp" && (!preservesLatinSegments(item.source_text, item.translated_text)
        || (isLatinOnlyTextOccurrence(item.source_text) && item.source_text !== item.translated_text))) add("영문 원문 보존 불일치", index, true);
    } else if (typeof item.text !== "string" || !item.text.trim()) add("번역 블록이 비어 있음", index, true);
  });
  return issues;
}

// Match unchanged occurrences without array-index drift; changed means changed,
// including a single numeral. This metric is not a translation quality score.
export function countChangedOccurrences(primary, final) {
  const key = (item) => JSON.stringify([item.source_text ?? null, item.translated_text ?? item.text ?? null, item.page_zone ?? null, item.container_type ?? null, item.text_color_hint ?? null]);
  const remaining = new Map();
  for (const item of primary) { const k = key(item); remaining.set(k, (remaining.get(k) || 0) + 1); }
  let unchanged = 0;
  for (const item of final) { const k = key(item); if (remaining.get(k) > 0) { unchanged++; remaining.set(k, remaining.get(k) - 1); } }
  return Math.max(primary.length, final.length) - unchanged;
}

export async function runAnalysisPipeline({ mode, presetId, primary, verify, onStage = () => {} }) {
  mode = normalizeAnalysisMode(mode);
  const comic = isComic(presetId);
  const model = "gpt-6.1-sol";
  const effort = mode === "sol_adaptive" ? "low" : "high";
  const label = mode === "sol_adaptive" ? "Sol 낮음" : "Sol 높음";
  onStage(`${label} · 원문 판독·번역 중`, 18);
  const startedAt = Date.now();
  const draft = await primary({ model, effort });
  const primaryDurationMs = Date.now() - startedAt;
  const primaryIssues = inspectAnalysis(draft, presetId);
  const escalated = mode === "sol_adaptive" && primaryIssues.length > 0;
  const useVerification = escalated || (mode === "sol_double" && comic);
  let result = draft;
  let verificationDurationMs = 0;
  if (useVerification) {
    onStage(escalated ? `Sol 높음 · 불확실성 ${primaryIssues.length}건 추가 검증 중` : "Sol 높음 · 전체 페이지 재검증 중", 42);
    const verificationStartedAt = Date.now();
    result = await verify({ model: "gpt-6.1-sol", effort: "high", draft, issues: primaryIssues });
    verificationDurationMs = Date.now() - verificationStartedAt;
  }
  const issues = inspectAnalysis(result, presetId);
  const blocking = issues.filter((issue) => issue.blocking);
  if (blocking.length) {
    const reasons = blocking.map(({ index, reason }) => `${index === null ? "페이지" : `${index + 1}번`}: ${reason}`).join("; ");
    throw new Error(`분석 결과가 불완전하여 이미지 생성을 중단했습니다. ${reasons}`);
  }
  const entries = comic ? result.reading_order : result.blocks;
  const primaryEntries = comic ? draft?.reading_order : draft?.blocks;
  const reviewed = entries.map((item, index) => {
    const reasons = issues.filter((issue) => issue.index === index).map((issue) => issue.reason);
    return { ...item, review_reasons: reasons, review_status: reasons.length ? "needs_review" : useVerification ? "sol_high_verified" : "single_pass_checked",
      review_resolution: reasons.length ? reasons.join("; ") : useVerification ? "Sol 높음 추가 검증 완료" : `${label} 1회 분석 및 코드 검사 완료`,
      ...(comic ? { ocr_confidence: item.source_confidence, preserve_original_latin: presetId === "manga_jp" && isLatinOnlyTextOccurrence(item.source_text) } : {}) };
  });
  const pageReasons = issues.filter((issue) => issue.index === null).map((issue) => issue.reason);
  const analysisPassCount = useVerification ? 2 : 1;
  return {
    ...(comic ? { reading_order: reviewed } : { blocks: reviewed }),
    automation: {
      contract: ANALYSIS_CONTRACT_VERSION, analysisMode: mode, analysisPassCount,
      solPassCount: analysisPassCount,
      primaryModel: model, primaryReasoningEffort: effort,
      verificationModel: useVerification ? "gpt-6.1-sol" : null, verificationReasoningEffort: useVerification ? "high" : null,
      fallbackTriggered: escalated, escalationReasons: escalated ? primaryIssues.map(({ index, reason }) => `${index === null ? "페이지" : `${index + 1}번`}: ${reason}`) : [],
      primaryItemCount: Array.isArray(primaryEntries) ? primaryEntries.length : 0, verifiedItemCount: entries.length,
      correctedItemCount: useVerification ? countChangedOccurrences(Array.isArray(primaryEntries) ? primaryEntries.filter(Boolean) : [], entries) : 0,
      unresolvedItemCount: reviewed.filter((item) => item.review_reasons.length).length,
      pageNeedsReview: issues.length > 0, pageReviewReason: pageReasons.join("; "),
      primaryAudit: draft?.audit || null, verificationAudit: useVerification ? result.audit : null,
      primaryDurationMs, verificationDurationMs,
    },
  };
}
