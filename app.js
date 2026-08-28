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
  }));
  questionMap = new Map(questionList.map(q => [normalize(q.question), q.answer]));
  fuse = new Fuse(questionList, {
    keys: ['question'],
    includeScore: true,
    threshold: 0.4,
  });
}

// ---------- Phase 5: normalize text ----------
function normalize(str) {
  if (!str) return '';
  return str
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    // common OCR confusions (Thai/number look-alikes) — extend as benchmarked
    .replace(/[Il|]/g, '1')
    .replace(/O/g, '0');
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

function captureFrame() {
  const video = els.video;
  const canvas = els.canvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ---------- Phase 3: preprocess (grayscale + contrast) ----------
function preprocess(canvas) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  const contrastFactor = 1.35; // simple contrast boost
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const adjusted = (gray - 128) * contrastFactor + 128;
    const clamped = Math.max(0, Math.min(255, adjusted));
    d[i] = d[i + 1] = d[i + 2] = clamped;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// ---------- Phase 3: OCR pipeline (Tesseract.js, client-side) ----------
let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await Tesseract.createWorker('tha+eng');
  return ocrWorker;
}

async function runOcr(canvas) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas);
  return data; // { text, lines: [...], words: [...] }
}

// ---------- Phase 4: split question vs options (heuristic) ----------
function splitQuestionAndOptions(ocrData) {
  const lines = (ocrData.lines || [])
    .map(l => l.text.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { question: ocrData.text.trim(), options: [] };
  }

  // Heuristic: line ending with '?' or the longest line near top → question
  let questionIdx = lines.findIndex(l => l.endsWith('?') || l.endsWith('๏') || l.includes('?'));
  if (questionIdx === -1) {
    // fallback: longest line in the first half of the block = question
    const firstHalf = lines.slice(0, Math.ceil(lines.length / 2));
    let longest = '';
    firstHalf.forEach(l => { if (l.length > longest.length) longest = l; });
    questionIdx = lines.indexOf(longest);
  }

  const question = lines[questionIdx] || lines[0];
  const options = lines.filter((_, i) => i !== questionIdx);

  return { question, options };
}

// ---------- Phase 5: matching logic ----------
function matchAnswer(question) {
  const norm = normalize(question);

  // 1) exact match
  if (questionMap.has(norm)) {
    return { answer: questionMap.get(norm), confidence: 'high', matchedQuestion: question };
  }

  // 2) fuzzy match via Fuse.js
  const results = fuse.search(question);
  if (results.length > 0) {
    const best = results[0];
    const confidence = best.score <= 0.25 ? 'high' : 'low';
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
    const { question } = splitQuestionAndOptions(ocrData);
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

// ---------- Boot ----------
(async function init() {
  await loadQuestions();
  initDeviceView();
})();
