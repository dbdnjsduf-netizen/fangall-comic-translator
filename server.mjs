import "dotenv/config";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, extname, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

const PORT = Number(process.env.PORT || 3344);
const OAUTH_PORT = Number(process.env.OAUTH_PORT || 10531);
let activeOauthUrl = `http://127.0.0.1:${OAUTH_PORT}`;
const TMP_DIR = join(__dirname, "tmp");
const OUTPUT_DIR = join(__dirname, "output");
const RESTORE_SOURCE_DIR = join(TMP_DIR, "manual-restore-sources");
const BATCH_STATE_DIR = join(TMP_DIR, "batch-state");
const DOWNLOADS_DIR = join(homedir(), "Downloads", "번역 완료");
const PYTHON_CROP_SCRIPT = join(__dirname, "scripts", "crop_padded_image.py");
const PATCH_ATLAS_SCRIPT = join(__dirname, "scripts", "patch_atlas.py");
const PATCH_ATLAS_MODEL = join(__dirname, "models", "comic-text-bubble-detector-int8.onnx");
const PATCH_ATLAS_SIZE = "2048x2048";
const batches = new Map();
const AUTOMATIC_MODEL_PIPELINE = Object.freeze({
  comicPrimaryOcr: Object.freeze({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
  comicVerification: Object.freeze({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
  documentOcr: Object.freeze({ model: "gpt-5.6-terra", reasoningEffort: "medium" }),
  documentException: Object.freeze({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
  imageGeneration: Object.freeze({ model: "gpt-5.6-terra", reasoningEffort: "medium" }),
});
const AUTOMATIC_MODEL_ALLOWLIST = [...new Set(
  Object.values(AUTOMATIC_MODEL_PIPELINE).map((stage) => stage.model),
)];
const OAUTH_MODEL_ALLOWLIST = process.env.OAUTH_MODEL_ALLOWLIST || AUTOMATIC_MODEL_ALLOWLIST.join(",");
const OAUTH_CODEX_VERSION = String(process.env.OAUTH_CODEX_VERSION || "").trim();
const VALID_IMAGE_GENERATION_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const VALID_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const IMAGE_GENERATION_CONCURRENCY = Math.max(
  1,
  Math.min(3, Number(process.env.IMAGE_GENERATION_CONCURRENCY || 2)),
);
const ANALYSIS_CONCURRENCY = Math.max(
  1,
  Math.min(3, Number(process.env.ANALYSIS_CONCURRENCY || 2)),
);
const MODEL_CONCURRENCY_LIMIT = Math.max(
  2,
  Math.min(6, Number(process.env.MODEL_CONCURRENCY_LIMIT || 4)),
);
const configuredModelStageMaxRetries = Number(process.env.MODEL_STAGE_MAX_RETRIES);
const MODEL_STAGE_MAX_RETRIES = Number.isFinite(configuredModelStageMaxRetries)
  ? Math.max(0, Math.min(6, Math.floor(configuredModelStageMaxRetries)))
  : 4;
const configuredModelRetryBaseMs = Number(process.env.MODEL_RETRY_BASE_MS);
const MODEL_RETRY_BASE_MS = Number.isFinite(configuredModelRetryBaseMs)
  ? Math.max(250, Math.round(configuredModelRetryBaseMs))
  : 2000;
let activeModelRequestCount = 0;
const modelRequestWaiters = [];
const IMAGE_GENERATION_QUALITY = VALID_IMAGE_GENERATION_QUALITIES.has(process.env.IMAGE_GENERATION_QUALITY)
  ? process.env.IMAGE_GENERATION_QUALITY
  : "high";
const IMAGE_GENERATION_MODERATION = ["auto", "low"].includes(process.env.IMAGE_GENERATION_MODERATION)
  ? process.env.IMAGE_GENERATION_MODERATION
  : "low";
const OUTPUT_JPEG_OPTIONS = { quality: 100, chromaSubsampling: "4:4:4" };
const IMAGE_GENERATION_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.IMAGE_GENERATION_TIMEOUT_MS || process.env.IMA2_OAUTH_GENERATION_TIMEOUT_MS || 400 * 1000),
);
const IMAGE_RETRY_DELAY_MS = Math.max(0, Number(process.env.IMAGE_RETRY_DELAY_MS || 30000));
const IMAGE_LONG_RETRY_COUNT = Math.max(0, Number(process.env.IMAGE_LONG_RETRY_COUNT || 1));
const GENERATION_ADDITIONAL_REQUEST_MAX_LENGTH = 1000;
const PROTECTION_INPUT_EXPAND_PX = Math.max(0, Number(process.env.PROTECTION_INPUT_EXPAND_PX || 0));
const PROTECTION_INPUT_FEATHER_PX = Math.max(0, Number(process.env.PROTECTION_INPUT_FEATHER_PX || 0));
const PROTECTION_RESTORE_EXTRA_PX = Math.max(0, Number(process.env.PROTECTION_RESTORE_EXTRA_PX || 20));
const PROTECTION_RESTORE_EXPAND_PX = Math.max(
  0,
  Number(process.env.PROTECTION_RESTORE_EXPAND_PX || (PROTECTION_INPUT_EXPAND_PX + PROTECTION_RESTORE_EXTRA_PX)),
);
const PROTECTION_RESTORE_FEATHER_PX = Math.max(0, Number(process.env.PROTECTION_RESTORE_FEATHER_PX || 0));
const PAINTED_INPUT_EDGE_PX = Math.max(1, Math.round(Number(process.env.PAINTED_INPUT_EDGE_PX || 12)));
const PAINTED_SENTINEL_COLOR_A = /^#[0-9a-fA-F]{6}$/.test(process.env.PAINTED_SENTINEL_COLOR_A || "")
  ? process.env.PAINTED_SENTINEL_COLOR_A
  : "#00e5ff";
const PAINTED_SENTINEL_COLOR_B = /^#[0-9a-fA-F]{6}$/.test(process.env.PAINTED_SENTINEL_COLOR_B || "")
  ? process.env.PAINTED_SENTINEL_COLOR_B
  : "#ff00cc";
const PROTECTION_INPUT_REDACTION_COLOR = /^#[0-9a-fA-F]{6}$/.test(process.env.PROTECTION_INPUT_REDACTION_COLOR || "")
  ? process.env.PROTECTION_INPUT_REDACTION_COLOR
  : "#808080";
const PAINTED_SENTINEL_TILE_PX = Math.max(
  8,
  Math.min(64, Math.round(Number(process.env.PAINTED_SENTINEL_TILE_PX || 32))),
);
const PROTECTION_SENTINEL_REPAIR_COLOR_DISTANCE = Math.max(
  1,
  Math.min(255, Math.round(Number(process.env.PROTECTION_SENTINEL_REPAIR_COLOR_DISTANCE || 72))),
);
const PROTECTION_GRAY_REPAIR_COLOR_DISTANCE = Math.max(
  1,
  Math.min(64, Math.round(Number(process.env.PROTECTION_GRAY_REPAIR_COLOR_DISTANCE || 24))),
);
const PROTECTION_GRAY_KEY_COLOR_DISTANCE = Math.max(
  1,
  Math.min(96, Math.round(Number(process.env.PROTECTION_GRAY_KEY_COLOR_DISTANCE || 48))),
);
const PROTECTION_GRAY_KEY_MAX_CHROMA = Math.max(
  0,
  Math.min(64, Math.round(Number(process.env.PROTECTION_GRAY_KEY_MAX_CHROMA || 24))),
);
const PROTECTION_GRAY_KEY_MIN_LUMA = Math.max(
  0,
  Math.min(255, Math.round(Number(process.env.PROTECTION_GRAY_KEY_MIN_LUMA || 40))),
);
const PROTECTION_GRAY_KEY_MAX_LUMA = Math.max(
  PROTECTION_GRAY_KEY_MIN_LUMA,
  Math.min(255, Math.round(Number(process.env.PROTECTION_GRAY_KEY_MAX_LUMA || 210))),
);
const PROTECTION_GRAY_KEY_SPILL_PX = Math.max(
  0,
  Math.min(64, Math.round(Number(process.env.PROTECTION_GRAY_KEY_SPILL_PX || 16))),
);
const PROTECTION_GRAY_KEY_EDGE_RESTORE_PX = Math.max(
  0,
  Math.min(8, Math.round(Number(process.env.PROTECTION_GRAY_KEY_EDGE_RESTORE_PX || 4))),
);
const PROTECTION_SENTINEL_REPAIR_MAX_DISTANCE_PX = Math.max(
  1,
  Math.min(128, Math.round(Number(process.env.PROTECTION_SENTINEL_REPAIR_MAX_DISTANCE_PX || 64))),
);
const PROTECTION_SENTINEL_REPAIR_MIN_SOURCE_DELTA = Math.max(
  0,
  Math.min(255, Math.round(Number(process.env.PROTECTION_SENTINEL_REPAIR_MIN_SOURCE_DELTA || 12))),
);
const PROTECTION_RESTORE_OUTER_TRANSITION_PX = Math.max(
  0,
  Math.min(64, Math.round(Number(process.env.PROTECTION_RESTORE_OUTER_TRANSITION_PX || 0))),
);
const PROTECTION_RESTORE_COLOR_MATCH_PX = Math.max(
  0,
  Math.min(64, Math.round(Number(process.env.PROTECTION_RESTORE_COLOR_MATCH_PX || 0))),
);
const PROTECTION_RESTORE_COLOR_MATCH_BLUR = Math.max(
  0.3,
  Math.min(64, Number(process.env.PROTECTION_RESTORE_COLOR_MATCH_BLUR || 5)),
);
const PROTECTION_RESTORE_COLOR_MATCH_MAX_DELTA = Math.max(
  0,
  Math.min(64, Math.round(Number(process.env.PROTECTION_RESTORE_COLOR_MATCH_MAX_DELTA || 16))),
);
const PROTECTION_SEAM_REPAIR_PX = Math.max(0, Number(process.env.PROTECTION_SEAM_REPAIR_PX || 24));
const PROTECTION_SEAM_FORCE_EXPAND_PX = Math.max(
  0,
  Number(process.env.PROTECTION_SEAM_FORCE_EXPAND_PX || 5),
);
const PROTECTION_SEAM_WHITE_THRESHOLD = Math.max(
  0,
  Math.min(255, Number(process.env.PROTECTION_SEAM_WHITE_THRESHOLD || 230)),
);
const PROTECTION_SEAM_MIN_CONTRAST = Math.max(
  0,
  Math.min(255, Number(process.env.PROTECTION_SEAM_MIN_CONTRAST || 8)),
);
const DEFAULT_OPENAI_OCR_MODEL = AUTOMATIC_MODEL_PIPELINE.comicPrimaryOcr.model;
const DEFAULT_IMAGE_GENERATION_MODEL = AUTOMATIC_MODEL_PIPELINE.imageGeneration.model;
const ALLOWED_OPENAI_OCR_MODELS = new Set(AUTOMATIC_MODEL_ALLOWLIST);
const MODEL_REASONING_EFFORTS = new Map(
  Object.values(AUTOMATIC_MODEL_PIPELINE).map((stage) => [stage.model, stage.reasoningEffort]),
);
const COMIC_LOCALIZATION_GUIDE =
  "Korean comic dialogue localization rules: Treat each balloon as a spoken line in a scene, not as a dictionary entry. " +
  "Before writing Korean, decide the speech act: plea, complaint, sarcasm, threat, joke, panic, interruption, hesitation, or casual reply. " +
  "Then rewrite it as idiomatic Korean that a native speaker would actually say in that moment. " +
  "Do not preserve English word order, punctuation logic, or short phrase structure when Korean needs a different shape. " +
  "For short emotional lines, prioritize tone over literal wording. For example, 'A little help!?' can mean '좀 도와주지 그래?!' or '거기, 좀 도와줄 생각 없어?!' when the speaker is frustrated, not the flat imperative '도와줘!!'. " +
  "'Thank you...?' can be skeptical or confused, so prefer context-aware phrasing like '고맙다고 해야 하나...?' rather than automatic polite thanks. " +
  "Choose Korean sentence endings that match relationship and mood: casual -해/-지, annoyed -거든?/-아니야?, rough -라고, polite -요 only when the scene supports it. " +
  "Avoid bland defaults such as '도와줘', '고마워요', '정말?', and '괜찮아?' when the source punctuation or context implies sarcasm, disbelief, impatience, or banter.";
const COMIC_PROFANITY_AND_INTENSITY_GUIDE =
  "Profanity and rough-dialogue policy for comic localization: Do not sanitize, soften, euphemize, or moralize profanity, vulgarity, insults, sexual expletives, shock, anger, or crude banter when the source line uses it or the handwritten/emotional emphasis clearly implies it. " +
  "Preserve the emotional force in natural Korean, including words such as '씨발', '씨발놈', '개새끼', '좆같다', or other rough slang when that is the closest Korean comic voice. " +
  "For emphasis like 'fucking', 'the hell', 'damn', or a character reacting in disbelief, prefer direct rough Korean such as '씨발', '대체', '뭔', or stronger slang as context requires instead of bland phrases like '그놈의', '젠장', '빌어먹을', or polite paraphrases. " +
  "Example: 'Dude, is that fucking PAPYRUS?' should sound like a startled crude comic line such as '야, 저거 설마 씨발 파피루스야?' rather than the softened '야, 저거 설마 그놈의 파피루스야?'. " +
  "Do not add profanity where the source is neutral, but when the source is already crude or visibly intense, keep that intensity instead of making the Korean polite, tame, or family-friendly.";
const KOREAN_SPEECH_LEVEL_GUIDE =
  "Korean speech-level policy: Before finalizing each line, infer the speaker-listener relationship, age/status gap, intimacy, hostility, urgency, and public/private context from the image and neighboring text. " +
  "Choose the Korean register deliberately: casual 반말, polite 해요체, formal 합쇼체, written 서술체, rough slang, or clipped imperative. " +
  "Do not default to polite Korean just because the source is English. Do not default to casual Korean unless the visual context, relationship, or tone supports it. " +
  "Keep speech level consistent across the same speaker and conversation, but allow deliberate shifts when the scene implies sarcasm, intimidation, pleading, sudden anger, or social distance. " +
  "For commands, requests, and questions, preserve nuance: a desperate request, annoyed demand, respectful request, and sarcastic complaint should use different Korean endings. " +
  "After drafting, silently check whether the ending sounds like a natural Korean line for that speaker in that scene; if the honorific level feels generic or mismatched, rewrite it.";
const COMIC_OCR_ALIGNMENT_GUIDE =
  "One-to-one text alignment contract: First make a silent inventory of every distinct visible source-text occurrence. Return exactly one JSON item for each occurrence and never merge neighboring balloons, captions, signs, labels, or sound effects merely because they form one conversation or share a speaker. Keep connected or overlapping balloons separate unless the source glyphs are visibly one continuous text block inside one container. source_text must be the exact text visible at that occurrence, including meaningful punctuation; do not paraphrase it, translate it, or borrow words from a nearby balloon. page_zone is only a coarse 3-by-3 matching hint for that occurrence, not a glyph-tracing task, deletion boundary, typesetting box, speaker marker, whole panel, or artwork selection. Reading order controls array order and dialogue context only; it never changes which translation belongs to which physical occurrence. Repeated identical strings are separate items with separate ordered entries. Before returning JSON, silently verify that every source occurrence has one source_text and one translated_text and that no translation has been assigned to a neighboring container.";
const COMIC_CRITICAL_SEMANTIC_FIDELITY_GUIDE =
  "CRITICAL SOURCE-TO-TRANSLATION FIDELITY GATE: Before translating, silently re-read every meaning-critical source token directly from the image. Audit all numerals, quantities, counters, dates, ages, prices, measurements, negation or polarity markers, names, and terminology character by character. Preserve their exact meaning in translated_text; fluency, contextual plausibility, and concise fit must never change a count, number, negation, name, or factual relationship. After drafting Korean, silently compare those critical tokens against source_text again. If any critical source glyph remains visually ambiguous, use medium or low source_confidence and needs_review=true instead of guessing or reporting high confidence.";
const JAPANESE_MANGA_FORENSIC_GLYPH_GUIDE =
  "JAPANESE FORENSIC GLYPH CHECK: Give special scrutiny to visually similar kana, kanji, numerals, counter expressions, and any character whose identity changes with a small stroke difference. Determine character identity from the complete visible glyph structure, including stroke count, direction, spacing, and attachment. Count only strokes that visibly belong to the glyph. Never absorb a speech-balloon border, panel line, speed line, underline, adjacent punctuation, ruby text, or artwork into a character. Visual glyph evidence overrides a merely plausible contextual reading, while surrounding syntax may be used only to resolve genuinely compatible visual candidates. Preserve every verified number, quantity, and counter meaning exactly in Korean. Do not normalize, substitute, or infer a more likely character when the visible glyph supports another reading.";
const COMIC_ADVERSARIAL_VERIFICATION_GUIDE =
  "ADVERSARIAL FORENSIC VERIFICATION — HIGHEST PRIORITY: Treat the primary manifest as an untrusted draft that may contain deliberate single-glyph OCR and meaning errors, even when its confidence is high and its wording is plausible. Re-read every source occurrence from the image character by character before consulting or accepting the primary wording. Never approve a primary transcription merely because it produces a natural translation. When visual evidence conflicts with the primary manifest, correct source_text and translated_text. Perform the critical-token audit independently, then perform a final source-to-Korean semantic checksum for every number, count, counter, negation, name, and terminology item. Any unresolved one-stroke distinction must be marked medium or low source_confidence with needs_review=true.";
const JAPANESE_MANGA_LATIN_PRESERVATION_GUIDE =
  "Japanese manga Latin-text lock: Treat every visible Latin-script span (A-Z, a-z, accented Latin letters, and its attached digits/punctuation) as immutable source artwork. Preserve its exact spelling, capitalization, spacing, punctuation, and visible placement. Never translate it into Korean, transliterate it into Hangul, add a Korean gloss, expand an abbreviation, normalize its case, or invent romanization. If an occurrence contains only Latin-script language plus numbers/punctuation, translated_text must be exactly identical to source_text. If Latin and Japanese share one occurrence, copy every Latin span verbatim into translated_text and translate only the Japanese span. Examples: AXETORY -> AXETORY; Axe（斧） -> Axe（도끼）; AxeSSory（装飾品） -> AxeSSory（장식품）. This lock overrides general instructions to translate every visible text.";
const COMIC_RENDER_CONTRACT_VERSION = "coarse-anchor-v8-sol-generalized-forensic-glyph-check-latin-tail-presence-lock";
const COMIC_PAGE_ZONES = Object.freeze([
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
]);

function clampNormalizedCoordinate(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1000, numeric));
}

function normalizedRegionDetails(region) {
  const left = Math.min(999, clampNormalizedCoordinate(region?.x));
  const top = Math.min(999, clampNormalizedCoordinate(region?.y));
  const width = Math.max(1, Math.min(1000 - left, clampNormalizedCoordinate(region?.width, 1)));
  const height = Math.max(1, Math.min(1000 - top, clampNormalizedCoordinate(region?.height, 1)));
  const right = left + width;
  const bottom = top + height;
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const horizontal = centerX < 333 ? "left" : centerX > 667 ? "right" : "center";
  const vertical = centerY < 333 ? "top" : centerY > 667 ? "bottom" : "middle";
  return { left, top, right, bottom, centerX, centerY, pageZone: `${vertical}-${horizontal}` };
}

function pageZoneToApproximateRegion(pageZone) {
  const normalized = COMIC_PAGE_ZONES.includes(pageZone) ? pageZone : "middle-center";
  const [vertical, horizontal] = normalized.split("-");
  const x = horizontal === "left" ? 0 : horizontal === "right" ? 667 : 333;
  const y = vertical === "top" ? 0 : vertical === "bottom" ? 667 : 333;
  return { x, y, width: horizontal === "center" ? 334 : 333, height: vertical === "middle" ? 334 : 333 };
}

function comicItemPageZone(item) {
  return COMIC_PAGE_ZONES.includes(item?.page_zone)
    ? item.page_zone
    : normalizedRegionDetails(item?.region).pageZone;
}

function quotePromptData(value) {
  return JSON.stringify(String(value ?? "").replace(/\s+/g, " ").trim());
}

function latinScriptSegments(value) {
  return String(value ?? "").match(/\p{Script=Latin}[\p{Script=Latin}\p{N}._'’&+\-]*(?:[ \t]+\p{Script=Latin}[\p{Script=Latin}\p{N}._'’&+\-]*)*/gu) || [];
}

function isLatinOnlyTextOccurrence(value) {
  const letters = Array.from(String(value ?? "")).filter((character) => /\p{L}/u.test(character));
  return letters.length > 0 && letters.every((character) => /\p{Script=Latin}/u.test(character));
}

function preservesLatinSegments(sourceText, translatedText) {
  const sourceSegments = latinScriptSegments(sourceText);
  if (!sourceSegments.length) return true;
  const translated = String(translatedText ?? "");
  let searchFrom = 0;
  return sourceSegments.every((segment) => {
    const position = translated.indexOf(segment, searchFrom);
    if (position < 0) return false;
    searchFrom = position + segment.length;
    return true;
  });
}

function buildComicSpatialManifest(translationData, { preserveLatin = false } = {}) {
  const items = Array.isArray(translationData?.reading_order) ? translationData.reading_order : [];
  const manifest = items.flatMap((item, index) => {
    if (preserveLatin && isLatinOnlyTextOccurrence(item?.source_text)) return [];
    const id = `T${String(index + 1).padStart(2, "0")}`;
    const pageZone = comicItemPageZone(item);
    const ink = item?.text_color_hint && item.text_color_hint !== "none"
      ? item.text_color_hint
      : "ordinary black/grayscale";
    return [[
      `<text_item id="${id}" discourse_order="${index + 1}">`,
      `SOURCE_VISIBLE=${quotePromptData(item?.source_text)}`,
      `KOREAN_REPLACEMENT=${quotePromptData(item?.translated_text)}`,
      `ROLE=${item?.container_type || "other"}; ORIGINAL_INK=${ink}`,
      `APPROXIMATE_LOCATION=${pageZone}`,
      `</text_item>`,
    ].join("\n")];
  });
  return manifest.length ? manifest.join("\n\n") : "(none: this page has no replaceable non-Latin text occurrences)";
}

function buildComicProtectedLatinManifest(translationData) {
  const items = Array.isArray(translationData?.reading_order) ? translationData.reading_order : [];
  const protectedItems = items.flatMap((item, index) => {
    const segments = latinScriptSegments(item?.source_text);
    if (!segments.length) return [];
    const id = `T${String(index + 1).padStart(2, "0")}`;
    const mode = isLatinOnlyTextOccurrence(item?.source_text) ? "preserve-entire-occurrence" : "preserve-latin-spans-only";
    return [`<protected_latin item_id="${id}" mode="${mode}" approximate_location="${comicItemPageZone(item)}">${quotePromptData(segments.join(" | "))}</protected_latin>`];
  });
  return protectedItems.length ? protectedItems.join("\n") : "(none detected)";
}

function addComicPlacementMetadata(translationData) {
  const items = Array.isArray(translationData?.reading_order) ? translationData.reading_order : [];
  items.forEach((item, index) => {
    item.page_zone = comicItemPageZone(item);
    item.region = item?.region || pageZoneToApproximateRegion(item.page_zone);
    const box = normalizedRegionDetails(item.region);
    item.item_id = `T${String(index + 1).padStart(2, "0")}`;
    item.placement_anchor = {
      left: Math.round(box.left),
      top: Math.round(box.top),
      right: Math.round(box.right),
      bottom: Math.round(box.bottom),
      center_x: Math.round(box.centerX),
      center_y: Math.round(box.centerY),
      page_zone: box.pageZone,
    };
  });
  return translationData;
}
const DOCUMENT_TONE_GUIDE =
  "Document tone policy: Infer the document genre from the image before translating each block. Use polished written Korean for guidebooks and rulebooks, concise imperative/instructional Korean for procedures, neutral descriptive Korean for labels, and respectful formal Korean only for notices or direct reader-facing guidance that calls for it. " +
  "Do not overuse conversational 존댓말 in rules, headings, item names, card text, UI labels, or captions. Prefer consistent rulebook style such as '-한다', '-할 수 있다', '-하십시오' only when the source is explicitly instructive/formal. " +
  "Keep headings short and noun-like when possible, and keep body text clear, natural, and consistent across the page.";
const DOCUMENT_NAME_TRANSLITERATION_GUIDE =
  "Proper-name policy for document translation: Unless the user dictionary or a clearly established official Korean title says otherwise, transliterate character names, place names, organization names, scenario names, card names, and fictional terms into natural Korean Hangul. " +
  "Do not leave English proper names in Latin letters just because they are capitalized. Keep widely known product or series titles in their common Korean form when obvious. " +
  "If a term is partly descriptive and partly a name, translate the descriptive part and transliterate the name part naturally.";
const CARD_GAME_ICON_GUIDE =
  "Card-game icon preservation policy: Icons are rules components, not text. Treat every cost icon, class icon, trait icon, stat icon, difficulty symbol, token symbol, action arrow, bullet ornament, faction mark, skull/cultist/tablet/elder-sign style mark, and inline pictogram as protected artwork. " +
  "In OCR output, represent inline icons only as [ICON] placeholders. Preserve the relative order and count of icons, but place each [ICON] where Korean grammar naturally requires it instead of copying English word order. " +
  "Use the semantic role of each icon to choose natural Korean grammar, but never render the semantic name as text. For example, if icons mean knowledge, willpower, or combat, think '지식 또는 의지를 전투 대신 사용할 수 있다' to choose the sentence order, then output it as '[ICON] 또는 [ICON]을 [ICON] 대신 사용할 수 있다'. " +
  "When an English rule says something like 'you may use X or Y instead of Z', render it in natural Korean order such as '[ICON] 또는 [ICON]을 [ICON] 대신 사용할 수 있다', not the awkward English-order pattern '또는 [ICON]을 ... [ICON] 대신 ...'. " +
  "Never translate an icon into words such as token, skull, star, card, action, clue, resource, or symbol. Never omit icons, never move all icons to the end of the line, and never replace icons with Korean labels.";
const PROTECTED_REDACTION_GUIDE =
  "Protected/redacted regions are intentionally unavailable image data. Treat every synthetic uniform neutral-gray region as a hard deletion from the model input, not as artwork, a background, an empty canvas, an editable hole, or a visual clue. The exact neutral-gray footprint and boundary are fixed input sentinels: never enlarge, dilate, feather, blur, smooth, round, connect, move, shrink, continue, or spread them into any visible source area, not even by one pixel. Never sample the neutral gray as a fill color or use it to erase, cover, reshape, or replace a speech bubble, caption, text container, source background, or visible source island. Never copy, continue, redraw, recolor, imitate, replace, or render the neutral-gray redaction. Do not infer, guess, reconstruct, describe, classify, or use hidden content underneath or around those protected regions, including actions, relationships, intimacy, nudity, violence, ages, identities, or safety-sensitive scene details. Translate and render only visible unmasked text and context.";
const SOURCE_IMAGE_FIDELITY_LOCK =
  "ABSOLUTE SOURCE-IMAGE FIDELITY LOCK: Treat the provided input image as an immutable pixel, color, and geometry reference, not as a scene to redraw or reinterpret. The output must keep every non-text pixel at the same coordinate and with the same source color as closely as image editing allows. The only editable pixels are the original visible source-language letter strokes and the minimum pixels directly underneath those strokes required to erase them and render Korean lettering. Outside those exact source-text footprints, preserve RGB and alpha values, hue, saturation, brightness, contrast, gamma, gradients, shadows, textures, noise, anti-aliasing, line positions, line thickness, contours, silhouettes, proportions, perspective, panel geometry, object positions, and canvas edges. Never apply global or local recoloring, color grading, relighting, denoising, sharpening, smoothing, cleanup, style transfer, upscaling redraw, geometric warping, resampling, recomposition, or detail regeneration. Never redraw a whole speech bubble, text box, character, object, background region, panel, or page area merely to replace text. A color shift, moved or doubled line, changed line thickness, bent contour, altered face/body/object shape, shifted edge, or changed background outside the original source-letter strokes is a failed edit and must be corrected before returning the image.";
const SOURCE_IMAGE_FIDELITY_FINAL_CHECK =
  "FINAL SOURCE COMPARISON CHECK: Compare the completed image against the provided input at matching coordinates. Except for removal of original source-language glyphs and insertion of Korean glyphs in the same text locations, colors, gradients, linework, contours, geometry, textures, objects, characters, speech bubbles, borders, and backgrounds must remain visually identical. If any non-text color changed or any line/shape shifted, restore it to the source image before returning the result.";
const SPEECH_BUBBLE_TAIL_PRESENCE_LOCK =
  "SPEECH-BUBBLE TAIL PRESENCE LOCK: A speech balloon, thought balloon, caption, or other text container may intentionally have zero tails or pointers, one tail, multiple tails, an open border, or no enclosing border. Zero tails is a complete and valid source state, never a missing feature or defect to repair. Do not infer a speaker, owner, missing connector, or intended attachment from the dialogue, translation, reading order, character positions, faces, gaze, pose, proximity, panel composition, nearby artwork, or scene context. Never invent, add, draw, extend, complete, connect, detach, redirect, move, reshape, thicken, smooth, or erase any tail, pointer, spike, connector, callout line, or bridge between text or a container and a character, object, panel edge, or off-canvas area. Preserve the exact source-pixel presence or absence, count including zero, attachment point, endpoint, direction, length, width, curvature, outline, and separation of every existing tail or pointer. Treat jagged balloon edges, panel lines, motion lines, arrows, connectors, and nearby strokes as protected artwork, never as incomplete tail geometry. If no source tail pixels exist, return no tail pixels.";
const PAINTED_TEXT_EDIT_CONTRACT_VERSION = "painted-text-surgical-v3-tail-presence-lock";
const PROMPT_PRESETS = {
  comic: {
    id: "comic",
    label: "만화 번역",
    generationSize: "2k",
    ocrInstruction: [
      "TASK: Perform full-page comics OCR and Korean localization, then return JSON only.",
      "LAYOUT PASS (silent): Identify panel flow, the page's actual reading direction, every distinct text occurrence, its physical container, likely speaker, emotional tone, and conversation continuity before translating anything.",
      COMIC_OCR_ALIGNMENT_GUIDE,
      "TRANSLATION PASS: Translate every visible source-language text into natural Korean comic dialogue, polished narration/captions, concise signs/UI text, or Korean comic-style sound effects as appropriate. Preserve complete meaning while keeping each line concise enough for its own original container.",
      COMIC_LOCALIZATION_GUIDE,
      COMIC_PROFANITY_AND_INTENSITY_GUIDE,
      KOREAN_SPEECH_LEVEL_GUIDE,
      "PAGE ZONE: Choose only a coarse 3-by-3 page zone for each occurrence. Do not calculate coordinates or trace glyph boundaries. page_zone is a matching hint, never an erasing or typesetting boundary.",
      "CLASSIFICATION: Identify each item as speech, caption, sign, narration, sound_effect, or other. A speech bubble's shape does not make it a sound effect. Only actual expressive effect lettering is sound_effect.",
      "COLOR: text_color_hint describes visible lettering ink only. Use none for black, gray, grayscale, or unclear ink. Never infer the balloon, box, sign, or background color.",
      "FINAL AUDIT (silent): Every visible occurrence appears once; source_text exactly matches the full visible occurrence on the page; translated_text belongs to that same occurrence; no adjacent balloons are merged or swapped; names, terminology, speaker voice, and speech level remain consistent.",
      "Return JSON only.",
    ].join("\n"),
    schemaName: "comic_translation",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reading_order: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              source_text: { type: "string" },
              translated_text: { type: "string" },
              container_type: {
                type: "string",
                enum: ["speech", "caption", "sign", "sound_effect", "narration", "other"]
              },
              text_color_hint: {
                type: "string",
                enum: ["none", "red", "blue", "green", "purple", "pink", "yellow", "orange", "multicolor", "white_on_dark", "colored_on_dark", "other"]
              },
              page_zone: { type: "string", enum: COMIC_PAGE_ZONES }
            },
            required: ["source_text", "translated_text", "container_type", "text_color_hint", "page_zone"]
          }
        }
      },
      required: ["reading_order"]
    },
    renderPrompt(translationData, { preserveLatin = false } = {}) {
      const manifest = buildComicSpatialManifest(translationData, { preserveLatin });
      const protectedLatin = preserveLatin ? buildComicProtectedLatinManifest(translationData) : "";
      const latinLockBlock = preserveLatin
        ? `\n\nIMMUTABLE ORIGINAL LATIN TEXT (not replacement targets):\n${protectedLatin}\nLeave these exact Latin glyph pixels in the source image untouched. A preserve-entire-occurrence item must not be erased, redrawn, duplicated, translated, transliterated, or moved. For a preserve-latin-spans-only item, keep the listed Latin glyphs exactly as they already appear and edit only the non-Latin source glyphs around them. The Latin text repeated inside KOREAN_REPLACEMENT is an alignment reference, not permission to render a second copy.\n`
        : "";
      return (
        `COMIC LETTERING CONTRACT ${COMIC_RENDER_CONTRACT_VERSION}\n` +
        `Replace every listed visible source occurrence exactly once. Match items primarily by SOURCE_VISIBLE and reading order; APPROXIMATE_LOCATION is only a coarse disambiguation hint and is never an edit boundary.\n` +
        `For each text_item, locate SOURCE_VISIBLE in the image, then replace it with KOREAN_REPLACEMENT in the same existing container. IDs, field names, location words, and XML tags are metadata and must never be drawn.\n` +
        `Never move a replacement to a different balloon. Do not erase anything merely because it falls inside an approximate location.\n\n` +
        `ONE-TO-ONE REPLACEMENT CHECKLIST:\n${manifest}${latinLockBlock}\n` +
        `EXECUTION RULES:\n` +
        `1. Edit written glyphs only. Preserve the canvas, margins, panels, characters, objects, colors, lighting, textures, effects, icons, symbols, and all other non-text pixels.\n` +
        `2. Keep every existing bubble, caption box, sign, border, tail, pointer, connector, spike, and container pixel-identical. Never create, remove, merge, split, resize, reshape, move, redirect, repaint, or cover one.\n` +
        `${SPEECH_BUBBLE_TAIL_PRESENCE_LOCK}\n` +
        `3. Treat ROLE as authoritative. speech is ordinary dialogue inside its existing container regardless of bubble shape. Only sound_effect may use decorative effect lettering. Never turn speech into a floating sound effect or backplate.\n` +
        `4. Treat erasing and Korean rendering as one atomic replacement. Never erase a source occurrence unless its complete KOREAN_REPLACEMENT is rendered immediately in that same container. If a match is uncertain, preserve the source text instead of leaving a blank area.\n` +
        `5. Render every KOREAN_REPLACEMENT string completely and exactly once. Do not omit, shorten, paraphrase, combine, duplicate, or transfer text between items. If space is tight, rebalance line breaks and reduce font size inside the same existing container.\n` +
        `6. Match the source lettering's justified style, emphasis, scale, perspective, and ink color while using clean, correctly spelled Hangul. Do not add blanket outlines, shadows, labels, numbers, or metadata that were not source artwork.\n` +
        `7. Final completeness audit: every SOURCE_VISIBLE must still be visible as its Korean replacement; no listed container may be blank, and no neighboring container may receive the wrong line. Then confirm all non-text artwork is unchanged.\n\n` +
        `Input images:\n` +
        `- The uploaded image is the sole source comic page and sole edit target.`
      );
    }
  },
  document: {
    id: "document",
    label: "문서 번역",
    generationSize: "2k",
    ocrInstruction:
      "You are a concise OCR + document translation engine. Read visible source-language text from this document page and output only the Korean text needed for image rendering, in reading order. Do not repeat the original source text. Do not output separate source/translated markup copies. Preserve headings, labels, paragraphs, and line breaks inside each Korean text block when useful. " + DOCUMENT_TONE_GUIDE + " " + DOCUMENT_NAME_TRANSLITERATION_GUIDE + " If a non-linguistic icon, symbol, pictogram, game icon, card icon, skull, star, logo, bullet ornament, or decorative glyph appears inline among words, write [ICON] at that exact inline position inside text. Do not translate icons. Do not output icon names such as skull, star, card, logo, token, or symbol. Return JSON only.",
    schemaName: "document_translation",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        blocks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" }
            },
            required: ["text"]
          }
        }
      },
      required: ["blocks"]
    },
    renderPrompt(translationData) {
      const lines = translationData.blocks.map((item) => {
        const translated = (item.text || item.translated_markup || item.translated_text || "")
          .replace(/\s*\[ICON\]\s*/g, " [keep original icon here] ")
          .replace(/^\s*(?:\d+[\).:]\s*)+/, "")
          .replace(/\s+/g, " ")
          .trim();
        return translated;
      }).join("\n\n");

      return (
        `Generation instructions:\n` +
        `Perform 1:1 document text localization only. Replace pre-existing, clearly legible source-language letter strokes with Korean.\n` +
        `NO OMISSION CONTRACT: Render every Korean text block below exactly once. Do not skip, shorten, summarize, merge, paraphrase, or drop any block.\n` +
        `Render every Korean character in each block. If space is tight, use smaller lettering, tighter line breaks, or more lines inside the original text area; never omit text.\n` +
        `Before finishing, ensure each block has a visible Korean rendering in its corresponding original text location.\n` +
        `The blank lines between Korean text blocks are only separators for this instruction. They are not document text.\n` +
        `Never render instruction separators, artificial numbers, list numbers, bullets, IDs, angle brackets, labels, or metadata into the image.\n` +
        `Do not add any numbering before translated document lines unless that numbering already exists in the source image.\n` +
        `Preserve the original layout, margins, alignment, typography hierarchy, boxes, tables, paper texture, and all non-text artwork.\n` +
        `ICON PRESERVATION: Non-linguistic icons, symbols, pictograms, game icons, card icons, skulls, stars, logos, bullet ornaments, decorative glyphs, and inline symbol marks are protected artwork, not text.\n` +
        `Do not erase, translate, redraw, simplify, replace, move, resize, recolor, label, caption, or duplicate icons or symbols, even when they appear inside the same line as text.\n` +
        `The phrase "keep original icon here" in the list is not renderable text. It means leave the existing original icon graphic completely unchanged at that exact inline position.\n` +
        `Never render the words "icon", "token", "symbol", "skull", "star", "card", or "keep original icon here" in the image unless those exact words already exist as source text.\n` +
        `Only erase actual alphabet/word letter strokes. Preserve inline icons exactly in their original positions and let Korean text flow around the protected icons without covering them.\n` +
        `Do not add, remove, move, resize, or redesign any text containers or document elements.\n` +
        `Keep titles, labels, and body text visually distinct, with crisp Korean readability.\n` +
        `Korean render text blocks in reading order. Blank lines separate blocks and are not renderable text:\n${lines}\n` +
        `Typography requirements: exact Korean spelling, clean Hangul, no garbled characters, no malformed glyphs, no leftover source text.\n\n` +
        `Input images:\n` +
        `- Uploaded image: source document page to edit.`
      );
    }
  },
  cardgame: {
    id: "cardgame",
    label: "카드게임 번역",
    keepOriginalAspectGeneration: true,
    directImageTranslation: true,
    ocrInstruction:
      "Card-game mode bypasses separate OCR/translation preprocessing and lets the image generation model localize directly from the image.",
    schemaName: "cardgame_translation",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        blocks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" }
            },
            required: ["text"]
          }
        }
      },
      required: ["blocks"]
    },
    renderPrompt() {
      return (
        `Generation instructions:\n` +
        `Translate the visible English text on this card-game image directly into natural Korean.\n` +
        `Do not use a separate OCR list. Read the image yourself and replace only the existing English text.\n` +
        `Handle icons with extreme care. Keep every original icon, symbol, pictogram, cost mark, class mark, stat mark, action arrow, bullet ornament, and game symbol exactly as it is.\n` +
        `ABSOLUTE ICON/SYMBOL LOCK: Icons, symbols, pictograms, marks, bullets, arrows, cost icons, stat icons, faction/class icons, and decorative glyphs are not language. Do not translate them, do not interpret them, do not infer their meaning, do not describe them, do not convert them into Korean words, and do not replace them with semantic equivalents. Preserve their original pixels, shape, color, position, size, and orientation exactly.\n` +
        `Do not substitute one icon for another. Do not omit any icon. Do not add new icons. Do not move icons, reorder icons, align them differently, merge them, split them, resize them, recolor them, simplify them, redraw them, label them, caption them, or translate them into words.\n` +
        `Never normalize icons by meaning. A black icon must remain the same black icon, not a colored version. A colored icon must remain the same colored icon, not a black version. Preserve fill color, outline color, shading, silhouette, internal marks, orientation, thickness, size, and tiny decorative differences exactly.\n` +
        `Even if two icons represent the same game concept, they are not interchangeable artwork. Do not replace a monochrome icon with a colored icon, a colored icon with a monochrome icon, an outlined icon with a filled icon, or one variant with another variant.\n` +
        `If an icon appears between words or inside a rule sentence, preserve that exact original icon at that exact original position and translate the surrounding words carefully around it.\n` +
        `Translate only actual words and sentences. Leave every icon and symbol as untouched original artwork.\n` +
        `Make the Korean card text natural and readable, with rulebook-style phrasing and natural Korean word order. Be careful and deliberate rather than aggressive: text localization is the only goal.\n` +
        `Preserve the original card layout, art, borders, text boxes, title bars, spacing, and typography hierarchy.\n` +
        `Preserve the complete original canvas and every outer edge of the card. Do not crop, zoom in, trim, cut off, expand, or reframe the image. All four corners and all border artwork must remain visible in the final image.\n` +
        `Do not add black padding, borders, side bars, margins, new canvas area, artificial numbering, metadata, or explanatory notes.\n` +
        `Use clean Korean lettering with exact Hangul spelling. No broken Hangul, no malformed glyphs, no leftover English text unless it is a proper name that should remain.\n\n` +
        `Input images:\n` +
        `- Uploaded image: source card-game image to edit.`
      );
    }
  }
};

PROMPT_PRESETS.manga_jp = {
  ...PROMPT_PRESETS.comic,
  id: "manga_jp",
  label: "일본만화 번역",
  schemaName: "japanese_manga_translation",
  ocrInstruction: [
    "TASK: Perform full-page Japanese manga OCR and Korean localization, then return JSON only.",
    "LAYOUT PASS (silent): Determine the actual panel flow first. Use Japanese right-to-left panel order when the page follows it, but inspect mixed layouts, inserts, yonkoma, and left-to-right web-comic layouts instead of assuming. Inventory every distinct visible text occurrence and physical container before translating.",
    "JAPANESE READING: Read vertical writing top-to-bottom inside a column and right-column-to-left-column inside the same text block. Do not use vertical column order to merge text from different balloons or containers.",
    COMIC_OCR_ALIGNMENT_GUIDE,
    JAPANESE_MANGA_LATIN_PRESERVATION_GUIDE,
    "TRANSLATION PASS: Produce natural Korean manga dialogue and polished Korean narration/captions. Preserve complete meaning, characterization, joke, emotional beat, speech level, and intensity while removing redundant subjects or source-order padding that Korean does not need. Never omit actual information.",
    "HORIZONTAL KOREAN: Translate ordinary dialogue, thoughts, narration, captions, notes, signs, labels, and background text for horizontal left-to-right Korean typesetting. Do not preserve Japanese vertical word order, column breaks, or one-character stacking in translated_text. Artistic logos and true sound effects are the only orientation exceptions.",
    COMIC_LOCALIZATION_GUIDE,
    COMIC_PROFANITY_AND_INTENSITY_GUIDE,
    KOREAN_SPEECH_LEVEL_GUIDE,
    "PAGE ZONE: Choose only a coarse 3-by-3 page zone for each occurrence. Do not calculate coordinates or trace glyph boundaries. page_zone is a matching hint, never an erasing or typesetting boundary.",
    "CLASSIFICATION: Distinguish speech, caption, sign, narration, sound_effect, and other by function, not by outline shape. Ordinary text inside jagged, rectangular, colored, or partly outlined balloons is still speech unless the glyphs themselves are an effect.",
    "COLOR: text_color_hint describes visible lettering ink only. Use none for black, gray, grayscale, or unclear ink. Never infer the balloon, box, sign, or background color.",
    "FINAL AUDIT (silent): Every visible occurrence appears once; source_text exactly matches the full visible occurrence on the page; translated_text remains paired with that occurrence; every original Latin span is copied exactly and pure-Latin translated_text equals source_text; adjacent or connected balloons are not merged or swapped; names, terminology, speaker voice, and speech level remain consistent.",
    "Return JSON only.",
  ].join("\n"),
  renderPrompt(translationData) {
    return (
      PROMPT_PRESETS.comic.renderPrompt(translationData, { preserveLatin: true }) +
      `\n\nJapanese manga-specific rendering rules:\n` +
      `1. LATIN LOCK HAS HIGHEST PRIORITY. Existing English/Latin text is immutable source artwork. Never translate, Hangul-transliterate, erase, repaint, restyle, move, or duplicate it. Pure-Latin occurrences such as AXETORY remain pixel-unchanged and are intentionally absent from the replacement checklist.\n` +
      `2. For mixed occurrences, preserve the existing Latin glyph pixels and replace only Japanese glyphs. Example: for Axe（斧）, keep the already-drawn Axe untouched and change only 斧 to 도끼; do not redraw Axe and do not add 액스.\n` +
      `3. Ordinary Korean dialogue, thoughts, narration, captions, notes, signs, labels, and background text must be horizontal left-to-right even when SOURCE_VISIBLE was vertical Japanese. Vertical or one-character-per-line Korean is a failed render. Only true sound effects and artistic logos may keep a necessary decorative orientation.\n` +
      `4. Match the original occurrence by SOURCE_VISIBLE, reading order, and the coarse APPROXIMATE_LOCATION hint. That location is not an erasing boundary or final Korean line box. Compose Korean inside the same existing container and never take text from a neighboring item.\n` +
      `5. Preserve an inner safety margin where the container allows it. Balance horizontal line breaks and spacing, then reduce font size as needed. Never clip text, touch borders or tails, add a tail to a tailless container, cover artwork, widen a bubble, or move text to a roomier container.\n` +
      `6. Use professional Korean manga lettering: natural Hangul proportions, clean antialiasing, restrained medium weight for ordinary dialogue, lighter treatment for quiet speech, stronger treatment only for source-supported emphasis, and expressive styling only for sound_effect. Avoid rigid UI/subtitle typography and blanket outlines or backplates.\n` +
      `7. Final audit each replacement independently: Japanese SOURCE_VISIBLE must become its KOREAN_REPLACEMENT in the same container while every protected Latin span stays unchanged. No source occurrence may be erased into a blank container. Recheck adjacent vertical balloons especially carefully for swaps.`
    );
  },
};

app.use(express.json({ limit: "10mb" }));
app.use(express.static(join(__dirname, "public")));
app.use("/output", express.static(OUTPUT_DIR));

let shuttingDown = false;

function spawnOAuthProxy() {
  const oauthCliPath = join(__dirname, "node_modules", "openai-oauth", "dist", "cli.js");
  if (!existsSync(oauthCliPath)) {
    throw new Error(`openai-oauth CLI is missing at ${oauthCliPath}. Run npm install before starting the translator.`);
  }
  const oauthArgs = [
    oauthCliPath,
    "--port",
    String(OAUTH_PORT),
    "--models",
    OAUTH_MODEL_ALLOWLIST,
  ];
  if (OAUTH_CODEX_VERSION) {
    oauthArgs.push("--codex-version", OAUTH_CODEX_VERSION);
  }
  const child = spawn(process.execPath, oauthArgs, {
    cwd: __dirname,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString().trim();
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) activeOauthUrl = match[0];
    if (text) console.log(`[oauth] ${text}`);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    const isIntentionalPatchUpdateNotice =
      text.includes("A newer version of openai-oauth is available")
      || text.includes("npx openai-oauth@latest");
    if (text && !text.includes("npm warn") && !isIntentionalPatchUpdateNotice) {
      console.error(`[oauth] ${text}`);
    }
  });

  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.log(`[oauth] exited with code ${code}, restarting in 5s`);
    setTimeout(() => {
      if (!shuttingDown) oauthChild = spawnOAuthProxy();
    }, 5000);
  });

  return child;
}

let oauthChild = null;

async function ensureDirs() {
  await mkdir(TMP_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(RESTORE_SOURCE_DIR, { recursive: true });
  await mkdir(BATCH_STATE_DIR, { recursive: true });
  await mkdir(DOWNLOADS_DIR, { recursive: true });
}

async function clearDirectory(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const target = join(dirPath, entry.name);
      await rm(target, { recursive: true, force: true });
    }));
    return entries.length;
  } catch {
    return 0;
  }
}

const SINGLE_PAGE_LONG_SIDE = 2048;
const SPREAD_PAGE_LONG_SIDE = 3840;
const IMAGE_GENERATION_MAX_PIXELS = 8294400;
const SPREAD_MIN_ASPECT_RATIO = 1.1;

function isDoublePageSpread(width, height) {
  return width / height >= SPREAD_MIN_ASPECT_RATIO;
}

function normalizeSize(width, height, targetLongSide = SINGLE_PAGE_LONG_SIDE) {
  const longSide = Math.max(width, height);
  const scale = targetLongSide / longSide;
  let targetWidth = Math.round(width * scale);
  let targetHeight = Math.round(height * scale);

  targetWidth = Math.max(16, Math.round(targetWidth / 16) * 16);
  targetHeight = Math.max(16, Math.round(targetHeight / 16) * 16);

  const pixels = targetWidth * targetHeight;
  const maxPixels = IMAGE_GENERATION_MAX_PIXELS;
  if (pixels > maxPixels) {
    const ratio = Math.sqrt(maxPixels / pixels);
    targetWidth = Math.max(16, Math.round((targetWidth * ratio) / 16) * 16);
    targetHeight = Math.max(16, Math.round((targetHeight * ratio) / 16) * 16);
  }

  // 4K spreads may use the model's full pixel budget (3840x2160 fits exactly).
  // Keep the older conservative ceiling for ordinary 2K pages.
  const safeMaxPixels = targetLongSide > SINGLE_PAGE_LONG_SIDE
    ? IMAGE_GENERATION_MAX_PIXELS
    : 7600000;
  if (targetWidth * targetHeight > safeMaxPixels) {
    const ratio = Math.sqrt(safeMaxPixels / (targetWidth * targetHeight));
    targetWidth = Math.max(16, Math.floor((targetWidth * ratio) / 16) * 16);
    targetHeight = Math.max(16, Math.floor((targetHeight * ratio) / 16) * 16);
  }

  return { width: targetWidth, height: targetHeight, size: `${targetWidth}x${targetHeight}` };
}

function normalize2kPresetSize(width, height) {
  const detectedDoublePageSpread = isDoublePageSpread(width, height);
  const use4kSpreadGeneration = detectedDoublePageSpread
    && Math.max(width, height) > SINGLE_PAGE_LONG_SIDE;
  const target = normalizeSize(
    width,
    height,
    use4kSpreadGeneration ? SPREAD_PAGE_LONG_SIDE : SINGLE_PAGE_LONG_SIDE,
  );

  return {
    ...target,
    resolutionTier: use4kSpreadGeneration ? "4k-spread" : "2k",
    doublePageSpread: detectedDoublePageSpread,
    use4kSpreadGeneration,
    originalWidth: width,
    originalHeight: height,
    finalWidth: target.width,
    finalHeight: target.height,
    paddedGeneration: false,
    aspectPaddedGeneration: false,
    cropRect: null,
    sourceContentRect: null,
    forceFinalResize: true,
    finalResizeFit: "fill",
    finalResizeBackground: "#ffffff",
    preserveSourceAspect: false,
  };
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function normalizeNearestAspectSize(width, height) {
  let targetWidth = roundToMultiple(width, 16);
  let targetHeight = roundToMultiple(height, 16);
  const safeMaxPixels = 7600000;

  if (targetWidth * targetHeight > safeMaxPixels) {
    const ratio = Math.sqrt(safeMaxPixels / (targetWidth * targetHeight));
    targetWidth = roundToMultiple(targetWidth * ratio, 16);
    targetHeight = roundToMultiple(targetHeight * ratio, 16);
  }

  return {
    width: targetWidth,
    height: targetHeight,
    size: `${targetWidth}x${targetHeight}`,
    originalWidth: width,
    originalHeight: height,
    finalWidth: width,
    finalHeight: height,
    paddedGeneration: false,
    cropRect: null,
    forceFinalResize: true,
    finalResizeFit: "fill",
    finalResizeBackground: "#ffffff",
  };
}

function normalizeTargetForPreset(width, height, preset) {
  if (preset?.generationSize === "2k") {
    return normalize2kPresetSize(width, height);
  }

  if (preset?.keepOriginalAspectGeneration) {
    return normalizeNearestAspectSize(width, height);
  }

  if (preset?.paddedGeneration) {
    const squareSize = Number(preset.fixedGenerationSize || 1024);
    const scale = Math.min(squareSize / width, squareSize / height);
    const contentWidth = Math.max(1, Math.round(width * scale));
    const contentHeight = Math.max(1, Math.round(height * scale));
    const left = Math.floor((squareSize - contentWidth) / 2);
    const top = Math.floor((squareSize - contentHeight) / 2);

    return {
      width: squareSize,
      height: squareSize,
      size: `${squareSize}x${squareSize}`,
      originalWidth: width,
      originalHeight: height,
      finalWidth: width,
      finalHeight: height,
      scale,
      contentWidth,
      contentHeight,
      paddedGeneration: true,
      paddingColor: "#000000",
      cropRect: {
        left,
        top,
        width: contentWidth,
        height: contentHeight,
      },
    };
  }

  const target = normalizeSize(width, height);
  return {
    ...target,
    finalWidth: target.width,
    finalHeight: target.height,
    paddedGeneration: false,
    cropRect: null,
  };
}

function mapProtectionToGenerationSpace(protection, target) {
  const spec = normalizeProtectionSpec(protection);
  if (target?.preserveSourceAspect && target.sourceContentRect) {
    return {
      invert: spec.invert,
      regions: spec.regions.map((region) => ({
        x: (target.sourceContentRect.left + region.x * target.sourceContentRect.width) / target.width,
        y: (target.sourceContentRect.top + region.y * target.sourceContentRect.height) / target.height,
        width: (region.width * target.sourceContentRect.width) / target.width,
        height: (region.height * target.sourceContentRect.height) / target.height,
      })),
      strokes: spec.strokes.map((stroke) => ({
        radius: (stroke.radius * target.sourceContentRect.width) / target.width,
        points: stroke.points.map((point) => ({
          x: (target.sourceContentRect.left + point.x * target.sourceContentRect.width) / target.width,
          y: (target.sourceContentRect.top + point.y * target.sourceContentRect.height) / target.height,
        })),
      })),
    };
  }

  if (!target?.paddedGeneration || !target.cropRect) return spec;

  return {
    invert: spec.invert,
    regions: spec.regions.map((region) => ({
      x: (target.cropRect.left + region.x * target.cropRect.width) / target.width,
      y: (target.cropRect.top + region.y * target.cropRect.height) / target.height,
      width: (region.width * target.cropRect.width) / target.width,
      height: (region.height * target.cropRect.height) / target.height,
    })),
    strokes: spec.strokes.map((stroke) => ({
      radius: (stroke.radius * target.cropRect.width) / target.width,
      points: stroke.points.map((point) => ({
        x: (target.cropRect.left + point.x * target.cropRect.width) / target.width,
        y: (target.cropRect.top + point.y * target.cropRect.height) / target.height,
      })),
    })),
  };
}

async function prepareSourceForModels(originalBuffer, target) {
  const source = sharp(originalBuffer).flatten({ background: "#ffffff" });
  if (target?.paddedGeneration) {
    return source
      .resize(target.width, target.height, {
        fit: "contain",
        background: target.paddingColor || "#000000",
      })
      .png()
      .toBuffer();
  }

  if (target?.preserveSourceAspect) {
    return source
      .resize(target.width, target.height, {
        fit: "contain",
        background: target.finalResizeBackground || "#ffffff",
      })
      .png()
      .toBuffer();
  }

  return source
    .resize(target.width, target.height, { fit: "fill" })
    .png()
    .toBuffer();
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampExtractRect(rect, imageWidth, imageHeight) {
  const left = clampNumber(Math.floor(Number(rect?.left) || 0), 0, Math.max(0, imageWidth - 1));
  const top = clampNumber(Math.floor(Number(rect?.top) || 0), 0, Math.max(0, imageHeight - 1));
  const maxWidth = Math.max(1, imageWidth - left);
  const maxHeight = Math.max(1, imageHeight - top);
  const width = clampNumber(Math.floor(Number(rect?.width) || maxWidth), 1, maxWidth);
  const height = clampNumber(Math.floor(Number(rect?.height) || maxHeight), 1, maxHeight);

  return { left, top, width, height };
}

function fitCropToAspect(rect, targetWidth, targetHeight, aspectRatio) {
  let left = rect.left;
  let top = rect.top;
  let width = rect.width;
  let height = rect.height;
  const currentAspect = width / height;

  if (currentAspect > aspectRatio) {
    const nextHeight = width / aspectRatio;
    top -= (nextHeight - height) / 2;
    height = nextHeight;
  } else {
    const nextWidth = height * aspectRatio;
    left -= (nextWidth - width) / 2;
    width = nextWidth;
  }

  if (width > targetWidth) {
    width = targetWidth;
    height = width / aspectRatio;
  }
  if (height > targetHeight) {
    height = targetHeight;
    width = height * aspectRatio;
  }

  left = clampNumber(left, 0, targetWidth - width);
  top = clampNumber(top, 0, targetHeight - height);

  return clampExtractRect({
    left: Math.round(left),
    top: Math.round(top),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  }, targetWidth, targetHeight);
}

async function detectPaddedContentCropRect(generatedBuffer, target) {
  if (!target?.cropRect || !target.finalWidth || !target.finalHeight) return target?.cropRect || null;

  const resized = sharp(generatedBuffer)
    .resize(target.width, target.height, { fit: "fill" })
    .removeAlpha()
    .raw();
  const { data, info } = await resized.toBuffer({ resolveWithObject: true });
  const channels = info.channels || 3;
  const blackThreshold = 28;
  const minLineHits = Math.max(3, Math.floor(Math.min(info.width, info.height) * 0.006));
  const columns = new Uint16Array(info.width);
  const rows = new Uint16Array(info.height);

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      if (Math.max(r, g, b) > blackThreshold) {
        columns[x]++;
        rows[y]++;
      }
    }
  }

  let minX = 0;
  let maxX = info.width - 1;
  let minY = 0;
  let maxY = info.height - 1;

  while (minX < info.width && columns[minX] < minLineHits) minX++;
  while (maxX >= 0 && columns[maxX] < minLineHits) maxX--;
  while (minY < info.height && rows[minY] < minLineHits) minY++;
  while (maxY >= 0 && rows[maxY] < minLineHits) maxY--;

  if (minX >= maxX || minY >= maxY) return target.cropRect;

  const paddingMargin = Math.max(12, Math.round(Math.min(target.width, target.height) * 0.03));
  const detected = {
    left: clampNumber(minX - paddingMargin, 0, target.width - 1),
    top: clampNumber(minY - paddingMargin, 0, target.height - 1),
    width: clampNumber(maxX - minX + 1 + paddingMargin * 2, 1, target.width),
    height: clampNumber(maxY - minY + 1 + paddingMargin * 2, 1, target.height),
  };
  detected.width = Math.min(detected.width, target.width - detected.left);
  detected.height = Math.min(detected.height, target.height - detected.top);

  const aspectRatio = target.finalWidth / target.finalHeight;
  const fitted = fitCropToAspect(detected, target.width, target.height, aspectRatio);
  const expected = fitCropToAspect(target.cropRect, target.width, target.height, aspectRatio);
  const detectedArea = fitted.width * fitted.height;
  const expectedArea = expected.width * expected.height;

  if (detectedArea < expectedArea * 0.55 || detectedArea > target.width * target.height * 0.98) {
    return expected;
  }

  return fitted;
}

async function cropPaddedGeneration(generatedBuffer, target, finalTarget) {
  const resizedBuffer = await sharp(generatedBuffer)
    .resize(target.width, target.height, { fit: "fill" })
    .png()
    .toBuffer();
  const resizedMeta = await sharp(resizedBuffer).metadata();
  const resizedWidth = resizedMeta.width || target.width;
  const resizedHeight = resizedMeta.height || target.height;
  const detectedRect = await detectPaddedContentCropRect(resizedBuffer, {
    ...target,
    width: resizedWidth,
    height: resizedHeight,
  });
  const safeRect = clampExtractRect(detectedRect || target.cropRect, resizedWidth, resizedHeight);

  try {
    return await sharp(resizedBuffer)
      .extract(safeRect)
      .resize(finalTarget.width, finalTarget.height, { fit: "fill" })
      .png()
      .toBuffer();
  } catch (error) {
    const fallbackRect = clampExtractRect(target.cropRect, resizedWidth, resizedHeight);
    return sharp(resizedBuffer)
      .extract(fallbackRect)
      .resize(finalTarget.width, finalTarget.height, { fit: "fill" })
      .png()
      .toBuffer();
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

async function cropPaddedGenerationWithPython(generatedBuffer, target) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputPath = join(TMP_DIR, `card-crop-input-${unique}.png`);
  const metadataPath = join(TMP_DIR, `card-crop-metadata-${unique}.json`);
  const outputPath = join(TMP_DIR, `card-crop-output-${unique}.png`);
  const metadata = {
    original_width: target.originalWidth || target.finalWidth || target.width,
    original_height: target.originalHeight || target.finalHeight || target.height,
    pad_x: target.cropRect?.left || 0,
    pad_y: target.cropRect?.top || 0,
    content_width: target.contentWidth || target.cropRect?.width || target.width,
    content_height: target.contentHeight || target.cropRect?.height || target.height,
    padded_size: target.width,
    scale: target.scale || 1,
  };

  await writeFile(inputPath, generatedBuffer);
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  try {
    try {
      await runCommand("python", [PYTHON_CROP_SCRIPT, inputPath, metadataPath, outputPath]);
    } catch (error) {
      await runCommand("py", [PYTHON_CROP_SCRIPT, inputPath, metadataPath, outputPath]);
    }
    return await readFile(outputPath);
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }).catch(() => {}),
      rm(metadataPath, { force: true }).catch(() => {}),
      rm(outputPath, { force: true }).catch(() => {}),
    ]);
  }
}

async function cropAspectPaddedGeneration(generatedBuffer, target) {
  const metadata = await sharp(generatedBuffer).metadata();
  const actualWidth = metadata.width || 0;
  const actualHeight = metadata.height || 0;
  if (!actualWidth || !actualHeight) {
    throw new Error("생성 이미지의 크기를 읽지 못했습니다.");
  }

  const expectedAspect = target.width / target.height;
  const actualAspect = actualWidth / actualHeight;
  const aspectError = Math.abs(actualAspect - expectedAspect) / expectedAspect;
  if (aspectError > 0.001) {
    console.warn(
      `[image-postprocess] model aspect differs; continuing: requested=${target.width}x${target.height} actual=${actualWidth}x${actualHeight} difference=${(aspectError * 100).toFixed(2)}%`,
    );
  }

  if (actualWidth === target.width && actualHeight === target.height) {
    const cropRect = clampExtractRect(target.cropRect, target.width, target.height);
    const cropped = await sharp(generatedBuffer)
      .extract(cropRect)
      .png()
      .toBuffer();
    console.log(
      `[image-postprocess] mode=exact-crop generated=${actualWidth}x${actualHeight} crop=${cropRect.left},${cropRect.top},${cropRect.width}x${cropRect.height} final=${target.finalWidth}x${target.finalHeight}`,
    );
    return cropped;
  }

  const finalWidth = target.finalWidth || target.cropRect?.width || target.width;
  const finalHeight = target.finalHeight || target.cropRect?.height || target.height;
  const uniformScale = Math.max(finalWidth / actualWidth, finalHeight / actualHeight);
  const scaledWidth = actualWidth * uniformScale;
  const scaledHeight = actualHeight * uniformScale;
  const cropX = Math.max(0, (scaledWidth - finalWidth) / 2);
  const cropY = Math.max(0, (scaledHeight - finalHeight) / 2);
  const cropped = await sharp(generatedBuffer)
    .resize(finalWidth, finalHeight, {
      fit: "cover",
      position: "center",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();

  console.log(
    `[image-postprocess] mode=aspect-cover generated=${actualWidth}x${actualHeight} scale=${uniformScale.toFixed(6)} crop=${cropX.toFixed(2)},${cropY.toFixed(2)} final=${finalWidth}x${finalHeight}`,
  );
  return cropped;
}

async function resizeGeneratedToFinalTarget(generatedBuffer, target, finalTarget) {
  if (!target?.forceFinalResize) return generatedBuffer;

  return sharp(generatedBuffer)
    .resize(finalTarget.width, finalTarget.height, {
      fit: target.finalResizeFit || "cover",
      position: "center",
      background: target.finalResizeBackground || "#ffffff",
    })
    .png()
    .toBuffer();
}

function parseProtectionMasks(rawValue, fileCount) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return Array.from({ length: fileCount }, () => ({ regions: [], invert: false }));
  }

  let parsed = null;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return Array.from({ length: fileCount }, () => ({ regions: [], invert: false }));
  }

  const perFile = Array.from({ length: fileCount }, () => ({ regions: [], invert: false }));
  const entries = Array.isArray(parsed) ? parsed : [];

  for (const entry of entries) {
    const fileIndex = Number(entry?.index);
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= fileCount) continue;

    const regions = Array.isArray(entry?.regions) ? entry.regions : [];
    const strokes = Array.isArray(entry?.strokes) ? entry.strokes : [];
    perFile[fileIndex] = {
      invert: entry?.invert === true,
      regions: regions
        .slice(0, 50)
        .map((region) => {
        const x = Number(region?.x);
        const y = Number(region?.y);
        const width = Number(region?.width);
        const height = Number(region?.height);
        if (![x, y, width, height].every(Number.isFinite)) return null;

        const left = Math.max(0, Math.min(1, x));
        const top = Math.max(0, Math.min(1, y));
        const right = Math.max(left, Math.min(1, x + width));
        const bottom = Math.max(top, Math.min(1, y + height));
        if (right - left < 0.002 || bottom - top < 0.002) return null;

        return {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        };
      })
        .filter(Boolean),
      strokes: strokes
        .slice(0, 80)
        .map((stroke) => {
          const radius = Number(stroke?.radius);
          const rawPoints = Array.isArray(stroke?.points) ? stroke.points : [];
          if (!Number.isFinite(radius) || radius <= 0 || !rawPoints.length) return null;
          const points = rawPoints
            .slice(0, 800)
            .map((point) => {
              const x = Number(point?.x);
              const y = Number(point?.y);
              if (![x, y].every(Number.isFinite)) return null;
              return {
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y)),
              };
            })
            .filter(Boolean);
          if (!points.length) return null;
          return {
            radius: Math.max(0.001, Math.min(0.08, radius)),
            points,
          };
        })
        .filter(Boolean),
    };
  }

  return perFile;
}

function escapeSvg(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeProtectionSpec(protection) {
  if (Array.isArray(protection)) {
    return { regions: protection, strokes: [], invert: false };
  }
  return {
    regions: Array.isArray(protection?.regions) ? protection.regions : [],
    strokes: Array.isArray(protection?.strokes) ? protection.strokes : [],
    invert: protection?.invert === true,
  };
}

function hasProtectionShapes(protection) {
  const spec = normalizeProtectionSpec(protection);
  return spec.invert || spec.regions.length > 0 || spec.strokes.length > 0;
}

function protectionRegionToPixels(region, target, expandPx = 0) {
  const x = Math.round(region.x * target.width);
  const y = Math.round(region.y * target.height);
  const width = Math.max(1, Math.round(region.width * target.width));
  const height = Math.max(1, Math.round(region.height * target.height));
  const left = Math.max(0, x - expandPx);
  const top = Math.max(0, y - expandPx);
  const right = Math.min(target.width, x + width + expandPx);
  const bottom = Math.min(target.height, y + height + expandPx);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function editableHoleToPixels(region, target, shrinkPx = 0) {
  const x = Math.round(region.x * target.width);
  const y = Math.round(region.y * target.height);
  const width = Math.max(1, Math.round(region.width * target.width));
  const height = Math.max(1, Math.round(region.height * target.height));
  const left = Math.max(0, x + shrinkPx);
  const top = Math.max(0, y + shrinkPx);
  const right = Math.min(target.width, x + width - shrinkPx);
  const bottom = Math.min(target.height, y + height - shrinkPx);

  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function protectionStrokeToSvg(stroke, target, expandPx = 0, { hole = false, fill = "#000" } = {}) {
  const points = Array.isArray(stroke?.points) ? stroke.points : [];
  if (!points.length) return "";
  const radiusPx = Math.max(1, Math.round(Number(stroke.radius || 0) * target.width) + expandPx);
  const mapped = points
    .map((point) => {
      const x = Math.round(Math.max(0, Math.min(1, Number(point?.x))) * target.width);
      const y = Math.round(Math.max(0, Math.min(1, Number(point?.y))) * target.height);
      if (![x, y].every(Number.isFinite)) return null;
      return { x, y };
    })
    .filter(Boolean);
  if (!mapped.length) return "";

  const paintColor = escapeSvg(fill);
  if (mapped.length === 1) {
    const point = mapped[0];
    return `<circle cx="${point.x}" cy="${point.y}" r="${radiusPx}" fill="${paintColor}"/>`;
  }

  const d = mapped.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
  const strokeColor = hole ? "#000" : paintColor;
  return `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${radiusPx * 2}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function buildProtectionSvg(target, protection, { fill = "#000", transparent = false, expandPx = 0 } = {}) {
  const { regions, strokes, invert } = normalizeProtectionSpec(protection);
  if (invert) {
    const rectHoles = regions
      .map((region) => {
        const box = editableHoleToPixels(region, target, expandPx);
        if (!box) return "";
        const { x, y, width, height } = box;
        return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#000"/>`;
      })
      .join("");
    const strokeHoles = strokes
      .map((stroke) => protectionStrokeToSvg(stroke, target, expandPx, { hole: true, fill: "#000" }))
      .join("");

    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${target.width}" height="${target.height}"><defs><mask id="protection-mask"><rect width="100%" height="100%" fill="#fff"/>${rectHoles}${strokeHoles}</mask></defs><rect width="100%" height="100%" fill="${escapeSvg(fill)}" mask="url(#protection-mask)"/></svg>`,
    );
  }

  const background = transparent ? "" : `<rect width="100%" height="100%" fill="${escapeSvg(fill)}" fill-opacity="0"/>`;
  const rects = regions
    .map((region) => {
      const { x, y, width, height } = protectionRegionToPixels(region, target, expandPx);
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeSvg(fill)}"/>`;
    })
    .join("");
  const strokePaths = strokes
    .map((stroke) => protectionStrokeToSvg(stroke, target, expandPx, { fill }))
    .join("");

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${target.width}" height="${target.height}">${background}${rects}${strokePaths}</svg>`,
  );
}

function buildSentinelPlaceholderSvg(target) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${target.width}" height="${target.height}">`
      + `<rect width="100%" height="100%" fill="${PROTECTION_INPUT_REDACTION_COLOR}"/></svg>`,
  );
}

async function applyProtectionMask(buffer, target, protection) {
  const spec = normalizeProtectionSpec(protection);
  if (!hasProtectionShapes(spec)) return buffer;
  let overlayMaskInput;
  if (PROTECTION_INPUT_FEATHER_PX > 0) {
    const overlayMask = buildProtectionSvg(target, spec, {
      fill: "#fff",
      transparent: true,
      expandPx: PROTECTION_INPUT_EXPAND_PX,
    });
    overlayMaskInput = {
      input: await sharp(overlayMask)
        .blur(PROTECTION_INPUT_FEATHER_PX)
        .png()
        .toBuffer(),
    };
  } else {
    const renderedAlpha = await renderProtectionAlpha(target, spec, PROTECTION_INPUT_EXPAND_PX);
    const binaryMask = protectionBinaryMask(renderedAlpha);
    const hardMask = Buffer.alloc(target.width * target.height * 4);
    for (let pixel = 0; pixel < binaryMask.length; pixel++) {
      const offset = pixel * 4;
      hardMask[offset] = 255;
      hardMask[offset + 1] = 255;
      hardMask[offset + 2] = 255;
      hardMask[offset + 3] = binaryMask[pixel] ? 255 : 0;
    }
    overlayMaskInput = {
      input: hardMask,
      raw: { width: target.width, height: target.height, channels: 4 },
    };
  }
  const overlay = await sharp(buildSentinelPlaceholderSvg(target))
    .composite([{ ...overlayMaskInput, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(buffer)
    .composite([{ input: overlay, blend: "over" }])
    .png()
    .toBuffer();
}

async function buildPaintedEditMaskDataUrl(target, protection) {
  const spec = { ...normalizeProtectionSpec(protection), invert: false };
  if (!hasProtectionShapes(spec)) {
    throw new Error("직접 칠한 텍스트 영역이 없습니다. 텍스트 영역 편집에서 번역할 곳을 먼저 칠해 주세요.");
  }
  const renderedAlpha = await renderProtectionAlpha(target, spec, 0);
  const binaryMask = protectionBinaryMask(renderedAlpha);
  const mask = Buffer.alloc(target.width * target.height * 4);
  for (let pixel = 0; pixel < binaryMask.length; pixel++) {
    const offset = pixel * 4;
    mask[offset] = 255;
    mask[offset + 1] = 255;
    mask[offset + 2] = 255;
    // Image-generation masks edit transparent pixels and preserve opaque pixels.
    mask[offset + 3] = binaryMask[pixel] ? 0 : 255;
  }
  const png = await sharp(mask, {
    raw: { width: target.width, height: target.height, channels: 4 },
  }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function buildPaintedModelInput(sourceBuffer, target, protection) {
  const spec = { ...normalizeProtectionSpec(protection), invert: false };
  if (!hasProtectionShapes(spec)) {
    throw new Error("직접 칠한 텍스트 영역이 없습니다. 텍스트 영역 편집에서 번역할 곳을 먼저 칠해 주세요.");
  }

  const renderedAlpha = await renderProtectionAlpha(target, spec, 0);
  const painted = protectionBinaryMask(renderedAlpha);
  const edgePx = Math.min(PAINTED_INPUT_EDGE_PX, Math.floor(Math.min(target.width, target.height) / 2));
  const revealMask = Buffer.alloc(target.width * target.height * 4, 255);
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      const pixel = y * target.width + x;
      const onOuterEdge = x < edgePx || y < edgePx || x >= target.width - edgePx || y >= target.height - edgePx;
      revealMask[pixel * 4 + 3] = painted[pixel] || onOuterEdge ? 255 : 0;
    }
  }

  const revealMaskPng = await sharp(revealMask, {
    raw: { width: target.width, height: target.height, channels: 4 },
  }).png().toBuffer();
  const visibleSource = await sharp(sourceBuffer)
    .resize(target.width, target.height, { fit: "fill" })
    .ensureAlpha()
    .composite([{ input: revealMaskPng, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(buildSentinelPlaceholderSvg(target))
    .composite([{ input: visibleSource, blend: "over" }])
    .png()
    .toBuffer();
}

async function compositeGeneratedWithSentinelTransparency(
  generatedBuffer,
  sourceBuffer,
  target,
  protection,
  { paintedInputOnly = false } = {},
) {
  const spec = paintedInputOnly
    ? { ...normalizeProtectionSpec(protection), invert: false }
    : normalizeProtectionSpec(protection);
  if (!hasProtectionShapes(spec)) return generatedBuffer;
  const [renderedAlpha, sourceAtTarget, generatedAtTarget] = await Promise.all([
    renderProtectionAlpha(target, spec, paintedInputOnly ? 0 : PROTECTION_INPUT_EXPAND_PX),
    sharp(sourceBuffer)
      .resize(target.width, target.height, { fit: "fill" })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(generatedBuffer)
      .resize(target.width, target.height, { fit: "fill" })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  const shapeMask = protectionBinaryMask(renderedAlpha);
  const sourceChannels = sourceAtTarget.info.channels;
  const generatedChannels = generatedAtTarget.info.channels;
  const sentinelColor = parseHexRgb(PROTECTION_INPUT_REDACTION_COLOR);
  const keyThresholdSquared = PROTECTION_GRAY_KEY_COLOR_DISTANCE ** 2;
  const edgePx = paintedInputOnly
    ? Math.min(PAINTED_INPUT_EDGE_PX, Math.floor(Math.min(target.width, target.height) / 2))
    : 0;
  const pixelCount = shapeMask.length;
  const grayCandidates = new Uint8Array(pixelCount);
  const strictGrayCandidates = new Uint8Array(pixelCount);
  const grayDistances = new Uint16Array(pixelCount);
  const registrationMask = new Uint8Array(pixelCount);
  const grayQueue = new Int32Array(pixelCount);
  let grayQueueLength = 0;
  let keyedPixels = 0;
  let neutralKeyedPixels = 0;
  let registrationRestoredPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const x = pixel % target.width;
    const y = Math.floor(pixel / target.width);
    const registrationOnly = paintedInputOnly
      && !shapeMask[pixel]
      && (x < edgePx || y < edgePx || x >= target.width - edgePx || y >= target.height - edgePx);
    if (registrationOnly) {
      registrationMask[pixel] = 1;
      registrationRestoredPixels++;
      continue;
    }
    const wasGrayInput = paintedInputOnly ? !shapeMask[pixel] : Boolean(shapeMask[pixel]);
    const generatedOffset = pixel * generatedChannels;
    const red = generatedAtTarget.data[generatedOffset];
    const green = generatedAtTarget.data[generatedOffset + 1];
    const blue = generatedAtTarget.data[generatedOffset + 2];
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const luma = (red + green + blue) / 3;
    const neutralMidtone = maxChannel - minChannel <= PROTECTION_GRAY_KEY_MAX_CHROMA
      && luma >= PROTECTION_GRAY_KEY_MIN_LUMA
      && luma <= PROTECTION_GRAY_KEY_MAX_LUMA;
    const nearSentinel = squaredRgbDistance(
      generatedAtTarget.data,
      generatedOffset,
      sentinelColor,
    ) <= keyThresholdSquared;
    const sourceOffset = pixel * sourceChannels;
    const sourceDelta = Math.max(
      Math.abs(red - sourceAtTarget.data[sourceOffset]),
      Math.abs(green - sourceAtTarget.data[sourceOffset + 1]),
      Math.abs(blue - sourceAtTarget.data[sourceOffset + 2]),
    );
    if (!wasGrayInput && sourceDelta < PROTECTION_SENTINEL_REPAIR_MIN_SOURCE_DELTA) continue;
    if (!nearSentinel && !neutralMidtone) continue;
    grayCandidates[pixel] = 1;
    if (wasGrayInput && nearSentinel) strictGrayCandidates[pixel] = 1;
  }

  // Start only from dense sentinel-colored areas. This keeps isolated gray
  // antialiasing inside black/white lettering from becoming a restore seed.
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (!strictGrayCandidates[pixel] || registrationMask[pixel]) continue;
    const x = pixel % target.width;
    const y = Math.floor(pixel / target.width);
    let denseNeighbors = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= target.width || ny < 0 || ny >= target.height) continue;
        if (strictGrayCandidates[ny * target.width + nx]) denseNeighbors++;
      }
    }
    if (denseNeighbors < 13) continue;
    grayDistances[pixel] = 1;
    grayQueue[grayQueueLength++] = pixel;
  }

  for (let head = 0; head < grayQueueLength; head++) {
    const pixel = grayQueue[head];
    const distance = grayDistances[pixel];
    if (distance > PROTECTION_GRAY_KEY_SPILL_PX) continue;
    const x = pixel % target.width;
    const y = Math.floor(pixel / target.width);
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= target.width || ny < 0 || ny >= target.height) continue;
      const next = ny * target.width + nx;
      if (!grayCandidates[next] || grayDistances[next] || registrationMask[next]) continue;
      grayDistances[next] = distance + 1;
      grayQueue[grayQueueLength++] = next;
    }
  }

  const connectedGrayMask = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (!grayDistances[pixel]) continue;
    connectedGrayMask[pixel] = 1;
    const wasGrayInput = paintedInputOnly ? !shapeMask[pixel] : Boolean(shapeMask[pixel]);
    if (wasGrayInput) {
      keyedPixels++;
      if (!strictGrayCandidates[pixel]) neutralKeyedPixels++;
    }
  }
  const expandedGrayMask = dilateBinaryMask(
    connectedGrayMask,
    target.width,
    target.height,
    PROTECTION_GRAY_KEY_EDGE_RESTORE_PX,
  );
  const grayRestoreMask = expandedGrayMask;

  const output = Buffer.from(sourceAtTarget.data);
  let spillRestoredPixels = 0;
  let edgeRestoredPixels = 0;
  let retainedGeneratedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (registrationMask[pixel] || grayRestoreMask[pixel]) {
      const wasGrayInput = paintedInputOnly ? !shapeMask[pixel] : Boolean(shapeMask[pixel]);
      if (grayDistances[pixel] && !wasGrayInput) spillRestoredPixels++;
      if (grayRestoreMask[pixel] && !grayDistances[pixel]) edgeRestoredPixels++;
      continue;
    }
    const generatedOffset = pixel * generatedChannels;
    const outputOffset = pixel * 4;
    output[outputOffset] = generatedAtTarget.data[generatedOffset];
    output[outputOffset + 1] = generatedAtTarget.data[generatedOffset + 1];
    output[outputOffset + 2] = generatedAtTarget.data[generatedOffset + 2];
    output[outputOffset + 3] = generatedAtTarget.data[generatedOffset + 3];
    retainedGeneratedPixels++;
  }
  console.log(
    `[sentinel-chroma-key] mode=${paintedInputOnly ? "painted" : "protected"} color=${PROTECTION_INPUT_REDACTION_COLOR} distance=${PROTECTION_GRAY_KEY_COLOR_DISTANCE} neutralChroma<=${PROTECTION_GRAY_KEY_MAX_CHROMA} neutralLuma=${PROTECTION_GRAY_KEY_MIN_LUMA}-${PROTECTION_GRAY_KEY_MAX_LUMA} spillDistance=${PROTECTION_GRAY_KEY_SPILL_PX}px edgeRestore=${PROTECTION_GRAY_KEY_EDGE_RESTORE_PX}px keyed=${keyedPixels}px neutralExtra=${neutralKeyedPixels}px spillRestored=${spillRestoredPixels}px edgeRestored=${edgeRestoredPixels}px retainedGenerated=${retainedGeneratedPixels}px registrationRestored=${registrationRestoredPixels}px`,
  );
  return sharp(output, { raw: { width: target.width, height: target.height, channels: 4 } })
    .png()
    .toBuffer();
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}

async function renderProtectionAlpha(target, protection, expandPx) {
  const svg = buildProtectionSvg(target, protection, {
    fill: "#fff",
    transparent: true,
    expandPx,
  });
  return sharp(svg)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

const PROTECTION_NEIGHBOR_OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

function protectionBinaryMask(alphaImage) {
  const pixelCount = alphaImage.info.width * alphaImage.info.height;
  const channels = alphaImage.info.channels;
  const mask = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const alpha = alphaImage.data[pixel * channels + channels - 1];
    if (alpha > 0) mask[pixel] = 1;
  }
  return mask;
}

async function renderProtectionBinaryMask(target, protection, expandPx = 0) {
  return protectionBinaryMask(await renderProtectionAlpha(target, protection, expandPx));
}

function dilateBinaryMask(mask, width, height, radiusPx) {
  const radius = Math.max(0, Math.round(radiusPx));
  if (!radius) return new Uint8Array(mask);
  const output = new Uint8Array(mask);
  const radiusSquared = radius * radius;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (!mask[pixel]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radiusSquared) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        output[ny * width + nx] = 1;
      }
    }
  }
  return output;
}

function parseHexRgb(value) {
  const normalized = String(value || "").replace(/^#/, "");
  return [0, 1, 2].map((index) => Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16));
}

function squaredRgbDistance(data, offset, color) {
  const red = data[offset] - color[0];
  const green = data[offset + 1] - color[1];
  const blue = data[offset + 2] - color[2];
  return red * red + green * green + blue * blue;
}

async function repairConnectedSentinelLeak(
  generatedBuffer,
  restoredBuffer,
  original,
  target,
  restoredMask,
  marginPx,
  repairColors,
) {
  const width = target.width;
  const height = target.height;
  const pixelCount = width * height;
  const generated = await sharp(generatedBuffer)
    .resize(width, height, { fit: "fill" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const generatedChannels = generated.info.channels;
  const originalChannels = original.info.channels;
  const normalizedRepairColors = Array.isArray(repairColors) && repairColors.length
    ? repairColors
    : [PAINTED_SENTINEL_COLOR_A, PAINTED_SENTINEL_COLOR_B];
  const sentinelColors = normalizedRepairColors
    .filter((color) => /^#[0-9a-fA-F]{6}$/.test(color || ""))
    .map((color) => ({
      color: parseHexRgb(color),
      thresholdSquared: color.toLowerCase() === PROTECTION_INPUT_REDACTION_COLOR.toLowerCase()
        ? PROTECTION_GRAY_REPAIR_COLOR_DISTANCE ** 2
        : PROTECTION_SENTINEL_REPAIR_COLOR_DISTANCE ** 2,
    }));
  const candidates = new Uint8Array(pixelCount);
  let candidatePixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (restoredMask[pixel]) continue;
    const generatedOffset = pixel * generatedChannels;
    const originalOffset = pixel * originalChannels;
    const nearSentinel = sentinelColors.some(
      ({ color, thresholdSquared: colorThreshold }) => (
        squaredRgbDistance(generated.data, generatedOffset, color) <= colorThreshold
      ),
    );
    if (!nearSentinel) continue;
    const sourceDelta = Math.max(
      Math.abs(generated.data[generatedOffset] - original.data[originalOffset]),
      Math.abs(generated.data[generatedOffset + 1] - original.data[originalOffset + 1]),
      Math.abs(generated.data[generatedOffset + 2] - original.data[originalOffset + 2]),
    );
    if (sourceDelta < PROTECTION_SENTINEL_REPAIR_MIN_SOURCE_DELTA) continue;
    candidates[pixel] = 1;
    candidatePixels++;
  }

  if (!candidatePixels) {
    return { buffer: restoredBuffer, candidatePixels: 0, connectedPixels: 0, repairedPixels: 0 };
  }

  // One-pixel bridging keeps antialiased checker fragments in the same boundary component.
  const bridge = dilateBinaryMask(candidates, width, height, 1);
  const distances = new Uint16Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueLength = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (!bridge[pixel] || restoredMask[pixel]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    let touchesRestored = false;
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (restoredMask[ny * width + nx]) {
        touchesRestored = true;
        break;
      }
    }
    if (!touchesRestored) continue;
    distances[pixel] = 1;
    queue[queueLength++] = pixel;
  }

  for (let head = 0; head < queueLength; head++) {
    const pixel = queue[head];
    const distance = distances[pixel];
    if (distance >= PROTECTION_SENTINEL_REPAIR_MAX_DISTANCE_PX) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const next = ny * width + nx;
      if (restoredMask[next] || !bridge[next] || distances[next]) continue;
      distances[next] = distance + 1;
      queue[queueLength++] = next;
    }
  }

  const connectedMask = new Uint8Array(pixelCount);
  let connectedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (!candidates[pixel] || !distances[pixel]) continue;
    connectedMask[pixel] = 1;
    connectedPixels++;
  }
  if (!connectedPixels) {
    return { buffer: restoredBuffer, candidatePixels, connectedPixels: 0, repairedPixels: 0 };
  }

  const repairMask = dilateBinaryMask(connectedMask, width, height, marginPx);
  let repairedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (repairMask[pixel] && !restoredMask[pixel]) repairedPixels++;
  }
  const repaired = await compositeOriginalAlpha(restoredBuffer, original, target, repairMask, true);
  console.log(
    `[protection-sentinel-repair] candidates=${candidatePixels}px connected=${connectedPixels}px repaired=${repairedPixels}px margin=${marginPx}px maxDistance=${PROTECTION_SENTINEL_REPAIR_MAX_DISTANCE_PX}px colors=${normalizedRepairColors.join(",")} legacyColorDistance=${PROTECTION_SENTINEL_REPAIR_COLOR_DISTANCE} grayColorDistance=${PROTECTION_GRAY_REPAIR_COLOR_DISTANCE}`,
  );
  return { buffer: repaired, candidatePixels, connectedPixels, repairedPixels };
}

async function compositeOriginalAlpha(baseBuffer, original, target, alphaMap, binary = false) {
  const pixelCount = target.width * target.height;
  const originalChannels = original.info.channels;
  const overlay = Buffer.alloc(pixelCount * 4);
  let paintedPixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const alpha = binary ? (alphaMap[pixel] ? 255 : 0) : alphaMap[pixel];
    if (!alpha) continue;
    const originalOffset = pixel * originalChannels;
    const overlayOffset = pixel * 4;
    overlay[overlayOffset] = original.data[originalOffset];
    overlay[overlayOffset + 1] = original.data[originalOffset + 1];
    overlay[overlayOffset + 2] = original.data[originalOffset + 2];
    overlay[overlayOffset + 3] = alpha;
    paintedPixels++;
  }

  if (!paintedPixels) return baseBuffer;
  return sharp(baseBuffer)
    .resize(target.width, target.height, { fit: "fill" })
    .composite([{
      input: overlay,
      raw: { width: target.width, height: target.height, channels: 4 },
      blend: "over",
    }])
    .png()
    .toBuffer();
}

async function blendOriginalOutsideMask(baseBuffer, original, target, restoredMask, transitionPx) {
  if (transitionPx <= 0) return baseBuffer;
  const width = target.width;
  const height = target.height;
  const pixelCount = width * height;
  const distances = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueLength = 0;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (restoredMask[pixel]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (!restoredMask[ny * width + nx]) continue;
      distances[pixel] = 1;
      queue[queueLength++] = pixel;
      break;
    }
  }

  for (let head = 0; head < queueLength; head++) {
    const pixel = queue[head];
    const distance = distances[pixel];
    if (distance >= transitionPx) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (restoredMask[neighbor] || distances[neighbor]) continue;
      distances[neighbor] = distance + 1;
      queue[queueLength++] = neighbor;
    }
  }

  const transitionAlpha = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const distance = distances[pixel];
    if (!distance || distance > transitionPx) continue;
    transitionAlpha[pixel] = Math.round(
      255 * (transitionPx + 1 - distance) / (transitionPx + 1),
    );
  }
  return compositeOriginalAlpha(baseBuffer, original, target, transitionAlpha);
}

async function harmonizeProtectionBoundary(
  baseBuffer,
  target,
  restoredMask,
  matchPx = PROTECTION_RESTORE_COLOR_MATCH_PX,
  blurSigma = PROTECTION_RESTORE_COLOR_MATCH_BLUR,
  maxDelta = PROTECTION_RESTORE_COLOR_MATCH_MAX_DELTA,
) {
  if (matchPx <= 0 || maxDelta <= 0) return baseBuffer;

  const width = target.width;
  const height = target.height;
  const pixelCount = width * height;
  const base = await sharp(baseBuffer)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = base.info.channels;
  const encodedDelta = Buffer.alloc(pixelCount * 3);
  const seedWeight = Buffer.alloc(pixelCount);
  let seedPixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (restoredMask[pixel]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    let red = 0;
    let green = 0;
    let blue = 0;
    let neighbors = 0;
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (!restoredMask[neighbor]) continue;
      const neighborOffset = neighbor * channels;
      red += base.data[neighborOffset];
      green += base.data[neighborOffset + 1];
      blue += base.data[neighborOffset + 2];
      neighbors++;
    }
    if (!neighbors) continue;

    const offset = pixel * channels;
    const deltas = [
      red / neighbors - base.data[offset],
      green / neighbors - base.data[offset + 1],
      blue / neighbors - base.data[offset + 2],
    ];
    if (Math.max(...deltas.map((value) => Math.abs(value))) > maxDelta) continue;

    const encodedOffset = pixel * 3;
    for (let channel = 0; channel < 3; channel++) {
      encodedDelta[encodedOffset + channel] = Math.max(
        0,
        Math.min(255, Math.round((deltas[channel] + maxDelta) * 255 / (2 * maxDelta))),
      );
    }
    seedWeight[pixel] = 255;
    seedPixels++;
  }

  if (!seedPixels) return baseBuffer;
  const [smoothedDelta, smoothedWeight] = await Promise.all([
    sharp(encodedDelta, { raw: { width, height, channels: 3 } })
      .blur(blurSigma)
      .raw()
      .toBuffer(),
    sharp(seedWeight, { raw: { width, height, channels: 1 } })
      .blur(blurSigma)
      .extractChannel(0)
      .raw()
      .toBuffer(),
  ]);

  const distances = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueLength = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (restoredMask[pixel]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (!restoredMask[ny * width + nx]) continue;
      distances[pixel] = 1;
      queue[queueLength++] = pixel;
      break;
    }
  }
  for (let head = 0; head < queueLength; head++) {
    const pixel = queue[head];
    const distance = distances[pixel];
    if (distance >= matchPx) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (restoredMask[neighbor] || distances[neighbor]) continue;
      distances[neighbor] = distance + 1;
      queue[queueLength++] = neighbor;
    }
  }

  const output = Buffer.from(base.data);
  let changedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const distance = distances[pixel];
    const supportByte = smoothedWeight[pixel];
    if (!distance || distance > matchPx || supportByte < 1) continue;
    const distanceWeight = 0.5 * (1 + Math.cos(Math.PI * distance / (matchPx + 1)));
    const supportWeight = Math.min(1, supportByte / (255 * 0.08));
    const weight = distanceWeight * supportWeight;
    const offset = pixel * channels;
    const encodedOffset = pixel * 3;
    for (let channel = 0; channel < 3; channel++) {
      const normalized = smoothedDelta[encodedOffset + channel] * 255 / supportByte;
      const delta = normalized * (2 * maxDelta) / 255 - maxDelta;
      output[offset + channel] = Math.max(
        0,
        Math.min(255, Math.round(base.data[offset + channel] + delta * weight)),
      );
    }
    changedPixels++;
  }

  console.log(
    `[protection-color-match] seeds=${seedPixels}px changed=${changedPixels}px width=${matchPx}px blur=${blurSigma} maxDelta=${maxDelta}`,
  );
  return sharp(output, { raw: { width, height, channels } }).png().toBuffer();
}

async function repairProtectionWhiteSeams(
  generatedBuffer,
  restoredBuffer,
  originalBuffer,
  target,
  protection,
  restoredMask,
) {
  if (PROTECTION_SEAM_REPAIR_PX <= 0) return { buffer: restoredBuffer, restoredMask };

  const [generated, original, hardMask] = await Promise.all([
    sharp(generatedBuffer)
      .resize(target.width, target.height, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(originalBuffer)
      .resize(target.width, target.height, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    renderProtectionAlpha(target, protection, 0),
  ]);
  const pixelCount = target.width * target.height;
  const candidateAlpha = new Uint8Array(pixelCount);
  const distances = new Uint16Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const generatedChannels = generated.info.channels;
  const originalChannels = original.info.channels;
  const hardChannels = hardMask.info.channels;
  const width = target.width;
  const height = target.height;
  let queueLength = 0;
  let repairedPixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const generatedOffset = pixel * generatedChannels;
    const originalOffset = pixel * originalChannels;
    const generatedMin = Math.min(
      generated.data[generatedOffset],
      generated.data[generatedOffset + 1],
      generated.data[generatedOffset + 2],
    );
    if (generatedMin < PROTECTION_SEAM_WHITE_THRESHOLD) continue;
    const originalMin = Math.min(
      original.data[originalOffset],
      original.data[originalOffset + 1],
      original.data[originalOffset + 2],
    );
    const contrast = generatedMin - originalMin;
    if (contrast < PROTECTION_SEAM_MIN_CONTRAST) continue;

    const whiteStrength = clampUnit(
      (generatedMin - PROTECTION_SEAM_WHITE_THRESHOLD + 6) / 18,
    );
    const contrastStrength = clampUnit(
      (contrast - PROTECTION_SEAM_MIN_CONTRAST + 6) / 24,
    );
    candidateAlpha[pixel] = Math.round(255 * whiteStrength * contrastStrength);
  }

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (candidateAlpha[pixel] < 8) continue;
    const hardAlpha = hardMask.data[pixel * hardChannels + hardChannels - 1];
    if (hardAlpha >= 128) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    let touchesProtection = false;
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (hardMask.data[neighbor * hardChannels + hardChannels - 1] >= 128) {
        touchesProtection = true;
        break;
      }
    }
    if (!touchesProtection) continue;
    distances[pixel] = 1;
    queue[queueLength++] = pixel;
  }

  for (let head = 0; head < queueLength; head++) {
    const pixel = queue[head];
    const distance = distances[pixel];
    if (distance >= PROTECTION_SEAM_REPAIR_PX) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (const [dx, dy] of PROTECTION_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (distances[neighbor] || candidateAlpha[neighbor] < 8) continue;
      distances[neighbor] = distance + 1;
      queue[queueLength++] = neighbor;
    }
  }

  const forceMask = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (!distances[pixel]) continue;
    repairedPixels++;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (let dy = -PROTECTION_SEAM_FORCE_EXPAND_PX; dy <= PROTECTION_SEAM_FORCE_EXPAND_PX; dy++) {
      for (let dx = -PROTECTION_SEAM_FORCE_EXPAND_PX; dx <= PROTECTION_SEAM_FORCE_EXPAND_PX; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        forceMask[ny * width + nx] = 1;
      }
    }
  }

  if (!repairedPixels) return { buffer: restoredBuffer, restoredMask };
  let forceExpandedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (!forceMask[pixel]) continue;
    if (!distances[pixel]) forceExpandedPixels++;
  }

  console.log(
    `[protection-seam] connected=${repairedPixels}px connectedDistance=${PROTECTION_SEAM_REPAIR_PX}px forceExpanded=${forceExpandedPixels}px forceExpand=${PROTECTION_SEAM_FORCE_EXPAND_PX}px outerTransition=${PROTECTION_RESTORE_OUTER_TRANSITION_PX}px`,
  );
  const repairedBuffer = await compositeOriginalAlpha(
    restoredBuffer,
    original,
    target,
    forceMask,
    true,
  );
  const combinedMask = new Uint8Array(restoredMask);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (forceMask[pixel]) combinedMask[pixel] = 1;
  }
  return { buffer: repairedBuffer, restoredMask: combinedMask };
}

async function restoreProtectedRegions(
  generatedBuffer,
  originalBuffer,
  target,
  protection,
  {
    expandPx = PROTECTION_RESTORE_EXPAND_PX,
    repairSentinelLeak = false,
    sentinelMarginPx = 2,
    sentinelRepairColors = null,
  } = {},
) {
  const spec = normalizeProtectionSpec(protection);
  if (!hasProtectionShapes(spec)) return generatedBuffer;

  const originalResizeOptions = target?.preserveSourceAspect
    ? {
      fit: "contain",
      background: target.finalResizeBackground || "#ffffff",
    }
    : { fit: "fill" };
  const originalAtTargetSize = await sharp(originalBuffer)
    .flatten({ background: "#ffffff" })
    .resize(target.width, target.height, originalResizeOptions)
    .png()
    .toBuffer();
  const original = await sharp(originalAtTargetSize)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const binaryMask = await renderProtectionBinaryMask(target, spec, expandPx);
  let restored;
  if (PROTECTION_RESTORE_FEATHER_PX > 0) {
    const alphaMask = buildProtectionSvg(target, spec, {
      fill: "#fff",
      transparent: true,
      expandPx,
    });
    const blendedAlphaMask = await sharp(alphaMask)
      .blur(PROTECTION_RESTORE_FEATHER_PX)
      .png()
      .toBuffer();
    const protectedOverlay = await sharp(originalAtTargetSize)
      .ensureAlpha()
      .composite([{ input: blendedAlphaMask, blend: "dest-in" }])
      .png()
      .toBuffer();
    restored = await sharp(generatedBuffer)
      .resize(target.width, target.height, { fit: "fill" })
      .composite([{ input: protectedOverlay, blend: "over" }])
      .png()
      .toBuffer();
  } else {
    restored = await compositeOriginalAlpha(generatedBuffer, original, target, binaryMask, true);
  }

  if (!repairSentinelLeak) return restored;
  const repair = await repairConnectedSentinelLeak(
    generatedBuffer,
    restored,
    original,
    target,
    binaryMask,
    Math.max(0, Math.min(16, Math.round(sentinelMarginPx))),
    sentinelRepairColors,
  );
  return repair.buffer;
}

async function fetchOAuth(pathname, body, { accept = "application/json", signal = undefined } = {}) {
  // Stage-level retries release the global model slot before backing off.
  const MAX_RETRIES = 0;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${activeOauthUrl}${pathname}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: accept,
        },
        signal,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        let message = text;
        try {
          const parsed = JSON.parse(text);
          message = parsed.error?.message || parsed.message || text;
        } catch {}
        const requestId = response.headers.get("x-request-id") || response.headers.get("request-id");
        const err = new Error(`${message || `OAuth request failed with ${response.status}`}${requestId ? ` (request id: ${requestId})` : ""}`);
        err.status = response.status;
        err.requestId = requestId || null;
        err.body = text;
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const absoluteTime = Date.parse(retryAfter);
          err.retryAfterMs = Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : Number.isFinite(absoluteTime)
              ? Math.max(0, absoluteTime - Date.now())
              : null;
        }
        throw err;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (isModerationGenerationError(error)) {
        error.noRetry = true;
      }
      const retryable =
        !error?.noRetry &&
        (error?.status === 429 ||
          (typeof error?.status === "number" && error.status >= 500) ||
          /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error?.message || ""));
      if (!retryable || attempt === MAX_RETRIES) break;
      const waitMs = modelRetryDelayMs(error, attempt, 750);
      console.warn(`[oauth-retry] status=${error?.status || "network"} attempt=${attempt + 1}/${MAX_RETRIES} waitMs=${waitMs}`);
      await delay(waitMs);
    }
  }

  throw lastError || new Error("OAuth request failed");
}

function isTransientModelError(error) {
  const message = String(error?.message || "");
  return error?.status === 429
    || (typeof error?.status === "number" && error.status >= 500)
    || /An error occurred while processing your request|request id|temporarily unavailable|servers? (?:are )?(?:currently )?overloaded|overloaded|try again later|service unavailable|server_error|rate limit|timeout|terminated|abort|aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
}

function createOAuthStreamError(parsed, fallbackMessage) {
  const responseError = parsed?.error || parsed?.response?.error || {};
  const message = responseError?.message
    || responseError?.code
    || parsed?.message
    || fallbackMessage;
  const error = new Error(message);
  const numericStatus = Number(
    responseError?.status
      ?? responseError?.status_code
      ?? parsed?.status
      ?? parsed?.status_code,
  );
  if (Number.isFinite(numericStatus) && numericStatus >= 400) {
    error.status = numericStatus;
  } else if (/overloaded|try again later|service unavailable|server_error/i.test(message)) {
    error.status = 503;
  }
  error.code = responseError?.code || parsed?.code || null;
  error.requestId = responseError?.request_id
    || parsed?.request_id
    || parsed?.response?.id
    || null;
  try {
    error.body = JSON.stringify({
      type: parsed?.type || null,
      error: responseError,
    });
  } catch {}
  return error;
}

function generationErrorDetails(error) {
  return [
    String(error?.message || ""),
    String(error?.body || ""),
    String(error?.textOutput || ""),
    Array.isArray(error?.imageCallStatuses) ? error.imageCallStatuses.join(" ") : "",
  ].join("\n");
}

function isModerationGenerationError(error) {
  const message = generationErrorDetails(error);
  return /copyright|content policy|policy violation|violates? (our )?polic|safety system|safety policy|moderation|moderated|blocked|disallowed|not allowed|cannot assist|can't assist|refus(?:e|ed|al)|sexual|explicit|erotic|porn|pornographic|nudity|nude|adult content|underage|minor|self[- ]?harm|graphic violence|검열|정책(?:상|에)|안전(?:상| 정책)|죄송하지만|도와드릴 수 없|지원할 수 없|자해|자살|죽고\s*싶|목숨을\s*끊|성적(?:인)? 콘텐츠|노골적|음란|미성년|잔혹한 폭력|완화\s*표현|완화해서/i.test(message);
}

function isNonRetryableGenerationError(error) {
  const message = generationErrorDetails(error);
  return Boolean(error?.noRetry) || isModerationGenerationError(error) || /unsupported parameter|invalid parameter|unknown parameter/i.test(message);
}

function isGenerationRetryableError(error) {
  if (isNonRetryableGenerationError(error)) return false;
  const message = String(error?.message || "");
  return isTransientModelError(error) || /Image generation completed without image output|terminated|abort|aborted/i.test(message);
}

async function delay(ms) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function modelRetryDelayMs(error, attempt, baseMs = MODEL_RETRY_BASE_MS) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    return Math.round(error.retryAfterMs);
  }
  const exponential = Math.min(30000, baseMs * (2 ** Math.max(0, attempt)));
  const jitter = 0.8 + (Math.random() * 0.4);
  return Math.round(exponential * jitter);
}

async function acquireModelRequestPermit(label = "model") {
  if (activeModelRequestCount >= MODEL_CONCURRENCY_LIMIT) {
    await new Promise((resolve) => modelRequestWaiters.push(resolve));
  } else {
    activeModelRequestCount++;
  }
  console.log(`[model-slot] acquire label=${label} active=${activeModelRequestCount}/${MODEL_CONCURRENCY_LIMIT} queued=${modelRequestWaiters.length}`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = modelRequestWaiters.shift();
    if (next) {
      next();
    } else {
      activeModelRequestCount = Math.max(0, activeModelRequestCount - 1);
    }
    console.log(`[model-slot] release label=${label} active=${activeModelRequestCount}/${MODEL_CONCURRENCY_LIMIT} queued=${modelRequestWaiters.length}`);
  };
}

function getPreset(presetId) {
  return PROMPT_PRESETS[presetId] || PROMPT_PRESETS.comic;
}

function normalizeDictionary(rawDictionary) {
  if (typeof rawDictionary !== "string") return [];
  return rawDictionary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf("=");
      if (idx === -1) return null;
      const source = line.slice(0, idx).trim();
      const target = line.slice(idx + 1).trim();
      if (!source || !target) return null;
      return `${source} => ${target}`;
    })
    .filter(Boolean);
}

function normalizeOpenAiOcrModel(model) {
  return ALLOWED_OPENAI_OCR_MODELS.has(model) ? model : DEFAULT_OPENAI_OCR_MODEL;
}

function normalizeImageGenerationModel(model) {
  return model === AUTOMATIC_MODEL_PIPELINE.imageGeneration.model
    ? model
    : DEFAULT_IMAGE_GENERATION_MODEL;
}

function reasoningEffortForModel(model, fallback) {
  return MODEL_REASONING_EFFORTS.get(model) || fallback;
}

function isComicLikePreset(preset) {
  return preset?.id === "comic" || preset?.id === "manga_jp";
}

function buildOcrDeveloperInstruction(preset) {
  if (isComicLikePreset(preset)) {
    return [
      "You are a meticulous comics OCR, layout-alignment, and Korean localization engine.",
      "Treat physical source-text identity as strict data: each ordered visible occurrence, its exact source glyphs, coarse page zone, and Korean translation must remain one inseparable record.",
      "Use full-page context for reading order, speaker voice, tone, and translation, but never let semantics move a translation to a different physical occurrence.",
      preset.id === "manga_jp" ? JAPANESE_MANGA_LATIN_PRESERVATION_GUIDE : "",
      PROTECTED_REDACTION_GUIDE,
      "Do not summarize the page or describe artwork in the output. Output only the requested JSON schema.",
    ].filter(Boolean).join("\n");
  }

  return (
    "You are a translation-only OCR engine. Focus only on reading visible text, identifying its existing text role, and translating it into natural Korean. " +
    "Do not describe artwork, layout, camera angles, or composition. For document schemas, output only compact Korean render text blocks. Preserve non-text icons as [ICON] placeholders at their exact inline positions; never name or translate the icon. " +
    "Do not summarize the page. Output only the JSON schema requested."
  );
}

function buildOcrUserInstruction(preset, dictionaryBlock) {
  if (isComicLikePreset(preset)) {
    return [
      preset.ocrInstruction,
      dictionaryBlock,
      "Priority order: (1) exact one-to-one source occurrence and region alignment, (2) complete meaning and natural Korean voice, (3) concise fit. Never improve fit by swapping, merging, omitting, or relocating an item.",
    ].filter(Boolean).join("\n");
  }

  return `${preset.ocrInstruction}\n${dictionaryBlock}${DOCUMENT_TONE_GUIDE}\n${DOCUMENT_NAME_TRANSLITERATION_GUIDE}\nTranslate only the text content. Output each document block once, in Korean only. Do not include source_text, source_markup, translated_markup, explanations, or duplicate copies. Preserve [ICON] placeholders inside text only when an inline non-text icon exists.`.trim();
}

function automaticPipelineSnapshot() {
  return Object.fromEntries(
    Object.entries(AUTOMATIC_MODEL_PIPELINE).map(([name, stage]) => [name, { ...stage }]),
  );
}

function makeComicFullPageOcrSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      audit: {
        type: "object",
        additionalProperties: false,
        properties: {
          visible_occurrence_count: { type: "integer", minimum: 0 },
          coverage_confidence: { type: "string", enum: ["high", "medium", "low"] },
          reading_order_confidence: { type: "string", enum: ["high", "medium", "low"] },
          needs_review: { type: "boolean" },
          review_reason: { type: "string" },
          corrections_made: { type: "boolean" },
          audit_summary: { type: "string" },
        },
        required: [
          "visible_occurrence_count",
          "coverage_confidence",
          "reading_order_confidence",
          "needs_review",
          "review_reason",
          "corrections_made",
          "audit_summary",
        ],
      },
      reading_order: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            source_text: { type: "string" },
            translated_text: { type: "string" },
            container_type: {
              type: "string",
              enum: ["speech", "caption", "sign", "sound_effect", "narration", "other"],
            },
            text_color_hint: {
              type: "string",
              enum: ["none", "red", "blue", "green", "purple", "pink", "yellow", "orange", "multicolor", "white_on_dark", "colored_on_dark", "other"],
            },
            page_zone: { type: "string", enum: COMIC_PAGE_ZONES },
            source_confidence: { type: "string", enum: ["high", "medium", "low"] },
            translation_confidence: { type: "string", enum: ["high", "medium", "low"] },
            needs_review: { type: "boolean" },
            review_reason: { type: "string" },
          },
          required: [
            "source_text",
            "translated_text",
            "container_type",
            "text_color_hint",
            "page_zone",
            "source_confidence",
            "translation_confidence",
            "needs_review",
            "review_reason",
          ],
        },
      },
    },
    required: ["audit", "reading_order"],
  };
}

async function runStructuredResponse({
  model,
  reasoningEffort,
  developerText,
  userContent,
  schemaName,
  schema,
  emptyError,
}) {
  let lastError = null;
  for (let attempt = 0; attempt <= MODEL_STAGE_MAX_RETRIES; attempt++) {
    let releaseModelPermit = null;
    try {
      releaseModelPermit = await acquireModelRequestPermit(`${model}:${schemaName}`);
      const response = await fetchOAuth(
        "/v1/responses",
        {
          model,
          input: [
            {
              role: "developer",
              content: [{ type: "input_text", text: developerText }],
            },
            {
              role: "user",
              content: userContent,
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: schemaName,
              strict: true,
              schema,
            },
          },
          reasoning: { effort: reasoningEffort },
          stream: true,
        },
        { accept: "text/event-stream" },
      );
      const outputText = await readStreamedOutputText(response, emptyError);
      return JSON.parse(outputText);
    } catch (error) {
      releaseModelPermit?.();
      releaseModelPermit = null;
      lastError = error;
      if (!isTransientModelError(error) || attempt === MODEL_STAGE_MAX_RETRIES) break;
      const waitMs = modelRetryDelayMs(error, attempt);
      console.warn(`[stage-retry] model=${model} schema=${schemaName} retry=${attempt + 1}/${MODEL_STAGE_MAX_RETRIES} waitMs=${waitMs}`);
      await delay(waitMs);
    } finally {
      releaseModelPermit?.();
    }
  }
  throw lastError || new Error(emptyError);
}

function normalizeComparableSource(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\s、。！？!?…・「」『』（）()【】〔〕［］\[\],.:;'"“”‘’]/g, "")
    .toLowerCase();
}

function levenshteinDistance(left, right) {
  const a = [...left];
  const b = [...right];
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length];
}

function hasMaterialSourceDisagreement(draft, verified) {
  const left = normalizeComparableSource(draft);
  const right = normalizeComparableSource(verified);
  if (left === right) return false;
  if (!left || !right) return true;
  const distance = levenshteinDistance(left, right);
  const longest = Math.max(left.length, right.length);
  if (longest <= 8) return distance > 0;
  return distance / longest >= 0.14;
}

function comicReadingDirectionInstruction(preset) {
  return preset.id === "manga_jp"
    ? "Use Japanese manga right-to-left panel flow when the page follows it. Within vertical Japanese, read top-to-bottom and right-column-to-left-column. Inspect mixed layouts, inserts, yonkoma, and left-to-right web-comic layouts instead of assuming."
    : "Infer the page's actual panel and balloon reading order from the visible layout.";
}

function comicDictionaryBlock(dictionaryLines) {
  return dictionaryLines.length
    ? `User dictionary:\n${dictionaryLines.map((entry) => `- ${entry}`).join("\n")}\n`
    : "";
}

async function runComicPrimaryOcrTranslationPass(imageDataUrl, preset, dictionaryLines) {
  const dictionaryBlock = comicDictionaryBlock(dictionaryLines);
  return runStructuredResponse({
    model: AUTOMATIC_MODEL_PIPELINE.comicPrimaryOcr.model,
    reasoningEffort: AUTOMATIC_MODEL_PIPELINE.comicPrimaryOcr.reasoningEffort,
    developerText: [
      "You are the first mandatory Sol pass in a two-pass full-page comic OCR and Korean localization pipeline.",
      "Do layout analysis, exhaustive occurrence inventory, exact OCR, reading-order reconstruction, and Korean translation together from the single full-page image. There is no upstream locator list. Your reading_order must be your own complete inventory.",
      COMIC_CRITICAL_SEMANTIC_FIDELITY_GUIDE,
      preset.id === "manga_jp" ? JAPANESE_MANGA_FORENSIC_GLYPH_GUIDE : "",
      "Before returning, perform a second silent coverage sweep across every panel and every 3-by-3 page zone. Check speech, thoughts, captions, signs, labels, narration, sound effects, background writing, tiny notes, and repeated identical strings. Never merge neighboring containers or omit an occurrence because it seems unimportant.",
      "Use page_zone only as a coarse matching hint. Do not calculate numeric coordinates, trace glyph boundaries, request crops, or create a crop atlas.",
      "Set audit.visible_occurrence_count to exactly reading_order.length. For this first pass, corrections_made must be false. Report uncertainty honestly; the second Sol pass will independently re-scan the page.",
      COMIC_LOCALIZATION_GUIDE,
      COMIC_PROFANITY_AND_INTENSITY_GUIDE,
      KOREAN_SPEECH_LEVEL_GUIDE,
      preset.id === "manga_jp" ? JAPANESE_MANGA_LATIN_PRESERVATION_GUIDE : "",
      PROTECTED_REDACTION_GUIDE,
      "Return only the requested JSON schema.",
    ].filter(Boolean).join("\n"),
    userContent: [
      {
        type: "input_text",
        text: [
          preset.ocrInstruction,
          comicReadingDirectionInstruction(preset),
          dictionaryBlock,
          "This is the primary full-page pass. Inventory and translate every distinct visible text occurrence exactly once. Keep source_text exact and translated_text paired with the same physical occurrence.",
          "source_confidence and translation_confidence must reflect visible evidence and contextual stability, not optimism. Set needs_review=true whenever the exact source, occurrence identity, reading order, or Korean interpretation remains materially uncertain.",
        ].filter(Boolean).join("\n"),
      },
      { type: "input_image", image_url: imageDataUrl, detail: "high" },
    ],
    schemaName: "comic_sol_primary_full_page",
    schema: makeComicFullPageOcrSchema(),
    emptyError: "Sol 1차 전체 페이지 OCR/번역 응답이 비어 있습니다.",
  });
}

async function runComicVerificationPass(imageDataUrl, primaryResult, preset, dictionaryLines) {
  const dictionaryBlock = comicDictionaryBlock(dictionaryLines);
  const primaryItems = Array.isArray(primaryResult?.reading_order) ? primaryResult.reading_order : [];
  const primaryManifest = primaryItems.map((item, index) => {
    const id = `P${String(index + 1).padStart(2, "0")}`;
    return [
      `<primary_item id="${id}" order="${index + 1}">`,
      `SOURCE=${quotePromptData(item?.source_text)}`,
      `KOREAN=${quotePromptData(item?.translated_text)}`,
      `ROLE=${item?.container_type || "other"}; INK=${item?.text_color_hint || "none"}; APPROXIMATE_LOCATION=${comicItemPageZone(item)}`,
      `CONFIDENCE=source:${item?.source_confidence || "low"},translation:${item?.translation_confidence || "low"}; NEEDS_REVIEW=${item?.needs_review === true}`,
      `</primary_item>`,
    ].join("\n");
  }).join("\n\n");
  return runStructuredResponse({
    model: AUTOMATIC_MODEL_PIPELINE.comicVerification.model,
    reasoningEffort: AUTOMATIC_MODEL_PIPELINE.comicVerification.reasoningEffort,
    developerText: [
      "You are the second mandatory Sol pass and final OCR authority in a two-pass full-page comic localization pipeline.",
      COMIC_ADVERSARIAL_VERIFICATION_GUIDE,
      COMIC_CRITICAL_SEMANTIC_FIDELITY_GUIDE,
      preset.id === "manga_jp" ? JAPANESE_MANGA_FORENSIC_GLYPH_GUIDE : "",
      "First re-scan the entire image independently and build your own exhaustive occurrence inventory. Do not treat the primary list, its item count, its order, or its wording as a boundary. Only after the independent scan, compare it against the primary list.",
      "You must add text occurrences missed by the primary pass, remove hallucinated occurrences, split wrongly merged containers, merge only glyphs that truly belong to one physical text block, correct source glyphs, correct translations, and repair reading order or role assignments when visual evidence requires it.",
      "Return one complete corrected reading_order for the whole page. Its array order and item count are authoritative for image generation. Never return a patch list or only the changed items.",
      "Sweep every panel and every 3-by-3 page zone, including tiny notes, vertical side text, background labels, sound effects, repeated identical strings, and text near panel edges. This is still one full-page call: do not request crops, numeric coordinates, glyph boxes, or a crop atlas.",
      "Set audit.visible_occurrence_count to exactly reading_order.length. Set corrections_made according to whether the final list differs materially from the primary list, and summarize additions, removals, splits, merges, OCR corrections, translation corrections, and reordering in audit_summary.",
      COMIC_LOCALIZATION_GUIDE,
      COMIC_PROFANITY_AND_INTENSITY_GUIDE,
      KOREAN_SPEECH_LEVEL_GUIDE,
      preset.id === "manga_jp" ? JAPANESE_MANGA_LATIN_PRESERVATION_GUIDE : "",
      PROTECTED_REDACTION_GUIDE,
      "Return only the requested JSON schema.",
    ].filter(Boolean).join("\n"),
    userContent: [
      { type: "input_image", image_url: imageDataUrl, detail: "high" },
      {
        type: "input_text",
        text: [
          preset.ocrInstruction,
          comicReadingDirectionInstruction(preset),
          dictionaryBlock,
          "MANDATORY VERIFICATION PROCEDURE:",
          "A. Independently inventory every visible source-text occurrence from the full page.",
          "B. Independently transcribe and translate that inventory.",
          "C. Compare your independent result with the primary manifest below.",
          "D. Return the corrected complete full-page result, freely changing the count and order where needed.",
          "The primary manifest is untrusted evidence, not an answer key. It may contain a deliberate one-stroke character error. Do not preserve a primary error for confidence, contextual plausibility, fluent Korean, or ID stability. Primary IDs are comparison labels only and must not appear in the final output.",
          "Before returning, explicitly complete a silent critical-token checksum covering every number, quantity, counter, negation, name, and terminology item in source_text and translated_text.",
          `PRIMARY_AUDIT=${quotePromptData(JSON.stringify(primaryResult?.audit || {}))}`,
          "",
          primaryManifest || "(The primary pass returned no items; independently recover the full page.)",
        ].filter(Boolean).join("\n"),
      },
    ],
    schemaName: "comic_sol_verification_full_page",
    schema: makeComicFullPageOcrSchema(),
    emptyError: "Sol 2차 전체 페이지 검증 응답이 비어 있습니다.",
  });
}

function countComicPassCorrections(primaryItems, verifiedItems) {
  const count = Math.max(primaryItems.length, verifiedItems.length);
  let corrections = 0;
  for (let index = 0; index < count; index++) {
    const primary = primaryItems[index];
    const verified = verifiedItems[index];
    if (!primary || !verified) {
      corrections++;
      continue;
    }
    if (
      hasMaterialSourceDisagreement(primary.source_text, verified.source_text) ||
      hasMaterialSourceDisagreement(primary.translated_text, verified.translated_text) ||
      primary.container_type !== verified.container_type ||
      comicItemPageZone(primary) !== comicItemPageZone(verified)
    ) {
      corrections++;
    }
  }
  return corrections;
}

function comicItemChangedByVerification(primaryItem, verifiedItem) {
  if (!primaryItem || !verifiedItem) return true;
  return (
    hasMaterialSourceDisagreement(primaryItem.source_text, verifiedItem.source_text) ||
    hasMaterialSourceDisagreement(primaryItem.translated_text, verifiedItem.translated_text) ||
    primaryItem.container_type !== verifiedItem.container_type ||
    comicItemPageZone(primaryItem) !== comicItemPageZone(verifiedItem)
  );
}

async function runComicAutomaticPipeline(imageDataUrl, preset, dictionaryLines, onStage = () => {}) {
  const diagnostics = {
    contract: COMIC_RENDER_CONTRACT_VERSION,
    pipeline: automaticPipelineSnapshot(),
    solPassCount: 2,
    primaryItemCount: 0,
    verifiedItemCount: 0,
    correctedItemCount: 0,
    unresolvedItemCount: 0,
  };

  onStage("Sol이 전체 페이지를 1차 판독하고 번역 중", 18);
  const primaryResult = await runComicPrimaryOcrTranslationPass(imageDataUrl, preset, dictionaryLines);
  const primaryItems = Array.isArray(primaryResult?.reading_order) ? primaryResult.reading_order : [];
  diagnostics.primaryItemCount = primaryItems.length;
  diagnostics.primaryAudit = primaryResult?.audit || null;
  diagnostics.primaryReportedCountMatches = Number(primaryResult?.audit?.visible_occurrence_count) === primaryItems.length;

  onStage(`Sol이 원본 전체를 독립적으로 재검증 중 (1차 ${primaryItems.length}개)`, 42);
  const verifiedResult = await runComicVerificationPass(
    imageDataUrl,
    primaryResult,
    preset,
    dictionaryLines,
  );
  const verifiedItems = Array.isArray(verifiedResult?.reading_order) ? verifiedResult.reading_order : [];
  diagnostics.verifiedItemCount = verifiedItems.length;
  diagnostics.verificationAudit = verifiedResult?.audit || null;
  diagnostics.correctedItemCount = countComicPassCorrections(primaryItems, verifiedItems);
  diagnostics.itemCountDelta = verifiedItems.length - primaryItems.length;
  if (!verifiedItems.length) {
    throw new Error("Sol 2차 검증이 번역할 텍스트를 찾지 못해 원문 삭제를 막기 위해 이미지 생성을 중단했습니다.");
  }
  if (Number(verifiedResult?.audit?.visible_occurrence_count) !== verifiedItems.length) {
    throw new Error(`Sol 2차 검증의 전체 항목 수 보고(${verifiedResult?.audit?.visible_occurrence_count})와 실제 결과(${verifiedItems.length})가 달라 이미지 생성을 중단했습니다.`);
  }

  const workingItems = verifiedItems.map((verifiedItem, index) => {
    const primaryItem = primaryItems[index];
    const reviewReasons = [];
    const sourceText = String(verifiedItem?.source_text || "").trim();
    if (!sourceText) reviewReasons.push("2차 Sol 원문 판독 비어 있음");
    let translatedText = String(verifiedItem?.translated_text || "").trim();
    const preserveOriginalLatin = preset.id === "manga_jp" && isLatinOnlyTextOccurrence(sourceText);
    if (preserveOriginalLatin) translatedText = sourceText;
    if (!translatedText) reviewReasons.push("2차 Sol 번역 비어 있음");
    if (verifiedItem?.needs_review) reviewReasons.push(verifiedItem.review_reason || "2차 Sol 검증 후에도 불확실");
    if (verifiedItem?.source_confidence && verifiedItem.source_confidence !== "high") {
      reviewReasons.push(`2차 OCR 신뢰도 ${verifiedItem.source_confidence}`);
    }
    if (verifiedItem?.translation_confidence && verifiedItem.translation_confidence !== "high") {
      reviewReasons.push(`2차 번역 신뢰도 ${verifiedItem.translation_confidence}`);
    }
    if (preset.id === "manga_jp" && !preservesLatinSegments(sourceText, translatedText)) {
      reviewReasons.push("영문 원문 보존 불일치");
    }
    const changedByVerification = comicItemChangedByVerification(primaryItem, verifiedItem);
    return {
      ...verifiedItem,
      item_id: `T${String(index + 1).padStart(2, "0")}`,
      source_text: sourceText,
      translated_text: translatedText,
      page_zone: comicItemPageZone(verifiedItem),
      region: pageZoneToApproximateRegion(comicItemPageZone(verifiedItem)),
      preserve_original_latin: preserveOriginalLatin,
      ocr_confidence: verifiedItem?.source_confidence || "low",
      translation_confidence: verifiedItem?.translation_confidence || "low",
      changed_by_verification: changedByVerification,
      review_reasons: reviewReasons,
    };
  });

  const incompleteItems = workingItems.filter((item) => !item.source_text || !item.translated_text);
  if (incompleteItems.length) {
    const missingIds = incompleteItems.map((item) => item.item_id).join(", ");
    throw new Error(`Sol 이중검증 결과가 비어 있는 항목(${missingIds})이 있어 원문만 삭제되는 것을 막기 위해 이미지 생성을 중단했습니다.`);
  }
  const latinMismatchItems = preset.id === "manga_jp"
    ? workingItems.filter((item) => !preservesLatinSegments(item.source_text, item.translated_text))
    : [];
  if (latinMismatchItems.length) {
    const mismatchIds = latinMismatchItems.map((item) => item.item_id).join(", ");
    throw new Error(`영문 원문이 2차 검증 번역문에 그대로 보존되지 않은 항목(${mismatchIds})이 있어 영문 삭제·음역을 막기 위해 이미지 생성을 중단했습니다.`);
  }

  const flaggedItems = workingItems.filter((item) => item.review_reasons.length > 0);
  diagnostics.unresolvedItemCount = flaggedItems.length;
  diagnostics.pageNeedsReview = verifiedResult?.audit?.needs_review === true;
  diagnostics.pageReviewReason = String(verifiedResult?.audit?.review_reason || "").trim();
  workingItems.forEach((item) => {
    if (item.review_reasons.length) {
      item.review_status = "unresolved_after_sol_verification";
      item.review_resolution = item.review_reasons.join("; ");
      return;
    }
    item.review_status = item.changed_by_verification ? "sol_verification_corrected" : "sol_double_verified";
    item.review_resolution = item.changed_by_verification
      ? "Sol 2차 전체 페이지 재검증에서 수정됨"
      : "Sol 1차 판독과 2차 전체 페이지 검증 완료";
  });

  const translationData = {
    reading_order: workingItems.map((item) => ({
      source_text: item.source_text,
      translated_text: item.translated_text,
      container_type: item.container_type,
      text_color_hint: item.text_color_hint,
      page_zone: item.page_zone,
      region: item.region,
      ocr_confidence: item.ocr_confidence,
      translation_confidence: item.translation_confidence,
      review_status: item.review_status,
      review_reasons: item.review_reasons,
      review_resolution: item.review_resolution,
      changed_by_verification: item.changed_by_verification,
      preserve_original_latin: item.preserve_original_latin === true,
    })),
    automation: diagnostics,
  };
  console.log(`[automatic-pipeline] preset=${preset.id} solPasses=2 primary=${diagnostics.primaryItemCount} verified=${diagnostics.verifiedItemCount} corrected=${diagnostics.correctedItemCount} unresolved=${diagnostics.unresolvedItemCount}`);
  return addComicPlacementMetadata(translationData);
}

/*
 * The mandatory second Sol pass intentionally receives the full page and may change the
 * occurrence count. Do not replace this with a fixed-item review: that would make a text
 * occurrence omitted by the first pass impossible to recover.
 */

async function runOcrTranslation(imageDataUrl, preset, dictionaryLines = [], model = DEFAULT_OPENAI_OCR_MODEL) {
  const dictionaryBlock = dictionaryLines.length
    ? `User dictionary:\n${dictionaryLines.map((entry) => `- ${entry}`).join("\n")}\n`
    : "";
  const openAiModel = normalizeOpenAiOcrModel(model);
  const reasoningEffort = reasoningEffortForModel(openAiModel, AUTOMATIC_MODEL_PIPELINE.comicPrimaryOcr.reasoningEffort);
  let lastError = null;
  for (let attempt = 0; attempt <= MODEL_STAGE_MAX_RETRIES; attempt++) {
    let releaseModelPermit = null;
    try {
      releaseModelPermit = await acquireModelRequestPermit(`${openAiModel}:${preset.schemaName}`);
      const response = await fetchOAuth(
        "/v1/responses",
        {
          model: openAiModel,
          input: [
            {
              role: "developer",
              content: [
                {
                  type: "input_text",
                  text: buildOcrDeveloperInstruction(preset),
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildOcrUserInstruction(preset, dictionaryBlock),
                },
                { type: "input_image", image_url: imageDataUrl, detail: "high" },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: preset.schemaName,
              strict: true,
              schema: preset.schema,
            },
          },
          reasoning: { effort: reasoningEffort },
          stream: true,
        },
        { accept: "text/event-stream" },
      );

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let textBlock = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const eventBlock = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          let payload = "";
          for (const line of eventBlock.split("\n")) {
            if (line.startsWith("data: ")) payload += line.slice(6);
          }
          if (!payload || payload === "[DONE]") continue;

          const parsed = JSON.parse(payload);
          if (parsed.type === "response.output_text.done" && parsed.text) {
            textBlock = parsed.text;
          }
          if (parsed.type === "error" || parsed.type === "response.failed" || parsed.response?.status === "failed") {
            throw createOAuthStreamError(parsed, "OCR translation failed.");
          }
        }
      }

      if (!textBlock) throw new Error("OCR/translation response did not include JSON text.");
      return JSON.parse(textBlock);
    } catch (error) {
      releaseModelPermit?.();
      releaseModelPermit = null;
      lastError = error;
      if (!isTransientModelError(error) || attempt === MODEL_STAGE_MAX_RETRIES) break;
      const waitMs = modelRetryDelayMs(error, attempt);
      console.warn(`[stage-retry] model=${openAiModel} schema=${preset.schemaName} retry=${attempt + 1}/${MODEL_STAGE_MAX_RETRIES} waitMs=${waitMs}`);
      await delay(waitMs);
    } finally {
      releaseModelPermit?.();
    }
  }

  throw lastError || new Error("OCR translation failed.");
}

async function runAutomaticOcrTranslation(imageDataUrl, preset, dictionaryLines, onStage = () => {}) {
  if (isComicLikePreset(preset)) {
    return runComicAutomaticPipeline(imageDataUrl, preset, dictionaryLines, onStage);
  }

  onStage("Terra가 문서 OCR과 번역을 처리 중", 36);
  let translationData;
  const automation = {
    contract: "terra-sol-document-v1",
    pipeline: automaticPipelineSnapshot(),
    fallbackStages: [],
    documentFallbackCount: 0,
  };
  try {
    translationData = await runOcrTranslation(
      imageDataUrl,
      preset,
      dictionaryLines,
      AUTOMATIC_MODEL_PIPELINE.documentOcr.model,
    );
    const blocks = translationData?.blocks || [];
    if (!blocks.length || blocks.some((block) => !String(block?.text || "").trim())) {
      throw new Error("Terra 문서 OCR 결과가 비어 있거나 불완전합니다.");
    }
  } catch (error) {
    onStage("Sol이 불완전한 문서 OCR을 예외 재처리 중", 52);
    automation.fallbackStages.push({
      stage: "document_ocr_translation",
      from: AUTOMATIC_MODEL_PIPELINE.documentOcr.model,
      to: AUTOMATIC_MODEL_PIPELINE.documentException.model,
      error: error.message,
    });
    automation.documentFallbackCount = 1;
    translationData = await runOcrTranslation(
      imageDataUrl,
      preset,
      dictionaryLines,
      AUTOMATIC_MODEL_PIPELINE.documentException.model,
    );
  }
  translationData.automation = automation;
  return translationData;
}

function extractImageFromResponseJson(json) {
  for (const item of json?.output || []) {
    if (item?.type === "image_generation_call" && item.result) {
      return {
        imageB64: item.result,
        revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : null,
        usage: json?.usage || null,
      };
    }
  }
  return { imageB64: null, revisedPrompt: null, usage: json?.usage || null };
}

function summarizeEventTypes(eventTypes = {}) {
  const entries = Object.entries(eventTypes);
  const countFor = (needle) =>
    entries.reduce((sum, [key, value]) => sum + (key.includes(needle) && Number.isFinite(value) ? value : 0), 0);
  return {
    eventCountKinds: entries.length,
    eventTypes: entries.slice(0, 12).map(([key]) => key).join(","),
    imageEventCount: countFor("image"),
    completedEventCount: countFor("completed"),
  };
}

async function readImageGenerationStream(response) {
  if (!response.body) throw new Error("Image generation response body is missing.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const eventTypes = {};
  let buffer = "";
  let imageB64 = null;
  let usage = null;
  let revisedPrompt = null;
  let textOutput = "";
  const imageCallStatuses = [];
  let eventCount = 0;
  let parseSkipCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const eventBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      let payload = "";
      for (const line of eventBlock.split("\n")) {
        if (line.startsWith("data: ")) payload += line.slice(6);
      }
      if (!payload || payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);
        eventCount++;
        const eventType = typeof parsed.type === "string" ? parsed.type : "_unknown";
        eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

        if (parsed.type === "response.output_item.done" && parsed.item?.type === "image_generation_call") {
          if (parsed.item.status) imageCallStatuses.push(parsed.item.status);
          if (parsed.item.result) imageB64 = parsed.item.result;
          if (typeof parsed.item.revised_prompt === "string" && parsed.item.revised_prompt) {
            revisedPrompt = parsed.item.revised_prompt;
          }
        }
        if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
          textOutput += parsed.delta;
        }
        if (parsed.type === "response.output_text.done" && typeof parsed.text === "string") {
          textOutput = parsed.text;
        }
        if (parsed.type === "response.completed") {
          usage = parsed.response?.usage || null;
        }
        if (parsed.type === "error" || parsed.type === "response.failed" || parsed.response?.status === "failed") {
          throw createOAuthStreamError(parsed, "Image generation stream returned an error.");
        }
      } catch (error) {
        if (!String(error?.message || "").startsWith("Unexpected")) throw error;
        parseSkipCount++;
      }
    }
  }

  return { imageB64, usage, revisedPrompt, textOutput, imageCallStatuses, eventCount, eventTypes, parseSkipCount };
}

function buildPaintedTextEditPrompts(preset, translationData) {
  const developerPrompt = [
    `ROLE: Surgical text-replacement editor (${PAINTED_TEXT_EDIT_CONTRACT_VERSION}).`,
    "OUTCOME: Return the same source image at the same dimensions, changing only source-language glyph strokes into Korean glyph strokes.",
    SPEECH_BUBBLE_TAIL_PRESENCE_LOCK,
    "The visible source islands were selected by a human only to reveal text. Their outer silhouettes are artificial mask boundaries, not speech bubbles, panels, labels, holes, containers, or shapes to complete.",
    "Never trace, round, outline, connect, extend, fill, recolor, or imitate an island boundary. Never create a rectangle, capsule, cloud, patch, backplate, halo, or solid/sampled-color fill behind text.",
    "Inside each visible island, preserve all non-glyph pixels: background colors and gradients, texture, linework, borders, bubble fills and tails, icons, drawings, and spacing. Erase only the old letter strokes and reconstruct only the tiny pixels directly beneath those strokes.",
    `Uniform neutral gray (${PROTECTION_INPUT_REDACTION_COLOR}) is unavailable sentinel data. Do not draw, infer, reconstruct, or continue anything in gray areas. The ${PAINTED_INPUT_EDGE_PX}px outer source border is registration context, not an edit target.`,
    "If a source occurrence cannot be matched confidently, leave it unchanged. A missed edit is preferable to changing artwork or producing a blank container.",
    "Before returning, compare edited and source coordinates: every change must be explainable as removal of a source glyph stroke or addition of its Korean replacement.",
  ].join("\n");

  if (preset.id === "comic" || preset.id === "manga_jp") {
    const preserveLatin = preset.id === "manga_jp";
    const manifest = buildComicSpatialManifest(translationData, { preserveLatin });
    const latinBlock = preserveLatin
      ? `\n\nPROTECTED LATIN PIXELS:\n${buildComicProtectedLatinManifest(translationData)}\nKeep these existing Latin glyphs pixel-unchanged. In mixed Japanese/Latin text, replace only the Japanese glyphs; never draw a second Latin copy.`
      : "";
    const mangaRule = preserveLatin
      ? "\n- Ordinary Korean dialogue, notes, captions, signs, and narration must read horizontally left-to-right inside the same original container. Only genuine sound effects or logos may remain decorative."
      : "";
    return {
      mode: PAINTED_TEXT_EDIT_CONTRACT_VERSION,
      developerPrompt,
      userPrompt: [
        "TASK: Perform only the one-to-one glyph replacements listed below in the revealed source-text islands.",
        "Match primarily by SOURCE_VISIBLE and reading order. ROLE and APPROXIMATE_LOCATION are matching hints only; they do not define a paint area.",
        "Render each KOREAN_REPLACEMENT completely and exactly once in the same existing container. XML tags, IDs, field names, and location labels are metadata and must not be drawn.",
        "Use the original text ink, emphasis, perspective, and alignment. Fit with line breaks and font size; never enlarge, repaint, or replace the surrounding container.",
        "A container with no source tail or pointer is already complete and must remain tailless; never infer or draw a connection to any speaker or object.",
        "Do not erase a source occurrence unless its complete replacement is rendered in the same operation and location.",
        mangaRule,
        `\nONE-TO-ONE REPLACEMENT CHECKLIST:\n${manifest}${latinBlock}`,
      ].filter(Boolean).join("\n"),
    };
  }

  if (preset.id === "document") {
    const blocks = Array.isArray(translationData?.blocks) ? translationData.blocks : [];
    const checklist = blocks.map((item, index) => {
      const text = item?.text || item?.translated_markup || item?.translated_text || "";
      return `<replacement_block id="B${String(index + 1).padStart(2, "0")}">${quotePromptData(text)}</replacement_block>`;
    }).join("\n");
    return {
      mode: PAINTED_TEXT_EDIT_CONTRACT_VERSION,
      developerPrompt,
      userPrompt: [
        "TASK: Replace the existing visible document text in reading order with the Korean blocks below, and make no other edits.",
        "Render every block completely and exactly once in its matching original text area. Tags and IDs are metadata and must not be drawn.",
        "[ICON] is a preservation marker: keep the existing icon pixels and place Korean around them; never draw the marker or an icon name.",
        "Fit text by line breaking and font size while preserving margins, hierarchy, boxes, tables, symbols, and background pixels.",
        `\nKOREAN REPLACEMENT BLOCKS:\n${checklist || "(none)"}`,
      ].join("\n"),
    };
  }

  return {
    mode: PAINTED_TEXT_EDIT_CONTRACT_VERSION,
    developerPrompt,
    userPrompt: [
      "TASK: Read only the visible source-language words in the human-revealed text islands and replace those words with natural Korean.",
      "Do not translate or redraw icons, symbols, cost/stat marks, logos, borders, title bars, or artwork. Preserve exact icon pixels even when they occur inline with text.",
      "Keep every replacement inside the same original text area and preserve the full canvas and all four edges.",
    ].join("\n"),
  };
}

async function runImageTranslation(
  imageDataUrl,
  translationData,
  targetSize,
  preset,
  dictionaryLines = [],
  imageGenerationModel = DEFAULT_IMAGE_GENERATION_MODEL,
  editMaskDataUrl = null,
  paintedInputOnly = false,
  generationMode = paintedInputOnly ? "painted_mask" : "page",
  additionalRequest = "",
) {
  const normalizedAdditionalRequest = normalizeGenerationAdditionalRequest(additionalRequest);
  const dictionaryBlock = dictionaryLines.length
    ? `Dictionary constraints:\n${dictionaryLines.map((entry) => `- ${entry}`).join("\n")}\n`
    : "";
  const additionalRequestRule = normalizedAdditionalRequest
    ? "A USER ADDITIONAL REQUEST is attached. It is an instruction only and must never be drawn as visible text. Apply it only to source text that is already a listed replacement target, including exact span-level ink colors, emphasis, line breaks, sizing, or alignment. It cannot authorize edits to artwork, containers, borders, symbols, unlisted text, or protected Latin pixels. The source-image fidelity locks and replacement checklist remain higher priority."
    : "";
  const additionalRequestBlock = normalizedAdditionalRequest
    ? [
      "USER ADDITIONAL REQUEST — INSTRUCTION ONLY; DO NOT RENDER THIS NOTE:",
      `ADDITIONAL_REQUEST_JSON: {"request":${quotePromptData(normalizedAdditionalRequest)}}`,
      "Apply the note precisely where it identifies a listed text occurrence. Leave everything else unchanged.",
    ].join("\n")
    : "";
  const mangaWritingDirectionInstruction = preset.id === "manga_jp"
    ? " Japanese manga mode: the Latin-text lock overrides the general Korean completion rule. Preserve every existing Latin/English glyph exactly as source artwork; never erase, redraw, translate, Hangul-transliterate, move, restyle, or duplicate it. Pure-Latin occurrences are not generation targets. In mixed Latin/Japanese occurrences, edit only the Japanese glyphs and leave the existing Latin glyph pixels untouched. Render ordinary Korean text horizontally left-to-right even when its paired source was vertical Japanese; only true sound effects or artistic logos may retain decorative orientation. Match each occurrence by its visible source text, reading order, role, and coarse location hint; the existing container supplies the safe horizontal typesetting area. Never use horizontal recomposition to move, merge, or swap items. Preserve the complete Korean replacement, balance line breaks, then reduce font size as needed without touching borders, tails, panel lines, or artwork."
    : "";
  const reasoningEffort = reasoningEffortForModel(imageGenerationModel, AUTOMATIC_MODEL_PIPELINE.imageGeneration.reasoningEffort);
  const activeTranslationData = translationData;
  const paintedPrompts = paintedInputOnly
    ? buildPaintedTextEditPrompts(preset, activeTranslationData)
    : null;
  let activeEditMaskDataUrl = editMaskDataUrl;
  let useHighFidelityEditControls = paintedInputOnly || generationMode === "page";
  let lastError = null;
  for (let attempt = 0; attempt <= MODEL_STAGE_MAX_RETRIES; attempt++) {
    let releaseModelPermit = null;
    try {
      releaseModelPermit = await acquireModelRequestPermit(`${imageGenerationModel}:image-generation`);
      const signal = IMAGE_GENERATION_TIMEOUT_MS > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)
        : undefined;
      const promptMode = paintedPrompts?.mode || "standard";
      console.log(`[image-generation] model=${imageGenerationModel} preset=${preset.id} generationMode=${generationMode} promptMode=${promptMode} size=${targetSize} quality=${IMAGE_GENERATION_QUALITY} moderation=${IMAGE_GENERATION_MODERATION} reasoning=${reasoningEffort} editControls=${useHighFidelityEditControls ? "high-fidelity" : "default"}`);
      const generationTool = {
        type: "image_generation",
        quality: IMAGE_GENERATION_QUALITY,
        size: targetSize,
        moderation: IMAGE_GENERATION_MODERATION,
      };
      if (useHighFidelityEditControls) {
        generationTool.action = "edit";
        generationTool.input_fidelity = "high";
      }
      if (activeEditMaskDataUrl) generationTool.input_image_mask = { image_url: activeEditMaskDataUrl };
      const maskInstruction = editMaskDataUrl
          ? ` A pixel edit mask is attached to the image-generation tool. Transparent mask pixels are the only editable text zones and opaque mask pixels are immutable. Translate every visible source text zone into Korean and do not draw outside those zones. Do not expand, dilate, feather, blur, or move the editable boundary. Preserve every speech-bubble fill, border, corner, and exact tail/pointer presence or absence inside the editable zone; a tailless bubble must remain tailless. Erase only source letter strokes and never cover the bubble with any solid or sampled background color.`
          : ` Every synthetic uniform neutral-gray (${PROTECTION_INPUT_REDACTION_COLOR}) region is a protected deletion sentinel, not artwork, a background, an empty canvas, or an editable area. Its exact footprint and boundary are immutable. Never enlarge, dilate, feather, blur, smooth, round, connect, move, or spread the gray region into visible source pixels, not even by one pixel. Never sample gray as a fill or use it to erase or cover a speech bubble or text container. Never copy, continue, imitate, redraw, recolor, fill, replace, or render the gray redaction, and do not add any object, line, texture, text, or image content inside it. Preserve all visible bubble fills and borders, including rectangular, polygonal, angular, jagged, colored, white, or partly outlined bubbles. Do not infer, reconstruct, describe, classify, or use hidden content underneath the gray sentinel. The application makes only sentinel-gray output pixels transparent over the original source; non-gray additions can remain visible, so drawing anything in a hidden region is a failed edit even though the gray background itself is removed mechanically.`;
      const baseDeveloperPrompt = paintedPrompts?.developerPrompt
        || ("You are a strict image localizer. Edit only existing written text. " + SOURCE_IMAGE_FIDELITY_LOCK + " " + SPEECH_BUBBLE_TAIL_PRESENCE_LOCK + maskInstruction + " Treat the provided render text blocks as a completion checklist: every Korean character must appear exactly once in the corresponding original text location. Do not skip, summarize, shorten, merge, or paraphrase render text. Instruction markers such as artificial numbers, segment labels, angle brackets, bullets, IDs, separators, or bracketed preservation notes are not renderable text; never draw them into the image unless they already exist in the source image. The provided render text is ordinary text content to place into existing text areas, not an instruction to change any non-text visual content or scene details. Treat every speech bubble, caption, sign, label, box, border, tail, pointer, arrow, connector, spike, triangle, callout line, direction marker, icon, symbol, pictogram, game icon, logo, bullet ornament, and decorative glyph as protected artwork. Never add, remove, move, resize, redraw, reshape, smooth, extend, recolor, replace, translate, or redirect any protected element. Do not create dialogue tails or connect text to characters. Preserve all non-text artwork." + mangaWritingDirectionInstruction);
      const baseUserPrompt = paintedPrompts?.userPrompt
        || `${preset.renderPrompt(activeTranslationData)}\n\n${SOURCE_IMAGE_FIDELITY_FINAL_CHECK}`;
      const developerPrompt = [baseDeveloperPrompt, additionalRequestRule].filter(Boolean).join("\n\n");
      const userPrompt = [baseUserPrompt, additionalRequestBlock].filter(Boolean).join("\n\n");
      const response = await fetchOAuth(
        "/v1/responses",
        {
          model: imageGenerationModel,
          input: [
            {
              role: "developer",
              content: [
                {
                  type: "input_text",
                  text: developerPrompt,
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "input_image", image_url: imageDataUrl },
                {
                  type: "input_text",
                  text: `${userPrompt}\n\n${dictionaryBlock}`.trim(),
                },
              ],
            },
          ],
          tools: [generationTool],
          tool_choice: "required",
          reasoning: { effort: reasoningEffort },
          stream: true,
        },
        { accept: "text/event-stream", signal },
      );

      const contentType = response.headers.get("content-type") || "";
      let imageB64 = null;
      if (!contentType.includes("text/event-stream")) {
        const parsed = await response.json();
        ({ imageB64 } = extractImageFromResponseJson(parsed));
      } else {
        const streamResult = await readImageGenerationStream(response);
        imageB64 = streamResult.imageB64;
        if (!imageB64) {
          const summary = summarizeEventTypes(streamResult.eventTypes);
          const textHint = streamResult.textOutput
            ? `, text=${streamResult.textOutput.replace(/\s+/g, " ").slice(0, 240)}`
            : "";
          const imageStatusHint = streamResult.imageCallStatuses.length
            ? `, imageCallStatus=${[...new Set(streamResult.imageCallStatuses)].join(",")}`
            : "";
          const err = new Error(
            `Image generation completed without image output. events=${streamResult.eventCount}, types=${summary.eventTypes || "none"}${imageStatusHint}${textHint}, parseSkips=${streamResult.parseSkipCount}`,
          );
          err.eventCount = streamResult.eventCount;
          err.eventTypes = streamResult.eventTypes;
          err.textOutput = streamResult.textOutput;
          err.imageCallStatuses = streamResult.imageCallStatuses;
          err.parseSkipCount = streamResult.parseSkipCount;
          throw err;
        }
      }

      if (!imageB64) {
        throw new Error("Image generation completed without image output.");
      }

      return Buffer.from(imageB64, "base64");
    } catch (error) {
      releaseModelPermit?.();
      releaseModelPermit = null;
      lastError = error;
      if (isModerationGenerationError(error)) {
        error.noRetry = true;
        console.warn("[image-generation] moderation or policy refusal detected; automatic retry disabled");
        break;
      }
      const errorMessage = generationErrorDetails(error);
      if (useHighFidelityEditControls && /input_fidelity|\baction\b|unknown parameter|unsupported parameter|invalid parameter/i.test(errorMessage)) {
        useHighFidelityEditControls = false;
        console.warn("[image-generation] high-fidelity edit controls unsupported by current OAuth route; retrying with the selected prompt and default tool controls");
        continue;
      }
      if (activeEditMaskDataUrl && /input_image_mask|unknown parameter|unsupported parameter|invalid parameter/i.test(errorMessage)) {
        activeEditMaskDataUrl = null;
        console.warn("[image-generation] image edit mask unsupported by current OAuth route; retrying with redacted painted input and local painted-region compositing");
        continue;
      }
      if (isNonRetryableGenerationError(error) || !isTransientModelError(error) || attempt === MODEL_STAGE_MAX_RETRIES) break;
      const waitMs = modelRetryDelayMs(error, attempt, 1250);
      console.warn(`[stage-retry] model=${imageGenerationModel} schema=image-generation retry=${attempt + 1}/${MODEL_STAGE_MAX_RETRIES} waitMs=${waitMs}`);
      await delay(waitMs);
    } finally {
      releaseModelPermit?.();
    }
  }

  throw lastError || new Error("Image generation failed.");
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  throw new Error("Patch Atlas helper did not return JSON metadata.");
}

async function runPythonHelper(args) {
  try {
    return await runCommand("python", args);
  } catch (firstError) {
    try {
      return await runCommand("py", args);
    } catch {
      throw firstError;
    }
  }
}

function escapeSvgText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function buildPatchLocalizationGrid(sourceBuffer) {
  const metadata = await sharp(sourceBuffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error("Patch Atlas GPT 위치 검증용 이미지 크기를 읽지 못했습니다.");

  const lines = [];
  const labels = [];
  for (let step = 0; step <= 10; step++) {
    const x = Math.round((step / 10) * width);
    const y = Math.round((step / 10) * height);
    const value = step * 100;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
    labels.push(`<text x="${Math.min(width - 44, x + 3)}" y="18">x${value}</text>`);
    labels.push(`<text x="3" y="${Math.max(18, Math.min(height - 4, y - 3))}">y${value}</text>`);
  }
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
      + `<g fill="none" stroke="#00e5ff" stroke-width="1.5" stroke-opacity="0.55">${lines.join("")}</g>`
      + `<g font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#ffffff" stroke="#000000" stroke-width="3" paint-order="stroke">${labels.join("")}</g>`
      + `</svg>`,
  );
  const gridBuffer = await sharp(sourceBuffer).composite([{ input: svg }]).png().toBuffer();
  return {
    width,
    height,
    dataUrl: `data:image/png;base64,${gridBuffer.toString("base64")}`,
  };
}

async function readStreamedOutputText(response, errorMessage) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textBlock = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const eventBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      let payload = "";
      for (const line of eventBlock.split("\n")) {
        if (line.startsWith("data: ")) payload += line.slice(6);
      }
      if (!payload || payload === "[DONE]") continue;
      const parsed = JSON.parse(payload);
      if (parsed.type === "response.output_text.done" && parsed.text) textBlock = parsed.text;
      if (parsed.type === "error" || parsed.type === "response.failed" || parsed.response?.status === "failed") {
        throw createOAuthStreamError(parsed, errorMessage);
      }
    }
  }
  if (!textBlock) throw new Error(errorMessage);
  return textBlock;
}

async function runPatchAtlasGptLocalization(
  sourceBuffer,
  candidateSheetBuffer,
  candidateMetadata,
  translationData,
  preset,
  model = DEFAULT_OPENAI_OCR_MODEL,
) {
  const rawItems = translationData?.reading_order || translationData?.blocks || [];
  const items = rawItems
    .map((item, index) => ({
      id: `T${String(index + 1).padStart(2, "0")}`,
      sourceText: String(item?.source_text || "").trim(),
      containerType: String(item?.container_type || "other"),
    }))
    .filter((item) => item.sourceText);
  if (!items.length) return translationData;

  const originalDataUrl = `data:image/png;base64,${sourceBuffer.toString("base64")}`;
  const candidateDataUrl = `data:image/png;base64,${candidateSheetBuffer.toString("base64")}`;
  const candidateIds = (candidateMetadata?.candidates || []).map((candidate) => candidate.id);
  const candidateById = new Map((candidateMetadata?.candidates || []).map((candidate) => [candidate.id, candidate]));
  const [sourceWidth, sourceHeight] = candidateMetadata?.source_size || [];
  if (!candidateIds.length || !sourceWidth || !sourceHeight) {
    throw new Error("GPT 위치 검증 후보 데이터가 비어 있습니다.");
  }
  const sourceList = items.map((item) => `${item.id} [${item.containerType}]: ${item.sourceText}`).join("\n");
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      blocks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            found: { type: "boolean" },
            candidate_ids: {
              type: "array",
              items: { type: "string", enum: candidateIds },
            },
          },
          required: ["id", "found", "candidate_ids"],
        },
      },
    },
    required: ["blocks"],
  };

  const response = await fetchOAuth(
    "/v1/responses",
    {
      model: normalizeOpenAiOcrModel(model),
      input: [
        {
          role: "developer",
          content: [{
            type: "input_text",
            text: "You are a meticulous comic text localizer. Match exact visible source-language glyphs to numbered candidate rectangles. Never translate, rewrite, infer a missing occurrence, or select surrounding artwork. Output the requested JSON only.",
          }],
        },
        {
          role: "user",
          content: [
            { type: "input_image", image_url: originalDataUrl },
            { type: "input_image", image_url: candidateDataUrl },
            {
              type: "input_text",
              text: [
                `The first image is the unobstructed ${sourceWidth}x${sourceHeight} source page.`,
                "The second image is a contact sheet of candidate crops. Every tile has a candidate ID and a magenta rectangle showing the exact selectable source area.",
                "For every T ID below, select the candidate ID or IDs whose magenta rectangles jointly cover every glyph stroke of that exact visible occurrence.",
                "Select multiple adjacent candidates when one occurrence is split into columns, lines, or disconnected sound-effect strokes. Do not select a nearby candidate merely because it looks similar.",
                "Exclude speech-balloon borders, tails, hearts, decorations, characters, and background art. Prefer the tightest complete set of candidates.",
                "Repeated identical strings are distinct occurrences. Assign them once each in the page's manga reading order and never reuse the same occurrence.",
                "Set found=false and candidate_ids=[] only if no candidate set covers the occurrence confidently. Do not invent candidate IDs.",
                preset?.id === "manga_jp" ? "Use Japanese manga right-to-left panel reading order where applicable." : "Use the page's visible comic reading order.",
                "",
                sourceList,
              ].join("\n"),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "patch_atlas_text_locations",
          strict: true,
          schema,
        },
      },
      reasoning: { effort: "medium" },
      stream: true,
    },
    { accept: "text/event-stream" },
  );
  const parsed = JSON.parse(await readStreamedOutputText(response, "GPT 텍스트 위치 검증 응답이 비어 있습니다."));
  const byId = new Map((parsed.blocks || []).map((block) => [block.id, block]));
  const localized = JSON.parse(JSON.stringify(translationData));
  const localizedItems = localized.reading_order || localized.blocks || [];
  let foundCount = 0;
  localizedItems.forEach((item, index) => {
    const id = `T${String(index + 1).padStart(2, "0")}`;
    const block = byId.get(id);
    const selected = [...new Set(block?.candidate_ids || [])]
      .map((candidateId) => candidateById.get(candidateId))
      .filter(Boolean);
    const found = Boolean(block?.found && selected.length);
    item.region_verified = found;
    item.region_locator = "gpt_candidates_v1";
    if (found) {
      const union = selected.reduce(
        (box, candidate) => [
          Math.min(box[0], candidate.box[0]),
          Math.min(box[1], candidate.box[1]),
          Math.max(box[2], candidate.box[2]),
          Math.max(box[3], candidate.box[3]),
        ],
        [...selected[0].box],
      );
      item.region = {
        x: (union[0] / sourceWidth) * 1000,
        y: (union[1] / sourceHeight) * 1000,
        width: ((union[2] - union[0]) / sourceWidth) * 1000,
        height: ((union[3] - union[1]) / sourceHeight) * 1000,
      };
      item.region_candidate_ids = selected.map((candidate) => candidate.id);
      foundCount++;
    }
  });
  if (!foundCount) throw new Error("GPT가 신뢰할 수 있는 텍스트 위치를 하나도 반환하지 않았습니다.");
  console.log(`[patch-atlas-localization] model=${normalizeOpenAiOcrModel(model)} found=${foundCount}/${items.length}`);
  return localized;
}

function buildPatchAtlasRenderPrompt(metadata) {
  const lines = (metadata?.tiles || []).map((tile) => {
    const color = tile.text_color_hint && tile.text_color_hint !== "none"
      ? `; original ink=${tile.text_color_hint}`
      : "";
    return `${tile.id} (${tile.container_type}${color}): ${tile.target_text}`;
  });
  return [
    "Edit every numbered tile in the first input image.",
    "The second input image is a layout guide, not an output to copy wholesale. It fixes the intended Korean glyphs, line count, scale, and placement for each matching tile.",
    "For each tile, remove only the original source-language glyphs and render the exact Korean text listed below inside the indicated edit area.",
    "Source glyphs may already be locally erased in the first image. Those pale cleanup marks are intentional blank lettering space, not missing artwork or a request to redraw the container.",
    "Never create a new speech bubble, caption box, white rectangle, plaque, label background, or solid covering shape. If a crop does not already contain the expected text container, leave that tile unchanged.",
    "If an existing white speech bubble, tag, plaque, or outlined text container is present, keep its exact silhouette, border, tail, interior color, heart, and decoration. Change lettering only.",
    SPEECH_BUBBLE_TAIL_PRESENCE_LOCK,
    "Use the complete local crop to understand the speech bubble, text container, nearby panel art, original lettering scale, and surrounding background.",
    "Neutral gray areas are intentionally redacted context. Keep them neutral gray and never reconstruct, interpret, or extend hidden content into them.",
    "Preserve every tile frame, blue identifier header, crop boundary, speech-bubble border, panel line, character, object, texture, and non-text pixel.",
    "Do not merge tiles or move content between tiles. Do not draw tile IDs into the comic crop.",
    "Ordinary Korean dialogue, captions, and narration must be horizontal left-to-right. Sound effects may retain an angled or decorative treatment when appropriate.",
    "The result must keep the exact 2048x2048 Atlas grid and return one edited Atlas image.",
    "",
    ...lines,
  ].join("\n");
}

async function requestPatchAtlasImage(
  atlasDataUrl,
  guideDataUrl,
  maskDataUrl,
  metadata,
  imageGenerationModel,
  useMask = true,
) {
  const reasoningEffort = reasoningEffortForModel(imageGenerationModel, AUTOMATIC_MODEL_PIPELINE.imageGeneration.reasoningEffort);
  const tool = {
    type: "image_generation",
    quality: IMAGE_GENERATION_QUALITY,
    size: PATCH_ATLAS_SIZE,
    moderation: IMAGE_GENERATION_MODERATION,
  };
  if (useMask) tool.input_image_mask = { image_url: maskDataUrl };

  const signal = IMAGE_GENERATION_TIMEOUT_MS > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)
    : undefined;
  const response = await fetchOAuth(
    "/v1/responses",
    {
      model: imageGenerationModel,
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text:
                "You are a precise comic-lettering image editor. The first image is a fixed Patch Atlas containing independent source crops. The second image is a placement and glyph guide. Edit all requested text patches in one image-generation call while preserving the Atlas geometry and all non-text pixels. The mask is a placement hint; never treat pixels outside it as editable. Do not invent speech bubbles, caption boxes, white rectangles, or other text backgrounds. " + SPEECH_BUBBLE_TAIL_PRESENCE_LOCK + " Return an image, not an explanation.",
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_image", image_url: atlasDataUrl },
            { type: "input_image", image_url: guideDataUrl },
            { type: "input_text", text: buildPatchAtlasRenderPrompt(metadata) },
          ],
        },
      ],
      tools: [tool],
      tool_choice: "required",
      reasoning: { effort: reasoningEffort },
      stream: true,
    },
    { accept: "text/event-stream", signal },
  );

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const parsed = await response.json();
    const { imageB64 } = extractImageFromResponseJson(parsed);
    if (!imageB64) throw new Error("Patch Atlas generation completed without image output.");
    return Buffer.from(imageB64, "base64");
  }

  const streamResult = await readImageGenerationStream(response);
  if (!streamResult.imageB64) {
    const summary = summarizeEventTypes(streamResult.eventTypes);
    const textHint = streamResult.textOutput
      ? `, text=${streamResult.textOutput.replace(/\s+/g, " ").slice(0, 240)}`
      : "";
    const imageStatusHint = streamResult.imageCallStatuses.length
      ? `, imageCallStatus=${[...new Set(streamResult.imageCallStatuses)].join(",")}`
      : "";
    const error = new Error(
      `Patch Atlas generation completed without image output. events=${streamResult.eventCount}, types=${summary.eventTypes || "none"}${imageStatusHint}${textHint}`,
    );
    error.textOutput = streamResult.textOutput;
    throw error;
  }
  return Buffer.from(streamResult.imageB64, "base64");
}

async function runPatchAtlasImageTranslation(
  atlasDataUrl,
  guideDataUrl,
  maskDataUrl,
  metadata,
  imageGenerationModel,
) {
  let lastError = null;
  let maskSupported = true;
  for (let attempt = 0; attempt <= MODEL_STAGE_MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[patch-atlas-generation] model=${imageGenerationModel} tiles=${metadata.tiles.length} size=${PATCH_ATLAS_SIZE} mask=${maskSupported ? "on" : "off"} quality=${IMAGE_GENERATION_QUALITY} moderation=${IMAGE_GENERATION_MODERATION}`,
      );
      return await requestPatchAtlasImage(
        atlasDataUrl,
        guideDataUrl,
        maskDataUrl,
        metadata,
        imageGenerationModel,
        maskSupported,
      );
    } catch (error) {
      lastError = error;
      const message = `${String(error?.message || "")}\n${String(error?.body || "")}`;
      if (maskSupported && /input_image_mask|unknown parameter|unsupported parameter|invalid parameter/i.test(message)) {
        maskSupported = false;
        console.warn("[patch-atlas-generation] image mask unsupported by current OAuth route; retrying with local hard-mask compositing only");
        continue;
      }
      if (isNonRetryableGenerationError(error) || !isTransientModelError(error) || attempt === MODEL_STAGE_MAX_RETRIES) break;
      const waitMs = modelRetryDelayMs(error, attempt, 1250);
      console.warn(`[stage-retry] model=${imageGenerationModel} schema=patch-atlas-generation retry=${attempt + 1}/${MODEL_STAGE_MAX_RETRIES} waitMs=${waitMs}`);
      await delay(waitMs);
    }
  }
  throw lastError || new Error("Patch Atlas image generation failed.");
}

async function generatePatchAtlasPage({
  sourceBuffer,
  translationData,
  preset,
  imageGenerationModel,
  localizationModel = DEFAULT_OPENAI_OCR_MODEL,
  artifactPrefix,
}) {
  if (!existsSync(PATCH_ATLAS_MODEL)) {
    throw new Error("Patch Atlas detector model is missing. Check models/comic-text-bubble-detector-int8.onnx.");
  }
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workDir = join(TMP_DIR, `patch-atlas-${unique}`);
  const sourcePath = join(workDir, "source.png");
  const translationsPath = join(workDir, "translations.json");
  const generatedAtlasPath = join(workDir, "generated-atlas.png");
  const compositePath = join(workDir, "composite.png");
  await mkdir(workDir, { recursive: true });
  await writeFile(sourcePath, sourceBuffer);
  let activeTranslationData = translationData;
  let localizationCandidateBuffer = null;
  const locationItems = translationData?.reading_order || translationData?.blocks || [];
  if (locationItems.some((item) => item?.region_locator !== "gpt_candidates_v1")) {
    try {
      const candidateResult = await runPythonHelper([
        PATCH_ATLAS_SCRIPT,
        "candidates",
        "--image",
        sourcePath,
        "--model",
        PATCH_ATLAS_MODEL,
        "--output-dir",
        workDir,
      ]);
      const candidateInfo = parseLastJsonLine(candidateResult.stdout);
      const [candidateSheetBuffer, candidateMetadataText] = await Promise.all([
        readFile(candidateInfo.sheet),
        readFile(candidateInfo.metadata, "utf8"),
      ]);
      localizationCandidateBuffer = candidateSheetBuffer;
      activeTranslationData = await runPatchAtlasGptLocalization(
        sourceBuffer,
        candidateSheetBuffer,
        JSON.parse(candidateMetadataText),
        translationData,
        preset,
        localizationModel,
      );
      const activeItems = activeTranslationData?.reading_order || activeTranslationData?.blocks || [];
      locationItems.forEach((item, index) => Object.assign(item, activeItems[index] || {}));
    } catch (error) {
      console.warn(`[patch-atlas-localization] GPT localization failed; using local fallback: ${error.message || error}`);
    }
  }
  await writeFile(translationsPath, JSON.stringify(activeTranslationData, null, 2), "utf8");

  try {
    const buildResult = await runPythonHelper([
      PATCH_ATLAS_SCRIPT,
      "build",
      "--image",
      sourcePath,
      "--translations",
      translationsPath,
      "--model",
      PATCH_ATLAS_MODEL,
      "--preset",
      preset.id,
      "--output-dir",
      workDir,
    ]);
    const buildInfo = parseLastJsonLine(buildResult.stdout);
    const [atlasBuffer, guideBuffer, maskBuffer, eraseMaskBuffer, metadataText] = await Promise.all([
      readFile(buildInfo.atlas),
      readFile(buildInfo.guide),
      readFile(buildInfo.mask),
      readFile(buildInfo.erase_mask),
      readFile(buildInfo.metadata, "utf8"),
    ]);
    const metadata = JSON.parse(metadataText);
    const generatedAtlas = await runPatchAtlasImageTranslation(
      `data:image/png;base64,${atlasBuffer.toString("base64")}`,
      `data:image/png;base64,${guideBuffer.toString("base64")}`,
      `data:image/png;base64,${maskBuffer.toString("base64")}`,
      metadata,
      imageGenerationModel,
    );
    await writeFile(generatedAtlasPath, generatedAtlas);
    const compositeResult = await runPythonHelper([
      PATCH_ATLAS_SCRIPT,
      "composite",
      "--image",
      sourcePath,
      "--atlas-input",
      buildInfo.atlas,
      "--erase-mask",
      buildInfo.erase_mask,
      "--generated",
      generatedAtlasPath,
      "--metadata",
      buildInfo.metadata,
      "--output",
      compositePath,
    ]);
    const compositeInfo = parseLastJsonLine(compositeResult.stdout);
    const persistedBase = join(RESTORE_SOURCE_DIR, `${artifactPrefix}-patch-atlas`);
    const artifactPaths = {
      source: `${persistedBase}-input.png`,
      guide: `${persistedBase}-guide.png`,
      generated: `${persistedBase}-generated.png`,
      eraseMask: `${persistedBase}-erase-mask.png`,
      metadata: `${persistedBase}-metadata.json`,
      localizationCandidates: localizationCandidateBuffer ? `${persistedBase}-localization-candidates.png` : null,
    };
    const artifactWrites = [
      writeFile(artifactPaths.source, atlasBuffer),
      writeFile(artifactPaths.guide, guideBuffer),
      writeFile(artifactPaths.generated, generatedAtlas),
      writeFile(artifactPaths.eraseMask, eraseMaskBuffer),
      writeFile(artifactPaths.metadata, metadataText, "utf8"),
    ];
    if (localizationCandidateBuffer) {
      artifactWrites.push(writeFile(artifactPaths.localizationCandidates, localizationCandidateBuffer));
    }
    await Promise.all(artifactWrites);
    console.log(
      `[patch-atlas] tiles=${metadata.tiles.length} rejected=${buildInfo.rejected_region_count || 0} detectorText=${buildInfo.detector_text_count} detectorEffects=${buildInfo.detector_effect_count || 0} bubbles=${buildInfo.detector_bubble_count} easyocrFallback=${buildInfo.easyocr_fallback_count} changed=${compositeInfo.changed_pixels}px`,
    );
    return {
      buffer: await readFile(compositePath),
      artifactPaths,
      tileCount: metadata.tiles.length,
      rejectedRegionCount: buildInfo.rejected_region_count || 0,
      changedPixels: compositeInfo.changed_pixels,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function postprocessOutputBuffer(buffer, target, finalTarget) {
  if (target?.aspectPaddedGeneration) {
    return cropAspectPaddedGeneration(buffer, target);
  }
  if (target?.cropRect) {
    return cropPaddedGenerationWithPython(buffer, target);
  }
  return resizeGeneratedToFinalTarget(buffer, target, finalTarget);
}

function resolveFinalOutputName(originalName) {
  const safeOriginalName = basename(String(originalName || "result.png").trim()) || "result.png";
  const originalExt = extname(safeOriginalName);
  const normalizedExt = originalExt.toLowerCase();
  if ([".png", ".jpg", ".jpeg"].includes(normalizedExt)) return safeOriginalName;
  return `${basename(safeOriginalName, originalExt) || "result"}.jpg`;
}

async function saveOutputs(
  originalName,
  generatedBuffer,
  target,
  originalBuffer,
  restorationSourceBuffer,
  protectionRegions = [],
  unrestoredGeneratedBuffer = generatedBuffer,
) {
  const outputName = resolveFinalOutputName(originalName);
  const outputExt = extname(outputName).toLowerCase();
  const tmpPath = join(OUTPUT_DIR, outputName);
  const downloadPath = join(DOWNLOADS_DIR, outputName);
  const finalTarget = {
    width: target.finalWidth || target.width,
    height: target.finalHeight || target.height,
  };
  const [croppedBuffer, restorationReferenceBuffer, unrestoredBuffer] = await Promise.all([
    postprocessOutputBuffer(generatedBuffer, target, finalTarget),
    restorationSourceBuffer
      ? postprocessOutputBuffer(restorationSourceBuffer, target, finalTarget)
      : Promise.resolve(originalBuffer),
    postprocessOutputBuffer(unrestoredGeneratedBuffer, target, finalTarget),
  ]);
  const protectionSpec = target?.cropRect
    ? normalizeProtectionSpec(protectionRegions)
    : mapProtectionToGenerationSpace(protectionRegions, target);
  const restoreTarget = {
    ...finalTarget,
    preserveSourceAspect: false,
    finalResizeBackground: target.finalResizeBackground,
  };
  if (hasProtectionShapes(protectionSpec)) {
    console.log(
      `[protection-restore] reference=${restorationSourceBuffer ? "preprocessed-source" : "original-fallback"} generation=${target.width}x${target.height} final=${finalTarget.width}x${finalTarget.height}`,
    );
  }
  const outputBuffer =
    restorationReferenceBuffer && hasProtectionShapes(protectionSpec)
      ? await restoreProtectedRegions(croppedBuffer, restorationReferenceBuffer, restoreTarget, protectionSpec)
      : croppedBuffer;

  let pipeline = sharp(outputBuffer)
    .toColourspace("srgb")
    .flatten({ background: "#ffffff" })
    .rotate();
  if (outputExt === ".png") {
    pipeline = pipeline.png();
  } else {
    pipeline = pipeline.jpeg(OUTPUT_JPEG_OPTIONS);
  }

  const rendered = await pipeline.toBuffer();
  await writeFile(tmpPath, rendered);
  await writeFile(downloadPath, rendered);

  return {
    outputName,
    tmpPath,
    downloadPath,
    publicUrl: `/output/${encodeURIComponent(outputName)}`,
    unrestoredBuffer,
  };
}

function isGifUpload(file) {
  const mimeType = (file.mimetype || "").toLowerCase();
  const ext = extname(file.originalname || "").toLowerCase();
  return mimeType === "image/gif" || ext === ".gif";
}

async function normalizeUploadedFile(file, index) {
  if (!isGifUpload(file)) {
    return file;
  }

  const originalName = file.originalname || `image-${index + 1}.gif`;
  const base = basename(originalName, extname(originalName) || ".gif");
  const buffer = await sharp(file.buffer, { animated: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 95 })
    .toBuffer();

  return {
    ...file,
    buffer,
    originalname: `${base}.jpg`,
    mimetype: "image/jpeg",
  };
}

async function normalizeUploadedFiles(files) {
  const imageFiles = (files || []).filter((file) => (file.mimetype || "").startsWith("image/"));
  return Promise.all(imageFiles.map((file, index) => normalizeUploadedFile(file, index)));
}

function parseSplitPageFlags(rawValue, fileCount) {
  try {
    const parsed = JSON.parse(typeof rawValue === "string" ? rawValue : "[]");
    return Array.from({ length: fileCount }, (_, index) => parsed[index] === true);
  } catch {
    return Array.from({ length: fileCount }, () => false);
  }
}

function protectionSpecForSplitHalf(protection, side) {
  const spec = normalizeProtectionSpec(protection);
  const start = side === "right" ? 0.5 : 0;
  const end = side === "right" ? 1 : 0.5;
  const regions = spec.regions.map((region) => {
    const left = Math.max(start, Number(region.x) || 0);
    const right = Math.min(end, (Number(region.x) || 0) + (Number(region.width) || 0));
    if (right <= left) return null;
    return {
      x: (left - start) * 2,
      y: region.y,
      width: (right - left) * 2,
      height: region.height,
    };
  }).filter(Boolean);
  const strokes = spec.strokes.map((stroke) => {
    const points = (stroke.points || [])
      .filter((point) => point.x >= start && point.x <= end)
      .map((point) => ({ x: (point.x - start) * 2, y: point.y }));
    return points.length ? { radius: Math.min(0.08, stroke.radius * 2), points } : null;
  }).filter(Boolean);
  return { regions, strokes, invert: false };
}

async function expandSplitPageUploads(uploadedFiles, protectionMasks, splitFlags) {
  const expanded = [];
  for (let index = 0; index < uploadedFiles.length; index++) {
    const file = uploadedFiles[index];
    if (!splitFlags[index]) {
      expanded.push({ file, protectionRegions: protectionMasks[index], split: null });
      continue;
    }
    const meta = await sharp(file.buffer).metadata();
    if (!meta.width || !meta.height || meta.width < 32) {
      expanded.push({ file, protectionRegions: protectionMasks[index], split: null });
      continue;
    }
    const leftWidth = Math.floor(meta.width / 2);
    const rightWidth = meta.width - leftWidth;
    const extension = extname(file.originalname || "") || ".png";
    const stem = basename(file.originalname || `image-${index + 1}`, extension);
    const groupId = `split-${index + 1}-${Date.now()}`;
    const common = { groupId, originalName: file.originalname, sourceWidth: meta.width, sourceHeight: meta.height };
    const [leftBuffer, rightBuffer] = await Promise.all([
      sharp(file.buffer).extract({ left: 0, top: 0, width: leftWidth, height: meta.height }).toBuffer(),
      sharp(file.buffer).extract({ left: leftWidth, top: 0, width: rightWidth, height: meta.height }).toBuffer(),
    ]);
    expanded.push({
      file: { ...file, buffer: leftBuffer, originalname: `${stem}.__split_left${extension}` },
      protectionRegions: protectionSpecForSplitHalf(protectionMasks[index], "left"),
      split: { ...common, side: "left", hidden: false },
    });
    expanded.push({
      file: { ...file, buffer: rightBuffer, originalname: `${stem}.__split_right${extension}` },
      protectionRegions: protectionSpecForSplitHalf(protectionMasks[index], "right"),
      split: { ...common, side: "right", hidden: true },
    });
  }
  return expanded;
}

function makeBatchSnapshot(batch) {
  return {
    id: batch.id,
    status: batch.status,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt || null,
    modelPipeline: batch.modelPipeline || null,
    imageGenerationModel: batch.imageGenerationModel || null,
    ocrEngine: batch.ocrEngine || null,
    ocrModel: batch.ocrModel || null,
    generationMode: batch.generationMode || "page",
    analysisConcurrency: batch.analysisConcurrency || ANALYSIS_CONCURRENCY,
    imageGenerationConcurrency: batch.imageGenerationConcurrency || IMAGE_GENERATION_CONCURRENCY,
    modelConcurrencyLimit: MODEL_CONCURRENCY_LIMIT,
    comicRenderContractVersion: COMIC_RENDER_CONTRACT_VERSION,
    items: batch.items.filter((item) => item.splitHidden !== true).map((item) => ({
      id: item.id,
      originalName: item.splitOriginalName || item.originalName,
      splitPage: Boolean(item.splitGroupId),
      presetId: item.presetId,
      status: item.status,
      phaseLabel: item.phaseLabel,
      progress: item.progress,
      outputPath: item.outputPath || null,
      previewUrl: item.previewUrl || null,
      manualOutputPath: item.manualOutputPath || null,
      manualPreviewUrl: item.manualPreviewUrl || null,
      manualEditStrokes: normalizeManualRestoreStrokes(item.manualEditStrokes),
      currentPromptOutputPath: item.currentPromptOutputPath || null,
      currentPromptPreviewUrl: item.currentPromptPreviewUrl || null,
      currentPromptUnrestoredPath: item.currentPromptUnrestoredPath || null,
      patchAtlasTileCount: item.patchAtlasTileCount || 0,
      patchAtlasRejectedRegionCount: item.patchAtlasRejectedRegionCount || 0,
      patchAtlasChangedPixels: item.patchAtlasChangedPixels || 0,
      patchAtlasRetryReady: Boolean(
        item.translation
        && item.targetSize
        && item.restorationSourcePath
        && existsSync(item.restorationSourcePath)
        && isComicLikePreset(getPreset(item.presetId))
      ),
      manualEditReady: Boolean(
        item.restorationSourcePath
        && item.unrestoredGeneratedPath
        && existsSync(item.restorationSourcePath)
        && existsSync(item.unrestoredGeneratedPath)
      ),
      protectionEditReady: Boolean(
        item.targetSize
        && item.restorationSourcePath
        && existsSync(item.restorationSourcePath)
      ),
      generationRetryReady: Boolean(
        item.targetSize
        && item.restorationSourcePath
        && existsSync(item.restorationSourcePath)
      ),
      translationEditReady: Boolean(
        item.translation
        && (
          Array.isArray(item.translation.reading_order)
          || Array.isArray(item.translation.blocks)
        )
      ),
      error: item.error || null,
      targetSize: item.targetSize || null,
      translation: item.translation || null,
      protectionRegions: normalizeProtectionSpec(item.protectionRegions),
      protectionRegionCount: normalizeProtectionSpec(item.protectionRegions).regions.length + normalizeProtectionSpec(item.protectionRegions).strokes.length,
      protectionInvert: normalizeProtectionSpec(item.protectionRegions).invert,
      protectionEditedAt: item.protectionEditedAt || null,
      protectionChangedSinceTranslation: item.protectionChangedSinceTranslation === true,
      translationEditedAt: item.translationEditedAt || null,
      translationEditCount: item.translationEditCount || 0,
      translationPendingRegeneration: item.translationPendingRegeneration === true,
      generationAdditionalRequest: normalizeGenerationAdditionalRequest(item.generationAdditionalRequest),
      generationAdditionalRequestAt: item.generationAdditionalRequestAt || null,
      generationAdditionalRequestCount: item.generationAdditionalRequestCount || 0,
      retryCount: item.retryCount || 0,
      retryStartedAt: item.retryStartedAt || null,
      retryCompletedAt: item.retryCompletedAt || null,
    })),
  };
}

function serializeBatchState(batch) {
  return {
    id: batch.id,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt || Date.now(),
    completedAt: batch.completedAt || null,
    modelPipeline: batch.modelPipeline || null,
    imageGenerationModel: batch.imageGenerationModel || null,
    ocrEngine: batch.ocrEngine || null,
    ocrModel: batch.ocrModel || null,
    generationMode: batch.generationMode || "page",
    analysisConcurrency: batch.analysisConcurrency || ANALYSIS_CONCURRENCY,
    imageGenerationConcurrency: batch.imageGenerationConcurrency || IMAGE_GENERATION_CONCURRENCY,
    modelConcurrencyLimit: MODEL_CONCURRENCY_LIMIT,
    comicRenderContractVersion: COMIC_RENDER_CONTRACT_VERSION,
    dictionaryText: batch.dictionaryText || "",
    items: batch.items.map((item) => ({
      id: item.id,
      originalName: item.originalName,
      presetId: item.presetId,
      status: item.status,
      phaseLabel: item.phaseLabel,
      progress: item.progress,
      buffer: null,
      outputPath: item.outputPath || null,
      previewUrl: item.previewUrl || null,
      manualOutputPath: item.manualOutputPath || null,
      manualPreviewUrl: item.manualPreviewUrl || null,
      manualEditBasePath: item.manualEditBasePath || item.outputPath || null,
      manualEditStrokes: normalizeManualRestoreStrokes(item.manualEditStrokes),
      currentPromptOutputPath: item.currentPromptOutputPath || null,
      currentPromptPreviewUrl: item.currentPromptPreviewUrl || null,
      currentPromptUnrestoredPath: item.currentPromptUnrestoredPath || null,
      patchAtlasTileCount: item.patchAtlasTileCount || 0,
      patchAtlasRejectedRegionCount: item.patchAtlasRejectedRegionCount || 0,
      patchAtlasChangedPixels: item.patchAtlasChangedPixels || 0,
      patchAtlasSourcePath: item.patchAtlasSourcePath || null,
      patchAtlasGuidePath: item.patchAtlasGuidePath || null,
      patchAtlasGeneratedPath: item.patchAtlasGeneratedPath || null,
      patchAtlasMetadataPath: item.patchAtlasMetadataPath || null,
      restorationSourcePath: item.restorationSourcePath || null,
      unrestoredGeneratedPath: item.unrestoredGeneratedPath || null,
      error: item.error || null,
      targetSize: item.targetSize || null,
      translation: item.translation || null,
      protectionRegions: normalizeProtectionSpec(item.protectionRegions),
      protectionEditedAt: item.protectionEditedAt || null,
      protectionChangedSinceTranslation: item.protectionChangedSinceTranslation === true,
      translationEditedAt: item.translationEditedAt || null,
      translationEditCount: item.translationEditCount || 0,
      translationPendingRegeneration: item.translationPendingRegeneration === true,
      generationAdditionalRequest: normalizeGenerationAdditionalRequest(item.generationAdditionalRequest),
      generationAdditionalRequestAt: item.generationAdditionalRequestAt || null,
      generationAdditionalRequestCount: item.generationAdditionalRequestCount || 0,
      retryCount: item.retryCount || 0,
      retryStartedAt: item.retryStartedAt || null,
      retryCompletedAt: item.retryCompletedAt || null,
      splitGroupId: item.splitGroupId || null,
      splitSide: item.splitSide || null,
      splitHidden: item.splitHidden === true,
      splitOriginalName: item.splitOriginalName || null,
      splitSourceWidth: item.splitSourceWidth || null,
      splitSourceHeight: item.splitSourceHeight || null,
    })),
  };
}

async function persistBatchState(batch) {
  if (!batch?.id) return;
  await mkdir(BATCH_STATE_DIR, { recursive: true });
  const statePath = join(BATCH_STATE_DIR, `${batch.id}.json`);
  await writeFile(statePath, JSON.stringify(serializeBatchState(batch), null, 2), "utf8");
}

async function loadPersistedBatchStates() {
  let entries = [];
  try {
    entries = await readdir(BATCH_STATE_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const state = JSON.parse(await readFile(join(BATCH_STATE_DIR, entry.name), "utf8"));
      if (!state?.id || !Array.isArray(state.items)) continue;
      state.generationMode = ["painted_mask", "protected_mask", "page"].includes(state.generationMode)
        ? state.generationMode
        : "page";
      let interrupted = false;
      state.items = state.items.map((item) => ({
        ...item,
        ...(item.status === "running" || (state.status === "running" && item.status === "queued")
          ? {
            status: "failed",
            phaseLabel: "서버 재시작으로 중단됨",
            progress: Math.max(0, Math.min(100, Number(item.progress || 0))),
            error: "서버가 처리 도중 재시작되어 중단되었습니다. 저장된 영역을 확인한 뒤 이미지 생성 재실행을 눌러 주세요.",
          }
          : {}),
        buffer: null,
        manualEditBasePath: item.manualEditBasePath || item.outputPath || null,
        manualEditStrokes: normalizeManualRestoreStrokes(item.manualEditStrokes),
        protectionRegions: normalizeProtectionSpec(item.protectionRegions),
        protectionChangedSinceTranslation: false,
        generationAdditionalRequest: normalizeGenerationAdditionalRequest(item.generationAdditionalRequest),
      }));
      interrupted = state.items.some((item) => item.phaseLabel === "서버 재시작으로 중단됨");
      if (interrupted) {
        state.status = state.items.some((item) => item.status === "completed") ? "completed_with_errors" : "failed";
        state.completedAt = Date.now();
        state.updatedAt = Date.now();
      }
      batches.set(state.id, state);
      if (interrupted) await persistBatchState(state);
    } catch (error) {
      console.warn(`[batch-state] skipped ${entry.name}: ${error.message}`);
    }
  }
  if (batches.size) console.log(`[batch-state] restored ${batches.size} batch(es)`);
}

function updateItemPhase(batch, item, status, phaseLabel, progress) {
  item.status = status;
  item.phaseLabel = phaseLabel;
  item.progress = progress;
  batch.updatedAt = Date.now();
}

async function finalizeSplitPageOutputs(batch) {
  const groupIds = [...new Set(batch.items.map((item) => item.splitGroupId).filter(Boolean))];
  for (const groupId of groupIds) {
    const parts = batch.items.filter((item) => item.splitGroupId === groupId);
    const left = parts.find((item) => item.splitSide === "left");
    const right = parts.find((item) => item.splitSide === "right");
    if (!left || !right) continue;
    if (left.status === "failed" || right.status === "failed" || !left.outputPath || !right.outputPath) {
      left.status = "failed";
      left.phaseLabel = "좌우 분할 처리 실패";
      left.error = left.error || right.error || "분할된 양쪽 결과를 모두 생성하지 못했습니다.";
      continue;
    }
    updateItemPhase(batch, left, "running", "좌우 결과 합성 중", 97);
    const [leftMeta, rightMeta] = await Promise.all([
      sharp(left.outputPath).metadata(),
      sharp(right.outputPath).metadata(),
    ]);
    const targetHeight = Math.max(leftMeta.height || 1, rightMeta.height || 1);
    const leftWidth = Math.round((leftMeta.width || 1) * targetHeight / (leftMeta.height || 1));
    const rightWidth = Math.round((rightMeta.width || 1) * targetHeight / (rightMeta.height || 1));
    const [leftBuffer, rightBuffer] = await Promise.all([
      sharp(left.outputPath).resize(leftWidth, targetHeight, { fit: "fill" }).png().toBuffer(),
      sharp(right.outputPath).resize(rightWidth, targetHeight, { fit: "fill" }).png().toBuffer(),
    ]);
    const merged = await sharp({
      create: { width: leftWidth + rightWidth, height: targetHeight, channels: 3, background: "#ffffff" },
    }).composite([
      { input: leftBuffer, left: 0, top: 0 },
      { input: rightBuffer, left: leftWidth, top: 0 },
    ]).png().toBuffer();
    const outputName = resolveFinalOutputName(left.splitOriginalName || left.originalName);
    const outputExt = extname(outputName).toLowerCase();
    let outputPipeline = sharp(merged).toColourspace("srgb").flatten({ background: "#ffffff" });
    outputPipeline = outputExt === ".png" ? outputPipeline.png() : outputPipeline.jpeg(OUTPUT_JPEG_OPTIONS);
    const rendered = await outputPipeline.toBuffer();
    const tmpPath = join(OUTPUT_DIR, outputName);
    const downloadPath = join(DOWNLOADS_DIR, outputName);
    await Promise.all([writeFile(tmpPath, rendered), writeFile(downloadPath, rendered)]);
    left.outputPath = downloadPath;
    left.previewUrl = `/output/${encodeURIComponent(outputName)}`;
    left.manualEditBasePath = downloadPath;
    left.targetSize = {
      width: leftWidth + rightWidth,
      height: targetHeight,
      finalWidth: leftWidth + rightWidth,
      finalHeight: targetHeight,
      size: `${leftWidth + rightWidth}x${targetHeight}`,
      resolutionTier: "split-merged",
    };
    left.error = null;
    updateItemPhase(batch, left, "completed", "좌우 분할 번역·합성 완료", 100);
    console.log(`[split-page] merged group=${groupId} left=${leftWidth}x${targetHeight} right=${rightWidth}x${targetHeight} output=${downloadPath}`);
  }
}

async function processBatch(batch) {
  batch.status = "running";
  const dictionaryLines = normalizeDictionary(batch.dictionaryText);
  const analysisConcurrency = Math.max(1, Math.min(3, Number(batch.analysisConcurrency || ANALYSIS_CONCURRENCY)));
  const generationConcurrency = Math.max(1, Math.min(3, Number(batch.imageGenerationConcurrency || IMAGE_GENERATION_CONCURRENCY)));
  const generationQueue = [];
  const generationWaiters = [];
  let ocrFinished = false;

  function enqueueGeneration(job) {
    const waiter = generationWaiters.shift();
    if (waiter) {
      waiter(job);
      return;
    }
    generationQueue.push(job);
  }

  function finishGenerationQueue() {
    ocrFinished = true;
    while (generationWaiters.length) {
      generationWaiters.shift()(null);
    }
  }

  async function takeGenerationJob() {
    if (generationQueue.length) return generationQueue.shift();
    if (ocrFinished) return null;
    return new Promise((resolve) => generationWaiters.push(resolve));
  }

  async function runGenerationWorker() {
    while (true) {
      const job = await takeGenerationJob();
      if (!job) break;

      const {
        batch: currentBatch,
        item,
        sourceDataUrl,
        translation,
        target,
        preset,
        dictionaryLines,
        originalBuffer,
        restorationSourceBuffer,
        protectionRegions,
        generationProtectionRegions,
        editMaskDataUrl,
        paintedInputOnly,
      } = job;
      try {
        let generated = null;
        let lastGenerationError = null;

        for (let attempt = 0; attempt <= IMAGE_LONG_RETRY_COUNT; attempt++) {
          try {
            const phase =
              attempt === 0
                ? "이미지 생성 중"
                : `이미지 생성 재시도 중 (${attempt}/${IMAGE_LONG_RETRY_COUNT})`;
            updateItemPhase(currentBatch, item, "running", phase, attempt === 0 ? 70 : 72);
            generated = await runImageTranslation(
              sourceDataUrl,
              translation,
              target.size,
              preset,
              dictionaryLines,
              currentBatch.imageGenerationModel,
              editMaskDataUrl,
              paintedInputOnly,
              currentBatch.generationMode,
            );
            lastGenerationError = null;
            break;
          } catch (error) {
            lastGenerationError = error;
            if (attempt >= IMAGE_LONG_RETRY_COUNT || !isGenerationRetryableError(error)) {
              throw error;
            }
            updateItemPhase(currentBatch, item, "running", `이미지 생성 실패, ${Math.round(IMAGE_RETRY_DELAY_MS / 1000)}초 후 재시도`, 71);
            await delay(IMAGE_RETRY_DELAY_MS);
          }
        }

        if (!generated) {
          throw lastGenerationError || new Error("이미지 생성 중 오류가 발생했습니다.");
        }

        const rawGenerated = generated;
        const useSentinelChromaKey = hasProtectionShapes(generationProtectionRegions);
        if (useSentinelChromaKey) {
          updateItemPhase(currentBatch, item, "running", "회색 센티널을 투명 처리해 원본 위에 합성 중", 88);
          generated = await compositeGeneratedWithSentinelTransparency(
            generated,
            restorationSourceBuffer,
            target,
            generationProtectionRegions,
            { paintedInputOnly },
          );
        }

        updateItemPhase(currentBatch, item, "running", "다운로드 폴더에 저장 중", 92);
        const saved = await saveOutputs(
          item.originalName,
          generated,
          target,
          originalBuffer,
          restorationSourceBuffer,
          useSentinelChromaKey ? [] : protectionRegions,
          rawGenerated,
        );
        item.outputPath = saved.downloadPath;
        item.previewUrl = saved.publicUrl;
        item.manualEditBasePath = saved.downloadPath;
        item.unrestoredGeneratedPath = join(RESTORE_SOURCE_DIR, `${currentBatch.id}-${item.id}-unrestored.png`);
        await writeFile(item.unrestoredGeneratedPath, saved.unrestoredBuffer);
        item.error = null;
        item.translationPendingRegeneration = false;
        updateItemPhase(currentBatch, item, "completed", "완료", 100);
      } catch (error) {
        item.error = error.message || "이미지 생성 중 오류가 발생했습니다.";
        updateItemPhase(currentBatch, item, "failed", "실패", 100);
      }
    }
  }

  async function processAnalysisItem(item) {
    const tempSourcePath = join(TMP_DIR, `${Date.now()}-${item.id}-${item.originalName}`);
    try {
      const preset = getPreset(item.presetId);
      updateItemPhase(batch, item, "running", "전처리 중", 5);
      await writeFile(tempSourcePath, item.buffer);
      const sourceMeta = await sharp(item.buffer).metadata();
      if (!sourceMeta.width || !sourceMeta.height) {
        throw new Error("이미지 크기를 읽지 못했습니다.");
      }

      const target = normalizeTargetForPreset(sourceMeta.width, sourceMeta.height, preset);
      item.targetSize = target;
      const normalizedSource = await prepareSourceForModels(item.buffer, target);
      item.restorationSourcePath = join(RESTORE_SOURCE_DIR, `${batch.id}-${item.id}.png`);
      await writeFile(item.restorationSourcePath, normalizedSource);
      const protectionRegions = normalizeProtectionSpec(item.protectionRegions);
      const generationProtectionRegions = mapProtectionToGenerationSpace(protectionRegions, target);
      const usePaintedMask = batch.generationMode === "painted_mask";
      if (usePaintedMask && !hasProtectionShapes(generationProtectionRegions)) {
        throw new Error("직접 칠한 텍스트 영역이 없습니다. 텍스트 영역 편집에서 번역할 곳을 먼저 칠해 주세요.");
      }
      const sourceForModels = usePaintedMask
        ? await buildPaintedModelInput(normalizedSource, target, generationProtectionRegions)
        : await applyProtectionMask(normalizedSource, target, generationProtectionRegions);
      if (hasProtectionShapes(generationProtectionRegions)) {
        item.inputRedactionColor = PROTECTION_INPUT_REDACTION_COLOR;
      }
      if (usePaintedMask) {
        item.modelInputPath = join(RESTORE_SOURCE_DIR, `${batch.id}-${item.id}-painted-model-input.png`);
        await writeFile(item.modelInputPath, sourceForModels);
        console.log(`[painted-input] item=${item.id} edge=${PAINTED_INPUT_EDGE_PX}px toolMask=off localComposite=on saved=${item.modelInputPath}`);
      }
      const editMaskDataUrl = null;
      const sourceDataUrl = `data:image/png;base64,${sourceForModels.toString("base64")}`;

      let translation = null;
      if (preset.directImageTranslation) {
        updateItemPhase(batch, item, "running", "Terra 이미지 직접 번역 준비 중", 55);
        translation = {
          mode: "direct_image_translation",
          automation: {
            contract: "terra-direct-image-v1",
            pipeline: automaticPipelineSnapshot(),
            solPassCount: 0,
          },
        };
        item.translation = translation;
      } else {
        translation = await runAutomaticOcrTranslation(
          sourceDataUrl,
          preset,
          dictionaryLines,
          (phaseLabel, progress) => updateItemPhase(batch, item, "running", phaseLabel, progress),
        );
        item.translation = translation;
      }
      item.protectionChangedSinceTranslation = false;

      enqueueGeneration({
        batch,
        item,
        sourceDataUrl,
        translation,
        target,
        preset,
        dictionaryLines,
        originalBuffer: item.buffer,
        restorationSourceBuffer: normalizedSource,
        protectionRegions,
        generationProtectionRegions,
        editMaskDataUrl,
        paintedInputOnly: usePaintedMask,
      });
    } catch (error) {
      item.error = error.message || "처리 중 오류가 발생했습니다.";
      updateItemPhase(batch, item, "failed", "실패", 100);
    } finally {
      item.buffer = null;
      if (existsSync(tempSourcePath)) {
        await rm(tempSourcePath, { force: true }).catch(() => {});
      }
    }
  }

  let nextAnalysisIndex = 0;
  function takeAnalysisItem() {
    if (nextAnalysisIndex >= batch.items.length) return null;
    const item = batch.items[nextAnalysisIndex];
    nextAnalysisIndex++;
    return item;
  }

  async function runAnalysisWorker(workerIndex) {
    while (true) {
      const item = takeAnalysisItem();
      if (!item) break;
      console.log(`[analysis-worker] worker=${workerIndex + 1}/${analysisConcurrency} item=${item.id} file=${item.originalName}`);
      await processAnalysisItem(item);
    }
  }

  console.log(`[batch-concurrency] batch=${batch.id} analysis=${analysisConcurrency} generation=${generationConcurrency} globalModelLimit=${MODEL_CONCURRENCY_LIMIT}`);
  const generationWorkers = Array.from({ length: generationConcurrency }, () => runGenerationWorker());
  const analysisWorkers = Array.from({ length: Math.min(analysisConcurrency, batch.items.length) }, (_, index) => runAnalysisWorker(index));

  await Promise.all(analysisWorkers);

  finishGenerationQueue();
  await Promise.all(generationWorkers);

  await finalizeSplitPageOutputs(batch);

  batch.completedAt = Date.now();
  batch.status = batch.items.some((item) => item.status === "failed") ? "completed_with_errors" : "completed";
  await persistBatchState(batch);
}

function getBatchItem(batchId, itemId) {
  const batch = batches.get(batchId);
  if (!batch) return { batch: null, item: null };
  return { batch, item: batch.items.find((entry) => entry.id === itemId) || null };
}

function normalizeManualRestoreStrokes(value) {
  const strokes = Array.isArray(value) ? value.slice(0, 500) : [];
  let remainingPoints = 20000;
  return strokes
    .map((stroke) => {
      if (remainingPoints <= 0) return null;
      const radius = Math.max(0.001, Math.min(0.25, Number(stroke?.radius) || 0.01));
      const rawPoints = Array.isArray(stroke?.points) ? stroke.points.slice(0, remainingPoints) : [];
      const points = rawPoints
        .map((point) => ({
          x: Math.max(0, Math.min(1, Number(point?.x))),
          y: Math.max(0, Math.min(1, Number(point?.y))),
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      remainingPoints -= points.length;
      const mode = stroke?.mode === "generated" || stroke?.mode === "heal" ? stroke.mode : "original";
      return points.length ? { mode, radius, points } : null;
    })
    .filter(Boolean);
}

const EDITABLE_COMIC_CONTAINER_TYPES = new Set(["speech", "caption", "sign", "sound_effect", "narration", "other"]);
const EDITABLE_COMIC_TEXT_COLORS = new Set(["none", "red", "blue", "green", "purple", "pink", "yellow", "orange", "multicolor", "white_on_dark", "colored_on_dark", "other"]);

function normalizeGenerationAdditionalRequest(value, { required = false } = {}) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    const error = new Error("생성본 추가요청은 글자로 입력해 주세요.");
    error.isGenerationAdditionalRequestInputError = true;
    throw error;
  }
  const normalized = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (normalized.length > GENERATION_ADDITIONAL_REQUEST_MAX_LENGTH) {
    const error = new Error(`생성본 추가요청은 ${GENERATION_ADDITIONAL_REQUEST_MAX_LENGTH}자 이하로 입력해 주세요.`);
    error.isGenerationAdditionalRequestInputError = true;
    throw error;
  }
  if (required && !normalized) {
    const error = new Error("생성본에 반영할 추가요청을 입력해 주세요.");
    error.isGenerationAdditionalRequestInputError = true;
    throw error;
  }
  return normalized;
}

function normalizeEditableString(value, label, maxLength = 8000) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}이(가) 비어 있습니다.`);
  if (text.length > maxLength) throw new Error(`${label}이(가) 너무 깁니다.`);
  return text;
}

function sanitizeSubmittedProtectionSpec(value) {
  return parseProtectionMasks(JSON.stringify([{
    index: 0,
    regions: value?.regions,
    strokes: value?.strokes,
    invert: false,
  }]), 1)[0];
}

function normalizeManuallyEditedTranslation(existingTranslation, submittedTranslation, preset) {
  const editedAt = Date.now();
  if (isComicLikePreset(preset)) {
    const submittedItems = Array.isArray(submittedTranslation?.reading_order)
      ? submittedTranslation.reading_order.slice(0, 500)
      : [];
    if (!submittedItems.length) throw new Error("번역 항목이 하나 이상 필요합니다.");
    const readingOrder = submittedItems.map((submittedItem, index) => {
      const sourceText = normalizeEditableString(submittedItem?.source_text, `${index + 1}번 원문`);
      let translatedText = normalizeEditableString(submittedItem?.translated_text, `${index + 1}번 번역문`);
      const preserveOriginalLatin = preset.id === "manga_jp" && isLatinOnlyTextOccurrence(sourceText);
      if (preserveOriginalLatin) translatedText = sourceText;
      if (preset.id === "manga_jp" && !preservesLatinSegments(sourceText, translatedText)) {
        throw new Error(`${index + 1}번 항목의 영문 원문이 번역문에 그대로 보존되지 않았습니다.`);
      }
      const containerType = EDITABLE_COMIC_CONTAINER_TYPES.has(submittedItem?.container_type)
        ? submittedItem.container_type
        : "other";
      const textColorHint = EDITABLE_COMIC_TEXT_COLORS.has(submittedItem?.text_color_hint)
        ? submittedItem.text_color_hint
        : "none";
      const pageZone = COMIC_PAGE_ZONES.includes(submittedItem?.page_zone)
        ? submittedItem.page_zone
        : "middle-center";
      return {
        source_text: sourceText,
        translated_text: translatedText,
        container_type: containerType,
        text_color_hint: textColorHint,
        page_zone: pageZone,
        region: pageZoneToApproximateRegion(pageZone),
        ocr_confidence: "manual",
        translation_confidence: "manual",
        review_status: "manually_edited",
        review_reasons: [],
        review_resolution: "사용자가 분석데이터를 직접 수정함",
        changed_by_verification: true,
        preserve_original_latin: preserveOriginalLatin,
      };
    });
    return addComicPlacementMetadata({
      ...existingTranslation,
      reading_order: readingOrder,
      automation: {
        ...(existingTranslation?.automation || {}),
        manuallyEditedAt: editedAt,
        manualEditCount: Number(existingTranslation?.automation?.manualEditCount || 0) + 1,
      },
    });
  }

  const submittedBlocks = Array.isArray(submittedTranslation?.blocks)
    ? submittedTranslation.blocks.slice(0, 500)
    : [];
  if (!submittedBlocks.length) throw new Error("번역 블록이 하나 이상 필요합니다.");
  return {
    ...existingTranslation,
    blocks: submittedBlocks.map((block, index) => ({
      ...(existingTranslation?.blocks?.[index] || {}),
      ...block,
      text: normalizeEditableString(block?.text, `${index + 1}번 번역 블록`),
    })),
    automation: {
      ...(existingTranslation?.automation || {}),
      manuallyEditedAt: editedAt,
      manualEditCount: Number(existingTranslation?.automation?.manualEditCount || 0) + 1,
    },
  };
}

function refreshBatchStatusFromItems(batch) {
  if (batch.items.some((entry) => entry.status === "running" || entry.status === "queued")) {
    batch.status = "running";
    batch.completedAt = null;
    return;
  }
  batch.completedAt = Date.now();
  batch.status = batch.items.some((entry) => entry.status === "failed")
    ? "completed_with_errors"
    : "completed";
}

async function regenerateStoredBatchItem(batch, item) {
  const preset = getPreset(item.presetId);
  const dictionaryLines = normalizeDictionary(batch.dictionaryText);
  if (!item.targetSize || !item.restorationSourcePath || !existsSync(item.restorationSourcePath)) {
    throw new Error("재실행에 필요한 전처리 원본 또는 출력 크기 정보가 없습니다.");
  }
  const normalizedSource = await readFile(item.restorationSourcePath);
  const protectionRegions = normalizeProtectionSpec(item.protectionRegions);
  const generationProtectionRegions = mapProtectionToGenerationSpace(protectionRegions, item.targetSize);
  const usePaintedMask = batch.generationMode === "painted_mask";
  if (usePaintedMask && !hasProtectionShapes(generationProtectionRegions)) {
    throw new Error("번역할 텍스트 영역이 비어 있습니다. 영역 편집에서 글자를 먼저 칠해 주세요.");
  }
  const sourceForModels = usePaintedMask
    ? await buildPaintedModelInput(normalizedSource, item.targetSize, generationProtectionRegions)
    : await applyProtectionMask(normalizedSource, item.targetSize, generationProtectionRegions);
  const sourceDataUrl = `data:image/png;base64,${sourceForModels.toString("base64")}`;
  // 영역은 이미지 생성 입력/합성 범위만 바꾼다. 이미 확정된 OCR·번역 데이터가
  // 있으면 이를 재사용하고, 분석 결과 자체가 없을 때만 Sol 분석을 실행한다.
  const mustRerunAnalysis = !item.translation;
  item.protectionChangedSinceTranslation = false;

  if (mustRerunAnalysis) {
    if (preset.directImageTranslation) {
      item.translation = {
        mode: "direct_image_translation",
        automation: {
          contract: "terra-direct-image-v1",
          pipeline: automaticPipelineSnapshot(),
          solPassCount: 0,
        },
      };
    } else {
      item.translation = await runAutomaticOcrTranslation(
        sourceDataUrl,
        preset,
        dictionaryLines,
        (phaseLabel, progress) => updateItemPhase(batch, item, "running", `재실행 · ${phaseLabel}`, progress),
      );
    }
  }

  updateItemPhase(batch, item, "running", "재실행 · 이미지 생성 중", 70);
  let generated = await runImageTranslation(
    sourceDataUrl,
    item.translation,
    item.targetSize.size,
    preset,
    dictionaryLines,
    batch.imageGenerationModel || DEFAULT_IMAGE_GENERATION_MODEL,
    null,
    usePaintedMask,
    batch.generationMode,
    item.generationAdditionalRequest,
  );
  const rawGenerated = generated;
  const useSentinelChromaKey = hasProtectionShapes(generationProtectionRegions);
  if (useSentinelChromaKey) {
    updateItemPhase(batch, item, "running", "재실행 · 원본 보호영역 합성 중", 88);
    generated = await compositeGeneratedWithSentinelTransparency(
      generated,
      normalizedSource,
      item.targetSize,
      generationProtectionRegions,
      { paintedInputOnly: usePaintedMask },
    );
  }
  const saved = await saveOutputs(
    item.originalName,
    generated,
    item.targetSize,
    normalizedSource,
    normalizedSource,
    useSentinelChromaKey ? [] : protectionRegions,
    rawGenerated,
  );
  item.outputPath = saved.downloadPath;
  item.previewUrl = saved.publicUrl;
  item.manualEditBasePath = saved.downloadPath;
  item.unrestoredGeneratedPath = join(RESTORE_SOURCE_DIR, `${batch.id}-${item.id}-unrestored.png`);
  await writeFile(item.unrestoredGeneratedPath, saved.unrestoredBuffer);
  item.manualOutputPath = null;
  item.manualPreviewUrl = null;
  item.manualEditStrokes = [];
  item.currentPromptOutputPath = null;
  item.currentPromptPreviewUrl = null;
  item.currentPromptUnrestoredPath = null;
  item.translationPendingRegeneration = false;
  item.error = null;
  item.retryCompletedAt = Date.now();
  updateItemPhase(batch, item, "completed", "재실행 완료", 100);
  refreshBatchStatusFromItems(batch);
  await persistBatchState(batch);
}

async function buildManualRestorationReference(item) {
  if (!item?.restorationSourcePath || !existsSync(item.restorationSourcePath) || !item.targetSize) {
    throw new Error("원본 복구용 전처리 이미지를 찾을 수 없습니다. 이미지를 다시 번역해 주세요.");
  }
  const finalTarget = {
    width: item.targetSize.finalWidth || item.targetSize.width,
    height: item.targetSize.finalHeight || item.targetSize.height,
  };
  const sourceBuffer = await readFile(item.restorationSourcePath);
  return postprocessOutputBuffer(sourceBuffer, item.targetSize, finalTarget);
}

async function buildManualUnrestoredReference(item, width, height, overridePath = null) {
  const unrestoredPath = overridePath || item?.unrestoredGeneratedPath;
  if (!unrestoredPath || !existsSync(unrestoredPath)) {
    throw new Error("자동복구 전 생성본을 찾을 수 없습니다. 이미지를 다시 번역해 주세요.");
  }
  return sharp(await readFile(unrestoredPath))
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();
}

function buildManualEditOverlaySvg(target, originalBuffer, unrestoredBuffer, strokes) {
  const layerStrokes = strokes.filter((stroke) => stroke.mode !== "heal");
  const clips = layerStrokes
    .map((stroke, index) => {
      const shape = protectionStrokeToSvg(stroke, target, 0, { fill: "#fff" });
      return `<clipPath id="manual-stroke-${index}" clipPathUnits="userSpaceOnUse">${shape}</clipPath>`;
    })
    .join("");
  const layers = layerStrokes
    .map((stroke, index) => {
      const sourceId = stroke.mode === "generated" ? "manual-unrestored" : "manual-original";
      return `<use href="#${sourceId}" clip-path="url(#manual-stroke-${index})"/>`;
    })
    .join("");
  const originalData = originalBuffer.toString("base64");
  const unrestoredData = unrestoredBuffer.toString("base64");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${target.width}" height="${target.height}">`
      + `<defs><image id="manual-original" width="${target.width}" height="${target.height}" preserveAspectRatio="none" href="data:image/png;base64,${originalData}"/>`
      + `<image id="manual-unrestored" width="${target.width}" height="${target.height}" preserveAspectRatio="none" href="data:image/png;base64,${unrestoredData}"/>${clips}</defs>`
      + `${layers}</svg>`,
  );
}

app.get("/api/translate-batch/:batchId/:itemId/restore-source", async (req, res) => {
  try {
    const { item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });
    const sourceBuffer = await buildManualRestorationReference(item);
    res.setHeader("Cache-Control", "no-store");
    res.type("png").send(sourceBuffer);
  } catch (error) {
    res.status(400).json({ error: error.message || "원본 복구 이미지를 준비하지 못했습니다." });
  }
});

app.get("/api/translate-batch/:batchId/:itemId/edit-base-source", async (req, res) => {
  try {
    const { item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });
    const basePath = item.manualEditBasePath || item.outputPath;
    if (!basePath || !existsSync(basePath) || !item.targetSize) {
      throw new Error("편집 기준 생성본을 찾을 수 없습니다.");
    }
    const width = item.targetSize.finalWidth || item.targetSize.width;
    const height = item.targetSize.finalHeight || item.targetSize.height;
    const sourceBuffer = await sharp(await readFile(basePath))
      .resize(width, height, { fit: "fill" })
      .png()
      .toBuffer();
    res.setHeader("Cache-Control", "no-store");
    res.type("png").send(sourceBuffer);
  } catch (error) {
    res.status(400).json({ error: error.message || "편집 기준 생성본을 준비하지 못했습니다." });
  }
});

app.get("/api/translate-batch/:batchId/:itemId/unrestored-source", async (req, res) => {
  try {
    const { item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });
    const originalReference = await buildManualRestorationReference(item);
    const meta = await sharp(originalReference).metadata();
    if (!meta.width || !meta.height) throw new Error("편집용 이미지의 크기를 읽지 못했습니다.");
    const sourceBuffer = await buildManualUnrestoredReference(item, meta.width, meta.height);
    res.setHeader("Cache-Control", "no-store");
    res.type("png").send(sourceBuffer);
  } catch (error) {
    res.status(400).json({ error: error.message || "자동복구 전 생성본을 준비하지 못했습니다." });
  }
});

app.put("/api/translate-batch/:batchId/:itemId/protection-regions", async (req, res) => {
  try {
    const { batch, item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!batch || !item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });
    if (item.status === "running") {
      return res.status(409).json({ error: "현재 처리 중인 항목의 영역은 수정할 수 없습니다." });
    }
    if (!item.targetSize || !item.restorationSourcePath || !existsSync(item.restorationSourcePath)) {
      return res.status(400).json({ error: "영역 편집에 필요한 전처리 원본이 없습니다." });
    }
    const previousProtectionRegions = normalizeProtectionSpec(item.protectionRegions);
    const nextProtectionRegions = sanitizeSubmittedProtectionSpec(req.body?.protectionRegions || req.body);
    const protectionChanged = JSON.stringify(previousProtectionRegions) !== JSON.stringify(nextProtectionRegions);
    item.protectionRegions = nextProtectionRegions;
    item.protectionEditedAt = Date.now();
    item.protectionChangedSinceTranslation = false;
    batch.updatedAt = Date.now();
    await persistBatchState(batch);
    res.json({ ok: true, changed: protectionChanged, batch: makeBatchSnapshot(batch) });
  } catch (error) {
    console.error(`[protection-edit] save failed: ${error.stack || error.message || error}`);
    res.status(400).json({ error: error.message || "보호영역을 저장하지 못했습니다." });
  }
});

app.put("/api/translate-batch/:batchId/:itemId/translation", async (req, res) => {
  try {
    const { batch, item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!batch || !item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });
    if (item.status === "running") {
      return res.status(409).json({ error: "현재 처리 중인 항목의 번역은 수정할 수 없습니다." });
    }
    if (!item.translation) {
      return res.status(400).json({ error: "수정할 분석데이터가 없습니다. 먼저 실패 항목을 재실행해 주세요." });
    }
    const preset = getPreset(item.presetId);
    item.translation = normalizeManuallyEditedTranslation(
      item.translation,
      req.body?.translation || req.body,
      preset,
    );
    item.translationEditedAt = Date.now();
    item.translationEditCount = Number(item.translationEditCount || 0) + 1;
    item.translationPendingRegeneration = true;
    item.protectionChangedSinceTranslation = false;
    batch.updatedAt = Date.now();
    await persistBatchState(batch);
    console.log(`[translation-edit] saved batch=${batch.id} item=${item.id} count=${item.translationEditCount}`);
    res.json({ ok: true, batch: makeBatchSnapshot(batch) });
  } catch (error) {
    console.error(`[translation-edit] save failed: ${error.stack || error.message || error}`);
    res.status(400).json({ error: error.message || "번역 분석데이터를 저장하지 못했습니다." });
  }
});

app.post("/api/translate-batch/:batchId/:itemId/retry-generation", async (req, res) => {
  try {
    const { batch, item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!batch || !item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });
    if (item.status === "running") {
      return res.status(409).json({ error: "이미 재실행 중입니다." });
    }
    if (!item.targetSize || !item.restorationSourcePath || !existsSync(item.restorationSourcePath)) {
      return res.status(400).json({ error: "재실행에 필요한 전처리 원본이 없습니다." });
    }
    item.error = null;
    item.retryCount = Number(item.retryCount || 0) + 1;
    item.retryStartedAt = Date.now();
    item.retryCompletedAt = null;
    updateItemPhase(batch, item, "running", item.translation
      ? "저장된 번역으로 이미지 생성 재실행 준비 중"
      : "Sol 이중검증부터 재실행 준비 중", 8);
    batch.status = "running";
    batch.completedAt = null;
    await persistBatchState(batch);
    res.status(202).json({ ok: true, batch: makeBatchSnapshot(batch) });

    void regenerateStoredBatchItem(batch, item).catch(async (error) => {
      item.error = error.message || "재실행 중 오류가 발생했습니다.";
      item.retryCompletedAt = Date.now();
      updateItemPhase(batch, item, "failed", "재실행 실패", 100);
      refreshBatchStatusFromItems(batch);
      await persistBatchState(batch).catch((persistError) => console.error(persistError));
      console.error(`[item-retry] failed batch=${batch.id} item=${item.id}: ${error.stack || error.message || error}`);
    });
  } catch (error) {
    console.error(`[item-retry] start failed: ${error.stack || error.message || error}`);
    res.status(400).json({ error: error.message || "이미지 생성 재실행을 시작하지 못했습니다." });
  }
});

app.post("/api/translate-batch/:batchId/:itemId/regenerate-current-prompt", async (req, res) => {
  let activeItem = null;
  try {
    const { batch, item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!batch || !item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });
    if (item.status === "running") {
      return res.status(409).json({ error: "현재 처리 중인 항목에는 추가요청을 적용할 수 없습니다." });
    }
    if (item.additionalRequestInFlight) {
      return res.status(409).json({ error: "이미 생성본 추가요청을 처리 중입니다." });
    }
    if (!item.translation || !item.targetSize) {
      return res.status(400).json({ error: "저장된 번역문 또는 생성 크기 정보가 없습니다." });
    }
    if (!item.restorationSourcePath || !existsSync(item.restorationSourcePath)) {
      return res.status(400).json({ error: "저장된 전처리 원본을 찾을 수 없습니다." });
    }
    const additionalRequest = normalizeGenerationAdditionalRequest(
      req.body?.additionalRequest,
      { required: true },
    );
    activeItem = item;
    item.additionalRequestInFlight = true;

    const preset = getPreset(item.presetId);
    const dictionaryLines = normalizeDictionary(batch.dictionaryText);
    const normalizedSource = await readFile(item.restorationSourcePath);
    const generationProtection = mapProtectionToGenerationSpace(item.protectionRegions, item.targetSize);
    const usePaintedMask = batch.generationMode === "painted_mask";
    const sourceForModels = usePaintedMask
      ? await buildPaintedModelInput(normalizedSource, item.targetSize, generationProtection)
      : await applyProtectionMask(normalizedSource, item.targetSize, generationProtection);
    if (hasProtectionShapes(generationProtection)) {
      item.currentPromptInputRedactionColor = PROTECTION_INPUT_REDACTION_COLOR;
    }
    if (usePaintedMask) {
      item.currentPromptModelInputPath = join(
        RESTORE_SOURCE_DIR,
        `${batch.id}-${item.id}-current-prompt-painted-model-input.png`,
      );
      await writeFile(item.currentPromptModelInputPath, sourceForModels);
    }
    const sourceDataUrl = `data:image/png;base64,${sourceForModels.toString("base64")}`;
    const model = batch.imageGenerationModel || DEFAULT_IMAGE_GENERATION_MODEL;
    console.log(
      `[prompt-regeneration] started batch=${batch.id} item=${item.id} model=${model} preset=${preset.id} size=${item.targetSize.size} paintedInputOnly=${usePaintedMask}`,
    );

    let generated = await runImageTranslation(
      sourceDataUrl,
      item.translation,
      item.targetSize.size,
      preset,
      dictionaryLines,
      model,
      null,
      usePaintedMask,
      batch.generationMode,
      additionalRequest,
    );
    const rawGenerated = generated;
    const useSentinelChromaKey = hasProtectionShapes(generationProtection);
    if (useSentinelChromaKey) {
      generated = await compositeGeneratedWithSentinelTransparency(
        generated,
        normalizedSource,
        item.targetSize,
        generationProtection,
        { paintedInputOnly: usePaintedMask },
      );
    }
    const saved = await saveOutputs(
      item.originalName,
      generated,
      item.targetSize,
      normalizedSource,
      normalizedSource,
      useSentinelChromaKey ? [] : item.protectionRegions,
      rawGenerated,
    );
    item.currentPromptOutputPath = saved.downloadPath;
    item.currentPromptPreviewUrl = saved.publicUrl;
    item.currentPromptUnrestoredPath = join(
      RESTORE_SOURCE_DIR,
      `${batch.id}-${item.id}-current-prompt-unrestored.png`,
    );
    await writeFile(item.currentPromptUnrestoredPath, saved.unrestoredBuffer);
    item.outputPath = saved.downloadPath;
    item.previewUrl = saved.publicUrl;
    item.manualEditBasePath = saved.downloadPath;
    item.unrestoredGeneratedPath = item.currentPromptUnrestoredPath;
    item.manualOutputPath = null;
    item.manualPreviewUrl = null;
    item.manualEditStrokes = [];
    item.translationPendingRegeneration = false;
    item.generationAdditionalRequest = additionalRequest;
    item.generationAdditionalRequestAt = Date.now();
    item.generationAdditionalRequestCount = Number(item.generationAdditionalRequestCount || 0) + 1;
    item.error = null;
    updateItemPhase(batch, item, "completed", "생성본 추가요청 반영 완료", 100);
    refreshBatchStatusFromItems(batch);
    await persistBatchState(batch);

    console.log(
      `[prompt-regeneration] completed batch=${batch.id} item=${item.id} output=${saved.downloadPath} unrestored=${item.currentPromptUnrestoredPath}`,
    );
    res.json({
      ok: true,
      model,
      outputPath: saved.downloadPath,
      previewUrl: saved.publicUrl,
      unrestoredPath: item.currentPromptUnrestoredPath,
      additionalRequest,
      batch: makeBatchSnapshot(batch),
    });
  } catch (error) {
    if (error.isGenerationAdditionalRequestInputError) {
      console.warn(`[prompt-regeneration] rejected: ${error.message}`);
    } else {
      console.error(`[prompt-regeneration] failed: ${error.stack || error.message || error}`);
    }
    res.status(400).json({ error: error.message || "생성본 추가요청으로 이미지를 다시 생성하지 못했습니다." });
  } finally {
    if (activeItem) activeItem.additionalRequestInFlight = false;
  }
});

app.post("/api/translate-batch/:batchId/:itemId/regenerate-patch-atlas", (_req, res) => {
  res.status(410).json({ error: "Patch Atlas 자동 생성 기능은 중지되었습니다." });
});

app.post("/api/translate-batch/:batchId/:itemId/rebuild-restoration", async (req, res) => {
  try {
    const { batch, item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!batch || !item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });

    const restorationReference = await buildManualRestorationReference(item);
    const referenceMeta = await sharp(restorationReference).metadata();
    const width = referenceMeta.width || 0;
    const height = referenceMeta.height || 0;
    if (!width || !height) throw new Error("원본 복구 이미지의 크기를 읽지 못했습니다.");

    const useCurrentPromptLayer = req.body?.layer === "current_prompt";
    const unrestoredPath = useCurrentPromptLayer
      ? item.currentPromptUnrestoredPath
      : item.unrestoredGeneratedPath;
    const unrestoredReference = await buildManualUnrestoredReference(
      item,
      width,
      height,
      unrestoredPath,
    );
    const protectionSpec = item.targetSize?.cropRect
      ? normalizeProtectionSpec(item.protectionRegions)
      : mapProtectionToGenerationSpace(item.protectionRegions, item.targetSize);
    const hasRestoreExpandOverride = req.body?.restoreExpandPx !== undefined;
    const requestedRestoreExpandPx = Number(req.body?.restoreExpandPx);
    if (hasRestoreExpandOverride && !Number.isFinite(requestedRestoreExpandPx)) {
      return res.status(400).json({ error: "복원 확장 픽셀 값이 올바르지 않습니다." });
    }
    const restoreExpandPx = hasRestoreExpandOverride
      ? Math.max(0, Math.min(128, Math.round(requestedRestoreExpandPx)))
      : PROTECTION_RESTORE_EXPAND_PX;
    const repairSentinelLeak = req.body?.repairSentinelLeak === true;
    const requestedSentinelMarginPx = Number(req.body?.sentinelMarginPx ?? 2);
    if (repairSentinelLeak && !Number.isFinite(requestedSentinelMarginPx)) {
      return res.status(400).json({ error: "체크무늬 복구 여유 픽셀 값이 올바르지 않습니다." });
    }
    const sentinelMarginPx = Math.max(0, Math.min(16, Math.round(requestedSentinelMarginPx)));
    const storedRedactionColor = useCurrentPromptLayer
      ? item.currentPromptInputRedactionColor
      : item.inputRedactionColor;
    const sentinelRepairColors = storedRedactionColor
      ? [storedRedactionColor]
      : [PAINTED_SENTINEL_COLOR_A, PAINTED_SENTINEL_COLOR_B];
    const useSentinelChromaKey = req.body?.sentinelChromaKey === true;
    const rebuilt = useSentinelChromaKey && hasProtectionShapes(protectionSpec)
      ? await compositeGeneratedWithSentinelTransparency(
        unrestoredReference,
        restorationReference,
        { width, height },
        protectionSpec,
        { paintedInputOnly: batch.generationMode === "painted_mask" },
      )
      : hasProtectionShapes(protectionSpec)
        ? await restoreProtectedRegions(
        unrestoredReference,
        restorationReference,
        {
          width,
          height,
          preserveSourceAspect: false,
          finalResizeBackground: item.targetSize?.finalResizeBackground || "#ffffff",
        },
        protectionSpec,
        {
          expandPx: restoreExpandPx,
          repairSentinelLeak,
          sentinelMarginPx,
          sentinelRepairColors,
        },
        )
        : unrestoredReference;

    const outputName = resolveFinalOutputName(item.originalName || item.outputPath || "result.jpg");
    const outputExt = extname(outputName).toLowerCase();
    const tmpPath = join(OUTPUT_DIR, outputName);
    const downloadPath = join(DOWNLOADS_DIR, outputName);
    let pipeline = sharp(rebuilt)
      .toColourspace("srgb")
      .rotate();
    pipeline = outputExt === ".png" ? pipeline.png() : pipeline.jpeg(OUTPUT_JPEG_OPTIONS);
    const rendered = await pipeline.toBuffer();
    await writeFile(tmpPath, rendered);
    await writeFile(downloadPath, rendered);

    console.log(`[protection-rebuild] batch=${batch.id} item=${item.id} chromaKey=${useSentinelChromaKey} restoreExpand=${restoreExpandPx}px sentinelRepair=${repairSentinelLeak ? `${sentinelMarginPx}px` : "off"} output=${downloadPath}`);
    res.json({
      ok: true,
      layer: useCurrentPromptLayer ? "current_prompt" : "original_generation",
      restoreExpandPx,
      repairSentinelLeak,
      sentinelMarginPx,
      sentinelChromaKey: useSentinelChromaKey,
      outputPath: downloadPath,
      previewUrl: `/output/${encodeURIComponent(outputName)}`,
    });
  } catch (error) {
    console.error(`[protection-rebuild] failed: ${error.stack || error.message || error}`);
    res.status(400).json({ error: error.message || "저장된 기록에서 원본 복구 결과를 다시 만들지 못했습니다." });
  }
});

app.post("/api/translate-batch/:batchId/:itemId/manual-restore", upload.single("editedImage"), async (req, res) => {
  try {
    const { batch, item } = getBatchItem(req.params.batchId, req.params.itemId);
    if (!batch || !item) return res.status(404).json({ error: "번역 항목을 찾을 수 없습니다." });
    let submittedStrokes = req.body?.strokes;
    if (typeof submittedStrokes === "string") {
      try {
        submittedStrokes = JSON.parse(submittedStrokes);
      } catch {
        return res.status(400).json({ error: "편집 브러시 기록 형식이 올바르지 않습니다." });
      }
    }
    const strokes = normalizeManualRestoreStrokes(submittedStrokes);
    const baseOutputPath = item.manualEditBasePath || item.outputPath;
    if (!baseOutputPath || !existsSync(baseOutputPath)) {
      return res.status(400).json({ error: "편집할 번역 결과를 찾을 수 없습니다." });
    }

    const restorationReference = await buildManualRestorationReference(item);
    const referenceMeta = await sharp(restorationReference).metadata();
    const width = referenceMeta.width || 0;
    const height = referenceMeta.height || 0;
    if (!width || !height) throw new Error("원본 복구 이미지의 크기를 읽지 못했습니다.");
    const target = { width, height };
    let edited;
    let renderSource = "server-svg-fallback";
    if (req.file?.buffer) {
      const submittedMeta = await sharp(req.file.buffer).metadata();
      if (submittedMeta.width !== width || submittedMeta.height !== height) {
        return res.status(400).json({
          error: `편집본 크기가 기준 이미지와 다릅니다. expected=${width}x${height}, actual=${submittedMeta.width || 0}x${submittedMeta.height || 0}`,
        });
      }
      edited = req.file.buffer;
      renderSource = "browser-canvas";
    } else {
      if (strokes.some((stroke) => stroke.mode === "heal")) {
        throw new Error("경계 보정 결과 이미지가 누락되었습니다. 복구 편집기에서 다시 저장해 주세요.");
      }
      const unrestoredReference = await buildManualUnrestoredReference(item, width, height);
      const basePipeline = sharp(await readFile(baseOutputPath)).resize(width, height, { fit: "fill" });
      edited = strokes.length
        ? await basePipeline
          .composite([{
            input: buildManualEditOverlaySvg(
              target,
              await sharp(restorationReference).png().toBuffer(),
              unrestoredReference,
              strokes,
            ),
            blend: "over",
          }])
          .flatten({ background: "#ffffff" })
          .png()
          .toBuffer()
        : await basePipeline
          .flatten({ background: "#ffffff" })
          .png()
          .toBuffer();
    }

    const outputName = resolveFinalOutputName(item.originalName || item.outputPath || baseOutputPath);
    const outputExt = extname(outputName).toLowerCase();
    const tmpPath = join(OUTPUT_DIR, outputName);
    const downloadPath = join(DOWNLOADS_DIR, outputName);
    let rendered = edited;
    if (outputExt !== ".png" || renderSource !== "browser-canvas") {
      let pipeline = sharp(edited)
        .toColourspace("srgb")
        .rotate();
      pipeline = outputExt === ".png" ? pipeline.png() : pipeline.jpeg(OUTPUT_JPEG_OPTIONS);
      rendered = await pipeline.toBuffer();
    }
    await writeFile(tmpPath, rendered);
    await writeFile(downloadPath, rendered);

    item.manualOutputPath = downloadPath;
    item.manualPreviewUrl = `/output/${encodeURIComponent(outputName)}`;
    item.manualEditStrokes = strokes;
    batch.updatedAt = Date.now();
    await persistBatchState(batch);
    console.log(`[manual-edit] saved batch=${batch.id} item=${item.id} strokes=${strokes.length} renderer=${renderSource} size=${width}x${height} output=${downloadPath}`);
    res.json({
      ok: true,
      outputPath: downloadPath,
      previewUrl: item.manualPreviewUrl,
      savedStrokeCount: strokes.length,
      renderer: renderSource,
      batch: makeBatchSnapshot(batch),
    });
  } catch (error) {
    console.error(`[manual-edit] save failed: ${error.stack || error.message || error}`);
    res.status(400).json({ error: error.message || "원본 복구 결과를 저장하지 못했습니다." });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    const status = await fetch(`${activeOauthUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
    res.json({ ok: true, oauthReady: status.ok, oauthUrl: activeOauthUrl, downloadsDir: DOWNLOADS_DIR, modelPipeline: automaticPipelineSnapshot(), concurrency: { analysis: ANALYSIS_CONCURRENCY, imageGeneration: IMAGE_GENERATION_CONCURRENCY, globalModelLimit: MODEL_CONCURRENCY_LIMIT, activeModelRequests: activeModelRequestCount, queuedModelRequests: modelRequestWaiters.length } });
  } catch {
    res.json({ ok: true, oauthReady: false, oauthUrl: activeOauthUrl, downloadsDir: DOWNLOADS_DIR, modelPipeline: automaticPipelineSnapshot(), concurrency: { analysis: ANALYSIS_CONCURRENCY, imageGeneration: IMAGE_GENERATION_CONCURRENCY, globalModelLimit: MODEL_CONCURRENCY_LIMIT, activeModelRequests: activeModelRequestCount, queuedModelRequests: modelRequestWaiters.length } });
  }
});

app.post("/api/translate-batch", upload.any(), async (req, res) => {
  const uploadedFiles = await normalizeUploadedFiles(req.files);

  if (!uploadedFiles.length) {
    return res.status(400).json({ error: "이미지 파일이 필요합니다." });
  }

  const requestedConcurrency = Number.parseInt(req.body?.concurrency, 10);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(3, requestedConcurrency))
    : IMAGE_GENERATION_CONCURRENCY;

  const imageGenerationModel = AUTOMATIC_MODEL_PIPELINE.imageGeneration.model;
  const requestedPresetId = typeof req.body?.presetId === "string" ? req.body.presetId : "comic";
  const requestedPreset = getPreset(requestedPresetId);
  const generationMode = ["painted_mask", "protected_mask", "page"].includes(req.body?.generationMode)
    ? req.body.generationMode
    : "painted_mask";
  const protectionMasks = parseProtectionMasks(req.body?.protectionMasks, uploadedFiles.length);
  const splitPageFlags = parseSplitPageFlags(req.body?.splitPageFlags, uploadedFiles.length);
  const workEntries = await expandSplitPageUploads(uploadedFiles, protectionMasks, splitPageFlags);

  const batch = {
    id: `batch-${Date.now()}`,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    items: workEntries.map((entry, index) => ({
      id: `item-${index + 1}`,
      originalName: entry.file.originalname || `image-${index + 1}.png`,
      presetId: requestedPresetId,
      status: "queued",
      phaseLabel: "대기 중",
      progress: 0,
      buffer: entry.file.buffer,
      outputPath: null,
      previewUrl: null,
      manualOutputPath: null,
      manualPreviewUrl: null,
      manualEditBasePath: null,
      manualEditStrokes: [],
      patchAtlasTileCount: 0,
      patchAtlasRejectedRegionCount: 0,
      patchAtlasChangedPixels: 0,
      patchAtlasSourcePath: null,
      patchAtlasGuidePath: null,
      patchAtlasGeneratedPath: null,
      patchAtlasMetadataPath: null,
      restorationSourcePath: null,
      unrestoredGeneratedPath: null,
      error: null,
      targetSize: null,
      translation: null,
      protectionRegions: entry.protectionRegions || { regions: [], invert: false },
      splitGroupId: entry.split?.groupId || null,
      splitSide: entry.split?.side || null,
      splitHidden: entry.split?.hidden === true,
      splitOriginalName: entry.split?.originalName || null,
      splitSourceWidth: entry.split?.sourceWidth || null,
      splitSourceHeight: entry.split?.sourceHeight || null,
      protectionEditedAt: null,
      protectionChangedSinceTranslation: false,
      translationEditedAt: null,
      translationEditCount: 0,
      translationPendingRegeneration: false,
      generationAdditionalRequest: "",
      generationAdditionalRequestAt: null,
      generationAdditionalRequestCount: 0,
      retryCount: 0,
      retryStartedAt: null,
      retryCompletedAt: null,
    })),
    dictionaryText: typeof req.body?.dictionary === "string" ? req.body.dictionary : "",
    modelPipeline: automaticPipelineSnapshot(),
    ocrEngine: "automatic",
    ocrModel: isComicLikePreset(requestedPreset)
      ? AUTOMATIC_MODEL_PIPELINE.comicPrimaryOcr.model
      : AUTOMATIC_MODEL_PIPELINE.documentOcr.model,
    imageGenerationModel,
    generationMode,
    analysisConcurrency: ANALYSIS_CONCURRENCY,
  };

  batches.set(batch.id, batch);
  batch.imageGenerationConcurrency = concurrency;
  processBatch(batch).catch((error) => {
    console.error(error);
    batch.status = "failed";
    persistBatchState(batch).catch((persistError) => console.error(persistError));
  });

  res.json({ ok: true, batch: makeBatchSnapshot(batch) });
});

app.get("/api/presets", (_req, res) => {
  res.json({
    ok: true,
    presets: Object.values(PROMPT_PRESETS).map((preset) => ({
      id: preset.id,
      label: preset.label
    }))
  });
});

app.get("/api/translate-batches", (_req, res) => {
  const recentBatches = [...batches.values()]
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .slice(0, 20)
    .map(makeBatchSnapshot);
  res.json({ ok: true, batches: recentBatches });
});

app.get("/api/translate-batch/:batchId", (req, res) => {
  const batch = batches.get(req.params.batchId);
  if (!batch) {
    return res.status(404).json({ error: "배치를 찾을 수 없습니다." });
  }
  res.json({ ok: true, batch: makeBatchSnapshot(batch) });
});

app.delete("/api/translation-history", async (_req, res) => {
  try {
    const hasRunningBatch = [...batches.values()].some((batch) => (
      batch.status === "running"
      || batch.items?.some((item) => item.status === "running")
    ));
    if (hasRunningBatch || activeModelRequestCount > 0 || modelRequestWaiters.length > 0) {
      return res.status(409).json({ error: "번역 처리 중에는 기록을 지울 수 없습니다. 현재 작업이 끝난 뒤 다시 시도해 주세요." });
    }
    const removedBatchCount = batches.size;
    const removedHistoryFiles = await clearDirectory(BATCH_STATE_DIR);
    await mkdir(BATCH_STATE_DIR, { recursive: true });
    batches.clear();
    res.json({
      ok: true,
      removedBatchCount,
      removedHistoryFiles,
      preservedOutputs: true,
      preservedTemporaryFiles: true,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "번역 기록을 지우는 중 오류가 발생했습니다." });
  }
});

app.post("/api/cleanup", async (_req, res) => {
  try {
    const removedOutput = await clearDirectory(OUTPUT_DIR);
    const removedTmp = await clearDirectory(TMP_DIR);
    await ensureDirs();
    const logFiles = ["launch.log", "server.out.log", "server.err.log"];
    let removedLogs = 0;
    for (const file of logFiles) {
      const path = join(__dirname, file);
      if (existsSync(path)) {
        await rm(path, { force: true }).catch(() => {});
        removedLogs += 1;
      }
    }
    batches.clear();
    res.json({ ok: true, removedOutput, removedTmp, removedLogs });
  } catch (error) {
    res.status(500).json({ error: error.message || "정리 중 오류가 발생했습니다." });
  }
});

app.post("/api/shutdown", (_req, res) => {
  res.status(204).end();
  setTimeout(() => {
    shuttingDown = true;
    try { oauthChild?.kill(); } catch {}
    process.exit(0);
  }, 100);
});

app.use("/api", (error, _req, res, _next) => {
  console.error(error);

  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_UNEXPECTED_FILE"
      ? "업로드 파일 필드가 올바르지 않습니다. 이미지 파일은 images 필드로 전송해야 합니다."
      : error.message;
    return res.status(400).json({ error: message });
  }

  res.status(500).json({ error: error.message || "서버 오류가 발생했습니다." });
});

await ensureDirs();
await loadPersistedBatchStates();
oauthChild = spawnOAuthProxy();

process.on("SIGINT", () => {
  shuttingDown = true;
  try { oauthChild?.kill(); } catch {}
  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  try { oauthChild?.kill(); } catch {}
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Comic translator running at http://127.0.0.1:${PORT}`);
  console.log(`OAuth login helper: ${activeOauthUrl}`);
  console.log(`Comic OCR/render contract: ${COMIC_RENDER_CONTRACT_VERSION} (ordered source/replacement checklist + coarse 3x3 page zones + exact speech-bubble tail presence/absence lock; no numeric coordinates sent to models)`);
  console.log(`Automatic comic pipeline: primary=${AUTOMATIC_MODEL_PIPELINE.comicPrimaryOcr.model}/${AUTOMATIC_MODEL_PIPELINE.comicPrimaryOcr.reasoningEffort} verification=${AUTOMATIC_MODEL_PIPELINE.comicVerification.model}/${AUTOMATIC_MODEL_PIPELINE.comicVerification.reasoningEffort} image=${AUTOMATIC_MODEL_PIPELINE.imageGeneration.model}/${AUTOMATIC_MODEL_PIPELINE.imageGeneration.reasoningEffort}`);
  console.log(`Automatic document OCR: primary=${AUTOMATIC_MODEL_PIPELINE.documentOcr.model}/${AUTOMATIC_MODEL_PIPELINE.documentOcr.reasoningEffort} exception=${AUTOMATIC_MODEL_PIPELINE.documentException.model}/${AUTOMATIC_MODEL_PIPELINE.documentException.reasoningEffort}`);
  console.log(`OAuth runtime: openai-oauth=local CodexClientVersion=${OAUTH_CODEX_VERSION || "automatic"}`);
  console.log(`Concurrency defaults: analysis=${ANALYSIS_CONCURRENCY} imageGeneration=${IMAGE_GENERATION_CONCURRENCY} globalModelLimit=${MODEL_CONCURRENCY_LIMIT} fixedOcrThrottle=off adaptiveBackoff=on stageRetries=${MODEL_STAGE_MAX_RETRIES} retryBaseMs=${MODEL_RETRY_BASE_MS}`);
  console.log(`Image generation defaults: model=${normalizeImageGenerationModel(DEFAULT_IMAGE_GENERATION_MODEL)} quality=${IMAGE_GENERATION_QUALITY} moderation=${IMAGE_GENERATION_MODERATION} reasoning=${AUTOMATIC_MODEL_PIPELINE.imageGeneration.reasoningEffort} timeoutMs=${IMAGE_GENERATION_TIMEOUT_MS} aspectMismatch=continue`);
  console.log("Source-image fidelity lock: enabled for comic, manga_jp, document, and cardgame presets; non-text color and geometry changes forbidden");
  console.log(`Image edit controls: generationMode=painted_mask -> ${PAINTED_TEXT_EDIT_CONTRACT_VERSION}; generationMode=painted_mask|page -> action=edit + input_fidelity=high (automatic fallback enabled); protected_mask -> standard controls`);
  console.log(`Protection mask defaults: inputPattern=solid inputFill=${PROTECTION_INPUT_REDACTION_COLOR} inputExpand=${PROTECTION_INPUT_EXPAND_PX}px inputFeather=${PROTECTION_INPUT_FEATHER_PX}px legacyRebuildExpand=${PROTECTION_RESTORE_EXPAND_PX}px restoreFeather=${PROTECTION_RESTORE_FEATHER_PX}px sentinelComposite=chroma-key grayKeyDistance=${PROTECTION_GRAY_KEY_COLOR_DISTANCE} neutralChroma<=${PROTECTION_GRAY_KEY_MAX_CHROMA} neutralLuma=${PROTECTION_GRAY_KEY_MIN_LUMA}-${PROTECTION_GRAY_KEY_MAX_LUMA} graySpill=${PROTECTION_GRAY_KEY_SPILL_PX}px grayEdgeRestore=${PROTECTION_GRAY_KEY_EDGE_RESTORE_PX}px paintedInputEdge=${PAINTED_INPUT_EDGE_PX}px paintedOuterHintOnly=true legacySentinel=${PAINTED_SENTINEL_COLOR_A}/${PAINTED_SENTINEL_COLOR_B} paintedToolMask=off`);
});
