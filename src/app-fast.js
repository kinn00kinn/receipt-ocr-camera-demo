import { PaddleOCR } from '@paddleocr/paddleocr-js';

// Fast bootstrap for the existing v2 UI.
// - PP-OCRv6 tiny: much smaller/faster mobile-oriented det+rec pair
// - WebGPU first, WASM fallback
// - Downscale still-image inference to 720 px while mapping OCR polygons back
//   to the original 960 px preview used by app-v2.js.

const params = new URLSearchParams(location.search);
const FAST_SIDE = Math.max(480, Math.min(960, Number(params.get('ocrSide')) || 720));
const forceWasm = params.get('backend') === 'wasm';
const disableFastResize = params.get('hq') === '1';
const originalCreate = PaddleOCR.create.bind(PaddleOCR);

function getWasmThreads() {
  if (!globalThis.crossOriginIsolated) return 1;
  return Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
}

function isCanvas(value) {
  return typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement;
}

function resizeCanvas(source, maxSide) {
  if (!isCanvas(source)) return { input: source, scaleX: 1, scaleY: 1, original: null };
  const max = Math.max(source.width, source.height);
  if (disableFastResize || max <= maxSide) {
    return { input: source, scaleX: 1, scaleY: 1, original: { width: source.width, height: source.height } };
  }

  const scale = maxSide / max;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, width, height);

  return {
    input: canvas,
    scaleX: source.width / width,
    scaleY: source.height / height,
    original: { width: source.width, height: source.height },
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

function setRuntimeBadge(result) {
  const badge = document.getElementById('runtimeBadge');
  if (!badge) return;
  const provider = result?.runtime?.recProvider || result?.runtime?.detProvider || (forceWasm ? 'wasm' : 'auto');
  badge.textContent = `PP-OCRv6 tiny / ${String(provider).toUpperCase()} · ${FAST_SIDE}px`;
}

PaddleOCR.create = async function fastCreate(options = {}) {
  const { lang, ocrVersion, ...rest } = options;
  const engine = await originalCreate({
    ...rest,
    textDetectionModelName: 'PP-OCRv6_tiny_det',
    textRecognitionModelName: 'PP-OCRv6_tiny_rec',
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: 8,
    ortOptions: {
      ...(rest.ortOptions || {}),
      backend: forceWasm ? 'wasm' : 'auto',
      wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/',
      numThreads: getWasmThreads(),
      simd: true,
    },
  });

  const originalPredict = engine.predict.bind(engine);
  engine.predict = async (input, predictOptions = {}) => {
    // app-v2 uses one canvas at a time. Keep non-canvas and array inputs untouched.
    if (Array.isArray(input) || !isCanvas(input)) {
      const results = await originalPredict(input, predictOptions);
      setRuntimeBadge(results?.[0]);
      return results;
    }

    const transform = resizeCanvas(input, FAST_SIDE);
    const effectiveLimit = disableFastResize
      ? predictOptions.textDetLimitSideLen
      : Math.min(Number(predictOptions.textDetLimitSideLen) || FAST_SIDE, FAST_SIDE);

    const results = await originalPredict(transform.input, {
      ...predictOptions,
      textDetLimitSideLen: effectiveLimit,
      // Official demo default is 0.6; this also avoids spending recognition
      // time on weaker detection boxes in the receipt use case.
      textDetBoxThresh: Math.max(Number(predictOptions.textDetBoxThresh) || 0, 0.6),
    });

    const remapped = results.map((result) => remapResult(result, transform));
    const first = remapped[0];
    if (first) {
      first.runtime = {
        ...(first.runtime || {}),
        fastPath: {
          model: 'PP-OCRv6_tiny',
          inputSide: Math.max(transform.input.width || 0, transform.input.height || 0),
          displaySide: transform.original ? Math.max(transform.original.width, transform.original.height) : null,
          forcedWasm: forceWasm,
          hq: disableFastResize,
        },
      };
    }
    setRuntimeBadge(first);
    return remapped;
  };

  return engine;
};

const badge = document.getElementById('runtimeBadge');
if (badge) badge.textContent = `PP-OCRv6 tiny / WebGPU preferred · ${FAST_SIDE}px`;

await import('./app-v2.js');

// app-v2 updates the badge when initialization finishes. Keep the model/backend
// description accurate until the first prediction reveals the actual provider.
if (badge && !badge.textContent.includes('PP-OCRv6')) {
  badge.textContent = `PP-OCRv6 tiny / WebGPU preferred · ${FAST_SIDE}px`;
}
