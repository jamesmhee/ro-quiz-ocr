// ============================================================
// Mobile Camera OCR Quiz Auto-Answer — vanilla JS implementation
// Follows plan.md phases 1-7, adapted to a static client-only app
// (no Next.js/Supabase/Vercel — plain HTML + JS + local questions.json)
// ============================================================

const els = {
  desktopView: document.getElementById('desktopView'),
  mobileView: document.getElementById('mobileView'),
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
  stopScanBtn: document.getElementById('stopScanBtn'),
  permError: document.getElementById('permError'),
  permErrorMsg: document.getElementById('permErrorMsg'),
  frameOverlay: document.getElementById('frameOverlay'),
  roiLayer: document.getElementById('roiLayer'),
  roiRect: document.getElementById('roiRect'),
  roiSaved: document.getElementById('roiSaved'),
  roiHint: document.getElementById('roiHint'),
  calibrateBtn: document.getElementById('calibrateBtn'),
  presetBtn: document.getElementById('presetBtn'),
  presetPanel: document.getElementById('presetPanel'),
  presetList: document.getElementById('presetList'),
  presetSaveBtn: document.getElementById('presetSaveBtn'),
  presetCloseBtn: document.getElementById('presetCloseBtn'),
  sourceToggle: document.getElementById('sourceToggle'),
  sourceNote: document.getElementById('sourceNote'),
  pickerView: document.getElementById('pickerView'),
  pickerStatus: document.getElementById('pickerStatus'),
  quizSetBtn: document.getElementById('quizSetBtn'),
  desktopQuizSetBtn: document.getElementById('desktopQuizSetBtn'),
  gateOverlay: document.getElementById('gateOverlay'),
  gateBowBtn: document.getElementById('gateBowBtn'),
};

// ---------- Phase 5/7: Data layer — load questions into memory Map ----------
// The game runs different quizzes at different times, and a question from one
// round never appears in another — matching against the wrong set only invents
// wrong answers, so the set is chosen up front and only that file is loaded.
const QUIZ_SETS = {
  noon:  { name: 'เที่ยงและหนึ่งทุ่ม', file: 'questions.json' },
  hoppy: { name: 'สามทุ่ม',            file: 'questionHoppy.json' },
  guild: { name: 'งานเลี้ยงกิลด์',       file: 'questionGuild.json' },
};
const QUIZ_SET_STORAGE_KEY = 'quizSet';

let currentSet = null;
let questionMap = new Map();   // normalized question -> answer
let questionList = [];         // [{question, answer}] for Fuse.js
let fuse = null;

async function loadQuestions(setKey) {
  const set = QUIZ_SETS[setKey];
  if (!set) throw new Error('unknown quiz set: ' + setKey);
  const res = await fetch(set.file);
  if (!res.ok) throw new Error(`โหลด ${set.file} ไม่สำเร็จ (${res.status})`);
  const data = await res.json();
  questionList = data.map(item => ({
    question: item.question,
    answer: pickAnswer(item),
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
  currentSet = setKey;
  localStorage.setItem(QUIZ_SET_STORAGE_KEY, setKey);
  renderQuizSetLabel();
}

// Some sets (guild) store the same answer in several languages instead of one
// string; the player types Thai, so prefer the Thai variant and fall back to
// the first listed alternative.
function pickAnswer(item) {
  if (typeof item.answer === 'string') return item.answer;
  const list = Array.isArray(item.answers) ? item.answers : [];
  return list.find(a => /[\u0E00-\u0E7F]/.test(a)) || list[0] || '';
}

function renderQuizSetLabel() {
  const name = currentSet ? QUIZ_SETS[currentSet].name : '—';
  els.quizSetBtn.textContent = `ชุด: ${name}`;
  els.desktopQuizSetBtn.textContent = `ชุดคำถาม: ${name} (เปลี่ยน)`;
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

let onMobile = false;

function initDeviceView() {
  onMobile = isMobileDevice();
  if (onMobile) {
    els.mobileView.style.display = 'block';
    setSource('camera');
  } else {
    els.desktopView.style.display = 'flex';
  }
  els.sourceToggle.textContent = 'แหล่งภาพ: กล้อง';
}

// ---------- Phase 2: camera capture ----------
let stream = null;
let continuousMode = false;
let continuousTimer = null;

// Screen sharing is the same getDisplayMedia call on every platform — it is
// available on Android Chrome and on desktop, but iOS/iPadOS Safari (and every
// iOS browser, since they all run WebKit) still ships no getDisplayMedia at all.
function supportsScreenShare() {
  return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
}

function isIOS() {
  // iPadOS reports itself as a Mac, so also treat a touch-capable "Mac" as iOS.
  return /iPhone|iPod|iPad/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

let currentSource = 'camera';

function stopStream() {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
  stream = null;
  els.video.srcObject = null;
}

function showNote(html) {
  els.sourceNote.innerHTML = html;
  els.sourceNote.classList.add('show');
}

function hideNote() {
  els.sourceNote.classList.remove('show');
}

function showCaptureError(msg) {
  els.mobileView.style.display = 'none';
  els.permError.style.display = 'flex';
  els.permErrorMsg.textContent = msg;
}

async function setSource(kind) {
  if (kind === 'screen' && !supportsScreenShare()) {
    showNote(isIOS()
      ? '<b>iPhone / iPad แชร์หน้าจอในเบราว์เซอร์ไม่ได้</b><br>' +
        'ซาฟารีบน iOS/iPadOS ยังไม่รองรับ getDisplayMedia<br>' +
        'ทางออก: เปิดหน้านี้บนเครื่องที่สอง แล้วส่องกล้องไปที่จอเกม ' +
        'หรือใช้แท็บเล็ต Android / คอมพิวเตอร์เพื่อแชร์หน้าจอโดยตรง'
      : '<b>อุปกรณ์นี้ไม่รองรับการแชร์หน้าจอ</b><br>ใช้โหมดกล้องแทน');
    return;
  }

  if (continuousMode) setContinuous(false);
  hideNote();
  stopStream();
  currentSource = kind;
  els.sourceToggle.textContent = kind === 'screen' ? 'แหล่งภาพ: หน้าจอ' : 'แหล่งภาพ: กล้อง';
  els.sourceToggle.classList.toggle('active', kind === 'screen');

  try {
    if (kind === 'screen') {
      // getDisplayMedia opens the browser's own picker (screen/window/tab) —
      // a consent dialog, not an OS-level permission we can request ourselves.
      stream = await navigator.mediaDevices.getDisplayMedia({
        // The change watcher can only react as fast as frames arrive.
        video: { frameRate: 15 },
        audio: false,
      });
      // "Stop sharing" from the browser's own bar drops us back to the camera
      // on mobile, or to the QR screen on desktop.
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (onMobile) {
          setSource('camera');
        } else {
          els.mobileView.style.display = 'none';
          els.desktopView.style.display = 'flex';
        }
      });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    }
    els.video.srcObject = stream;
    roi = loadRoi();
    renderSavedRoi();
  } catch (err) {
    if (kind === 'screen' && onMobile) {
      // A declined picker on mobile should not strand the user on an error page.
      showNote('<b>ไม่ได้อนุญาตให้แชร์หน้าจอ</b><br>กลับไปใช้กล้องแล้ว');
      await setSource('camera');
      return;
    }
    showCaptureError(err.message || (kind === 'screen'
      ? 'ไม่ได้อนุญาตให้แชร์หน้าจอ'
      : 'กรุณาอนุญาตการใช้กล้อง'));
  }
}

function toggleSource() {
  setSource(currentSource === 'screen' ? 'camera' : 'screen');
}

// ---------- Phase 4 (calibration): ROI stored as fractions of the video frame ----------
// Cropping to just the question line is what makes OCR accurate here — the full
// game screen carries icons, portraits and decorative text that Tesseract merges
// into the question and wrecks the match.
// Keyed per source: a box drawn around the question on the phone camera does
// not line up with the same question on a shared screen.
function roiKey() {
  return `quizRoi:${currentSource}`;
}

let roi = loadRoi();

function loadRoi() {
  try {
    const saved = JSON.parse(localStorage.getItem(roiKey()));
    if (saved && saved.w > 0.01 && saved.h > 0.005) return saved;
  } catch (_) { /* ignore malformed value */ }
  return null;
}

function saveRoi(next) {
  roi = next;
  localStorage.setItem(roiKey(), JSON.stringify(next));
  // Remembered thumbnails were taken through the old box and no longer match.
  clearAnswerCache();
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

// ---------- ROI presets: up to 5 named crop boxes per source, saved for reuse ----------
const MAX_PRESETS = 5;
function presetsKey() {
  return `quizRoiPresets:${currentSource}`;
}

function loadPresets() {
  try {
    const saved = JSON.parse(localStorage.getItem(presetsKey()));
    if (Array.isArray(saved)) return saved;
  } catch (_) { /* ignore malformed value */ }
  return [];
}

function savePresets(list) {
  localStorage.setItem(presetsKey(), JSON.stringify(list));
}

function renderPresetList() {
  const presets = loadPresets();
  els.presetList.innerHTML = presets.length
    ? presets.map((p, i) => `
        <div class="presetRow">
          <button class="presetApplyBtn" data-i="${i}">${p.name}</button>
          <button class="presetDeleteBtn" data-i="${i}">ลบ</button>
        </div>
      `).join('')
    : '<p class="presetEmpty">ยังไม่มีพรีเซ็ต</p>';

  const full = presets.length >= MAX_PRESETS;
  els.presetSaveBtn.disabled = full || !roi;
  els.presetSaveBtn.textContent = full
    ? `เต็มแล้ว (${MAX_PRESETS}/${MAX_PRESETS})`
    : `+ บันทึกกรอบปัจจุบัน (${presets.length}/${MAX_PRESETS})`;
}

function openPresetPanel() {
  if (continuousMode) setContinuous(false);
  hideResult();
  renderPresetList();
  els.presetPanel.classList.add('show');
}

function closePresetPanel() {
  els.presetPanel.classList.remove('show');
}

function applyPreset(i) {
  const preset = loadPresets()[i];
  if (!preset) return;
  saveRoi(preset.roi);
  els.statusText.textContent = `ใช้พรีเซ็ต: ${preset.name}`;
  closePresetPanel();
}

function deletePreset(i) {
  const presets = loadPresets();
  presets.splice(i, 1);
  savePresets(presets);
  renderPresetList();
}

function saveCurrentAsPreset() {
  if (!roi) {
    alert('ยังไม่ได้เลือกกรอบคำถาม กรุณาลากกรอบก่อนบันทึกเป็นพรีเซ็ต');
    return;
  }
  const presets = loadPresets();
  if (presets.length >= MAX_PRESETS) return;
  const name = (prompt('ตั้งชื่อพรีเซ็ต:', `พรีเซ็ต ${presets.length + 1}`) || '').trim();
  if (!name) return;
  presets.push({ name: name.slice(0, 30), roi });
  savePresets(presets);
  renderPresetList();
}

els.presetBtn.addEventListener('click', openPresetPanel);
els.presetCloseBtn.addEventListener('click', closePresetPanel);
els.presetSaveBtn.addEventListener('click', saveCurrentAsPreset);
els.presetList.addEventListener('click', (e) => {
  const applyBtn = e.target.closest('.presetApplyBtn');
  if (applyBtn) return applyPreset(Number(applyBtn.dataset.i));
  const delBtn = e.target.closest('.presetDeleteBtn');
  if (delBtn) deletePreset(Number(delBtn.dataset.i));
});

function startCalibration() {
  // Scanning would keep raising the result panel over the drag layer.
  if (continuousMode) setContinuous(false);
  hideResult();
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

// Source rectangle in video pixels: the calibrated ROI, or the whole frame.
function roiSource() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return null;
  return roi
    ? {
        x: Math.max(0, Math.round(roi.x * vw)),
        y: Math.max(0, Math.round(roi.y * vh)),
        w: Math.min(vw, Math.round(roi.w * vw)),
        h: Math.min(vh, Math.round(roi.h * vh)),
      }
    : { x: 0, y: 0, w: vw, h: vh };
}

function captureFrame() {
  const video = els.video;
  const src = roiSource();
  if (!src) throw new Error('ยังไม่มีภาพจากกล้อง/หน้าจอ');

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

// ---------- Phase 3: preprocess (grayscale -> Otsu binarize -> trim) ----------
// Returns the canvas to OCR: dark text on white, cropped to the text itself.
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
  // Background covers most of a text box, so the minority side is the ink.
  // Game text is often light-on-dark; always emit dark-on-light, which is
  // what Tesseract is trained on.
  let bright = 0;
  for (let g = 0; g < gray.length; g++) if (gray[g] > threshold) bright++;
  const inkIsBright = bright < gray.length / 2;

  const ink = new Uint8Array(gray.length);
  for (let i = 0, g = 0; i < d.length; i += 4, g++) {
    ink[g] = (gray[g] > threshold) === inkIsBright ? 1 : 0;
    const v = ink[g] ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return trimToInk(canvas, ink);
}

// OCR time scales with pixel count, and a loosely drawn box is mostly empty
// margin — crop to the rows/columns that actually carry ink.
const TRIM_PAD = 12;
const TRIM_MIN_INK = 2; // ink pixels a row/column needs, so lone specks don't stretch the box

function trimToInk(canvas, ink) {
  const w = canvas.width;
  const h = canvas.height;
  const rowInk = new Uint32Array(h);
  const colInk = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ink[y * w + x]) { rowInk[y]++; colInk[x]++; }
    }
  }

  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < h && rowInk[top] < TRIM_MIN_INK) top++;
  if (top === h) return canvas; // blank box: nothing to trim to
  while (bottom > top && rowInk[bottom] < TRIM_MIN_INK) bottom--;
  while (left < w && colInk[left] < TRIM_MIN_INK) left++;
  while (right > left && colInk[right] < TRIM_MIN_INK) right--;

  top = Math.max(0, top - TRIM_PAD);
  left = Math.max(0, left - TRIM_PAD);
  bottom = Math.min(h - 1, bottom + TRIM_PAD);
  right = Math.min(w - 1, right + TRIM_PAD);
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  if (cw * ch > 0.9 * w * h) return canvas; // not worth a copy

  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d').drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
  return out;
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
// The default "best" model is the most accurate but the slowest; tessdata_fast
// is a smaller network that reads a line noticeably quicker. Open the page with
// ?ocr=best to compare against the slower model.
const OCR_MODEL = new URLSearchParams(location.search).get('ocr') === 'best' ? 'best' : 'fast';
const OCR_WORKER_OPTIONS = OCR_MODEL === 'fast'
  ? {
      langPath: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main',
      gzip: false,
      // tesseract.js caches traineddata by language name only; a separate
      // cache path stops it reusing a previously downloaded "best" file.
      cachePath: 'tessdata_fast',
    }
  : {};

// Cache the promise, not the worker, so a warm-up and a scan racing each other
// share one worker instead of loading the language data twice.
let ocrWorkerPromise = null;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await Tesseract.createWorker('tha+eng', 1, OCR_WORKER_OPTIONS);
      await worker.setParameters({
        // ROI is a single question line, so treat it as one block of text
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
      });
      return worker;
    })();
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}

// Loading the language data and the first recognize() are the slowest calls
// Tesseract makes; pay for them while the player is still setting up.
function warmUpOcr() {
  getOcrWorker()
    .then(worker => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 32;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      return worker.recognize(c);
    })
    .catch(() => { /* a real scan will surface the error */ });
}

// Only text + line layout are used; skipping hOCR/TSV generation saves time per scan.
const OCR_OUTPUT = { text: true, blocks: true, hocr: false, tsv: false };

async function runOcr(canvas) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas, {}, OCR_OUTPUT);
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
  // The true/false round (สามทุ่ม) leaves only seconds to answer, so show a
  // huge green/red dot that reads at a glance instead of a word.
  const trueFalse = currentSet === 'hoppy' && (answer === 'จริง' || answer === 'เท็จ');
  els.resultAnswer.textContent = trueFalse
    ? (answer === 'จริง' ? '🟢' : '🔴')
    : (answer || 'ไม่พบคำตอบที่ตรงกัน');
  els.resultAnswer.style.fontSize = trueFalse ? '100px' : '';
  // True/false answers get colour-coded so the result reads at a glance.
  els.resultAnswer.style.color =
    answer && answer.includes('เท็จ') ? '#ff4d4d' : '';
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
// quiet: continuous-mode scan — keep the current answer on screen while OCR
// runs and only replace it when a new answer is found, so the player never
// loses the answer to a spinner or a failed read of a transition frame.
async function scanOnce({ quiet = false } = {}) {
  if (busy) return null;
  busy = true;
  els.captureBtn.classList.add('busy');
  els.statusText.textContent = 'กำลังสแกน...';
  if (!quiet) showLoading();

  const t0 = performance.now();
  let result = null;
  let fromCache = false;
  try {
    // Thumbnail taken from the same frame that gets OCR'd.
    const cacheSig = sampleRoi(cacheCtx, CACHE_W, CACHE_H);
    // A manual press always does a fresh OCR, so a wrong remembered answer
    // can be corrected by tapping the capture button.
    const hit = quiet && cacheSig ? nearestCacheEntry(cacheSig) : null;
    if (hit) {
      fromCache = true;
      result = { answer: hit.answer, confidence: 'high', matchedQuestion: hit.question };
      showResult({ ...result, rawText: '(จำได้จากครั้งก่อน — ไม่ต้อง OCR)' });
    } else {
      const canvas = preprocess(captureFrame());
      const ocrData = await runOcr(canvas);
      const question = extractQuestion(ocrData);
      result = matchAnswer(question);
      if (!quiet || result.answer) {
        showResult({ ...result, rawText: ocrData.text.trim() });
      }
      if (cacheSig && result.answer && result.confidence === 'high') {
        cacheStore(cacheSig, result);
      }
    }
  } catch (err) {
    if (!quiet) {
      showResult({ answer: null, confidence: 'low', matchedQuestion: null, rawText: 'เกิดข้อผิดพลาด: ' + err.message });
    }
  } finally {
    const elapsed = Math.round(performance.now() - t0);
    const how = fromCache ? 'จำได้' : `${elapsed}ms`;
    els.statusText.textContent = quiet
      ? `${result && result.answer ? 'เจอคำถาม' : 'ไม่พบคำถาม'} (${how}) — รอคำถามใหม่`
      : `พร้อมสแกน (${how})`;
    els.captureBtn.classList.remove('busy');
    busy = false;
  }
  return result;
}

// ---------- Continuous mode: watch the ROI, OCR only when the question changes ----------
// OCR costs ~0.5-1.5s; comparing a tiny grayscale thumbnail of the ROI costs
// well under 1ms. So sample often, and run OCR only once the box shows
// something new and has stopped animating. After a confident answer the
// question is locked and never re-scanned until the box changes again.
const WATCH_INTERVAL_MS = 100;
const SIG_W = 64;
const SIG_H = 16;
// Thresholds are the share of thumbnail pixels that changed noticeably. A mean
// diff can't be used: a new question in the same box changes only the thin
// text strokes, which averages out to almost nothing against the background.
const CHANGE_THRESHOLD = 0.004; // this much of the box changed = different question
const STABLE_THRESHOLD = 0.004; // less than this between samples = frame has settled
// Safety net: even when nothing seems to change, re-check a locked question
// this often. Same question = instant answer-memory hit, so it costs ~nothing.
const RECHECK_MS = 1500;

const sigCanvas = document.createElement('canvas');
sigCanvas.width = SIG_W;
sigCanvas.height = SIG_H;
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });

let prevSig = null;    // previous sample, to detect when a transition settles
let lockedSig = null;  // sample the last OCR ran on
let lockedHit = false; // whether that OCR produced a confident answer
let lockedAt = 0;      // when that OCR ran

// Grayscale thumbnail of the ROI at w×h, as one byte per pixel.
function sampleRoi(ctx, w, h) {
  const src = roiSource();
  if (!src) return null;
  ctx.drawImage(els.video, src.x, src.y, src.w, src.h, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const sig = new Uint8Array(w * h);
  for (let i = 0, g = 0; i < d.length; i += 4, g++) {
    sig[g] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }
  return sig;
}

function frameSignature() {
  return sampleRoi(sigCtx, SIG_W, SIG_H);
}

// ---------- Answer memory: skip OCR for questions seen before ----------
// Questions are drawn from a fixed bank, so they repeat. A shared screen
// renders the same question pixel-for-pixel each time, so a sharper thumbnail
// than the change watcher's identifies it without OCR. Only confident answers
// are remembered, per quiz set and per source (the box differs between them).
const CACHE_W = 128;
const CACHE_H = 20;
const CACHE_HIT_THRESHOLD = 0.01; // changed-pixel share; a different question lands far above this
const CACHE_MAX = 200;         // ~3.4KB each in localStorage

const cacheCanvas = document.createElement('canvas');
cacheCanvas.width = CACHE_W;
cacheCanvas.height = CACHE_H;
const cacheCtx = cacheCanvas.getContext('2d', { willReadFrequently: true });

let answerCache = [];
let answerCacheKey = null;

function currentCacheKey() {
  return `answerCache:${currentSet}:${currentSource}`;
}

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function b64ToBytes(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function loadAnswerCache() {
  const key = currentCacheKey();
  if (answerCacheKey === key) return answerCache;
  answerCacheKey = key;
  try {
    const raw = JSON.parse(localStorage.getItem(key)) || [];
    answerCache = raw.map(e => ({ sig: b64ToBytes(e.s), answer: e.a, question: e.q }));
  } catch (_) {
    answerCache = [];
  }
  return answerCache;
}

function persistAnswerCache() {
  try {
    localStorage.setItem(answerCacheKey, JSON.stringify(
      answerCache.map(e => ({ s: bytesToB64(e.sig), a: e.answer, q: e.question }))));
  } catch (_) { /* storage full: keep remembering for this session only */ }
}

function clearAnswerCache() {
  Object.keys(QUIZ_SETS).forEach(set => localStorage.removeItem(`answerCache:${set}:${currentSource}`));
  answerCache = [];
  answerCacheKey = null;
}

function nearestCacheEntry(sig) {
  let best = null;
  let bestDiff = Infinity;
  for (const entry of loadAnswerCache()) {
    const diff = sigDiff(sig, entry.sig);
    if (diff < bestDiff) { bestDiff = diff; best = entry; }
  }
  return bestDiff < CACHE_HIT_THRESHOLD ? best : null;
}

function cacheStore(sig, { answer, matchedQuestion }) {
  const existing = nearestCacheEntry(sig);
  if (existing) {
    // A fresh OCR of the same question wins over what was remembered.
    existing.answer = answer;
    existing.question = matchedQuestion;
  } else {
    answerCache.push({ sig, answer, question: matchedQuestion });
    if (answerCache.length > CACHE_MAX) answerCache.shift();
  }
  persistAnswerCache();
}

// Share of pixels (0..1) whose gray level moved more than PIXEL_DELTA —
// big enough to ignore video-compression shimmer, small enough to see text.
const PIXEL_DELTA = 30;

function sigDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > PIXEL_DELTA) changed++;
  }
  return changed / a.length;
}

async function watchTick() {
  if (!continuousMode || busy) return;
  const sig = frameSignature();
  if (!sig) return;
  const settling = sigDiff(sig, prevSig) > STABLE_THRESHOLD;
  prevSig = sig;
  if (settling) return; // mid-animation: OCR would read half-drawn text

  // A confident answer holds until the question clearly changes; a miss is
  // retried on any visible change (camera moved, text finished fading in).
  const limit = lockedHit ? CHANGE_THRESHOLD : STABLE_THRESHOLD;
  const due = performance.now() - lockedAt > RECHECK_MS;
  if (lockedSig && sigDiff(sig, lockedSig) < limit && !due) return;

  const result = await scanOnce({ quiet: true });
  lockedSig = sig;
  lockedAt = performance.now();
  lockedHit = !!(result && result.answer && result.confidence === 'high');
}

function setContinuous(on) {
  continuousMode = on;
  els.continuousToggle.textContent = `โหมดต่อเนื่อง: ${on ? 'เปิด' : 'ปิด'}`;
  els.continuousToggle.classList.toggle('active', on);
  // The result panel covers the toggle, so it carries its own stop button.
  els.stopScanBtn.classList.toggle('show', on);
  clearInterval(continuousTimer);
  prevSig = lockedSig = null;
  lockedHit = false;
  if (on) {
    continuousTimer = setInterval(watchTick, WATCH_INTERVAL_MS);
    els.statusText.textContent = 'กำลังเฝ้าดูกรอบคำถาม...';
  }
}

function toggleContinuous() {
  setContinuous(!continuousMode);
}

function stopContinuous() {
  setContinuous(false);
  hideResult();
  els.statusText.textContent = 'หยุดสแกนต่อเนื่องแล้ว';
}

// ---------- Wire up events ----------
els.captureBtn.addEventListener('click', scanOnce);
els.continuousToggle.addEventListener('click', toggleContinuous);
els.closeResult.addEventListener('click', hideResult);
els.stopScanBtn.addEventListener('click', stopContinuous);
els.calibrateBtn.addEventListener('click', startCalibration);
els.sourceToggle.addEventListener('click', toggleSource);
els.screenShareBtn.addEventListener('click', () => {
  els.desktopView.style.display = 'none';
  els.mobileView.style.display = 'block';
  setSource('screen');
});
els.sourceNote.addEventListener('click', hideNote);

els.roiLayer.addEventListener('mousedown', onDragStart);
els.roiLayer.addEventListener('mousemove', onDragMove);
els.roiLayer.addEventListener('mouseup', onDragEnd);
els.roiLayer.addEventListener('touchstart', onDragStart, { passive: false });
els.roiLayer.addEventListener('touchmove', onDragMove, { passive: false });
els.roiLayer.addEventListener('touchend', onDragEnd);

els.video.addEventListener('loadedmetadata', renderSavedRoi);
window.addEventListener('resize', renderSavedRoi);

// ---------- Step 0: quiz set picker ----------
// Shown before any capture starts; re-openable so a player can switch rounds
// without reloading (and losing their calibrated question box).
function showPicker() {
  if (continuousMode) setContinuous(false);
  stopStream();
  hideResult();
  hideNote();
  endCalibration();
  closePresetPanel();
  els.mobileView.style.display = 'none';
  els.desktopView.style.display = 'none';
  els.permError.style.display = 'none';
  els.pickerStatus.textContent = '';
  els.pickerView.style.display = 'flex';
}

async function chooseQuizSet(setKey) {
  els.pickerStatus.textContent = `กำลังโหลด ${QUIZ_SETS[setKey].name}...`;
  try {
    await loadQuestions(setKey);
  } catch (err) {
    els.pickerStatus.textContent = err.message;
    return;
  }
  els.pickerView.style.display = 'none';
  warmUpOcr();
  initDeviceView();
}

document.querySelectorAll('.quizSetBtn').forEach(btn => {
  btn.addEventListener('click', () => chooseQuizSet(btn.dataset.set));
});
els.quizSetBtn.addEventListener('click', showPicker);
els.desktopQuizSetBtn.addEventListener('click', showPicker);

// ---------- Step -1: fullscreen gate, must press "กดคาราวะ" to enter ----------
// Remembers today's date in localStorage so a player who already bowed today
// isn't stopped by the gate again until the date rolls over.
const GATE_STORAGE_KEY = 'nutoi_gate_date';
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function enterApp() {
  els.gateOverlay.classList.add('hidden');
  showPicker();
}
els.gateBowBtn.addEventListener('click', () => {
  localStorage.setItem(GATE_STORAGE_KEY, todayStr());
  enterApp();
});

// ---------- Boot ----------
(function init() {
  renderQuizSetLabel();
  const remembered = localStorage.getItem(QUIZ_SET_STORAGE_KEY);
  if (remembered && QUIZ_SETS[remembered]) {
    els.pickerStatus.textContent = `เลือกล่าสุด: ${QUIZ_SETS[remembered].name}`;
  }
  if (localStorage.getItem(GATE_STORAGE_KEY) === todayStr()) {
    enterApp();
  }
})();
