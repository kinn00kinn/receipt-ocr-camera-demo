const cameraFrame = document.getElementById('cameraFrame');
const captureCanvas = document.getElementById('captureCanvas');
const captureButton = document.getElementById('captureButton');
const startCameraButton = document.getElementById('startCameraButton');
const retryButton = document.getElementById('retryButton');
const captureNotice = document.getElementById('captureNotice');
const captureNoticeTitle = document.getElementById('captureNoticeTitle');
const captureNoticeText = document.getElementById('captureNoticeText');
const statusTitle = document.getElementById('statusTitle');

let captureLocked = false;
let feedbackTimer = null;

function setNotice(state, title, text) {
  captureNotice.hidden = false;
  captureNotice.className = `capture-notice ${state}`;
  captureNoticeTitle.textContent = title;
  captureNoticeText.textContent = text;
}

function showCapturedFrame() {
  if (!captureCanvas.width || !captureCanvas.height) return;

  captureCanvas.hidden = false;
  cameraFrame.classList.remove('did-capture');
  // Force the flash animation to restart on every capture.
  void cameraFrame.offsetWidth;
  cameraFrame.classList.add('did-capture');

  setNotice('is-processing', '撮影完了 ✓', '画像を固定しました。OCRを処理しています…');
  captureButton.textContent = '撮影済み ✓';

  if (navigator.vibrate) navigator.vibrate(35);

  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    cameraFrame.classList.remove('did-capture');
  }, 500);
}

function resetCaptureFeedback() {
  captureLocked = false;
  captureCanvas.hidden = true;
  captureNotice.hidden = true;
  captureNotice.className = 'capture-notice';
  captureButton.textContent = '撮影して OCR';
  cameraFrame.classList.remove('did-capture');
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = null;
}

// Capture phase lets us prevent an accidental second capture while the frozen
// frame is still being shown. The normal OCR handler runs afterward on the
// first click.
captureButton.addEventListener(
  'click',
  (event) => {
    if (captureLocked) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    captureLocked = true;
    // The existing capture handler draws into captureCanvas synchronously
    // before its first OCR await. Show that exact frame on the next paint.
    requestAnimationFrame(showCapturedFrame);
  },
  true,
);

startCameraButton.addEventListener('click', resetCaptureFeedback, true);
retryButton.addEventListener('click', resetCaptureFeedback, true);

const statusObserver = new MutationObserver(() => {
  if (!captureLocked) return;
  const title = statusTitle.textContent.trim();

  if (title === 'OCR完了') {
    setNotice('is-complete', 'OCR完了 ✓', '撮影と文字認識が完了しました。結果を下で確認できます。');
  } else if (title.includes('失敗')) {
    setNotice('is-error', 'OCRエラー', '撮影は完了しましたが、文字認識に失敗しました。');
  } else if (title === 'OCR実行中') {
    setNotice('is-processing', '撮影完了 ✓', '画像を固定しました。OCRを処理しています…');
  }
});

statusObserver.observe(statusTitle, { childList: true, characterData: true, subtree: true });
