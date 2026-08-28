// ============================================================
// Mobile Camera OCR Quiz Auto-Answer — vanilla JS implementation
// Follows plan.md phases 1-7, adapted to a static client-only app
// (no Next.js/Supabase/Vercel — plain HTML + JS + local questions.json)
// ============================================================

const els = {
  desktopView: document.getElementById('desktopView'),
  mobileView: document.getElementById('mobileView'),
  qrImg: document.getElementById('qrImg'),
  desktopUrl: document.getElementById('desktopUrl'),
  screenShareBtn: document.getElementById('screenShareBtn'),
  video: document.getElementById('video'),
  canvas: document.getElementById('captureCanvas'),
  captureBtn: document.getElementById('captureBtn'),
  continuousToggle: document.getElementById('continuousToggle'),
  statusText: document.getElementById('statusText'),
  fpsText: document.getElementById('fpsText'),
  resultPanel: document.getElementById('resultPanel'),
  resultSpinner: document.getElementById('resultSpinner'),
  resultAnswer: document.getElementById('resultAnswer'),
  resultConfidence: document.getElementById('resultConfidence'),
  resultQuestion: document.getElementById('resultQuestion'),
  rawTextBox: document.getElementById('rawTextBox'),
  closeResult: document.getElementById('closeResult'),
  permError: document.getElementById('permError'),
  permErrorMsg: document.getElementById('permErrorMsg'),
  frameOverlay: document.getElementById('frameOverlay'),
  roiLayer: document.getElementById('roiLayer'),
  roiRect: document.getElementById('roiRect'),
  roiSaved: document.getElementById('roiSaved'),
  roiHint: document.getElementById('roiHint'),
  calibrateBtn: document.getElementById('calibrateBtn'),
};

// ---------- Phase 5/7: Data layer — load questions into memory Map ----------
let questionMap = new Map();   // normalized question -> answer
let questionList = [];         // [{question, answer}] for Fuse.js
let fuse = null;

async function loadQuestions() {
  const res = await fetch('questions.json');
  const data = await res.json();
  questionList = data.map(item => ({
    question: item.question,
    answer: item.answer,
    norm: normalize(item.question),
  }));
  questionMap = new Map(questionList.map(q => [q.norm, q.answer]));
  // Match on the normalized form: OCR noise lives in the characters normalize() strips.
  fuse = new Fuse(questionList, {
    keys: ['norm'],
    includeScore: true,
    threshold: 0.5,
    ignoreLocation: true,
    minMatchCharLength: 4,
  });
}

// ---------- Phase 5: normalize text ----------
// Tesseract on stylised game fonts emits stray punctuation and drops spaces
// unpredictably, so strip everything that is not a Thai/Latin/digit character
// and compare on the bare letter sequence.
function normalize(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^฀-๿a-z0-9]/g, '');
}

// ---------- Phase 1: device detection ----------
function isMobileDevice() {
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const uaMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return coarsePointer || uaMobile;
}

function initDeviceView() {
  if (isMobileDevice()) {
    els.mobileView.style.display = 'block';
    startCamera();
  } else {
    els.desktopView.style.display = 'flex';
    const url = window.location.href;
    els.desktopUrl.textContent = url;
    els.qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(url);
    els.screenShareBtn.addEventListener('click', () => {
      els.desktopView.style.display = 'none';
      els.mobileView.style.display = 'block';
      startScreenShare();
    });
  }
}

// ---------- Phase 2: camera capture ----------
let stream = null;
let continuousMode = false;
let continuousTimer = null;
const CONTINUOUS_INTERVAL_MS = 1500;

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    els.video.srcObject = stream;
  } catch (err) {
    els.mobileView.style.display = 'none';
    els.permError.style.display = 'flex';
    els.permErrorMsg.textContent = err.message || 'กรุณาอนุญาตการใช้กล้อง';
  }
}

// Desktop live capture: getDisplayMedia asks the browser's own screen-share
// picker (window/tab/screen) — a standard consent dialog, not an OS permission.
async function startScreenShare() {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false,
    });
    els.video.srcObject = stream;
    // if user stops sharing via the browser's own "Stop sharing" bar
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      els.mobileView.style.display = 'none';
      els.desktopView.style.display = 'flex';
    });
  } catch (err) {
    els.mobileView.style.display = 'none';
    els.permError.style.display = 'flex';
    els.permErrorMsg.textContent = err.message || 'ไม่ได้อนุญาตให้แชร์หน้าจอ';
  }
}

// ---------- Phase 4 (calibration): ROI stored as fractions of the video frame ----------
// Cropping to just the question line is what makes OCR accurate here — the full
// game screen carries icons, portraits and decorative text that Tesseract merges
// into the question and wrecks the match.
const ROI_KEY = 'quizRoi';
let roi = loadRoi();

function loadRoi() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROI_KEY));
    if (saved && saved.w > 0.01 && saved.h > 0.005) return saved;
  } catch (_) { /* ignore malformed value */ }
  return null;
}

function saveRoi(next) {
  roi = next;
  localStorage.setItem(ROI_KEY, JSON.stringify(next));
  renderSavedRoi();
}

// Video is object-fit:cover, so the displayed box crops the source frame.
// Convert between the two coordinate spaces to keep the drawn box honest.
function videoGeometry() {
  const rect = els.video.getBoundingClientRect();
  const vw = els.video.videoWidth || 1;
  const vh = els.video.videoHeight || 1;
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const drawnW = vw * scale;
  const drawnH = vh * scale;
  return {
    rect,
    offsetX: (rect.width - drawnW) / 2,
    offsetY: (rect.height - drawnH) / 2,
    drawnW,
    drawnH,
  };
}

function screenRectToRoi(box) {
  const g = videoGeometry();
  return {
    x: (box.left - g.offsetX) / g.drawnW,
    y: (box.top - g.offsetY) / g.drawnH,
    w: box.width / g.drawnW,
    h: box.height / g.drawnH,
  };
}

function renderSavedRoi() {
  if (!roi) {
    els.roiSaved.style.display = 'none';
    els.frameOverlay.classList.remove('hidden');
    return;
  }
  const g = videoGeometry();
  els.frameOverlay.classList.add('hidden');
  els.roiSaved.style.display = 'block';
  els.roiSaved.style.left = `${g.offsetX + roi.x * g.drawnW}px`;
  els.roiSaved.style.top = `${g.offsetY + roi.y * g.drawnH}px`;
  els.roiSaved.style.width = `${roi.w * g.drawnW}px`;
  els.roiSaved.style.height = `${roi.h * g.drawnH}px`;
}

function startCalibration() {
  els.roiLayer.classList.add('active');
  els.roiHint.classList.add('show');
  els.frameOverlay.classList.add('hidden');
  els.roiSaved.style.display = 'none';
}

function endCalibration() {
  els.roiLayer.classList.remove('active');
  els.roiHint.classList.remove('show');
  els.roiRect.style.display = 'none';
}

let dragStart = null;
function onDragStart(e) {
  const p = pointerPos(e);
  dragStart = p;
  els.roiRect.style.display = 'block';
  els.roiRect.style.left = `${p.x}px`;
  els.roiRect.style.top = `${p.y}px`;
  els.roiRect.style.width = '0px';
  els.roiRect.style.height = '0px';
  e.preventDefault();
}

function onDragMove(e) {
  if (!dragStart) return;
  const p = pointerPos(e);
  els.roiRect.style.left = `${Math.min(dragStart.x, p.x)}px`;
  els.roiRect.style.top = `${Math.min(dragStart.y, p.y)}px`;
  els.roiRect.style.width = `${Math.abs(p.x - dragStart.x)}px`;
  els.roiRect.style.height = `${Math.abs(p.y - dragStart.y)}px`;
  e.preventDefault();
}

function onDragEnd(e) {
  if (!dragStart) return;
  const p = pointerPos(e);
  const box = {
    left: Math.min(dragStart.x, p.x),
    top: Math.min(dragStart.y, p.y),
    width: Math.abs(p.x - dragStart.x),
    height: Math.abs(p.y - dragStart.y),
  };
  dragStart = null;
  endCalibration();
  if (box.width < 20 || box.height < 10) {
    els.frameOverlay.classList.remove('hidden');
    return;
  }
  saveRoi(screenRectToRoi(box));
  els.statusText.textContent = 'บันทึกกรอบคำถามแล้ว';
}

function pointerPos(e) {
  const rect = els.roiLayer.getBoundingClientRect();
  const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
  const src = touch || e;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

// ---------- Phase 2/3: capture the ROI and prepare it for OCR ----------
const OCR_TARGET_HEIGHT = 220; // upscale small text so Tesseract sees real glyphs

function captureFrame() {
  const video = els.video;
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  const src = roi
    ? {
        x: Math.max(0, Math.round(roi.x * vw)),
        y: Math.max(0, Math.round(roi.y * vh)),
        w: Math.min(vw, Math.round(roi.w * vw)),
        h: Math.min(vh, Math.round(roi.h * vh)),
      }
    : { x: 0, y: 0, w: vw, h: vh };

  const scale = roi ? Math.max(1, OCR_TARGET_HEIGHT / src.h) : 1;
  const canvas = els.canvas;
  canvas.width = Math.round(src.w * scale);
  canvas.height = Math.round(src.h * scale);

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ---------- Phase 3: preprocess (grayscale -> Otsu binarize) ----------
function preprocess(canvas) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;

  const gray = new Uint8Array(d.length / 4);
  const histogram = new Array(256).fill(0);
  for (let i = 0, g = 0; i < d.length; i += 4, g++) {
    const v = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    gray[g] = v;
    histogram[v]++;
  }

  const threshold = otsuThreshold(histogram, gray.length);
  for (let i = 0, g = 0; i < d.length; i += 4, g++) {
    const v = gray[g] > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];

  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > best) { best = variance; threshold = t; }
  }
  return threshold;
}

// ---------- Phase 3: OCR pipeline (Tesseract.js, client-side) ----------
let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await Tesseract.createWorker('tha+eng');
  await ocrWorker.setParameters({
    // ROI is a single question line, so treat it as one block of text
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1',
  });
  return ocrWorker;
}

async function runOcr(canvas) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas);
  return data; // { text, lines: [...], words: [...] }
}

// ---------- Phase 4: pick the question text out of the OCR result ----------
function extractQuestion(ocrData) {
  const lines = (ocrData.lines || [])
    .map(l => l.text.trim())
    .filter(Boolean);

  if (lines.length === 0) return ocrData.text.trim();

  // Inside a calibrated ROI every line belongs to the question, so join them.
  if (roi) return lines.join(' ');

  // Uncalibrated fallback: line with '?' wins, else the longest line up top.
  const withMark = lines.find(l => l.includes('?'));
  if (withMark) return withMark;
  return lines.slice(0, Math.ceil(lines.length / 2))
    .reduce((a, b) => (b.length > a.length ? b : a), '');
}

// ---------- Phase 5: matching logic ----------
function matchAnswer(question) {
  const norm = normalize(question);

  // 1) exact match
  if (questionMap.has(norm)) {
    return { answer: questionMap.get(norm), confidence: 'high', matchedQuestion: question };
  }

  // 2) fuzzy match via Fuse.js
  const results = fuse.search(norm);
  if (results.length > 0) {
    const best = results[0];
    const confidence = best.score <= 0.35 ? 'high' : 'low';
    return { answer: best.item.answer, confidence, matchedQuestion: best.item.question };
  }

  return { answer: null, confidence: 'low', matchedQuestion: null };
}

// ---------- Phase 6: display result ----------
function showResult({ answer, confidence, matchedQuestion, rawText }) {
  els.resultSpinner.style.display = 'none';
  els.resultAnswer.textContent = answer || 'ไม่พบคำตอบที่ตรงกัน';
  els.resultQuestion.textContent = matchedQuestion ? `คำถามที่จับคู่: ${matchedQuestion}` : '';
  els.resultConfidence.textContent = answer
    ? (confidence === 'high' ? 'มั่นใจสูง' : 'ไม่ค่อยมั่นใจ — ลองสแกนใหม่')
    : '';
  els.resultConfidence.className = confidence === 'high' ? 'conf-high' : 'conf-low';
  els.rawTextBox.textContent = rawText ? `ข้อความที่อ่านได้: ${rawText}` : '';
  els.resultPanel.classList.add('show');
}

function showLoading() {
  els.resultAnswer.textContent = '';
  els.resultConfidence.textContent = '';
  els.resultQuestion.textContent = '';
  els.rawTextBox.textContent = '';
  els.resultSpinner.style.display = 'block';
  els.resultPanel.classList.add('show');
}

function hideResult() {
  els.resultPanel.classList.remove('show');
}

// ---------- Orchestration: capture -> preprocess -> OCR -> match -> display ----------
let busy = false;
async function scanOnce() {
  if (busy) return;
  busy = true;
  els.captureBtn.classList.add('busy');
  els.statusText.textContent = 'กำลังสแกน...';
  showLoading();

  const t0 = performance.now();
  try {
    const canvas = captureFrame();
    preprocess(canvas);
    const ocrData = await runOcr(canvas);
    const question = extractQuestion(ocrData);
    const { answer, confidence, matchedQuestion } = matchAnswer(question);
    showResult({ answer, confidence, matchedQuestion, rawText: ocrData.text.trim() });
  } catch (err) {
    showResult({ answer: null, confidence: 'low', matchedQuestion: null, rawText: 'เกิดข้อผิดพลาด: ' + err.message });
  } finally {
    const elapsed = Math.round(performance.now() - t0);
    els.statusText.textContent = `พร้อมสแกน (${elapsed}ms)`;
    els.captureBtn.classList.remove('busy');
    busy = false;
  }
}

function toggleContinuous() {
  continuousMode = !continuousMode;
  els.continuousToggle.textContent = `โหมดต่อเนื่อง: ${continuousMode ? 'เปิด' : 'ปิด'}`;
  els.continuousToggle.classList.toggle('active', continuousMode);
  if (continuousMode) {
    continuousTimer = setInterval(() => { if (!busy) scanOnce(); }, CONTINUOUS_INTERVAL_MS);
  } else {
    clearInterval(continuousTimer);
  }
}

// ---------- Wire up events ----------
els.captureBtn.addEventListener('click', scanOnce);
els.continuousToggle.addEventListener('click', toggleContinuous);
els.closeResult.addEventListener('click', hideResult);
els.calibrateBtn.addEventListener('click', startCalibration);

els.roiLayer.addEventListener('mousedown', onDragStart);
els.roiLayer.addEventListener('mousemove', onDragMove);
els.roiLayer.addEventListener('mouseup', onDragEnd);
els.roiLayer.addEventListener('touchstart', onDragStart, { passive: false });
els.roiLayer.addEventListener('touchmove', onDragMove, { passive: false });
els.roiLayer.addEventListener('touchend', onDragEnd);

els.video.addEventListener('loadedmetadata', renderSavedRoi);
window.addEventListener('resize', renderSavedRoi);

// ---------- Boot ----------
(async function init() {
  await loadQuestions();
  initDeviceView();
})();
