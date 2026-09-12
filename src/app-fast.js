import { PaddleOCR } from '@paddleocr/paddleocr-js';

// Runtime manager for the existing receipt UI.
// Design rules:
// - keep at most one real OCR engine alive
// - lazy-load the real model only when predict() is first requested
// - dispose worker/session before changing OCR modes
// - keep the heavier Japanese model off WebGPU on mobile
// - switch modes from UI controls, never URL parameters
// - aggressively release temporary canvases and preview copies

const MODE_STORAGE_KEY = 'receipt-ocr-mode-v4';
const LAST_ERROR_KEY = 'receipt-ocr-last-runtime-error-v4';
const originalCreate = PaddleOCR.create.bind(PaddleOCR);

const MODES = Object.freeze({
  fast: Object.freeze({
    id: 'fast',
    label: '高速',
    short: '速度優先',
    description: 'PP-OCRv6 tiny / 576px / WebGPU。スマホ向けの推奨モード。',
    detectionModel: 'PP-OCRv6_tiny_det',
    recognitionModel: 'PP-OCRv6_tiny_rec',
    backend: 'auto',
    inputSide: 576,
    liveSide: 320,
    recognitionBatchSize: 8,
    detBoxThresh: 0.62,
    recScoreThresh: 0.42,
    timeoutMs: 15000,
    initTimeoutMs: 35000,
  }),
  standard: Object.freeze({
    id: 'standard',
    label: '標準',
    short: '精度と速度',
    description: 'PP-OCRv6 tiny / 720px / WebGPU。文字が小さいレシート向け。',
    detectionModel: 'PP-OCRv6_tiny_det',
    recognitionModel: 'PP-OCRv6_tiny_rec',
    backend: 'auto',
    inputSide: 720,
    liveSide: 360,
    recognitionBatchSize: 6,
    detBoxThresh: 0.56,
    recScoreThresh: 0.38,
    timeoutMs: 22000,
    initTimeoutMs: 40000,
  }),
  japanese: Object.freeze({
    id: 'japanese',
    label: '日本語優先',
    short: '日本語精度優先',
    description: 'tiny検出 + PP-OCRv5 mobile認識 / 640px / WASM Worker。遅いがGPUメモリを圧迫しにくい。',
    detectionModel: 'PP-OCRv6_tiny_det',
    recognitionModel: 'PP-OCRv5_mobile_rec',
    backend: 'wasm',
    inputSide: 640,
    liveSide: 320,
    recognitionBatchSize: 2,
    detBoxThresh: 0.56,
    recScoreThresh: 0.34,
    timeoutMs: 45000,
    initTimeoutMs: 55000,
  }),
});

let activeModeId = sessionStorage.getItem(MODE_STORAGE_KEY);
if (!MODES[activeModeId]) activeModeId = 'fast';
let activeMode = MODES[activeModeId];

let realEngine = null;
let realEnginePromise = null;
let realEngineModeId = null;
let realModelInitMs = null;
let resolvedWorkerMode = true;
let engineGeneration = 0;
let debugPatchBusy = false;
let modeUi = null;
let predictInFlight = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getStatusElements() {
  return {
    title: document.getElementById('statusTitle'),
    text: document.getElementById('statusText'),
    spinner: document.getElementById('spinner'),
    notice: document.getElementById('captureNotice'),
    badge: document.getElementById('runtimeBadge'),
  };
}

function setRuntimeStatus(title, text, busy = false) {
  const els = getStatusElements();
  if (els.title) els.title.textContent = title;
  if (els.text) els.text.textContent = text;
  if (els.spinner) els.spinner.hidden = !busy;
}

function memorySnapshot() {
  const memory = performance?.memory;
  if (!memory) return null;
  return {
    usedJSHeapMB: Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10,
    totalJSHeapMB: Math.round((memory.totalJSHeapSize / 1048576) * 10) / 10,
    jsHeapLimitMB: Math.round((memory.jsHeapSizeLimit / 1048576) * 10) / 10,
  };
}

function hasWebGpu() {
  return Boolean(navigator.gpu);
}

function isCanvas(value) {
  return typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement;
}

function releaseCanvas(canvas) {
  if (!isCanvas(canvas)) return;
  try {
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  } catch {}
  canvas.width = 1;
  canvas.height = 1;
}

function shrinkPreviewCanvas(canvas, maxSide = 240) {
  if (!isCanvas(canvas) || Math.max(canvas.width, canvas.height) <= maxSide) return;
  const scale = maxSide / Math.max(canvas.width, canvas.height);
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const tiny = document.createElement('canvas');
  tiny.width = width;
  tiny.height = height;
  tiny.getContext('2d', { alpha: false })?.drawImage(canvas, 0, 0, width, height);
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { alpha: false })?.drawImage(tiny, 0, 0);
  releaseCanvas(tiny);
}

function resizeCanvas(source, maxSide) {
  if (!isCanvas(source)) {
    return { input: source, scaleX: 1, scaleY: 1, original: null, temporary: false };
  }
  const max = Math.max(source.width, source.height);
  if (max <= maxSide) {
    return {
      input: source,
      scaleX: 1,
      scaleY: 1,
      original: { width: source.width, height: source.height },
      temporary: false,
    };
  }

  const scale = maxSide / max;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(source, 0, 0, width, height);
  }

  return {
    input: canvas,
    scaleX: source.width / width,
    scaleY: source.height / height,
    original: { width: source.width, height: source.height },
    temporary: true,
  };
}

function rescalePoly(poly, scaleX, scaleY) {
  if (!Array.isArray(poly) || (scaleX === 1 && scaleY === 1)) return poly;
  return poly.map((point) => {
    if (Array.isArray(point) && point.length >= 2) {
      return [Number(point[0]) * scaleX, Number(point[1]) * scaleY];
    }
    if (point && typeof point === 'object' && 'x' in point && 'y' in point) {
      return { ...point, x: Number(point.x) * scaleX, y: Number(point.y) * scaleY };
    }
    return point;
  });
}

function remapResult(result, transform) {
  if (!transform.original || (transform.scaleX === 1 && transform.scaleY === 1)) return result;
  return {
    ...result,
    image: { width: transform.original.width, height: transform.original.height },
    items: (result.items || []).map((item) => ({
      ...item,
      poly: rescalePoly(item.poly, transform.scaleX, transform.scaleY),
    })),
  };
}

function updateRuntimeBadge(result = null) {
  const badge = document.getElementById('runtimeBadge');
  if (!badge) return;
  const provider = result?.runtime?.recProvider || result?.runtime?.detProvider;
  const providerLabel = provider
    ? String(provider).toUpperCase()
    : activeMode.backend === 'wasm'
      ? 'WASM'
      : 'WebGPU preferred';
  badge.textContent = `${activeMode.label} · ${providerLabel} · ${activeMode.inputSide}px`;
}

function createModeUi() {
  if (document.getElementById('ocrModePanel')) return;
  const anchor = document.querySelector('.intro-card');
  if (!anchor) return;

  const style = document.createElement('style');
  style.textContent = `
    .ocr-mode-card { padding: 14px 16px; }
    .ocr-mode-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .ocr-mode-head strong { font-size:14px; }
    .ocr-mode-head span { font-size:12px; opacity:.68; }
    .ocr-mode-buttons { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
    .ocr-mode-button { appearance:none; border:1px solid rgba(30,41,59,.16); border-radius:10px; background:rgba(255,255,255,.7); color:inherit; padding:9px 6px; min-height:50px; cursor:pointer; font:inherit; }
    .ocr-mode-button:disabled { cursor:not-allowed; opacity:.48; }
    .ocr-mode-button strong,.ocr-mode-button small { display:block; }
    .ocr-mode-button strong { font-size:13px; }
    .ocr-mode-button small { margin-top:2px; font-size:10px; opacity:.65; }
    .ocr-mode-button.is-active { border-color:currentColor; box-shadow:inset 0 0 0 1px currentColor; }
    .ocr-mode-description { margin:10px 0 0; font-size:12px; line-height:1.55; opacity:.78; }
    .ocr-mode-memory { margin-top:6px; font-size:11px; opacity:.62; }
    @media(max-width:520px){ .ocr-mode-buttons { grid-template-columns:1fr; } .ocr-mode-button { min-height:42px; text-align:left; padding:9px 11px; } }
  `;
  document.head.append(style);

  const card = document.createElement('section');
  card.id = 'ocrModePanel';
  card.className = 'card ocr-mode-card';
  card.innerHTML = `
    <div class="ocr-mode-head">
      <div><strong>OCRモード</strong><br><span>URLを変更せず、この画面から切り替えます。</span></div>
      <span id="ocrModeEngineState">モデル未読込</span>
    </div>
    <div class="ocr-mode-buttons" role="group" aria-label="OCRモード"></div>
    <p id="ocrModeDescription" class="ocr-mode-description"></p>
    <p id="ocrModeMemory" class="ocr-mode-memory">モデルは最初のOCR時だけ読み込みます。モード変更時は旧モデルをdisposeします。</p>
  `;
  anchor.after(card);

  const buttons = card.querySelector('.ocr-mode-buttons');
  Object.values(MODES).forEach((mode) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ocr-mode-button';
    button.dataset.mode = mode.id;
    button.innerHTML = `<strong>${mode.label}</strong><small>${mode.short}</small>`;
    button.addEventListener('click', () => switchMode(mode.id));
    buttons.append(button);
  });
  modeUi = card;
  renderModeUi();
}

function renderModeUi() {
  updateRuntimeBadge();
  if (!modeUi) return;
  modeUi.querySelectorAll('.ocr-mode-button').forEach((button) => {
    const selected = button.dataset.mode === activeMode.id;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    button.disabled = predictInFlight > 0;
  });
  const description = document.getElementById('ocrModeDescription');
  if (description) description.textContent = activeMode.description;
  const state = document.getElementById('ocrModeEngineState');
  if (state) {
    state.textContent = predictInFlight > 0
      ? 'OCR実行中'
      : realEngine || realEnginePromise
        ? 'モデル読込済み'
        : 'モデル未読込';
  }
  const mem = document.getElementById('ocrModeMemory');
  const snapshot = memorySnapshot();
  if (mem) {
    mem.textContent = snapshot
      ? `モデルは最初のOCR時だけ読み込みます。JS heap ${snapshot.usedJSHeapMB} / ${snapshot.jsHeapLimitMB} MB。モード変更時は旧モデルをdisposeします。`
      : 'モデルは最初のOCR時だけ読み込みます。モード変更時は旧モデルをdisposeします。';
  }
}

async function disposeRealEngine({ hardReloadOnFailure = false } = {}) {
  engineGeneration += 1;
  const engine = realEngine;
  realEngine = null;
  realEnginePromise = null;
  realEngineModeId = null;
  realModelInitMs = null;
  renderModeUi();
  if (!engine?.dispose) return true;

  try {
    const completed = await Promise.race([
      Promise.resolve(engine.dispose()).then(() => true),
      sleep(1500).then(() => false),
    ]);
    if (!completed && hardReloadOnFailure) {
      sessionStorage.setItem(LAST_ERROR_KEY, 'OCR workerの解放が完了しなかったため、ページを再初期化しました。');
      location.reload();
      return false;
    }
    return completed;
  } catch (error) {
    console.warn('[Receipt OCR runtime] dispose failed', error);
    if (hardReloadOnFailure) {
      sessionStorage.setItem(LAST_ERROR_KEY, 'OCR workerの解放に失敗したため、ページを再初期化しました。');
      location.reload();
    }
    return false;
  }
}

async function switchMode(nextModeId) {
  if (!MODES[nextModeId] || nextModeId === activeMode.id) return;
  if (predictInFlight > 0) {
    setRuntimeStatus('OCR実行中はモード変更できません', '現在のOCRが完了してから切り替えてください。', false);
    return;
  }

  const previousMode = activeMode;
  activeModeId = nextModeId;
  activeMode = MODES[nextModeId];
  sessionStorage.setItem(MODE_STORAGE_KEY, nextModeId);
  setRuntimeStatus('OCRモードを変更中', `${previousMode.label} → ${activeMode.label}。旧モデルを解放しています。`, true);
  renderModeUi();

  if (realEngine || realEnginePromise) {
    const released = await disposeRealEngine({ hardReloadOnFailure: true });
    if (!released) return;
  }

  setRuntimeStatus('OCRモードを変更しました', `${activeMode.label}: ${activeMode.description}`, false);
  renderModeUi();
}

function engineOptions(mode, worker, backendOverride = null) {
  const backend = backendOverride || mode.backend;
  const ortOptions = { backend, simd: true };
  if (backend === 'wasm') ortOptions.numThreads = 1;
  return {
    textDetectionModelName: mode.detectionModel,
    textRecognitionModelName: mode.recognitionModel,
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: mode.recognitionBatchSize,
    worker,
    ortOptions,
  };
}

function armInitializationWatchdog(mode) {
  return setTimeout(() => {
    sessionStorage.setItem(
      LAST_ERROR_KEY,
      `${mode.label}モードのモデル初期化が${Math.round(mode.initTimeoutMs / 1000)}秒を超えたため、ページを安全に再初期化しました。`,
    );
    location.reload();
  }, mode.initTimeoutMs);
}

async function createRealEngine(mode, generation) {
  const startedAt = performance.now();
  setRuntimeStatus('OCRモデルを読み込み中', `${mode.label}モードを初期化しています。`, true);

  let engine;
  let backendFallback = false;
  let watchdog = armInitializationWatchdog(mode);
  try {
    try {
      engine = await originalCreate(engineOptions(mode, true));
      resolvedWorkerMode = true;
    } catch (error) {
      if (mode.backend !== 'auto') throw error;
      clearTimeout(watchdog);
      console.warn('[Receipt OCR runtime] WebGPU/auto worker init failed; retrying WASM worker', error);
      backendFallback = true;
      watchdog = armInitializationWatchdog(mode);
      engine = await originalCreate(engineOptions(mode, true, 'wasm'));
      resolvedWorkerMode = true;
    }
  } finally {
    clearTimeout(watchdog);
  }

  if (generation !== engineGeneration || mode.id !== activeMode.id) {
    try { await engine.dispose?.(); } catch {}
    throw new Error('OCR mode changed during initialization');
  }

  realModelInitMs = performance.now() - startedAt;
  realEngineModeId = mode.id;
  realEngine = engine;
  renderModeUi();
  setRuntimeStatus(
    'OCRモデル準備完了',
    `${mode.label}モデル ${Math.round(realModelInitMs)} ms${backendFallback ? '（WASM fallback）' : ''}`,
    false,
  );
  console.debug('[Receipt OCR runtime] engine ready', {
    mode: mode.id,
    modelInitMs: realModelInitMs,
    worker: resolvedWorkerMode,
    memory: memorySnapshot(),
    backendFallback,
  });
  return engine;
}

async function ensureRealEngine() {
  if (realEngine && realEngineModeId === activeMode.id) return realEngine;
  if (realEnginePromise && realEngineModeId === activeMode.id) return realEnginePromise;

  if (realEngine && realEngineModeId !== activeMode.id) {
    await disposeRealEngine({ hardReloadOnFailure: true });
  }

  const generation = engineGeneration;
  const mode = activeMode;
  realEngineModeId = mode.id;
  realEnginePromise = createRealEngine(mode, generation).catch((error) => {
    realEngine = null;
    realEnginePromise = null;
    realEngineModeId = null;
    renderModeUi();
    throw error;
  });
  return realEnginePromise;
}

function timeoutError(mode, isLive) {
  const seconds = Math.round((isLive ? Math.min(mode.timeoutMs, 12000) : mode.timeoutMs) / 1000);
  return new Error(`OCR timeout after ${seconds} s`);
}

async function predictWithTimeout(engine, input, params, mode, isLive) {
  const timeoutMs = isLive ? Math.min(mode.timeoutMs, 12000) : mode.timeoutMs;
  let timer;
  try {
    return await Promise.race([
      engine.predict(input, params).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(mode, isLive)), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (String(error?.message || '').includes('OCR timeout')) {
      const els = getStatusElements();
      if (els.title) els.title.textContent = 'OCRを安全停止します';
      if (els.text) els.text.textContent = '推論が長時間終了しないため、Worker/GPUセッションを破棄して再初期化します。';
      if (els.spinner) els.spinner.hidden = true;
      if (els.notice) {
        els.notice.hidden = false;
        els.notice.textContent = 'OCRタイムアウト — エンジンを再初期化します';
      }
      sessionStorage.setItem(LAST_ERROR_KEY, `${mode.label}モードがタイムアウトしたためOCRエンジンを再初期化しました。`);
      // Promise.race alone does not cancel the worker request. dispose() is mandatory here.
      const released = await disposeRealEngine({ hardReloadOnFailure: false });
      if (!released) setTimeout(() => location.reload(), 250);
    }
    throw error;
  }
}

function augmentRuntime(result, transform, mode, isLive, memoryBefore) {
  if (!result) return result;
  result.runtime = {
    ...(result.runtime || {}),
    runtimeManager: {
      mode: mode.id,
      modeLabel: mode.label,
      detectionModel: mode.detectionModel,
      recognitionModel: mode.recognitionModel,
      requestedBackend: mode.backend,
      workerMode: resolvedWorkerMode,
      inputSide: Math.max(transform.input?.width || 0, transform.input?.height || 0),
      displaySide: transform.original ? Math.max(transform.original.width, transform.original.height) : null,
      recognitionBatchSize: mode.recognitionBatchSize,
      detBoxThresh: mode.detBoxThresh,
      recScoreThresh: mode.recScoreThresh,
      modelInitMs: realModelInitMs,
      timeoutMs: isLive ? Math.min(mode.timeoutMs, 12000) : mode.timeoutMs,
      lazyLoaded: true,
      memoryBefore,
      memoryAfter: memorySnapshot(),
    },
  };
  return result;
}

async function runtimePredict(input, predictOptions = {}) {
  const mode = activeMode;
  const isLiveCanvas = isCanvas(input) && Math.max(input.width, input.height) <= 500;
  const maxSide = isLiveCanvas ? mode.liveSide : mode.inputSide;
  const transform = resizeCanvas(input, maxSide);
  const memoryBefore = memorySnapshot();
  predictInFlight += 1;
  renderModeUi();

  try {
    const engine = await ensureRealEngine();
    const params = {
      ...predictOptions,
      textDetLimitSideLen: Math.min(Number(predictOptions.textDetLimitSideLen) || maxSide, maxSide),
      textDetBoxThresh: Math.max(Number(predictOptions.textDetBoxThresh) || 0, mode.detBoxThresh),
      textRecScoreThresh: Math.max(Number(predictOptions.textRecScoreThresh) || 0, mode.recScoreThresh),
    };

    const results = await predictWithTimeout(engine, transform.input, params, mode, isLiveCanvas);
    const remapped = results.map((result) => augmentRuntime(
      remapResult(result, transform),
      transform,
      mode,
      isLiveCanvas,
      memoryBefore,
    ));
    updateRuntimeBadge(remapped[0]);
    return remapped;
  } finally {
    predictInFlight = Math.max(0, predictInFlight - 1);
    if (transform.temporary) releaseCanvas(transform.input);
    renderModeUi();
  }
}

// app-v2 calls PaddleOCR.create() during page initialization. Return a lightweight lazy proxy
// immediately. The actual PaddleOCR engine is created only on the first predict().
PaddleOCR.create = async function createLazyRuntimeProxy() {
  return {
    predict: runtimePredict,
    async dispose() { await disposeRealEngine({ hardReloadOnFailure: false }); },
    getInitializationSummary() { return null; },
    getModelConfig() { return null; },
  };
};

function installDebugPatcher() {
  const debugEl = document.getElementById('debugJson');
  if (!debugEl) return;
  new MutationObserver(() => {
    if (debugPatchBusy) return;
    const text = debugEl.textContent?.trim();
    if (!text?.startsWith('{')) return;
    let debug;
    try { debug = JSON.parse(text); } catch { return; }
    const manager = debug?.paddle?.runtime?.runtimeManager;
    if (!manager) return;

    debugPatchBusy = true;
    try {
      debug.config = {
        ...(debug.config || {}),
        activeMode: manager.mode,
        activeModeLabel: manager.modeLabel,
        inferenceSide: manager.inputSide,
        requestedBackend: manager.requestedBackend,
        actualDetProvider: debug?.paddle?.runtime?.detProvider ?? null,
        actualRecProvider: debug?.paddle?.runtime?.recProvider ?? null,
        detectionModel: manager.detectionModel,
        recognitionModel: manager.recognitionModel,
        recognitionBatchSize: manager.recognitionBatchSize,
        workerMode: manager.workerMode,
        lazyModelLoading: true,
      };
      debug.model = {
        ...(debug.model || {}),
        realModelInitMs: manager.modelInitMs,
      };
      debug.memory = {
        beforeInference: manager.memoryBefore,
        afterInference: manager.memoryAfter,
      };
      debugEl.textContent = JSON.stringify(debug, null, 2);

      const timingRows = document.getElementById('timingRows');
      if (timingRows && Number.isFinite(manager.modelInitMs) && !timingRows.querySelector('[data-runtime-init]')) {
        const row = document.createElement('tr');
        row.dataset.runtimeInit = 'true';
        row.innerHTML = `<th>実モデル初期化</th><td>${manager.modelInitMs.toFixed(1)}</td>`;
        timingRows.prepend(row);
      }
    } finally {
      queueMicrotask(() => { debugPatchBusy = false; });
    }
  }).observe(debugEl, { childList: true, characterData: true, subtree: true });
}

function installMemoryGuards() {
  const chooser = document.getElementById('burstChooser');
  if (chooser) {
    const shrinkNewPreviews = () => {
      chooser.querySelectorAll('canvas').forEach((canvas) => shrinkPreviewCanvas(canvas, 240));
    };
    new MutationObserver(shrinkNewPreviews).observe(chooser, { childList: true, subtree: true });
    chooser.addEventListener('click', () => {
      setTimeout(() => {
        chooser.querySelectorAll('canvas').forEach(releaseCanvas);
        chooser.replaceChildren();
      }, 0);
    }, { capture: true });
  }

  const retryButton = document.getElementById('retryButton');
  retryButton?.addEventListener('click', () => {
    setTimeout(() => releaseCanvas(document.getElementById('resultCanvas')), 0);
  }, { capture: true });

  const liveButton = document.getElementById('liveToggleButton');
  liveButton?.addEventListener('click', (event) => {
    if (activeMode.id === 'japanese') {
      event.preventDefault();
      event.stopImmediatePropagation();
      setRuntimeStatus(
        'リアルタイムOCRは高速/標準モード専用です',
        '日本語優先モードではメモリ負荷を避けるため無効化しています。',
        false,
      );
    }
  }, { capture: true });
}

function restoreLastRuntimeMessage() {
  const message = sessionStorage.getItem(LAST_ERROR_KEY);
  if (!message) return;
  sessionStorage.removeItem(LAST_ERROR_KEY);
  setTimeout(() => setRuntimeStatus('OCRランタイムを再初期化しました', message, false), 100);
}

createModeUi();
updateRuntimeBadge();

await import('./app-v2.js');
await import('./ui-extras.js');

createModeUi();
installDebugPatcher();
installMemoryGuards();
restoreLastRuntimeMessage();
renderModeUi();

const footer = document.querySelector('footer p');
if (footer) footer.textContent = 'PaddleOCR.js · one-engine runtime · lazy model loading · Worker disposal';

window.addEventListener('pagehide', () => {
  void disposeRealEngine({ hardReloadOnFailure: false });
});

console.debug('[Receipt OCR runtime] boot', {
  mode: activeMode.id,
  webgpuAvailable: hasWebGpu(),
  lazyModelLoading: true,
  memory: memorySnapshot(),
});
