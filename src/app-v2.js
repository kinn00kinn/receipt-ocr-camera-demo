import './style.css';
import './ux-v2.css';
import { PaddleOCR } from '@paddleocr/paddleocr-js';

const BURST_COUNT = 3;
const BURST_INTERVAL_MS = 280;
const STILL_MAX_SIDE = 960;
const LIVE_MAX_SIDE = 480;
const LIVE_INTERVAL_MS = 3000;
const REC_BATCH_SIZE = 4;
const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'camera','cameraFrame','startCameraButton','captureButton','fileInput','burstChooser','burstStatus','captureNotice',
  'statusTitle','statusText','statusDot','spinner','resultSection','resultCanvas','retryButton','merchantCandidate',
  'dateCandidate','totalCandidate','subtotalCandidate','taxCandidate','ocrTime','itemCount','receiptItems','structuredJson',
  'timingRows','debugJson','ocrItems','rawJson','lineCount','evaluationVerdict','evaluationScore','evaluationList',
  'liveToggleButton','liveState','liveTiming','liveText','runtimeBadge'
].map((id) => [id, $(id)]));

let stream = null;
let ocr = null;
let ocrPromise = null;
let modelInitMs = null;
let workerMode = true;
let busy = false;
let burstFrames = [];
let liveActive = false;
let liveBusy = false;
let liveTimer = null;
let livePass = 0;

function setStatus(title, text, { busyState = false, error = false, success = false } = {}) {
  els.statusTitle.textContent = title;
  els.statusText.textContent = text;
  els.spinner.hidden = !busyState;
  els.statusDot.className = 'status-dot';
  if (busyState) els.statusDot.classList.add('is-busy');
  if (error) els.statusDot.classList.add('is-error');
  if (success) els.statusDot.classList.add('is-success');
}

async function createEngine(useWorker) {
  return PaddleOCR.create({
    lang: 'japan',
    ocrVersion: 'PP-OCRv5',
    worker: useWorker,
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: REC_BATCH_SIZE,
    ortOptions: {
      backend: 'wasm',
      wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/',
      numThreads: 1,
      simd: true,
    },
  });
}

async function prepareOcr() {
  if (ocr) return ocr;
  if (ocrPromise) return ocrPromise;
  const startedAt = performance.now();
  setStatus('OCRモデルを準備中', '初回のみモデルを読み込みます。撮影は先にできます。', { busyState: true });
  ocrPromise = (async () => {
    try {
      workerMode = true;
      ocr = await createEngine(true);
    } catch (workerError) {
      console.warn('[Receipt OCR v2] worker init failed; fallback to main thread', workerError);
      workerMode = false;
      ocr = await createEngine(false);
    }
    modelInitMs = performance.now() - startedAt;
    els.runtimeBadge.textContent = `PP-OCRv5 / WASM${workerMode ? ' Worker' : ''}`;
    setStatus('OCR準備完了', `モデル初期化 ${fmt(modelInitMs)}。`, { success: true });
    console.debug('[Receipt OCR v2] model ready', { modelInitMs, workerMode, recognitionBatchSize: REC_BATCH_SIZE });
    return ocr;
  })().catch((error) => {
    ocrPromise = null;
    setStatus('OCRモデルの準備に失敗', friendlyError(error), { error: true });
    throw error;
  });
  return ocrPromise;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('カメラを利用できません', '「写真を選択」から画像を指定してください。', { error: true });
    return;
  }
  try {
    els.startCameraButton.disabled = true;
    setStatus('カメラを起動中', 'カメラの使用を許可してください。', { busyState: true });
    stopCamera();
    const t0 = performance.now();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1920 } },
    });
    els.camera.srcObject = stream;
    await els.camera.play();
    els.cameraFrame.classList.add('camera-ready');
    els.captureButton.disabled = false;
    els.liveToggleButton.disabled = false;
    els.startCameraButton.textContent = 'カメラ再起動';
    setStatus('撮影できます', `カメラ起動 ${fmt(performance.now() - t0)}。ボタン1回で3枚連写します。`, { success: true });
  } catch (error) {
    setStatus('カメラを起動できません', cameraErrorMessage(error), { error: true });
  } finally {
    els.startCameraButton.disabled = false;
  }
}

function stopCamera() {
  stopLiveOcr();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  if (els.camera) els.camera.srcObject = null;
}

function flashCamera() {
  els.cameraFrame.classList.remove('burst-flash');
  void els.cameraFrame.offsetWidth;
  els.cameraFrame.classList.add('burst-flash');
  if (navigator.vibrate) navigator.vibrate(20);
}

async function captureBurst() {
  if (!stream || !els.camera.videoWidth || busy) return;
  busy = true;
  stopLiveOcr();
  els.captureButton.disabled = true;
  els.startCameraButton.disabled = true;
  els.burstChooser.hidden = true;
  els.captureNotice.hidden = false;
  burstFrames = [];
  const burstStarted = performance.now();

  try {
    for (let i = 0; i < BURST_COUNT; i += 1) {
      els.burstStatus.textContent = `${i + 1} / ${BURST_COUNT}`;
      els.captureNotice.textContent = `連写中 ${i + 1}/${BURST_COUNT}`;
      await delay(i === 0 ? 180 : BURST_INTERVAL_MS);
      const frame = captureVideoFrame(els.camera, STILL_MAX_SIDE);
      const qualityStarted = performance.now();
      const quality = measureFrameQuality(frame);
      const qualityMs = performance.now() - qualityStarted;
      burstFrames.push({ canvas: frame, quality, qualityMs, capturedAt: performance.now() });
      flashCamera();
    }
    const burstMs = performance.now() - burstStarted;
    renderBurstChooser(burstMs);
    els.captureNotice.textContent = '3枚撮影完了 ✓　使う画像を選んでください';
    setStatus('撮影完了', '3枚から最も読みやすい画像を選択してください。おすすめは自動で表示します。', { success: true });
  } catch (error) {
    console.error('[Receipt OCR v2] burst error', error);
    setStatus('撮影に失敗しました', friendlyError(error), { error: true });
  } finally {
    busy = false;
    els.captureButton.disabled = !stream;
    els.startCameraButton.disabled = false;
  }
}

function captureVideoFrame(video, maxSide) {
  const { width, height } = scaledSize(video.videoWidth, video.videoHeight, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, width, height);
  return canvas;
}

function measureFrameQuality(canvas) {
  const probe = document.createElement('canvas');
  const { width, height } = scaledSize(canvas.width, canvas.height, 180);
  probe.width = width;
  probe.height = height;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  let brightnessSum = 0;
  let clipped = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    gray[p] = g;
    brightnessSum += g;
    if (g < 18 || g > 242) clipped += 1;
  }
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      const lap = Math.abs(4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - width] - gray[p + width]);
      edgeSum += lap;
      edgeCount += 1;
    }
  }
  const sharpness = edgeCount ? edgeSum / edgeCount : 0;
  const brightness = brightnessSum / gray.length;
  const clipping = clipped / gray.length;
  const sharpScore = Math.min(1, sharpness / 22);
  const exposureScore = Math.max(0, 1 - Math.abs(brightness - 145) / 135);
  const clipScore = Math.max(0, 1 - clipping * 4);
  const score = Math.round(100 * (0.68 * sharpScore + 0.22 * exposureScore + 0.10 * clipScore));
  return { score, sharpness: round(sharpness, 2), brightness: round(brightness, 1), clipping: round(clipping, 3) };
}

function renderBurstChooser(burstMs) {
  els.burstChooser.replaceChildren();
  const bestIndex = burstFrames.reduce((best, frame, i, arr) => frame.quality.score > arr[best].quality.score ? i : best, 0);
  burstFrames.forEach((frame, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `burst-choice ${index === bestIndex ? 'is-recommended' : ''}`;
    const preview = document.createElement('canvas');
    preview.width = frame.canvas.width;
    preview.height = frame.canvas.height;
    preview.getContext('2d').drawImage(frame.canvas, 0, 0);
    const label = document.createElement('div');
    label.className = 'burst-choice-label';
    label.innerHTML = `<strong>候補 ${index + 1}${index === bestIndex ? ' · おすすめ' : ''}</strong><span>品質 ${frame.quality.score}/100</span>`;
    button.append(preview, label);
    button.addEventListener('click', () => chooseBurstFrame(index, burstMs));
    els.burstChooser.append(button);
  });
  els.burstChooser.hidden = false;
}

async function chooseBurstFrame(index, burstMs) {
  if (busy) return;
  const selected = burstFrames[index];
  if (!selected) return;
  busy = true;
  els.burstChooser.hidden = true;
  els.captureNotice.textContent = `候補 ${index + 1} を選択 ✓　OCR処理中…`;
  setStatus('OCR実行中', `選択画像 ${selected.canvas.width}×${selected.canvas.height}px を認識しています。`, { busyState: true });
  try {
    await runOcr(selected.canvas, {
      sourceType: 'burst',
      burstCount: BURST_COUNT,
      selectedIndex: index,
      burstMs,
      selectedQuality: selected.quality,
      candidateQualities: burstFrames.map((f) => f.quality),
      processedSize: { width: selected.canvas.width, height: selected.canvas.height },
    });
  } finally {
    busy = false;
    els.captureButton.disabled = !stream;
  }
}

async function loadFile(file) {
  if (!file || busy) return;
  busy = true;
  try {
    const t0 = performance.now();
    const image = await fileToImage(file);
    const decodeMs = performance.now() - t0;
    const canvas = imageToCanvas(image, STILL_MAX_SIDE);
    await runOcr(canvas, {
      sourceType: 'file', decodeMs,
      file: { name: file.name, type: file.type, size: file.size },
      processedSize: { width: canvas.width, height: canvas.height },
      selectedQuality: measureFrameQuality(canvas),
    });
  } catch (error) {
    setStatus('画像処理に失敗', friendlyError(error), { error: true });
  } finally {
    busy = false;
    els.fileInput.value = '';
  }
}

async function runOcr(source, meta) {
  const afterSelectionStarted = performance.now();
  els.resultSection.hidden = true;
  const timing = { decodeMs: meta.decodeMs ?? null, burstMs: meta.burstMs ?? null, modelInitMs, modelWaitMs: null, predictMs: null, rowBuildMs: null, parseMs: null, evaluateMs: null, renderMs: null, totalAfterSelectionMs: null };
  const waitT = performance.now();
  const engine = await prepareOcr();
  timing.modelWaitMs = performance.now() - waitT;
  while (liveBusy) await delay(50);

  const predictT = performance.now();
  const [result] = await engine.predict(source, { textRecScoreThresh: 0.38, textDetBoxThresh: 0.48, textDetLimitSideLen: STILL_MAX_SIDE });
  timing.predictMs = performance.now() - predictT;

  const rowT = performance.now();
  const rows = groupItemsIntoRows(result.items ?? []);
  timing.rowBuildMs = performance.now() - rowT;

  const parseT = performance.now();
  const receipt = parseReceipt(rows);
  timing.parseMs = performance.now() - parseT;

  const evalT = performance.now();
  const evaluation = evaluateReceipt(receipt, result, rows, meta.selectedQuality);
  timing.evaluateMs = performance.now() - evalT;

  const renderT = performance.now();
  renderResult(source, result, rows, receipt, evaluation, timing);
  timing.renderMs = performance.now() - renderT;
  timing.totalAfterSelectionMs = performance.now() - afterSelectionStarted;
  renderTimings(timing);
  els.ocrTime.textContent = fmt(timing.totalAfterSelectionMs);

  const debug = buildDebug({ meta, timing, result, rows, receipt, evaluation });
  els.debugJson.textContent = JSON.stringify(debug, null, 2);
  console.debug('[Receipt OCR v2] completed', debug);
  els.captureNotice.hidden = false;
  els.captureNotice.textContent = `OCR完了 ✓　${evaluation.label}`;
  setStatus('OCR完了', `${result.items?.length ?? 0} boxes / ${rows.length} rows。${evaluation.label}。OCR ${fmt(timing.predictMs)}。`, { success: evaluation.verdict !== 'FAIL', error: evaluation.verdict === 'FAIL' });
  els.resultSection.hidden = false;
  els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function groupItemsIntoRows(items) {
  const boxes = items.map((item, index) => {
    const p = normalizePoly(item.poly);
    if (!item.text || p.length < 3) return null;
    const xs = p.map(([x]) => x); const ys = p.map(([,y]) => y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { index, text: String(item.text).trim(), score: item.score, minX, maxX, minY, maxY, centerY:(minY+maxY)/2, height:Math.max(1,maxY-minY) };
  }).filter(Boolean).sort((a,b) => a.centerY-b.centerY || a.minX-b.minX);
  if (!boxes.length) return [];
  const hs = boxes.map(b=>b.height).sort((a,b)=>a-b); const med = hs[Math.floor(hs.length/2)] || 16; const tol = Math.max(7, med*.65); const rows=[];
  for (const box of boxes) {
    let best=null, dist=Infinity;
    for (const row of rows) { const d=Math.abs(box.centerY-row.centerY); if (d<=Math.max(tol,box.height*.6)&&d<dist){best=row;dist=d;} }
    if (!best) rows.push({items:[box],centerY:box.centerY}); else {best.items.push(box);best.centerY=best.items.reduce((s,x)=>s+x.centerY,0)/best.items.length;}
  }
  return rows.map(row => {
    row.items.sort((a,b)=>a.minX-b.minX); const scores=row.items.map(i=>i.score).filter(Number.isFinite);
    return { text:row.items.map(i=>i.text).join(' ').replace(/\s+/g,' ').trim(), parts:row.items.map(i=>({text:i.text,score:i.score,x:i.minX})), score:scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null, y:row.centerY };
  }).sort((a,b)=>a.y-b.y);
}

function parseReceipt(rows) {
  const r = rows.map((row,index)=>({...row,index,normalized:normalizeReceiptText(row.text),amounts:extractAmounts(row.text)}));
  const date=findDateCandidate(r.map(x=>x.text));
  const totalHit=findTaggedAmount(r,/(総合計|合計|お支払|お買上|現計|TOTAL|税込合計)/i,/(小計|税)/i);
  const subtotalHit=findTaggedAmount(r,/(小計|SUBTOTAL)/i);
  const taxHit=findTaggedAmount(r,/(消費税|内税|外税|税額|TAX)/i);
  const totalIndex=totalHit?.index ?? r.length;
  const merchant=findMerchant(r);
  const items=[];
  for (const row of r) {
    if (row.index>=totalIndex || !row.amounts.length || isMetadataRow(row.normalized)) continue;
    const amount=row.amounts.at(-1); if(!Number.isFinite(amount)||amount<=0||amount>9999999) continue;
    let name=stripTrailingAmount(row.text).replace(/^[*＊・\-–—\s]+/,'').trim();
    if(!name||name.length<2||/^(小計|合計|消費税|内税|外税|お預り|お釣り|現金|クレジット)/i.test(normalizeReceiptText(name))) continue;
    items.push({name,amount:Math.round(amount),confidence:Number.isFinite(row.score)?round(row.score,3):null,sourceText:row.text});
  }
  return { merchant,date,total:totalHit?.amount??null,subtotal:subtotalHit?.amount??null,tax:taxHit?.amount??null,items,parser:{rows:r.length,totalRow:totalHit?.text??null,subtotalRow:subtotalHit?.text??null,taxRow:taxHit?.text??null} };
}

function evaluateReceipt(receipt, result, rows, imageQuality) {
  const scores=(result.items??[]).map(i=>i.score).filter(Number.isFinite); const avgConf=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:0;
  const criteria=[];
  const push=(key,label,status,score,max,detail,blocking=false)=>criteria.push({key,label,status,score,max,detail,blocking});
  const totalOk=Number.isFinite(receipt.total)&&receipt.total>0&&receipt.total<10000000;
  push('total','合計金額',totalOk?'PASS':'FAIL',totalOk?25:0,25,totalOk?formatMoney(receipt.total):'合計を確定できません',true);
  const dateOk=Boolean(receipt.date);
  push('date','日付',dateOk?'PASS':'REVIEW',dateOk?15:5,15,dateOk?receipt.date:'未検出。登録前に確認',false);
  const merchantOk=Boolean(receipt.merchant)&&receipt.merchant.length>=2;
  push('merchant','店名',merchantOk?'PASS':'REVIEW',merchantOk?10:4,10,merchantOk?receipt.merchant:'未検出。登録前に確認',false);
  const confStatus=avgConf>=.75?'PASS':avgConf>=.58?'REVIEW':'FAIL';
  push('confidence','OCR信頼度',confStatus,confStatus==='PASS'?20:confStatus==='REVIEW'?10:0,20,`平均 ${Math.round(avgConf*100)}%`,avgConf<.50);
  const q=imageQuality?.score ?? null; const qStatus=q==null?'REVIEW':q>=55?'PASS':q>=35?'REVIEW':'FAIL';
  push('image','画像品質',qStatus,qStatus==='PASS'?10:qStatus==='REVIEW'?5:0,10,q==null?'評価なし':`${q}/100`,false);
  let consistencyStatus='REVIEW', consistencyDetail='比較できる小計・税額が不足';
  if (Number.isFinite(receipt.total)&&Number.isFinite(receipt.subtotal)&&Number.isFinite(receipt.tax)) {
    const diff=Math.abs((receipt.subtotal+receipt.tax)-receipt.total); const tol=Math.max(3,receipt.total*.02); consistencyStatus=diff<=tol?'PASS':'REVIEW'; consistencyDetail=`小計+税との差 ${formatMoney(diff)}`;
  }
  push('consistency','金額整合性',consistencyStatus,consistencyStatus==='PASS'?10:5,10,consistencyDetail,false);
  const itemConf=receipt.items.map(i=>i.confidence).filter(Number.isFinite); const itemAvg=itemConf.length?itemConf.reduce((a,b)=>a+b,0)/itemConf.length:null;
  const itemStatus=receipt.items.length&&itemAvg>=.65?'PASS':'REVIEW';
  push('items','商品明細',itemStatus,itemStatus==='PASS'?10:5,10,receipt.items.length?`${receipt.items.length}件 / 平均${Math.round((itemAvg??0)*100)}%`:'明細なし（取引登録には必須ではない）',false);
  const score=criteria.reduce((s,c)=>s+c.score,0); const blockingFail=criteria.some(c=>c.blocking&&c.status==='FAIL');
  let verdict='REVIEW'; if(blockingFail) verdict='FAIL'; else if(score>=80&&totalOk&&dateOk&&merchantOk&&avgConf>=.70) verdict='PASS';
  const label=verdict==='PASS'?'自動登録可能':verdict==='REVIEW'?'要確認':'登録不可';
  return {verdict,label,score,maxScore:100,avgConfidence:round(avgConf,3),criteria,policy:{autoRegister:'合計必須・日付/店名必須・平均OCR信頼度70%以上・総合80点以上・致命的FAILなし',review:'合計は取れたが他項目に不確実性あり。ユーザー確認後に登録',reject:'合計欠落、またはOCR信頼度が極端に低い場合は登録しない'}};
}

function renderResult(source,result,rows,receipt,evaluation,timing){
  drawOverlay(source,result.items??[]); renderOcrItems(result.items??[]); renderReceipt(receipt); renderEvaluation(evaluation);
  els.merchantCandidate.textContent=receipt.merchant??'—'; els.dateCandidate.textContent=receipt.date??'—'; els.totalCandidate.textContent=formatMoney(receipt.total)??'—'; els.subtotalCandidate.textContent=formatMoney(receipt.subtotal)??'—'; els.taxCandidate.textContent=formatMoney(receipt.tax)??'—'; els.itemCount.textContent=`${receipt.items.length} items`; els.lineCount.textContent=`${result.items?.length??0} boxes / ${rows.length} rows`;
  els.structuredJson.textContent=JSON.stringify(receipt,null,2); els.rawJson.textContent=JSON.stringify({image:result.image,metrics:result.metrics,runtime:result.runtime,items:result.items},null,2);
}

function renderEvaluation(ev){
  els.evaluationVerdict.textContent=ev.label; els.evaluationVerdict.className=`evaluation-verdict ${ev.verdict.toLowerCase()}`; els.evaluationScore.textContent=`${ev.score}/100`;
  els.evaluationList.replaceChildren(); for(const c of ev.criteria){const row=document.createElement('div');row.className='evaluation-row';row.innerHTML=`<div><strong>${escapeHtml(c.label)}</strong><span>${escapeHtml(c.detail)}</span></div><div class="evaluation-right"><b class="criterion ${c.status.toLowerCase()}">${c.status}</b><em>${c.score}/${c.max}</em></div>`;els.evaluationList.append(row);}
}

function renderReceipt(receipt){els.receiptItems.replaceChildren(); if(!receipt.items.length){els.receiptItems.innerHTML='<p class="empty-state">商品明細は特定できませんでした。取引単位の登録判定とは分離しています。</p>';return;} for(const item of receipt.items){const row=document.createElement('div');row.className='receipt-item-row';row.innerHTML=`<span class="receipt-item-name">${escapeHtml(item.name)}</span><strong>${formatMoney(item.amount)??'—'}</strong>`;els.receiptItems.append(row);}}
function renderOcrItems(items){els.ocrItems.replaceChildren();items.forEach((item,i)=>{const row=document.createElement('div');row.className='ocr-row';row.innerHTML=`<span class="ocr-index">${String(i+1).padStart(2,'0')}</span><span class="ocr-text">${escapeHtml(item.text||'')}</span><span class="ocr-score">${Number.isFinite(item.score)?Math.round(item.score*100)+'%':'—'}</span>`;els.ocrItems.append(row);});}
function drawOverlay(source,items){els.resultCanvas.width=source.width;els.resultCanvas.height=source.height;const ctx=els.resultCanvas.getContext('2d');ctx.drawImage(source,0,0);ctx.lineWidth=Math.max(2,source.width/500);ctx.strokeStyle='#0b7a75';for(const item of items){const p=normalizePoly(item.poly);if(p.length<3)continue;ctx.beginPath();ctx.moveTo(...p[0]);p.slice(1).forEach(x=>ctx.lineTo(...x));ctx.closePath();ctx.stroke();}}
function renderTimings(t){const labels={decodeMs:'画像デコード',burstMs:'3枚連写',modelInitMs:'モデル初期化（初回）',modelWaitMs:'モデル待機',predictMs:'OCR推論',rowBuildMs:'行再構成',parseMs:'レシート解析',evaluateMs:'登録判定',renderMs:'画面描画',totalAfterSelectionMs:'選択後の総処理'};els.timingRows.replaceChildren();for(const [k,l] of Object.entries(labels)){if(!Number.isFinite(t[k]))continue;const tr=document.createElement('tr');tr.innerHTML=`<th>${l}</th><td>${t[k].toFixed(1)}</td>`;els.timingRows.append(tr);}}
function buildDebug({meta,timing,result,rows,receipt,evaluation}){return{timestamp:new Date().toISOString(),browser:{userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency??null,deviceMemoryGB:navigator.deviceMemory??null,secureContext:window.isSecureContext},config:{stillMaxSide:STILL_MAX_SIDE,liveMaxSide:LIVE_MAX_SIDE,burstCount:BURST_COUNT,burstIntervalMs:BURST_INTERVAL_MS,recognitionBatchSize:REC_BATCH_SIZE,workerMode,backend:'wasm'},input:meta,model:{modelInitMs},timing,paddle:{metrics:result.metrics,runtime:result.runtime,boxes:result.items?.length??0},rows:rows.map(r=>({text:r.text,score:r.score,y:r.y})),receipt,evaluation};}

async function startLiveOcr(){if(!stream||liveActive)return;liveActive=true;livePass=0;els.liveToggleButton.textContent='停止';els.liveState.textContent='実行中';await prepareOcr();scheduleLive(0);}
function stopLiveOcr(){liveActive=false;if(liveTimer)clearTimeout(liveTimer);liveTimer=null;if(els.liveToggleButton){els.liveToggleButton.textContent='開始';els.liveState.textContent='停止中';}}
function scheduleLive(ms=LIVE_INTERVAL_MS){if(liveActive)liveTimer=setTimeout(runLive,ms);}
async function runLive(){if(!liveActive||!stream)return;if(liveBusy||busy){scheduleLive(500);return;}liveBusy=true;try{const canvas=captureVideoFrame(els.camera,LIVE_MAX_SIDE);const t=performance.now();const [result]=await ocr.predict(canvas,{textRecScoreThresh:.45,textDetBoxThresh:.52,textDetLimitSideLen:LIVE_MAX_SIDE});const predictMs=performance.now()-t;const rows=groupItemsIntoRows(result.items??[]);const receipt=parseReceipt(rows);livePass+=1;els.liveTiming.textContent=`${fmt(predictMs)} / pass ${livePass}`;els.liveText.textContent=[receipt.merchant&&`店名: ${receipt.merchant}`,receipt.total&&`合計: ${formatMoney(receipt.total)}`,...rows.slice(0,8).map(r=>r.text)].filter(Boolean).join('\n');console.debug('[Receipt OCR v2] live',{pass:livePass,predictMs,boxes:result.items?.length??0});}catch(e){els.liveText.textContent=`エラー: ${friendlyError(e)}`;}finally{liveBusy=false;scheduleLive();}}

function findTaggedAmount(rows,include,exclude=null){const c=rows.filter(r=>include.test(r.normalized)&&(!exclude||!exclude.test(r.normalized))&&r.amounts.length).map(r=>({index:r.index,text:r.text,amount:Math.round(r.amounts.at(-1))}));return c.at(-1)??null;}
function findMerchant(rows){const top=rows.slice(0,8).filter(r=>!isMetadataRow(r.normalized));const scored=top.map(r=>{const letters=(r.text.match(/[A-Za-zぁ-んァ-ヶ一-龠]/g)??[]).length;const digits=(r.text.match(/[0-9０-９]/g)??[]).length;const bonus=/(店|ストア|STORE|SHOP|マート|スーパー|AEON|EON|market|mart|drug|薬局|cafe)/i.test(r.text)?10:0;return{r,s:letters*2-digits+bonus-r.index*.4};}).sort((a,b)=>b.s-a.s);return scored[0]?.r.text??null;}
function isMetadataRow(t){return/(TEL|電話|〒|住所|レシート|領収|日時|担当|レジ|NO\.?|取引|伝票|カード|会員|ポイント|お預り|お釣り|現金|クレジット|電子マネー|税率|対象額|小計|合計|消費税|内税|外税|TAX)/i.test(t)||Boolean(findDateCandidate([t]))||/^\s*\d{1,2}:\d{2}/.test(t);}
function extractAmounts(text){const n=normalizeDigits(text).replace(/[¥￥]/g,' ');return[...n.matchAll(/(?:^|\s)([0-9]{1,3}(?:[,][0-9]{3})+|[0-9]{1,7})(?=\s*円?\s*$|\s)/g)].map(m=>Number(m[1].replace(/,/g,''))).filter(Number.isFinite);}
function stripTrailingAmount(t){return normalizeDigits(t).replace(/\s*[¥￥]?\s*[0-9]{1,3}(?:,[0-9]{3})*\s*円?\s*$/,'').trim();}
function normalizeReceiptText(t){return normalizeDigits(String(t)).replace(/合[勤勣動訊汁]/g,'合計').replace(/小[勤勣動訊汁]/g,'小計').replace(/\s+/g,' ').trim();}
function findDateCandidate(lines){const n=lines.map(normalizeDigits).join(' ');const m=n.match(/([0-9]{4,5})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})\s*日?/);if(m){const years=yearCandidates(m[1]);for(const year of years){const mo=Number(m[2]),d=Number(m[3]);if(validDateParts(year,mo,d))return`${year}/${String(mo).padStart(2,'0')}/${String(d).padStart(2,'0')}`;}}const s=n.match(/(\d{2})[\/\.\-](\d{1,2})[\/\.\-](\d{1,2})/);if(s){const y=2000+Number(s[1]),mo=Number(s[2]),d=Number(s[3]);if(validDateParts(y,mo,d))return`${y}/${String(mo).padStart(2,'0')}/${String(d).padStart(2,'0')}`;}return null;}
function yearCandidates(s){const out=[];if(s.length===4)out.push(Number(s));if(s.length===5){for(let i=0;i<5;i+=1)out.push(Number(s.slice(0,i)+s.slice(i+1)));}return[...new Set(out)].filter(y=>y>=2000&&y<=2099);}
function normalizeDigits(t){return String(t).replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xfee0)).replace(/：/g,':').replace(/／/g,'/').replace(/－/g,'-').replace(/，/g,',').replace(/．/g,'.');}
function normalizePoly(poly){if(!Array.isArray(poly))return[];return poly.map(p=>Array.isArray(p)?[Number(p[0]),Number(p[1])]:p&&'x'in p?[Number(p.x),Number(p.y)]:null).filter(p=>p&&p.every(Number.isFinite));}
function validDateParts(y,m,d){const x=new Date(y,m-1,d);return x.getFullYear()===y&&x.getMonth()===m-1&&x.getDate()===d;}
function scaledSize(w,h,max){const s=Math.min(1,max/Math.max(w,h));return{width:Math.round(w*s),height:Math.round(h*s)};}
function imageToCanvas(img,max){const s=scaledSize(img.naturalWidth,img.naturalHeight,max),c=document.createElement('canvas');c.width=s.width;c.height=s.height;c.getContext('2d',{alpha:false}).drawImage(img,0,0,s.width,s.height);return c;}
function fileToImage(file){return new Promise((resolve,reject)=>{const u=URL.createObjectURL(file),img=new Image();img.onload=()=>{URL.revokeObjectURL(u);resolve(img)};img.onerror=()=>{URL.revokeObjectURL(u);reject(new Error('Image decode failed'))};img.src=u;});}
function formatMoney(v){return Number.isFinite(v)?`¥${Math.round(v).toLocaleString('ja-JP')}`:null;}
function fmt(ms){return Number.isFinite(ms)?(ms>=1000?`${(ms/1000).toFixed(2)} s`:`${Math.round(ms)} ms`):'—';}
function round(v,n=2){const p=10**n;return Math.round(v*p)/p;}
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
function friendlyError(e){return e?.message??'不明なエラー';}
function cameraErrorMessage(e){if(e?.name==='NotAllowedError')return'カメラが許可されていません。サイト設定から許可してください。';if(e?.name==='NotFoundError')return'カメラが見つかりません。';return friendlyError(e);}
function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

els.startCameraButton.addEventListener('click',startCamera);
els.captureButton.addEventListener('click',captureBurst);
els.fileInput.addEventListener('change',()=>loadFile(els.fileInput.files?.[0]));
els.liveToggleButton.addEventListener('click',()=>liveActive?stopLiveOcr():startLiveOcr());
els.retryButton.addEventListener('click',()=>{els.resultSection.hidden=true;els.burstChooser.hidden=true;els.captureNotice.hidden=true;window.scrollTo({top:0,behavior:'smooth'});});
window.addEventListener('pagehide',stopCamera);

(async()=>{prepareOcr().catch(()=>{});try{const p=await navigator.permissions?.query?.({name:'camera'});if(p?.state==='granted')startCamera();}catch{}})();
