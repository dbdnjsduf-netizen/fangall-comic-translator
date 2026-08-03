const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const runBtn = document.getElementById("runBtn");
const loginBtn = document.getElementById("loginBtn");
const cleanupBtn = document.getElementById("cleanupBtn");
const historyClearBtn = document.getElementById("historyClearBtn");
const statusBox = document.getElementById("status");
const meta = document.getElementById("meta");
const jsonView = document.getElementById("jsonView");
const selectionList = document.getElementById("selectionList");
const batchList = document.getElementById("batchList");
const presetSelect = document.getElementById("presetSelect");
const concurrencySelect = document.getElementById("concurrencySelect");
const generationModeSelect = document.getElementById("generationModeSelect");
const dictionaryInput = document.getElementById("dictionaryInput");
const dictionaryResetBtn = document.getElementById("dictionaryResetBtn");
const maskPanelTitle = document.getElementById("maskPanelTitle");
const maskPanelDescription = document.getElementById("maskPanelDescription");
const maskEditorBtn = document.getElementById("maskEditorBtn");
const maskModal = document.getElementById("maskModal");
const maskModalTitle = document.getElementById("maskModalTitle");
const maskModalDescription = document.getElementById("maskModalDescription");
const maskCloseBtn = document.getElementById("maskCloseBtn");
const maskFileSelect = document.getElementById("maskFileSelect");
const maskInvertCheckbox = document.getElementById("maskInvertCheckbox");
const maskBrushSize = document.getElementById("maskBrushSize");
const maskUndoBtn = document.getElementById("maskUndoBtn");
const maskClearBtn = document.getElementById("maskClearBtn");
const maskCanvas = document.getElementById("maskCanvas");
const maskHelp = document.getElementById("maskHelp");
const maskCtx = maskCanvas.getContext("2d");
const restoreModal = document.getElementById("restoreModal");
const restoreCloseBtn = document.getElementById("restoreCloseBtn");
const restoreBrushSize = document.getElementById("restoreBrushSize");
const restorePaintModeInputs = [...document.querySelectorAll('input[name="restorePaintMode"]')];
const restoreViewMode = document.getElementById("restoreViewMode");
const restoreUndoBtn = document.getElementById("restoreUndoBtn");
const restoreClearBtn = document.getElementById("restoreClearBtn");
const restoreAdditionalRequestToggleBtn = document.getElementById("restoreAdditionalRequestToggleBtn");
const restoreAdditionalRequestPanel = document.getElementById("restoreAdditionalRequestPanel");
const restoreAdditionalRequestInput = document.getElementById("restoreAdditionalRequestInput");
const restoreAdditionalRequestCount = document.getElementById("restoreAdditionalRequestCount");
const restoreAdditionalRequestCancelBtn = document.getElementById("restoreAdditionalRequestCancelBtn");
const restoreAdditionalRequestRunBtn = document.getElementById("restoreAdditionalRequestRunBtn");
const restoreSaveBtn = document.getElementById("restoreSaveBtn");
const restoreCanvas = document.getElementById("restoreCanvas");
const restoreHelp = document.getElementById("restoreHelp");
const restoreCtx = restoreCanvas.getContext("2d");
const retryMaskModal = document.getElementById("retryMaskModal");
const retryMaskTitle = document.getElementById("retryMaskTitle");
const retryMaskDescription = document.getElementById("retryMaskDescription");
const retryMaskCloseBtn = document.getElementById("retryMaskCloseBtn");
const retryMaskBrushSize = document.getElementById("retryMaskBrushSize");
const retryMaskUndoBtn = document.getElementById("retryMaskUndoBtn");
const retryMaskClearBtn = document.getElementById("retryMaskClearBtn");
const retryMaskSaveBtn = document.getElementById("retryMaskSaveBtn");
const retryMaskCanvas = document.getElementById("retryMaskCanvas");
const retryMaskHelp = document.getElementById("retryMaskHelp");
const retryMaskCtx = retryMaskCanvas.getContext("2d");
const translationModal = document.getElementById("translationModal");
const translationCloseBtn = document.getElementById("translationCloseBtn");
const translationSummary = document.getElementById("translationSummary");
const translationEditorList = document.getElementById("translationEditorList");
const translationAddBtn = document.getElementById("translationAddBtn");
const translationSaveBtn = document.getElementById("translationSaveBtn");
const translationSaveRegenerateBtn = document.getElementById("translationSaveRegenerateBtn");
const translationHelp = document.getElementById("translationHelp");

let selectedFiles = [];
let protectionMasks = [];
let splitPageFlags = [];
let oauthUrl = "http://127.0.0.1:10531";
let activeBatchId = null;
let pollTimer = null;
let presets = [];
let maskImage = null;
let maskImageUrl = null;
let maskStrokeDraft = null;
let latestBatch = null;
let restoreBatchId = null;
let restoreItemId = null;
let restoreGeneratedImage = null;
let restoreSourceImage = null;
let restoreUnrestoredImage = null;
let restoreStrokes = [];
let restoreStrokeDraft = null;
let restoreAdditionalRequestRunning = false;
let retryMaskBatchId = null;
let retryMaskItemId = null;
let retryMaskImage = null;
let retryMaskEntry = null;
let retryMaskStrokeDraft = null;
let translationBatchId = null;
let translationItemId = null;
let translationDraft = null;
let translationDraftKind = null;

const DICTIONARY_STORAGE_KEY = "comic-translator.dictionary";
const GENERATION_MODE_STORAGE_KEY = "comic-translator.generation-mode";
const DEFAULT_DICTIONARY = [
  "Tico=티코",
  "Spider Jerusalem=스파이더 예루살렘",
  "Autumn Rainfall=아우텀 레인폴",
  "nanohuman=나노휴먼",
  "telecon=텔레콘",
  "falseface=페이스",
].join("\n");

function setStatus(text) {
  statusBox.textContent = text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cloneMaskEntry(entry) {
  return {
    regions: Array.isArray(entry?.regions)
      ? entry.regions.map((region) => ({ ...region }))
      : [],
    strokes: Array.isArray(entry?.strokes)
      ? entry.strokes.map((stroke) => ({
        radius: stroke.radius,
        points: Array.isArray(stroke.points) ? stroke.points.map((point) => ({ ...point })) : [],
      }))
      : [],
    invert: false,
  };
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${fallbackMessage} 서버가 JSON 대신 HTML/텍스트 응답을 보냈습니다.`);
    }
  }

  if (!response.ok) {
    throw new Error(data.error || fallbackMessage);
  }

  return data;
}

function createMaskEntry() {
  return { regions: [], strokes: [], invert: false };
}

function getMaskEntry(index) {
  if (Array.isArray(protectionMasks[index])) {
    protectionMasks[index] = { regions: protectionMasks[index], strokes: [], invert: false };
  }
  if (!protectionMasks[index]) {
    protectionMasks[index] = createMaskEntry();
  }
  if (!Array.isArray(protectionMasks[index].regions)) protectionMasks[index].regions = [];
  if (!Array.isArray(protectionMasks[index].strokes)) protectionMasks[index].strokes = [];
  return protectionMasks[index];
}

function getMaskShapeCount(entry) {
  return (entry.regions?.length || 0) + (entry.strokes?.length || 0);
}

function getGenerationModeLabel(mode) {
  if (mode === "painted_mask") return "직접 칠한 텍스트 영역";
  if (mode === "protected_mask") return "칠한 영역을 GPT에서 숨기고 원본 복원";
  return "전체 페이지";
}

function getMaskUiCopy(mode = generationModeSelect.value) {
  if (mode === "protected_mask") {
    return {
      panelTitle: "GPT에서 숨길 보호영역",
      panelDescription: "GPT가 보지 않아야 할 그림을 칠합니다. 칠한 영역은 입력에서 단색 중성 회색으로 가리고 생성 후 원본으로 복원합니다.",
      editorButton: "보호영역 편집",
      modalTitle: "보호영역 편집",
      modalDescription: "GPT에 전달하지 않을 그림만 칠하세요. 칠한 곳은 단색 중성 회색으로 가려지고 생성 후 원본으로 복원됩니다.",
      clearButton: "현재 파일 보호영역 전체 삭제",
      regionLabel: "보호영역",
      summaryLabel: "GPT에서 숨길 보호영역",
    };
  }
  return {
    panelTitle: "번역할 텍스트 영역",
    panelDescription: "말풍선 글자와 효과음처럼 GPT가 수정할 영역만 직접 칠합니다. 칠하지 않은 픽셀은 원본 그대로 유지됩니다.",
    editorButton: "텍스트 영역 편집",
    modalTitle: "텍스트 영역 편집",
    modalDescription: "번역할 원문 글자와 필요한 주변 배경만 칠하세요. 칠한 영역 안에서만 이미지가 생성됩니다.",
    clearButton: "현재 파일 텍스트 영역 전체 삭제",
    regionLabel: "텍스트 영역",
    summaryLabel: "직접 칠한 텍스트 영역",
  };
}

function updateMaskModeUi() {
  const copy = getMaskUiCopy();
  maskPanelTitle.textContent = copy.panelTitle;
  maskPanelDescription.textContent = copy.panelDescription;
  maskEditorBtn.textContent = copy.editorButton;
  maskModalTitle.textContent = copy.modalTitle;
  maskModalDescription.textContent = copy.modalDescription;
  maskClearBtn.textContent = copy.clearButton;
  if (selectedFiles.length) updateMaskHelp();
}

function renderSelectedFiles() {
  if (!selectedFiles.length) {
    selectionList.innerHTML = "<div class='selection-item'>아직 선택된 파일이 없습니다.</div>";
    meta.innerHTML = "";
    return;
  }

  selectionList.innerHTML = selectedFiles
    .map(
      (file, index) => {
        const maskEntry = getMaskEntry(index);
        const maskCount = getMaskShapeCount(maskEntry);
        const splitEnabled = splitPageFlags[index] === true;
        return `<div class="selection-item"><strong>${index + 1}. ${file.name}</strong><span>${(file.size / 1024 / 1024).toFixed(2)} MB · ${getMaskUiCopy().regionLabel} ${maskCount}개</span><button type="button" class="split-page-btn${splitEnabled ? " active" : ""}" data-split-index="${index}" aria-pressed="${splitEnabled}">${splitEnabled ? "좌우 분할 켜짐" : "좌우 분할"}</button></div>`;
      }
    )
    .join("");

  meta.innerHTML =
    `<strong>선택 파일 수:</strong> ${selectedFiles.length}장<br />` +
    `<strong>자동 분석:</strong> Sol 높음 1차 → Sol 높음 2차 전체 재검증<br />` +
    `<strong>이미지 출력:</strong> Terra 중간<br />` +
    `<strong>이미지 합성 방식:</strong> ${generationModeSelect.options[generationModeSelect.selectedIndex]?.text || "-"}<br />` +
    `<strong>선택 프롬프트:</strong> ${presetSelect.options[presetSelect.selectedIndex]?.text || "-"}<br />` +
    `<strong>페이지 분석 동시 처리 수:</strong> 2개<br />` +
    `<strong>이미지 생성 동시 처리 수:</strong> ${concurrencySelect.value || "2"}개<br />` +
    `<strong>전체 모델 호출 상한:</strong> 4개<br />` +
    `<strong>${getMaskUiCopy().summaryLabel}:</strong> ${protectionMasks.reduce((sum, entry, index) => sum + getMaskShapeCount(getMaskEntry(index)), 0)}개<br />` +
    `<strong>사용자사전 항목:</strong> ${parseDictionary(dictionaryInput.value).length}개`;
}

selectionList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-split-index]");
  if (!button) return;
  const index = Number(button.dataset.splitIndex);
  if (!Number.isInteger(index) || index < 0 || index >= selectedFiles.length) return;
  splitPageFlags[index] = splitPageFlags[index] !== true;
  renderSelectedFiles();
});

function renderPresets() {
  presetSelect.innerHTML = presets
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join("");
}

function loadDictionary() {
  const saved = window.localStorage.getItem(DICTIONARY_STORAGE_KEY);
  dictionaryInput.value = saved === null ? DEFAULT_DICTIONARY : saved;
}

function saveDictionary() {
  window.localStorage.setItem(DICTIONARY_STORAGE_KEY, dictionaryInput.value);
}

function loadAppSettings() {
  window.localStorage.removeItem("comic-translator.ocr-engine");
  window.localStorage.removeItem("comic-translator.image-generation-model");
  window.localStorage.removeItem("comic-translator.gemini-api-key");
  const savedGenerationMode = window.localStorage.getItem(GENERATION_MODE_STORAGE_KEY);
  if ([...generationModeSelect.options].some((option) => option.value === savedGenerationMode)) {
    generationModeSelect.value = savedGenerationMode;
  }
  updateMaskModeUi();
  updateRunAvailability();
}

function saveAppSettings() {
  window.localStorage.setItem(GENERATION_MODE_STORAGE_KEY, generationModeSelect.value);
}

function updateRunAvailability() {
  runBtn.disabled = selectedFiles.length === 0;
  renderSelectedFiles();
}

function parseDictionary(text) {
  return text
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

function renderBatch(batch) {
  latestBatch = batch;
  const automaticPipelineLabel = batch.modelPipeline
    ? batch.modelPipeline.comicPrimaryOcr
      ? `${batch.modelPipeline.comicPrimaryOcr.model} 1차 → ${batch.modelPipeline.comicVerification?.model || "gpt-5.6-sol"} 2차 전체 재검증 → ${batch.modelPipeline.imageGeneration?.model || "gpt-5.6-terra"} 이미지 생성`
      : `${batch.modelPipeline.layout?.model || "Luna"} → ${batch.modelPipeline.ocr?.model || "Terra"} 또는 ${batch.modelPipeline.exceptionReview?.model || "Sol"}(이전 방식)`
    : null;
  const batchId = escapeHtml(batch.id);
  const statusLabels = {
    queued: "대기",
    running: "처리 중",
    completed: "완료",
    failed: "실패",
  };
  batchList.innerHTML = batch.items.map((item, index) => {
    const itemId = escapeHtml(item.id);
    const status = ["queued", "running", "completed", "failed"].includes(item.status)
      ? item.status
      : "queued";
    const progress = Math.max(0, Math.min(100, Number(item.progress || 0)));
    const automation = item.translation?.automation;
    const solVerificationSummary = automation?.solPassCount === 2
      ? `Sol 이중검증: 1차 ${automation.primaryItemCount ?? 0}개 → 최종 ${automation.verifiedItemCount ?? 0}개 · 수정 ${automation.correctedItemCount ?? 0}개`
      : Number.isFinite(automation?.solEscalatedItemCount)
        ? `이전 Sol 복잡 페이지 경로: ${automation.solEscalatedItemCount}개 항목`
        : "";
    const resolutionText = item.targetSize
      ? item.targetSize.finalWidth && item.targetSize.finalHeight
        && (item.targetSize.finalWidth !== item.targetSize.width || item.targetSize.finalHeight !== item.targetSize.height)
        ? `생성 ${item.targetSize.width}×${item.targetSize.height} · 최종 ${item.targetSize.finalWidth}×${item.targetSize.finalHeight}`
        : `출력 ${item.targetSize.width}×${item.targetSize.height}`
      : "";
    const details = [
      automaticPipelineLabel ? `자동 분석: ${automaticPipelineLabel}` : "",
      batch.analysisConcurrency
        ? `병렬 처리: 분석 ${batch.analysisConcurrency}개 · 생성 ${batch.imageGenerationConcurrency || 2}개 · 전체 최대 ${batch.modelConcurrencyLimit || 4}개`
        : "",
      solVerificationSummary,
      batch.imageGenerationModel ? `이미지 출력: ${batch.imageGenerationModel}` : "",
      batch.generationMode ? `이미지 합성: ${getGenerationModeLabel(batch.generationMode)}` : "",
      item.protectionRegionCount
        ? `${getMaskUiCopy(batch.generationMode).regionLabel}: ${item.protectionRegionCount}개`
        : "",
      resolutionText,
      item.retryCount ? `재실행 횟수: ${item.retryCount}회` : "",
    ].filter(Boolean);
    const detailHtml = details.length
      ? `<details class="batch-details"><summary>처리 세부정보</summary>${details.map((detail) => `<div>${escapeHtml(detail)}</div>`).join("")}</details>`
      : "";
    const outputHtml = item.manualOutputPath
      ? `<div class="output-path"><span>번역본</span>${escapeHtml(item.outputPath)}</div><div class="output-path"><span>복구 편집본</span>${escapeHtml(item.manualOutputPath)}</div>`
      : item.outputPath
        ? `<div class="output-path"><span>저장 위치</span>${escapeHtml(item.outputPath)}</div>`
        : "";
    const previewUrl = item.manualPreviewUrl || item.previewUrl;
    const previewHtml = status === "completed" && previewUrl
      ? `<a class="batch-preview" href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(item.originalName)} 번역 결과 미리보기" /><span>결과 크게 보기</span></a>`
      : "";
    const notices = [
      item.translationPendingRegeneration
        ? `<div class="batch-notice warning">번역 수정사항이 저장되어 있습니다. 이미지 재생성이 필요합니다.</div>`
        : "",
      status === "failed" && item.error
        ? `<div class="batch-error"><strong>실패 원인</strong><span>${escapeHtml(item.error)}</span></div>`
        : "",
    ].join("");
    const tools = [];
    if (status === "completed" && item.previewUrl && item.manualEditReady) {
      tools.push(`<button type="button" class="ghost small manual-restore-btn" data-batch-id="${batchId}" data-item-id="${itemId}">생성본 복구 편집</button>`);
    }
    if (status === "completed") {
      tools.push(item.translationEditReady
        ? `<button type="button" class="ghost small translation-edit-btn" data-batch-id="${batchId}" data-item-id="${itemId}">번역수정</button>`
        : `<button type="button" class="ghost small" disabled title="이 프리셋에는 수정할 OCR/번역 분석데이터가 없습니다.">번역수정 불가</button>`);
    }
    if (status === "failed") {
      const editLabel = batch.generationMode === "protected_mask" ? "보호영역 편집" : "텍스트 영역 편집";
      tools.push(item.protectionEditReady
        ? `<button type="button" class="ghost small failed-mask-edit-btn" data-batch-id="${batchId}" data-item-id="${itemId}">${editLabel}</button>`
        : `<button type="button" class="ghost small" disabled title="전처리 원본이 없어 편집할 수 없습니다.">${editLabel} 불가</button>`);
      tools.push(item.generationRetryReady
        ? `<button type="button" class="primary small retry-generation-btn" data-batch-id="${batchId}" data-item-id="${itemId}">이미지 생성 재실행</button>`
        : `<button type="button" class="primary small" disabled title="재실행에 필요한 전처리 원본이 없습니다.">이미지 생성 재실행 불가</button>`);
    }
    const toolsHtml = tools.length ? `<div class="batch-tools">${tools.join("")}</div>` : "";

    return `
      <article class="batch-item status-${status}">
        <div class="batch-item-head">
          <div><span class="batch-index">${index + 1}</span><strong>${escapeHtml(item.originalName)}</strong></div>
          <span class="status-badge">${statusLabels[status]}</span>
        </div>
        <div class="batch-phase"><span>${escapeHtml(item.phaseLabel || statusLabels[status])}</span><strong>${progress}%</strong></div>
        <div class="batch-progress" aria-label="진행률 ${progress}%"><span style="width:${progress}%"></span></div>
        ${notices}
        <div class="batch-content">${previewHtml}<div class="batch-content-main">${detailHtml}${outputHtml}${toolsHtml}</div></div>
      </article>
    `;
  }).join("");

  const current = batch.items.find((item) => item.status === "running");
  const completed = batch.items.filter((item) => item.status === "completed").length;
  const failed = batch.items.filter((item) => item.status === "failed").length;

  if (current) {
    setStatus(`현재 ${current.originalName}: ${current.phaseLabel}`);
  } else if (batch.status === "completed" || batch.status === "completed_with_errors" || batch.status === "failed") {
    setStatus(`배치 완료. 성공 ${completed}장, 실패 ${failed}장`);
  } else {
    setStatus("배치 준비 중");
  }

  const latestDone = [...batch.items].reverse().find((item) => item.translation);
  jsonView.textContent = latestDone ? JSON.stringify(latestDone.translation, null, 2) : "";
}

async function refreshHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await readJsonResponse(response, "서버 상태를 확인하지 못했습니다.");
    oauthUrl = data.oauthUrl || oauthUrl;
    if (data.oauthReady) {
      setStatus(`준비 완료. 파일을 올리고 실행 버튼을 누르세요. 결과 저장 위치: ${data.downloadsDir}`);
    } else {
      setStatus(`OAuth 로그인이 필요합니다. 로그인 버튼을 눌러 ${data.oauthUrl} 에서 인증하세요.`);
    }
  } catch {
    setStatus("서버 상태를 확인하지 못했습니다.");
  }
}

async function loadPresets() {
  const response = await fetch("/api/presets");
  const data = await readJsonResponse(response, "프리셋을 불러오지 못했습니다.");
  presets = data.presets;
  renderPresets();
  renderSelectedFiles();
}

async function loadRecentBatch() {
  const response = await fetch("/api/translate-batches");
  const data = await readJsonResponse(response, "최근 편집 상태를 불러오지 못했습니다.");
  const recentBatch = data.batches?.[0];
  if (recentBatch && !selectedFiles.length) {
    activeBatchId = recentBatch.id;
    renderBatch(recentBatch);
  }
}

function setFiles(fileList) {
  selectedFiles = Array.from(fileList);
  protectionMasks = selectedFiles.map(() => createMaskEntry());
  splitPageFlags = selectedFiles.map(() => false);
  runBtn.disabled = selectedFiles.length === 0;
  maskEditorBtn.disabled = selectedFiles.length === 0;
  activeBatchId = null;
  latestBatch = null;
  batchList.innerHTML = "";
  jsonView.textContent = "";
  updateRunAvailability();
}

async function pollBatch(batchId) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  const response = await fetch(`/api/translate-batch/${batchId}`);
  const data = await readJsonResponse(response, "배치 상태를 읽지 못했습니다.");

  renderBatch(data.batch);

  if (data.batch.status === "completed" || data.batch.status === "completed_with_errors" || data.batch.status === "failed") {
    runBtn.disabled = selectedFiles.length === 0;
    return;
  }

  pollTimer = window.setTimeout(() => {
    pollBatch(batchId).catch((error) => setStatus(`오류: ${error.message}`));
  }, 1500);
}

function getMaskFileIndex() {
  const index = Number.parseInt(maskFileSelect.value, 10);
  return Number.isInteger(index) && index >= 0 && index < selectedFiles.length ? index : 0;
}

function updateMaskHelp() {
  const index = getMaskFileIndex();
  const maskEntry = getMaskEntry(index);
  const count = getMaskShapeCount(maskEntry);
  if (generationModeSelect.value === "protected_mask") {
    maskHelp.textContent = `${selectedFiles[index]?.name || ""} 보호영역 ${count}회 칠함. 브러시 ${maskBrushSize.value}px. 칠한 곳은 GPT 입력에서 단색 중성 회색으로 가리고 생성 후 원본으로 복원됩니다.`;
    return;
  }
  maskHelp.textContent = `${selectedFiles[index]?.name || ""} 텍스트 영역 ${count}회 칠함. 브러시 ${maskBrushSize.value}px. 칠한 곳만 GPT가 수정하고 나머지는 원본 픽셀로 유지됩니다.`;
}

function getBrushRadiusPx() {
  return Math.max(4, Number(maskBrushSize.value || 32) / 2);
}

function getBrushRadiusNormalized() {
  return getBrushRadiusPx() / Math.max(1, maskCanvas.width);
}

function drawStrokePath(ctx, stroke, width, height) {
  const points = Array.isArray(stroke?.points) ? stroke.points : [];
  if (!points.length) return;
  const radiusPx = Math.max(1, (stroke.radius || 0.01) * width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = radiusPx * 2;

  if (points.length === 1) {
    const point = points[0];
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, radiusPx, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x * width, points[0].y * height);
  for (const point of points.slice(1)) {
    ctx.lineTo(point.x * width, point.y * height);
  }
  ctx.stroke();
}

function drawMaskShape(ctx, region, width, height) {
  ctx.fillRect(region.x * width, region.y * height, region.width * width, region.height * height);
}

function drawMaskOverlay(ctx, regions, strokes, width, height, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (const region of regions) drawMaskShape(ctx, region, width, height);
  for (const stroke of strokes) drawStrokePath(ctx, stroke, width, height);
  ctx.restore();
}

function drawMaskGuides(ctx, regions, strokes, width, height) {
  ctx.save();
  ctx.strokeStyle = "#f4b942";
  ctx.fillStyle = "rgba(244, 185, 66, 0.45)";
  ctx.lineWidth = Math.max(2, width / 500);
  for (const region of regions) {
    ctx.strokeRect(region.x * width, region.y * height, region.width * width, region.height * height);
  }
  ctx.strokeStyle = "rgba(244, 185, 66, 0.82)";
  ctx.fillStyle = "rgba(244, 185, 66, 0.45)";
  for (const stroke of strokes) drawStrokePath(ctx, stroke, width, height);
  ctx.restore();
}

function drawMaskEditor() {
  if (!maskImage) return;

  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskCtx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);

  const index = getMaskFileIndex();
  const maskEntry = getMaskEntry(index);
  const regions = [...maskEntry.regions];
  const strokes = [...maskEntry.strokes];
  if (maskStrokeDraft) strokes.push(maskStrokeDraft);

  drawMaskOverlay(maskCtx, regions, strokes, maskCanvas.width, maskCanvas.height, "rgba(244, 185, 66, 0.45)");
  drawMaskGuides(maskCtx, regions, strokes, maskCanvas.width, maskCanvas.height);

  updateMaskHelp();
}

function loadMaskImage(index) {
  if (maskImageUrl) {
    URL.revokeObjectURL(maskImageUrl);
    maskImageUrl = null;
  }

  maskStrokeDraft = null;
  maskImage = new Image();
  maskImage.onload = () => {
    const maxWidth = 1000;
    const scale = Math.min(1, maxWidth / maskImage.naturalWidth);
    maskCanvas.width = Math.max(1, Math.round(maskImage.naturalWidth * scale));
    maskCanvas.height = Math.max(1, Math.round(maskImage.naturalHeight * scale));
    drawMaskEditor();
  };
  maskImageUrl = URL.createObjectURL(selectedFiles[index]);
  maskImage.src = maskImageUrl;
}

function openMaskEditor() {
  if (!selectedFiles.length) return;

  maskFileSelect.innerHTML = selectedFiles
    .map((file, index) => `<option value="${index}">${index + 1}. ${file.name}</option>`)
    .join("");
  maskFileSelect.value = "0";
  getMaskEntry(0).invert = false;
  maskInvertCheckbox.checked = false;
  maskModal.hidden = false;
  loadMaskImage(0);
}

function closeMaskEditor() {
  maskModal.hidden = true;
  maskStrokeDraft = null;
  maskImage = null;
  if (maskImageUrl) {
    URL.revokeObjectURL(maskImageUrl);
    maskImageUrl = null;
  }
  renderSelectedFiles();
}

function canvasPointToNormalized(event) {
  const rect = maskCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  };
}

function appendPointToDraft(point) {
  if (!maskStrokeDraft) return;
  const points = maskStrokeDraft.points;
  const previous = points[points.length - 1];
  const minDistance = Math.max(0.0015, maskStrokeDraft.radius * 0.35);
  const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
  if (distance >= minDistance) {
    points.push(point);
  }
}

function cacheBustUrl(url) {
  return `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

function loadBrowserImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("편집용 이미지를 불러오지 못했습니다."));
    image.src = cacheBustUrl(url);
  });
}

function getRestoreBrushRadiusNormalized() {
  const radiusPx = Math.max(4, Number(restoreBrushSize.value || 64) / 2);
  return radiusPx / Math.max(1, restoreCanvas.width);
}

function restoreCanvasPointToNormalized(event) {
  const rect = restoreCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function appendRestorePoint(point) {
  if (!restoreStrokeDraft) return;
  const points = restoreStrokeDraft.points;
  const previous = points[points.length - 1];
  const minDistance = Math.max(0.0015, restoreStrokeDraft.radius * 0.35);
  if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minDistance) {
    points.push(point);
  }
}

function updateRestoreHelp() {
  if (!restoreGeneratedImage || !restoreSourceImage || !restoreUnrestoredImage) return;
  const selectedMode = restorePaintModeInputs.find((input) => input.checked)?.value || "original";
  const paintMode = selectedMode === "generated"
    ? "자동복구 전 생성본"
    : selectedMode === "heal"
      ? "경계 자동 보정"
      : "원본";
  const viewText = restoreViewMode.options[restoreViewMode.selectedIndex]?.text || "편집 결과";
  const instruction = selectedMode === "heal"
    ? " · 이음새를 따라 가늘게 칠하면 표시한 띠를 양쪽 주변 색으로 자동 연결합니다."
    : "";
  restoreHelp.textContent = `${restoreStrokes.length}회 칠함 · 브러시 ${restoreBrushSize.value}px · 브러시: ${paintMode} · 보기: ${viewText}${instruction}`;
}

function applyRestoreLayerStrokes(ctx, width, height, strokes) {
  const layerStrokes = strokes.filter((stroke) => stroke.mode !== "heal");
  if (layerStrokes.length) {
    const groups = [];
    for (const stroke of layerStrokes) {
      const previous = groups[groups.length - 1];
      if (previous?.mode === stroke.mode) {
        previous.strokes.push(stroke);
      } else {
        groups.push({ mode: stroke.mode, strokes: [stroke] });
      }
    }
    const maskLayer = document.createElement("canvas");
    maskLayer.width = width;
    maskLayer.height = height;
    const maskCtx = maskLayer.getContext("2d");
    const sourceLayer = document.createElement("canvas");
    sourceLayer.width = width;
    sourceLayer.height = height;
    const sourceCtx = sourceLayer.getContext("2d");
    for (const group of groups) {
      maskCtx.globalCompositeOperation = "source-over";
      maskCtx.clearRect(0, 0, width, height);
      maskCtx.fillStyle = "#fff";
      maskCtx.strokeStyle = "#fff";
      for (const stroke of group.strokes) drawStrokePath(maskCtx, stroke, width, height);

      sourceCtx.globalCompositeOperation = "source-over";
      sourceCtx.clearRect(0, 0, width, height);
      const sourceImage = group.mode === "generated" ? restoreUnrestoredImage : restoreSourceImage;
      sourceCtx.drawImage(sourceImage, 0, 0, width, height);
      sourceCtx.globalCompositeOperation = "destination-in";
      sourceCtx.drawImage(maskLayer, 0, 0);
      sourceCtx.globalCompositeOperation = "source-over";
      ctx.drawImage(sourceLayer, 0, 0);
    }
  }
}

function applyAutomaticSeamHealing(ctx, width, height, strokes) {
  const healStrokes = strokes.filter((stroke) => stroke.mode === "heal");
  if (!healStrokes.length) return;

  const hardMaskCanvas = document.createElement("canvas");
  hardMaskCanvas.width = width;
  hardMaskCanvas.height = height;
  const hardMaskCtx = hardMaskCanvas.getContext("2d", { willReadFrequently: true });
  hardMaskCtx.fillStyle = "#fff";
  hardMaskCtx.strokeStyle = "#fff";

  const featherMaskCanvas = document.createElement("canvas");
  featherMaskCanvas.width = width;
  featherMaskCanvas.height = height;
  const featherMaskCtx = featherMaskCanvas.getContext("2d", { willReadFrequently: true });
  featherMaskCtx.fillStyle = "#fff";
  featherMaskCtx.strokeStyle = "#fff";

  let maxRadiusPx = 1;
  for (const stroke of healStrokes) {
    const radiusPx = Math.max(1, (Number(stroke.radius) || 0.01) * width);
    maxRadiusPx = Math.max(maxRadiusPx, radiusPx);
    drawStrokePath(hardMaskCtx, stroke, width, height);
    featherMaskCtx.save();
    featherMaskCtx.filter = `blur(${Math.max(1.5, radiusPx * 0.18)}px)`;
    drawStrokePath(featherMaskCtx, stroke, width, height);
    featherMaskCtx.restore();
  }

  const image = ctx.getImageData(0, 0, width, height);
  const hardMask = hardMaskCtx.getImageData(0, 0, width, height).data;
  const featherMask = featherMaskCtx.getImageData(0, 0, width, height).data;
  const working = new Uint8ClampedArray(image.data);
  const maskedPixels = [];
  for (let pixel = 0; pixel < width * height; pixel++) {
    if (hardMask[pixel * 4 + 3] >= 96) maskedPixels.push(pixel);
  }
  if (!maskedPixels.length) return;

  // Harmonic inpainting: the marked band is repeatedly relaxed toward the
  // pixels on both sides. This removes a hard join without blurring the page.
  const iterations = Math.max(12, Math.min(96, Math.round(maxRadiusPx * 1.5)));
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const pixel of maskedPixels) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const neighbors = [];
      if (x > 0) neighbors.push(pixel - 1);
      if (x + 1 < width) neighbors.push(pixel + 1);
      if (y > 0) neighbors.push(pixel - width);
      if (y + 1 < height) neighbors.push(pixel + width);
      if (!neighbors.length) continue;
      const offset = pixel * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (const neighbor of neighbors) sum += working[neighbor * 4 + channel];
        working[offset + channel] = Math.round(sum / neighbors.length);
      }
    }
  }

  for (const pixel of maskedPixels) {
    const offset = pixel * 4;
    const blend = featherMask[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel++) {
      image.data[offset + channel] = Math.round(
        image.data[offset + channel] * (1 - blend) + working[offset + channel] * blend,
      );
    }
  }
  ctx.putImageData(image, 0, 0);
}

function drawSeamHealingGuide(ctx, width, height, stroke) {
  ctx.save();
  ctx.fillStyle = "rgba(28, 192, 190, 0.38)";
  ctx.strokeStyle = "rgba(28, 192, 190, 0.52)";
  drawStrokePath(ctx, stroke, width, height);
  ctx.restore();
}

function renderRestoreComposite(ctx, width, height, strokes) {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(restoreGeneratedImage, 0, 0, width, height);
  applyRestoreLayerStrokes(ctx, width, height, strokes);
  applyAutomaticSeamHealing(ctx, width, height, strokes);
}

function drawRestoreEditor() {
  if (!restoreGeneratedImage || !restoreSourceImage || !restoreUnrestoredImage) return;
  const width = restoreCanvas.width;
  const height = restoreCanvas.height;
  restoreCtx.clearRect(0, 0, width, height);

  if (restoreViewMode.value === "original") {
    restoreCtx.drawImage(restoreSourceImage, 0, 0, width, height);
    updateRestoreHelp();
    return;
  }
  if (restoreViewMode.value === "generated") {
    restoreCtx.drawImage(restoreUnrestoredImage, 0, 0, width, height);
    updateRestoreHelp();
    return;
  }
  if (restoreViewMode.value === "base") {
    restoreCtx.drawImage(restoreGeneratedImage, 0, 0, width, height);
    updateRestoreHelp();
    return;
  }

  if (restoreStrokeDraft?.mode === "heal") {
    renderRestoreComposite(restoreCtx, width, height, restoreStrokes);
    drawSeamHealingGuide(restoreCtx, width, height, restoreStrokeDraft);
  } else {
    const visibleStrokes = restoreStrokeDraft
      ? [...restoreStrokes, restoreStrokeDraft]
      : restoreStrokes;
    renderRestoreComposite(restoreCtx, width, height, visibleStrokes);
  }
  updateRestoreHelp();
}

function renderRestoreCompositeBlob() {
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = restoreGeneratedImage.naturalWidth;
  fullCanvas.height = restoreGeneratedImage.naturalHeight;
  renderRestoreComposite(fullCanvas.getContext("2d"), fullCanvas.width, fullCanvas.height, restoreStrokes);
  return new Promise((resolve, reject) => {
    fullCanvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("원본 해상도 편집본을 만들지 못했습니다."));
    }, "image/png");
  });
}

function updateRestoreAdditionalRequestCount() {
  const length = restoreAdditionalRequestInput.value.length;
  restoreAdditionalRequestCount.textContent = `${length} / ${restoreAdditionalRequestInput.maxLength}`;
}

async function loadRestoreEditorImages(batchId, itemId) {
  const previewUrl = `/api/translate-batch/${encodeURIComponent(batchId)}/${encodeURIComponent(itemId)}/edit-base-source`;
  const sourceUrl = `/api/translate-batch/${encodeURIComponent(batchId)}/${encodeURIComponent(itemId)}/restore-source`;
  const unrestoredUrl = `/api/translate-batch/${encodeURIComponent(batchId)}/${encodeURIComponent(itemId)}/unrestored-source`;
  [restoreGeneratedImage, restoreSourceImage, restoreUnrestoredImage] = await Promise.all([
    loadBrowserImage(previewUrl),
    loadBrowserImage(sourceUrl),
    loadBrowserImage(unrestoredUrl),
  ]);

  const maxWidth = 1200;
  const scale = Math.min(1, maxWidth / restoreGeneratedImage.naturalWidth);
  restoreCanvas.width = Math.max(1, Math.round(restoreGeneratedImage.naturalWidth * scale));
  restoreCanvas.height = Math.max(1, Math.round(restoreGeneratedImage.naturalHeight * scale));
  restoreSaveBtn.disabled = false;
  drawRestoreEditor();
}

async function openRestoreEditor(batchId, item) {
  restoreBatchId = batchId;
  restoreItemId = item.id;
  restoreStrokes = Array.isArray(item.manualEditStrokes)
    ? item.manualEditStrokes.map((stroke) => ({
      mode: stroke.mode === "generated" || stroke.mode === "heal" ? stroke.mode : "original",
      radius: stroke.radius,
      points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
    }))
    : [];
  restoreStrokeDraft = null;
  restoreGeneratedImage = null;
  restoreSourceImage = null;
  restoreUnrestoredImage = null;
  restoreViewMode.value = "edit";
  restoreSaveBtn.disabled = true;
  restoreAdditionalRequestPanel.hidden = true;
  restoreAdditionalRequestInput.value = item.generationAdditionalRequest || "";
  restoreAdditionalRequestToggleBtn.disabled = false;
  restoreAdditionalRequestRunBtn.disabled = false;
  updateRestoreAdditionalRequestCount();
  restoreHelp.textContent = "생성본과 전처리 원본을 같은 좌표로 불러오는 중...";
  restoreModal.hidden = false;

  try {
    await loadRestoreEditorImages(batchId, item.id);
  } catch (error) {
    restoreHelp.textContent = `오류: ${error.message}`;
  }
}

function closeRestoreEditor() {
  if (restoreAdditionalRequestRunning) return;
  restoreModal.hidden = true;
  restoreBatchId = null;
  restoreItemId = null;
  restoreGeneratedImage = null;
  restoreSourceImage = null;
  restoreUnrestoredImage = null;
  restoreStrokes = [];
  restoreStrokeDraft = null;
  restoreAdditionalRequestPanel.hidden = true;
  restoreAdditionalRequestInput.value = "";
  restoreAdditionalRequestToggleBtn.disabled = false;
  restoreAdditionalRequestRunBtn.disabled = false;
  updateRestoreAdditionalRequestCount();
  restoreCanvas.width = 1;
  restoreCanvas.height = 1;
}

async function runRestoreAdditionalRequest() {
  if (!restoreBatchId || !restoreItemId) {
    restoreHelp.textContent = "추가요청을 적용할 번역 결과를 다시 열어 주세요.";
    return;
  }
  const additionalRequest = restoreAdditionalRequestInput.value.trim();
  if (!additionalRequest) {
    restoreAdditionalRequestInput.focus();
    restoreHelp.textContent = "생성본에 반영할 추가요청을 입력해 주세요.";
    return;
  }
  if (
    (restoreStrokes.length || restoreStrokeDraft)
    && !window.confirm("현재 브러시 편집은 새 생성본에 맞춰 초기화됩니다. 추가요청으로 재생성할까요?")
  ) {
    return;
  }

  restoreAdditionalRequestToggleBtn.disabled = true;
  restoreAdditionalRequestInput.disabled = true;
  restoreAdditionalRequestCancelBtn.disabled = true;
  restoreAdditionalRequestRunBtn.disabled = true;
  restoreCloseBtn.disabled = true;
  restoreSaveBtn.disabled = true;
  restoreAdditionalRequestRunning = true;
  restoreHelp.textContent = "추가요청을 이미지 생성 모델에 전달해 새 생성본을 만드는 중...";

  try {
    const response = await fetch(
      `/api/translate-batch/${encodeURIComponent(restoreBatchId)}/${encodeURIComponent(restoreItemId)}/regenerate-current-prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ additionalRequest }),
      },
    );
    const data = await readJsonResponse(response, "생성본 추가요청을 반영하지 못했습니다.");
    renderBatch(data.batch);
    restoreStrokes = [];
    restoreStrokeDraft = null;
    restoreGeneratedImage = null;
    restoreSourceImage = null;
    restoreUnrestoredImage = null;
    restoreViewMode.value = "edit";
    restoreAdditionalRequestInput.value = data.additionalRequest || additionalRequest;
    updateRestoreAdditionalRequestCount();
    await loadRestoreEditorImages(restoreBatchId, restoreItemId);
    restoreAdditionalRequestPanel.hidden = true;
    setStatus("생성본 추가요청을 반영했습니다. 새 결과를 확인한 뒤 필요한 부분만 복구 편집해 주세요.");
  } catch (error) {
    restoreHelp.textContent = `오류: ${error.message}`;
  } finally {
    restoreAdditionalRequestToggleBtn.disabled = false;
    restoreAdditionalRequestInput.disabled = false;
    restoreAdditionalRequestCancelBtn.disabled = false;
    restoreAdditionalRequestRunBtn.disabled = false;
    restoreCloseBtn.disabled = false;
    restoreAdditionalRequestRunning = false;
    if (restoreGeneratedImage) restoreSaveBtn.disabled = false;
  }
}

function getRetryMaskBrushRadiusNormalized() {
  const radiusPx = Math.max(4, Number(retryMaskBrushSize.value || 48) / 2);
  return radiusPx / Math.max(1, retryMaskCanvas.width);
}

function retryMaskCanvasPointToNormalized(event) {
  const rect = retryMaskCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function appendRetryMaskPoint(point) {
  if (!retryMaskStrokeDraft) return;
  const points = retryMaskStrokeDraft.points;
  const previous = points[points.length - 1];
  const minDistance = Math.max(0.0015, retryMaskStrokeDraft.radius * 0.35);
  if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minDistance) points.push(point);
}

function updateRetryMaskHelp() {
  if (!retryMaskEntry || !latestBatch) return;
  const count = getMaskShapeCount(retryMaskEntry);
  const regionLabel = getMaskUiCopy(latestBatch.generationMode).regionLabel;
  retryMaskHelp.textContent = `${regionLabel} ${count}회 · 브러시 ${retryMaskBrushSize.value}px · 저장 후 실패 카드의 이미지 생성 재실행을 누르세요.`;
}

function drawRetryMaskEditor() {
  if (!retryMaskImage || !retryMaskEntry) return;
  retryMaskCtx.clearRect(0, 0, retryMaskCanvas.width, retryMaskCanvas.height);
  retryMaskCtx.drawImage(retryMaskImage, 0, 0, retryMaskCanvas.width, retryMaskCanvas.height);
  const strokes = retryMaskStrokeDraft
    ? [...retryMaskEntry.strokes, retryMaskStrokeDraft]
    : retryMaskEntry.strokes;
  drawMaskOverlay(
    retryMaskCtx,
    retryMaskEntry.regions,
    strokes,
    retryMaskCanvas.width,
    retryMaskCanvas.height,
    "rgba(220, 63, 70, 0.38)",
  );
  drawMaskGuides(retryMaskCtx, retryMaskEntry.regions, strokes, retryMaskCanvas.width, retryMaskCanvas.height);
  updateRetryMaskHelp();
}

async function openRetryMaskEditor(batchId, item) {
  retryMaskBatchId = batchId;
  retryMaskItemId = item.id;
  retryMaskEntry = cloneMaskEntry(item.protectionRegions);
  retryMaskStrokeDraft = null;
  retryMaskImage = null;
  const protectedMode = latestBatch?.generationMode === "protected_mask";
  retryMaskTitle.textContent = protectedMode ? "실패 항목 보호영역 편집" : "실패 항목 텍스트 영역 편집";
  retryMaskDescription.textContent = protectedMode
    ? "GPT에 보이지 않게 가린 뒤 원본으로 복원할 영역을 수정합니다."
    : "번역 모델이 수정할 글자와 필요한 주변 배경만 칠합니다. 칠하지 않은 곳은 원본을 유지합니다.";
  retryMaskSaveBtn.disabled = true;
  retryMaskHelp.textContent = "저장된 전처리 원본을 불러오는 중...";
  retryMaskModal.hidden = false;
  try {
    retryMaskImage = await loadBrowserImage(
      `/api/translate-batch/${encodeURIComponent(batchId)}/${encodeURIComponent(item.id)}/restore-source`,
    );
    const maxWidth = 1200;
    const scale = Math.min(1, maxWidth / retryMaskImage.naturalWidth);
    retryMaskCanvas.width = Math.max(1, Math.round(retryMaskImage.naturalWidth * scale));
    retryMaskCanvas.height = Math.max(1, Math.round(retryMaskImage.naturalHeight * scale));
    retryMaskSaveBtn.disabled = false;
    drawRetryMaskEditor();
  } catch (error) {
    retryMaskHelp.textContent = `오류: ${error.message}`;
  }
}

function closeRetryMaskEditor() {
  retryMaskModal.hidden = true;
  retryMaskBatchId = null;
  retryMaskItemId = null;
  retryMaskImage = null;
  retryMaskEntry = null;
  retryMaskStrokeDraft = null;
  retryMaskCanvas.width = 1;
  retryMaskCanvas.height = 1;
}

const TRANSLATION_CONTAINER_OPTIONS = [
  ["speech", "말풍선"],
  ["caption", "캡션"],
  ["sign", "간판/표지"],
  ["sound_effect", "효과음"],
  ["narration", "내레이션"],
  ["other", "기타"],
];
const TRANSLATION_COLOR_OPTIONS = [
  ["none", "기본/자동"], ["red", "빨강"], ["blue", "파랑"], ["green", "초록"],
  ["purple", "보라"], ["pink", "분홍"], ["yellow", "노랑"], ["orange", "주황"],
  ["multicolor", "여러 색"], ["white_on_dark", "어두운 바탕의 흰색"],
  ["colored_on_dark", "어두운 바탕의 색상 글자"], ["other", "기타"],
];
const TRANSLATION_ZONE_OPTIONS = [
  ["top-left", "위 왼쪽"], ["top-center", "위 중앙"], ["top-right", "위 오른쪽"],
  ["middle-left", "중간 왼쪽"], ["middle-center", "중간 중앙"], ["middle-right", "중간 오른쪽"],
  ["bottom-left", "아래 왼쪽"], ["bottom-center", "아래 중앙"], ["bottom-right", "아래 오른쪽"],
];

function selectOptions(options, selected) {
  return options.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`).join("");
}

function renderTranslationEditor() {
  if (!translationDraft) return;
  const items = translationDraftKind === "reading_order"
    ? translationDraft.reading_order
    : translationDraft.blocks;
  translationSummary.textContent = `${items.length}개 항목 · 순서는 이미지의 읽기 순서 및 같은 문구의 위치 대응에 사용됩니다.`;
  translationEditorList.innerHTML = items.map((item, index) => {
    if (translationDraftKind === "blocks") {
      return `<article class="translation-row" data-index="${index}">
        <div class="translation-row-head"><strong>${index + 1}번 번역 블록</strong><div class="translation-row-actions"><button type="button" class="ghost small" data-action="up" title="위로">↑</button><button type="button" class="ghost small" data-action="down" title="아래로">↓</button><button type="button" class="ghost danger small" data-action="delete">삭제</button></div></div>
        <label>번역문<textarea rows="4" data-field="text">${escapeHtml(item.text)}</textarea></label>
      </article>`;
    }
    return `<article class="translation-row" data-index="${index}">
      <div class="translation-row-head"><strong>${index + 1}번 텍스트</strong><div class="translation-row-actions"><button type="button" class="ghost small" data-action="up" title="위로">↑</button><button type="button" class="ghost small" data-action="down" title="아래로">↓</button><button type="button" class="ghost danger small" data-action="delete">삭제</button></div></div>
      <div class="translation-text-grid">
        <label>인식된 원문<textarea rows="3" data-field="source_text">${escapeHtml(item.source_text)}</textarea></label>
        <label>이미지에 넣을 번역문<textarea rows="3" data-field="translated_text">${escapeHtml(item.translated_text)}</textarea></label>
      </div>
      <div class="translation-meta-grid">
        <label>글자 역할<select data-field="container_type">${selectOptions(TRANSLATION_CONTAINER_OPTIONS, item.container_type)}</select></label>
        <label>글자색 힌트<select data-field="text_color_hint">${selectOptions(TRANSLATION_COLOR_OPTIONS, item.text_color_hint)}</select></label>
        <label>대략적인 위치<select data-field="page_zone">${selectOptions(TRANSLATION_ZONE_OPTIONS, item.page_zone)}</select></label>
      </div>
    </article>`;
  }).join("");
}

function openTranslationEditor(batchId, item) {
  translationBatchId = batchId;
  translationItemId = item.id;
  translationDraft = JSON.parse(JSON.stringify(item.translation));
  translationDraftKind = Array.isArray(translationDraft.reading_order) ? "reading_order" : "blocks";
  translationHelp.textContent = "수정사항만 저장하면 현재 생성본은 유지됩니다. 재생성을 눌러야 이미지에 반영됩니다.";
  translationSaveBtn.disabled = false;
  translationSaveRegenerateBtn.disabled = false;
  translationModal.hidden = false;
  renderTranslationEditor();
}

function closeTranslationEditor() {
  translationModal.hidden = true;
  translationBatchId = null;
  translationItemId = null;
  translationDraft = null;
  translationDraftKind = null;
  translationEditorList.innerHTML = "";
}

async function saveTranslationEdits(regenerate = false) {
  if (!translationBatchId || !translationItemId || !translationDraft) return;
  translationSaveBtn.disabled = true;
  translationSaveRegenerateBtn.disabled = true;
  translationHelp.textContent = regenerate ? "수정사항 저장 후 이미지 재생성을 준비 중..." : "수정사항 저장 중...";
  try {
    const response = await fetch(
      `/api/translate-batch/${encodeURIComponent(translationBatchId)}/${encodeURIComponent(translationItemId)}/translation`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ translation: translationDraft }),
      },
    );
    const data = await readJsonResponse(response, "번역 수정사항을 저장하지 못했습니다.");
    const batchId = translationBatchId;
    const itemId = translationItemId;
    renderBatch(data.batch);
    if (!regenerate) {
      closeTranslationEditor();
      setStatus("번역 수정사항을 저장했습니다. 이미지에 반영하려면 번역수정에서 재생성을 실행하세요.");
      return;
    }
    closeTranslationEditor();
    await startGenerationRetry(batchId, itemId, false);
  } catch (error) {
    translationSaveBtn.disabled = false;
    translationSaveRegenerateBtn.disabled = false;
    translationHelp.textContent = `오류: ${error.message}`;
  }
}

async function startGenerationRetry(batchId, itemId, askConfirmation = true) {
  if (askConfirmation && !window.confirm("저장된 번역/영역을 사용해 이 항목의 이미지 생성을 다시 실행할까요?")) return;
  setStatus("이미지 생성 재실행을 등록 중...");
  const response = await fetch(
    `/api/translate-batch/${encodeURIComponent(batchId)}/${encodeURIComponent(itemId)}/retry-generation`,
    { method: "POST" },
  );
  const data = await readJsonResponse(response, "이미지 생성 재실행을 시작하지 못했습니다.");
  activeBatchId = batchId;
  renderBatch(data.batch);
  await pollBatch(batchId);
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragover");
  if (event.dataTransfer.files.length) setFiles(event.dataTransfer.files);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length) setFiles(fileInput.files);
});

loginBtn.addEventListener("click", () => {
  const command = "npx @openai/codex login";
  navigator.clipboard?.writeText(command).catch(() => {});
  window.alert(
    `새 계정으로 로그인하려면 CMD/PowerShell에서 다음 명령을 실행하세요.\n\n${command}\n\n명령을 클립보드에 복사해 두었습니다. 로그인 후 launch-comic-translator.vbs를 다시 실행하세요.`,
  );
});

cleanupBtn.addEventListener("click", async () => {
  const confirmed = window.confirm("output, tmp, 로그 파일만 삭제합니다. 다운로드 폴더는 유지됩니다. 계속할까요?");
  if (!confirmed) return;

  cleanupBtn.disabled = true;
  setStatus("찌꺼기 삭제 중...");

  try {
    const response = await fetch("/api/cleanup", { method: "POST" });
    const data = await readJsonResponse(response, "정리 실패");
    batchList.innerHTML = "";
    latestBatch = null;
    jsonView.textContent = "";
    setStatus(`정리 완료. output ${data.removedOutput}개, tmp ${data.removedTmp}개, log ${data.removedLogs}개 삭제`);
    renderSelectedFiles();
  } catch (error) {
    setStatus(`오류: ${error.message}`);
  } finally {
    cleanupBtn.disabled = false;
  }
});

historyClearBtn.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "화면에 남아 있는 전체 번역 기록과 저장된 분석데이터만 지웁니다.\n\n다운로드 폴더의 번역 결과 이미지와 임시파일은 삭제하지 않습니다. 계속할까요?",
  );
  if (!confirmed) return;

  historyClearBtn.disabled = true;
  setStatus("번역 기록을 지우는 중...");
  try {
    const response = await fetch("/api/translation-history", { method: "DELETE" });
    const data = await readJsonResponse(response, "번역 기록을 지우지 못했습니다.");
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    activeBatchId = null;
    latestBatch = null;
    batchList.innerHTML = "";
    jsonView.textContent = "";
    setStatus(`번역 기록 ${data.removedBatchCount}건을 지웠습니다. 결과 이미지와 임시파일은 유지됩니다.`);
  } catch (error) {
    setStatus(`오류: ${error.message}`);
  } finally {
    historyClearBtn.disabled = false;
  }
});

maskEditorBtn.addEventListener("click", openMaskEditor);
maskCloseBtn.addEventListener("click", closeMaskEditor);
maskModal.addEventListener("click", (event) => {
  if (event.target === maskModal) closeMaskEditor();
});

maskFileSelect.addEventListener("change", () => {
  const index = getMaskFileIndex();
  getMaskEntry(index).invert = false;
  maskInvertCheckbox.checked = false;
  loadMaskImage(index);
});

maskInvertCheckbox.addEventListener("change", () => {
  const index = getMaskFileIndex();
  getMaskEntry(index).invert = false;
  maskInvertCheckbox.checked = false;
  drawMaskEditor();
  renderSelectedFiles();
});

maskBrushSize.addEventListener("input", () => {
  updateMaskHelp();
});

maskUndoBtn.addEventListener("click", () => {
  const index = getMaskFileIndex();
  const maskEntry = getMaskEntry(index);
  if (maskEntry.strokes.length) {
    maskEntry.strokes.pop();
  } else {
    maskEntry.regions.pop();
  }
  drawMaskEditor();
  renderSelectedFiles();
});

maskClearBtn.addEventListener("click", () => {
  const index = getMaskFileIndex();
  const maskEntry = getMaskEntry(index);
  maskEntry.regions = [];
  maskEntry.strokes = [];
  drawMaskEditor();
  renderSelectedFiles();
});

maskCanvas.addEventListener("pointerdown", (event) => {
  if (!maskImage) return;
  event.preventDefault();
  maskCanvas.setPointerCapture(event.pointerId);
  const point = canvasPointToNormalized(event);
  maskStrokeDraft = {
    radius: getBrushRadiusNormalized(),
    points: [point],
  };
  drawMaskEditor();
});

maskCanvas.addEventListener("pointermove", (event) => {
  if (!maskStrokeDraft) return;
  event.preventDefault();
  appendPointToDraft(canvasPointToNormalized(event));
  drawMaskEditor();
});

maskCanvas.addEventListener("pointerup", (event) => {
  if (!maskStrokeDraft) return;
  event.preventDefault();
  appendPointToDraft(canvasPointToNormalized(event));
  const index = getMaskFileIndex();
  const maskEntry = getMaskEntry(index);
  maskEntry.strokes = [...maskEntry.strokes, maskStrokeDraft];
  maskStrokeDraft = null;
  drawMaskEditor();
  renderSelectedFiles();
});

maskCanvas.addEventListener("pointercancel", () => {
  maskStrokeDraft = null;
  drawMaskEditor();
});

batchList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-item-id]");
  if (!button || !latestBatch) return;
  const item = latestBatch.items.find((entry) => entry.id === button.dataset.itemId);
  if (!item) return;
  try {
    if (button.classList.contains("manual-restore-btn")) {
      await openRestoreEditor(button.dataset.batchId, item);
    } else if (button.classList.contains("failed-mask-edit-btn")) {
      await openRetryMaskEditor(button.dataset.batchId, item);
    } else if (button.classList.contains("translation-edit-btn")) {
      openTranslationEditor(button.dataset.batchId, item);
    } else if (button.classList.contains("retry-generation-btn")) {
      button.disabled = true;
      await startGenerationRetry(button.dataset.batchId, item.id, true);
    }
  } catch (error) {
    button.disabled = false;
    setStatus(`오류: ${error.message}`);
  }
});

restoreCloseBtn.addEventListener("click", closeRestoreEditor);
restoreModal.addEventListener("click", (event) => {
  if (event.target === restoreModal) closeRestoreEditor();
});

restoreAdditionalRequestToggleBtn.addEventListener("click", () => {
  restoreAdditionalRequestPanel.hidden = !restoreAdditionalRequestPanel.hidden;
  if (!restoreAdditionalRequestPanel.hidden) {
    restoreAdditionalRequestInput.focus();
    restoreAdditionalRequestInput.setSelectionRange(
      restoreAdditionalRequestInput.value.length,
      restoreAdditionalRequestInput.value.length,
    );
  }
});
restoreAdditionalRequestCancelBtn.addEventListener("click", () => {
  restoreAdditionalRequestPanel.hidden = true;
});
restoreAdditionalRequestInput.addEventListener("input", updateRestoreAdditionalRequestCount);
restoreAdditionalRequestInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runRestoreAdditionalRequest();
  }
});
restoreAdditionalRequestRunBtn.addEventListener("click", runRestoreAdditionalRequest);

restoreBrushSize.addEventListener("input", updateRestoreHelp);
restoreViewMode.addEventListener("change", drawRestoreEditor);
for (const input of restorePaintModeInputs) {
  input.addEventListener("change", () => {
    restoreViewMode.value = "edit";
    updateRestoreHelp();
  });
}

restoreUndoBtn.addEventListener("click", () => {
  restoreStrokes.pop();
  restoreStrokeDraft = null;
  restoreViewMode.value = "edit";
  drawRestoreEditor();
});

restoreClearBtn.addEventListener("click", () => {
  restoreStrokes = [];
  restoreStrokeDraft = null;
  restoreViewMode.value = "edit";
  drawRestoreEditor();
});

restoreCanvas.addEventListener("pointerdown", (event) => {
  if (!restoreGeneratedImage || restoreViewMode.value !== "edit") return;
  event.preventDefault();
  restoreCanvas.setPointerCapture(event.pointerId);
  const selectedMode = restorePaintModeInputs.find((input) => input.checked)?.value || "original";
  restoreStrokeDraft = {
    mode: selectedMode === "generated" || selectedMode === "heal" ? selectedMode : "original",
    radius: getRestoreBrushRadiusNormalized(),
    points: [restoreCanvasPointToNormalized(event)],
  };
  drawRestoreEditor();
});

restoreCanvas.addEventListener("pointermove", (event) => {
  if (!restoreStrokeDraft) return;
  event.preventDefault();
  appendRestorePoint(restoreCanvasPointToNormalized(event));
  drawRestoreEditor();
});

restoreCanvas.addEventListener("pointerup", (event) => {
  if (!restoreStrokeDraft) return;
  event.preventDefault();
  appendRestorePoint(restoreCanvasPointToNormalized(event));
  restoreStrokes = [...restoreStrokes, restoreStrokeDraft];
  restoreStrokeDraft = null;
  drawRestoreEditor();
});

restoreCanvas.addEventListener("pointercancel", () => {
  restoreStrokeDraft = null;
  drawRestoreEditor();
});

restoreSaveBtn.addEventListener("click", async () => {
  if (!restoreBatchId || !restoreItemId) {
    restoreHelp.textContent = "편집할 번역 결과를 다시 열어 주세요.";
    return;
  }
  restoreSaveBtn.disabled = true;
  restoreHelp.textContent = "화면과 같은 합성 방식으로 원본 해상도 편집본을 저장하는 중...";
  try {
    const renderedBlob = await renderRestoreCompositeBlob();
    const formData = new FormData();
    formData.append("editedImage", renderedBlob, "manual-edit.png");
    formData.append("strokes", JSON.stringify(restoreStrokes));
    const response = await fetch(
      `/api/translate-batch/${encodeURIComponent(restoreBatchId)}/${encodeURIComponent(restoreItemId)}/manual-restore`,
      {
        method: "POST",
        body: formData,
      },
    );
    const data = await readJsonResponse(response, "편집본 저장에 실패했습니다.");
    renderBatch(data.batch);
    closeRestoreEditor();
    setStatus(`편집본 저장 완료 (${data.savedStrokeCount}회 칠): ${data.outputPath}`);
  } catch (error) {
    restoreSaveBtn.disabled = false;
    restoreHelp.textContent = `오류: ${error.message}`;
  }
});

retryMaskCloseBtn.addEventListener("click", closeRetryMaskEditor);
retryMaskModal.addEventListener("click", (event) => {
  if (event.target === retryMaskModal) closeRetryMaskEditor();
});
retryMaskBrushSize.addEventListener("input", updateRetryMaskHelp);
retryMaskUndoBtn.addEventListener("click", () => {
  if (!retryMaskEntry) return;
  if (retryMaskEntry.strokes.length) retryMaskEntry.strokes.pop();
  else retryMaskEntry.regions.pop();
  drawRetryMaskEditor();
});
retryMaskClearBtn.addEventListener("click", () => {
  if (!retryMaskEntry) return;
  retryMaskEntry.regions = [];
  retryMaskEntry.strokes = [];
  drawRetryMaskEditor();
});
retryMaskCanvas.addEventListener("pointerdown", (event) => {
  if (!retryMaskImage || !retryMaskEntry) return;
  event.preventDefault();
  retryMaskCanvas.setPointerCapture(event.pointerId);
  retryMaskStrokeDraft = {
    radius: getRetryMaskBrushRadiusNormalized(),
    points: [retryMaskCanvasPointToNormalized(event)],
  };
  drawRetryMaskEditor();
});
retryMaskCanvas.addEventListener("pointermove", (event) => {
  if (!retryMaskStrokeDraft) return;
  event.preventDefault();
  appendRetryMaskPoint(retryMaskCanvasPointToNormalized(event));
  drawRetryMaskEditor();
});
retryMaskCanvas.addEventListener("pointerup", (event) => {
  if (!retryMaskStrokeDraft || !retryMaskEntry) return;
  event.preventDefault();
  appendRetryMaskPoint(retryMaskCanvasPointToNormalized(event));
  retryMaskEntry.strokes = [...retryMaskEntry.strokes, retryMaskStrokeDraft];
  retryMaskStrokeDraft = null;
  drawRetryMaskEditor();
});
retryMaskCanvas.addEventListener("pointercancel", () => {
  retryMaskStrokeDraft = null;
  drawRetryMaskEditor();
});
retryMaskSaveBtn.addEventListener("click", async () => {
  if (!retryMaskBatchId || !retryMaskItemId || !retryMaskEntry) return;
  retryMaskSaveBtn.disabled = true;
  retryMaskHelp.textContent = "수정한 영역을 저장 중...";
  try {
    const response = await fetch(
      `/api/translate-batch/${encodeURIComponent(retryMaskBatchId)}/${encodeURIComponent(retryMaskItemId)}/protection-regions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protectionRegions: retryMaskEntry }),
      },
    );
    const data = await readJsonResponse(response, "영역을 저장하지 못했습니다.");
    renderBatch(data.batch);
    closeRetryMaskEditor();
    setStatus("영역을 저장했습니다. 실패 카드에서 이미지 생성 재실행을 누르세요.");
  } catch (error) {
    retryMaskSaveBtn.disabled = false;
    retryMaskHelp.textContent = `오류: ${error.message}`;
  }
});

translationCloseBtn.addEventListener("click", closeTranslationEditor);
translationModal.addEventListener("click", (event) => {
  if (event.target === translationModal) closeTranslationEditor();
});
translationEditorList.addEventListener("input", (event) => {
  const control = event.target.closest("[data-field]");
  const row = event.target.closest(".translation-row");
  if (!control || !row || !translationDraft) return;
  const index = Number.parseInt(row.dataset.index, 10);
  const items = translationDraftKind === "reading_order" ? translationDraft.reading_order : translationDraft.blocks;
  if (!items[index]) return;
  items[index][control.dataset.field] = control.value;
});
translationEditorList.addEventListener("change", (event) => {
  const control = event.target.closest("select[data-field]");
  const row = event.target.closest(".translation-row");
  if (!control || !row || !translationDraft) return;
  const index = Number.parseInt(row.dataset.index, 10);
  const items = translationDraftKind === "reading_order" ? translationDraft.reading_order : translationDraft.blocks;
  if (items[index]) items[index][control.dataset.field] = control.value;
});
translationEditorList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest(".translation-row");
  if (!button || !row || !translationDraft) return;
  const index = Number.parseInt(row.dataset.index, 10);
  const items = translationDraftKind === "reading_order" ? translationDraft.reading_order : translationDraft.blocks;
  const action = button.dataset.action;
  if (action === "delete") {
    if (items.length === 1) {
      translationHelp.textContent = "번역 항목은 최소 1개가 필요합니다.";
      return;
    }
    items.splice(index, 1);
  } else if (action === "up" && index > 0) {
    [items[index - 1], items[index]] = [items[index], items[index - 1]];
  } else if (action === "down" && index < items.length - 1) {
    [items[index + 1], items[index]] = [items[index], items[index + 1]];
  } else {
    return;
  }
  renderTranslationEditor();
});
translationAddBtn.addEventListener("click", () => {
  if (!translationDraft) return;
  if (translationDraftKind === "reading_order") {
    translationDraft.reading_order.push({
      source_text: "",
      translated_text: "",
      container_type: "speech",
      text_color_hint: "none",
      page_zone: "middle-center",
    });
  } else {
    translationDraft.blocks.push({ text: "" });
  }
  renderTranslationEditor();
  translationEditorList.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
});
translationSaveBtn.addEventListener("click", () => saveTranslationEdits(false));
translationSaveRegenerateBtn.addEventListener("click", () => saveTranslationEdits(true));

presetSelect.addEventListener("change", () => {
  renderSelectedFiles();
});

concurrencySelect.addEventListener("change", () => {
  renderSelectedFiles();
});

generationModeSelect.addEventListener("change", () => {
  saveAppSettings();
  updateMaskModeUi();
  renderSelectedFiles();
});

dictionaryInput.addEventListener("input", () => {
  saveDictionary();
  renderSelectedFiles();
});

dictionaryResetBtn.addEventListener("click", () => {
  dictionaryInput.value = "";
  window.localStorage.removeItem(DICTIONARY_STORAGE_KEY);
  renderSelectedFiles();
});

runBtn.addEventListener("click", async () => {
  if (!selectedFiles.length) return;
  runBtn.disabled = true;
  setStatus("배치 등록 중...");
  batchList.innerHTML = "";
  latestBatch = null;
  jsonView.textContent = "";

  try {
    const formData = new FormData();
    selectedFiles.forEach((file) => formData.append("images", file));
    formData.append("presetId", presetSelect.value || "comic");
    formData.append("concurrency", concurrencySelect.value || "2");
    formData.append("dictionary", dictionaryInput.value || "");
    formData.append("generationMode", generationModeSelect.value || "painted_mask");
    formData.append("splitPageFlags", JSON.stringify(splitPageFlags));
    formData.append(
      "protectionMasks",
      JSON.stringify(protectionMasks.map((entry, index) => {
        const maskEntry = getMaskEntry(index);
        return { index, regions: maskEntry.regions, strokes: maskEntry.strokes, invert: false };
      })),
    );

    const response = await fetch("/api/translate-batch", {
      method: "POST",
      body: formData,
    });
    const data = await readJsonResponse(response, "배치 시작에 실패했습니다.");

    activeBatchId = data.batch.id;
    renderBatch(data.batch);
    await pollBatch(activeBatchId);
  } catch (error) {
    runBtn.disabled = false;
    setStatus(`오류: ${error.message}`);
  }
});

renderSelectedFiles();
loadDictionary();
loadAppSettings();
loadPresets()
  .then(() => refreshHealth())
  .then(() => loadRecentBatch())
  .catch((error) => setStatus(`오류: ${error.message}`));
