/* REAL Audio to Text Mobile — 갤럭시(안드로이드 Chrome·삼성 인터넷)용 정적 웹 앱
 * 녹음(5분 구간 자동 저장, 최대 3시간) → 텍스트 변환(OpenAI·Gemini) → AI 정리(OpenAI·Gemini·Claude) → txt 저장
 * 서버 없음. 녹음·텍스트는 휴대폰 브라우저(IndexedDB)에, API 키는 localStorage에만 저장한다.
 */
'use strict';

const APP_VERSION = 'v0.2.0';
const SETTINGS_VER = 2;
const MAX_SEC = 3 * 60 * 60;            // 최대 녹음 3시간
let SEG_SEC = 5 * 60;                   // 구간 길이 5분
const PARTIAL_SAVE_MS = 30 * 1000;      // 진행 중 구간 30초마다 임시 저장
const LS_SETTINGS = 'ratm_settings';
const LS_KEYS = 'ratm_keys';
const LS_PIN = 'ratm_pin';

// 시험용: localhost에서만 ?segsec=N 으로 구간 길이 조정
(function () {
  const p = new URLSearchParams(location.search);
  if (p.has('segsec') && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    const v = parseInt(p.get('segsec'), 10);
    if (v >= 1) SEG_SEC = v;
  }
})();

const DEFAULT_SETTINGS = {
  sttProvider: 'openai',
  sttModel: { openai: 'gpt-transcribe', gemini: 'gemini-2.5-flash' },
  sumProvider: 'openai',
  sumModel: { openai: 'gpt-5-mini', gemini: 'gemini-2.5-flash', claude: 'claude-sonnet-5-5' },
  saveKeys: true,
  vocab: '',
  settingsVer: SETTINGS_VER,
};
// v0.1 기본값이던 모델(2027-02-26 종료 예정)을 쓰던 경우 OpenAI 권장 후속 모델로 한 번만 자동 변경
const OLD_DEFAULT_STT = ['gpt-4o-mini-transcribe'];
let settingsMigrated = false;

const STT_HINT = '부동산 중개 상담 또는 회의 녹음입니다. 매매, 전세, 월세, 보증금, 계약금, 잔금, 중개보수, 등기부등본, 건축물대장, 융자, 근저당 같은 용어가 나올 수 있습니다.';
const GEMINI_STT_PROMPT = '다음 음성을 한국어로 빠짐없이 그대로 받아 적으세요. 요약하거나 내용을 바꾸지 말고, 말하는 사람이 바뀌면 줄을 바꾸세요. 알아들을 수 없는 부분은 [불명확]으로 표시하세요. 설명 없이 받아 적은 문장만 출력하세요. ' + STT_HINT;
const CONTEXT_CHARS = 200;              // 앞 구간 끝부분을 다음 구간 문맥으로 전달하는 길이
const SILENCE_RMS = 0.004;              // 이보다 작으면 무음 구간으로 판단(약 -48dBFS)

/* ---------------- 변환 정확도 보조 ---------------- */
function vocabList() {
  return String(settings.vocab || '').split(/[,\n、·]/).map((s) => s.trim()).filter(Boolean).slice(0, 100);
}
function tailText(t, n) {
  if (!t) return '';
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(s.length - n) : s;
}
function sttPromptText(prevText) {
  let p = STT_HINT;
  const v = vocabList();
  if (v.length) p += ' 등장할 수 있는 이름·지명·단지명: ' + v.join(', ').slice(0, 300) + '.';
  if (prevText) p += ' 앞부분 내용: ' + tailText(prevText, CONTEXT_CHARS);
  return p;
}
// 같은 문장이 비정상적으로 반복되는 인식 오류(무음·잡음 구간에서 생기는 현상) 감지
function looksBroken(t) {
  if (!t) return false;
  if (/(.{2,30}?)\1{7,}/.test(t.replace(/\s+/g, ''))) return true;
  const parts = t.split(/[\n.?!。]+/).map((s) => s.trim()).filter((s) => s.length >= 4);
  if (parts.length >= 8) {
    const cnt = {}; let max = 0;
    for (const p of parts) { cnt[p] = (cnt[p] || 0) + 1; if (cnt[p] > max) max = cnt[p]; }
    if (max / parts.length > 0.4) return true;
  }
  return false;
}
function isSilent(mono) {
  const win = 8000; // 16kHz 기준 0.5초
  let maxRms = 0;
  for (let i = 0; i < mono.length; i += win) {
    let sum = 0; const end = Math.min(mono.length, i + win);
    for (let j = i; j < end; j++) sum += mono[j] * mono[j];
    const rms = Math.sqrt(sum / Math.max(1, end - i));
    if (rms > maxRms) maxRms = rms;
    if (maxRms >= SILENCE_RMS) return false;
  }
  return true;
}

const SUM_SYSTEM = '당신은 공인중개사의 업무 보조자입니다. 입력은 녹음을 받아 적은 전사문이며 인식 오류가 있을 수 있습니다. 문맥으로 판단하되 전사문에 없는 내용은 만들지 마십시오. 확인되지 않은 내용은 "확인 필요"로 표시하십시오. 날짜는 YYYY-MM-DD, 금액은 억원·만원 단위로 표기하십시오. 마크다운 기호(#, *, |, ```)를 쓰지 말고 일반 텍스트로만 작성하십시오.';
const SUM_TEMPLATES = {
  consult: {
    label: '상담정리',
    prompt: '아래 전사문을 부동산 상담 기록으로 정리하십시오. 다음 순서를 지키십시오.\n1. 상담 개요: 일시(전사문에 있는 경우), 상담 대상, 상담 유형(매매/전세/월세/기타)\n2. 고객 요구사항: 지역, 물건 유형, 예산·보증금·월세, 면적·방 수, 입주 시기, 기타 조건\n3. 주요 상담 내용 요약\n4. 고객 질문과 답변\n5. 확인이 필요한 사항\n6. 후속 조치(할 일, 담당, 기한)',
  },
  meeting: {
    label: '회의록',
    prompt: '아래 전사문을 회의록으로 정리하십시오. 다음 순서를 지키십시오.\n1. 회의 개요: 일시, 참석자(전사문에서 확인되는 범위)\n2. 안건\n3. 안건별 논의 내용\n4. 결정 사항\n5. 할 일(담당, 기한)\n6. 미결 사항',
  },
};

/* ---------------- 공통 유틸 ---------------- */
const $ = (id) => document.getElementById(id);
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fileStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}
function setProgress(wrapId, barId, ratio) {
  const w = $(wrapId);
  if (ratio == null) { w.hidden = true; return; }
  w.hidden = false;
  $(barId).style.width = Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 저장소(IndexedDB) ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ratm', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('segments')) {
          const s = d.createObjectStore('segments', { keyPath: 'id' });
          s.createIndex('bySession', 'sessionId');
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  _req(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const os = tx.objectStore(store);
      const r = fn(os);
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('저장 실패'));
    });
  },
  put(store, v) { return this._req(store, 'readwrite', (os) => os.put(v)); },
  get(store, k) { return this._req(store, 'readonly', (os) => os.get(k)); },
  all(store) { return this._req(store, 'readonly', (os) => os.getAll()); },
  del(store, k) { return this._req(store, 'readwrite', (os) => os.delete(k)); },
  async segs(sessionId) {
    const list = await this._req('segments', 'readonly', (os) => os.index('bySession').getAll(sessionId));
    return (list || []).sort((a, b) => a.index - b.index);
  },
  async deleteSession(id) {
    const segs = await this.segs(id);
    for (const s of segs) await this.del('segments', s.id);
    await this.del('sessions', id);
  },
};

/* ---------------- 설정·키 ---------------- */
let settings = loadSettings();
let memKeys = { openai: '', gemini: '', claude: '' };

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
    if (!s) return structuredClone(DEFAULT_SETTINGS);
    const out = {
      ...structuredClone(DEFAULT_SETTINGS), ...s,
      sttModel: { ...DEFAULT_SETTINGS.sttModel, ...(s.sttModel || {}) },
      sumModel: { ...DEFAULT_SETTINGS.sumModel, ...(s.sumModel || {}) },
    };
    if (!s.settingsVer || s.settingsVer < SETTINGS_VER) {
      if (OLD_DEFAULT_STT.includes(out.sttModel.openai)) { out.sttModel.openai = DEFAULT_SETTINGS.sttModel.openai; settingsMigrated = true; }
      out.settingsVer = SETTINGS_VER;
      localStorage.setItem(LS_SETTINGS, JSON.stringify(out));
    }
    return out;
  } catch (e) { return structuredClone(DEFAULT_SETTINGS); }
}
function getKeys() {
  if (settings.saveKeys) {
    try { return { openai: '', gemini: '', claude: '', ...JSON.parse(localStorage.getItem(LS_KEYS) || '{}') }; } catch (e) { /* 무시 */ }
  }
  return memKeys;
}
function storeKeys(k) {
  if (settings.saveKeys) { localStorage.setItem(LS_KEYS, JSON.stringify(k)); memKeys = { ...k }; }
  else { localStorage.removeItem(LS_KEYS); memKeys = { ...k }; }
}

/* ---------------- 화면 전환 ---------------- */
const TITLES = {
  lock: 'REAL Audio to Text', home: 'REAL Audio to Text', record: '녹음하기', import: '파일 불러오기',
  history: '작업 기록', detail: '작업 상세', settings: '설정',
};
let currentView = 'home';
let currentSessionId = null;

function show(view, push = true) {
  if (Rec.active && view !== 'record') {
    toast('녹음 중에는 다른 화면으로 이동할 수 없습니다. 먼저 녹음을 종료하십시오.');
    if (!push) history.pushState({ view: 'record' }, '');
    return;
  }
  if (Job.running && view !== 'detail') {
    toast('변환·정리 중에는 다른 화면으로 이동할 수 없습니다. 끝날 때까지 기다려 주십시오.');
    if (!push) history.pushState({ view: 'detail' }, '');
    return;
  }
  if (view !== 'history') selMode = false;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = true; });
  $('view-' + view).hidden = false;
  $('viewTitle').textContent = TITLES[view] || 'REAL Audio to Text';
  $('btnBack').hidden = (view === 'home' || view === 'lock');
  currentView = view;
  if (push && view !== 'lock') history.pushState({ view }, '');
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  if (view === 'home') renderHome();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  if (currentView === 'lock') return;
  if (currentView === 'detail') show('history', false);
  else if (currentView !== 'home') show('home', false);
});
$('btnBack').addEventListener('click', () => {
  if (currentView === 'detail') show('history');
  else show('home');
});
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

/* ---------------- 앱 잠금 ---------------- */
async function hashPin(pin, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, key, 256);
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  return { salt: b64(salt), hash: b64(new Uint8Array(bits)) };
}
let lockFails = 0;
$('btnUnlock').addEventListener('click', async () => {
  const saved = JSON.parse(localStorage.getItem(LS_PIN) || 'null');
  if (!saved) { show('home'); return; }
  if (lockFails >= 5) { setMsg($('lockMsg'), '5회 실패했습니다. 잠시 후 다시 시도하십시오.', 'err'); return; }
  const h = await hashPin($('lockPin').value, saved.salt);
  if (h.hash === saved.hash) { lockFails = 0; $('lockPin').value = ''; setMsg($('lockMsg'), ''); show('home'); }
  else {
    lockFails++;
    setMsg($('lockMsg'), `비밀번호가 맞지 않습니다. (${lockFails}/5)`, 'err');
    if (lockFails >= 5) setTimeout(() => { lockFails = 0; setMsg($('lockMsg'), ''); }, 60000);
  }
});
$('lockPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnUnlock').click(); });
$('btnSetPin').addEventListener('click', async () => {
  const pin = $('newPin').value.trim();
  if (!pin) { localStorage.removeItem(LS_PIN); setMsg($('pinMsg'), '앱 잠금을 해제했습니다.', 'ok'); return; }
  if (!/^\d{4,}$/.test(pin)) { setMsg($('pinMsg'), '숫자 4자리 이상으로 입력하십시오.', 'err'); return; }
  localStorage.setItem(LS_PIN, JSON.stringify(await hashPin(pin)));
  $('newPin').value = '';
  setMsg($('pinMsg'), '잠금 비밀번호를 저장했습니다. 다음에 앱을 열 때 적용됩니다.', 'ok');
});

/* ---------------- 홈 ---------------- */
async function renderHome() {
  const n = $('homeNotice');
  const k = getKeys();
  const sttKey = k[settings.sttProvider];
  if (!sttKey) {
    n.hidden = false;
    n.textContent = '텍스트 변환을 하려면 설정에서 OpenAI 또는 Gemini API 키를 입력하십시오. 녹음은 키 없이도 할 수 있습니다.';
  } else n.hidden = true;
}

/* ---------------- 녹음 ---------------- */
const Rec = {
  active: false, paused: false,
  stream: null, recorder: null, mime: '', session: null,
  segIndex: 0, segChunks: [], segActiveMs: 0, segMark: 0,
  doneSec: 0, timer: null, wakeLock: null, lastPartial: 0,
  stopping: false, pendingSave: Promise.resolve(),
};

function pickMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function extOf(mime) {
  if (!mime) return '.webm';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('flac')) return '.flac';
  return '.webm';
}
function segElapsedMs() {
  return Rec.segActiveMs + (Rec.paused ? 0 : performance.now() - Rec.segMark);
}
function totalElapsedSec() { return Rec.doneSec + segElapsedMs() / 1000; }

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      Rec.wakeLock = await navigator.wakeLock.request('screen');
      Rec.wakeLock.addEventListener('release', () => { Rec.wakeLock = null; });
    }
  } catch (e) { /* 지원하지 않거나 거부됨 — 녹음은 계속 */ }
}
function releaseWakeLock() {
  try { if (Rec.wakeLock) Rec.wakeLock.release(); } catch (e) { /* 무시 */ }
  Rec.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (Rec.active || Job.running) && !Rec.wakeLock) requestWakeLock();
});
window.addEventListener('beforeunload', (e) => {
  if (Rec.active || Job.running) { e.preventDefault(); e.returnValue = ''; }
});

function startSegment() {
  Rec.segChunks = [];
  Rec.segActiveMs = 0;
  Rec.segMark = performance.now();
  Rec.lastPartial = performance.now();
  const opts = { audioBitsPerSecond: 64000 }; // 음성 인식 정확도를 위해 32kbps → 64kbps(5분 약 2.4MB)
  if (Rec.mime) opts.mimeType = Rec.mime;
  const r = new MediaRecorder(Rec.stream, opts);
  const idx = Rec.segIndex;
  const chunks = Rec.segChunks;
  r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  r.onerror = () => { abortRecording('녹음 장치 오류로 녹음이 중단되었습니다. 저장된 부분까지 보관했습니다.'); };
  r.onstop = () => {
    // 구간 길이는 stop() 직전에 r._durSec에 기록해 둔다(onstop은 다음 구간 시작 뒤에 호출될 수 있음)
    const sec = r._durSec != null ? r._durSec : 0;
    Rec.pendingSave = Rec.pendingSave.then(() => saveSegment(idx, chunks, sec, true));
  };
  r.start(1000);
  Rec.recorder = r;
}
async function saveSegment(index, chunks, durationSec, final) {
  if (!chunks.length) return;
  const mime = (chunks[0] && chunks[0].type) || Rec.mime || 'audio/webm';
  const blob = new Blob(chunks, { type: mime });
  const id = `${Rec.session.id}_${pad(index, 3)}`;
  await DB.put('segments', {
    id, sessionId: Rec.session.id, index, blob, mime,
    durationSec: Math.round(durationSec * 10) / 10, transcript: null, partial: !final,
  });
}
async function saveSessionProgress(status) {
  if (!Rec.session) return;
  Rec.session.durationSec = Math.round(totalElapsedSec());
  if (status) Rec.session.status = status;
  await DB.put('sessions', Rec.session);
}
function rotateSegment() {
  // 현재 구간을 닫고 바로 다음 구간을 시작
  const old = Rec.recorder;
  old._durSec = segElapsedMs() / 1000;
  Rec.doneSec += old._durSec;
  old.stop();
  Rec.segIndex++;
  startSegment();
  saveSessionProgress();
}
function tick() {
  if (!Rec.active) return;
  const tot = totalElapsedSec();
  $('recTime').textContent = fmtDur(tot);
  $('recSegInfo').textContent = `${Rec.paused ? '일시정지' : '녹음 중'} · 저장 구간 ${Rec.segIndex}개`;
  if (tot >= MAX_SEC) { stopRecording('최대 3시간에 도달해 녹음을 자동 종료했습니다.'); return; }
  if (!Rec.paused && segElapsedMs() / 1000 >= SEG_SEC) { rotateSegment(); return; }
  // 진행 중 구간 임시 저장(앱이 강제 종료돼도 최대 30초 분량만 손실)
  if (!Rec.paused && performance.now() - Rec.lastPartial >= PARTIAL_SAVE_MS && Rec.segChunks.length) {
    Rec.lastPartial = performance.now();
    const idx = Rec.segIndex; const copy = Rec.segChunks.slice(); const sec = segElapsedMs() / 1000;
    Rec.pendingSave = Rec.pendingSave.then(async () => {
      const cur = await DB.get('segments', `${Rec.session.id}_${pad(idx, 3)}`);
      if (cur && !cur.partial) return; // 이미 확정 저장됨
      await saveSegment(idx, copy, sec, false);
      await saveSessionProgress();
    });
  }
}

async function startRecording() {
  if (!window.MediaRecorder || !navigator.mediaDevices) {
    setMsg($('recMsg'), '이 브라우저는 녹음을 지원하지 않습니다. Chrome 또는 삼성 인터넷 최신 버전에서 여십시오.', 'err');
    return;
  }
  try {
    Rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (e) {
    setMsg($('recMsg'), '마이크 사용이 허용되지 않았습니다. 브라우저 주소창 옆 설정에서 마이크 권한을 허용하십시오.', 'err');
    return;
  }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* 무시 */ }
  Rec.mime = pickMime();
  const now = Date.now();
  Rec.session = {
    id: 's' + now, title: '녹음 ' + fmtDate(now), createdAt: now, source: 'record',
    status: 'recording', durationSec: 0, transcript: '', summary: '', summaryType: '', summaryModel: '',
  };
  await DB.put('sessions', Rec.session);
  Rec.active = true; Rec.paused = false; Rec.stopping = false;
  Rec.segIndex = 0; Rec.doneSec = 0;
  Rec.pendingSave = Promise.resolve();
  Rec.stream.getAudioTracks().forEach((t) => {
    t.addEventListener('ended', () => abortRecording('마이크 연결이 끊겨 녹음이 중단되었습니다. 저장된 부분까지 보관했습니다.'));
  });
  startSegment();
  await requestWakeLock();
  Rec.timer = setInterval(tick, 500);
  $('btnRec').classList.add('recording');
  $('btnRec').setAttribute('aria-label', '녹음 중');
  $('btnPause').disabled = false; $('btnStop').disabled = false;
  setMsg($('recMsg'), '녹음 중입니다. 화면을 켜 둔 상태로 두십시오.');
}
function togglePause() {
  if (!Rec.active || !Rec.recorder) return;
  if (!Rec.paused) {
    Rec.recorder.pause();
    Rec.segActiveMs += performance.now() - Rec.segMark;
    Rec.paused = true;
    $('btnPause').textContent = '이어서 녹음';
    $('btnRec').classList.add('paused');
  } else {
    Rec.recorder.resume();
    Rec.segMark = performance.now();
    Rec.paused = false;
    $('btnPause').textContent = '일시정지';
    $('btnRec').classList.remove('paused');
  }
  tick();
}
async function stopRecording(note) {
  if (!Rec.active || Rec.stopping) return;
  Rec.stopping = true;
  clearInterval(Rec.timer);
  const r = Rec.recorder;
  const lastSec = segElapsedMs() / 1000;
  if (r) r._durSec = lastSec;
  const total = Rec.doneSec + lastSec;
  await new Promise((resolve) => {
    if (!r || r.state === 'inactive') { resolve(); return; }
    r.addEventListener('stop', () => resolve(), { once: true });
    try { r.stop(); } catch (e) { resolve(); }
  });
  await Rec.pendingSave;
  try { Rec.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* 무시 */ }
  releaseWakeLock();
  Rec.session.durationSec = Math.round(total);
  Rec.session.status = 'recorded';
  await DB.put('sessions', Rec.session);
  const id = Rec.session.id;
  Rec.active = false; Rec.paused = false; Rec.recorder = null; Rec.stream = null; Rec.session = null;
  resetRecordUI();
  if (note) toast(note, 4000);
  openDetail(id);
}
async function abortRecording(reason) {
  if (!Rec.active || Rec.stopping) return;
  await stopRecording(reason);
}
function resetRecordUI() {
  $('recTime').textContent = '00:00:00';
  $('recSegInfo').textContent = '대기 중';
  $('btnRec').classList.remove('recording', 'paused');
  $('btnRec').setAttribute('aria-label', '녹음 시작');
  $('btnPause').disabled = true; $('btnPause').textContent = '일시정지';
  $('btnStop').disabled = true;
  setMsg($('recMsg'), '');
}
$('btnRec').addEventListener('click', () => { if (!Rec.active) startRecording(); else togglePause(); });
$('btnPause').addEventListener('click', togglePause);
$('btnStop').addEventListener('click', () => stopRecording());

/* ---------------- 오디오 변환(디코딩·WAV) ---------------- */
function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
async function decodeToMono16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 16000 });
  try {
    const ab = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(ab);
    let mono;
    if (audio.numberOfChannels === 1) mono = audio.getChannelData(0);
    else {
      mono = new Float32Array(audio.length);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const d = audio.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels;
      }
    }
    return { data: mono, sampleRate: audio.sampleRate };
  } finally { try { await ctx.close(); } catch (e) { /* 무시 */ } }
}

/* ---------------- 파일 불러오기 ---------------- */
$('fileInput').addEventListener('change', () => {
  const f = $('fileInput').files[0];
  $('btnImport').disabled = !f;
  setMsg($('impMsg'), f ? `${f.name} (${(f.size / 1048576).toFixed(1)}MB)` : '');
});
$('btnImport').addEventListener('click', async () => {
  const f = $('fileInput').files[0];
  if (!f) return;
  $('btnImport').disabled = true;
  setMsg($('impMsg'), '파일을 읽는 중입니다. 큰 파일은 1~2분 걸릴 수 있습니다.');
  setProgress('impProgWrap', 'impProg', 0.05);
  try {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* 무시 */ }
    const { data, sampleRate } = await decodeToMono16k(f);
    const total = data.length / sampleRate;
    if (total > MAX_SEC + 60) throw new Error('3시간을 넘는 파일은 불러올 수 없습니다. 나눠서 불러오십시오.');
    const now = Date.now();
    const session = {
      id: 's' + now, title: f.name.replace(/\.[^.]+$/, ''), createdAt: now, source: 'file',
      status: 'recorded', durationSec: Math.round(total), transcript: '', summary: '', summaryType: '', summaryModel: '',
    };
    const per = SEG_SEC * sampleRate;
    const count = Math.max(1, Math.ceil(data.length / per));
    for (let i = 0; i < count; i++) {
      const part = data.subarray(i * per, Math.min(data.length, (i + 1) * per));
      const blob = encodeWav(part, sampleRate);
      await DB.put('segments', {
        id: `${session.id}_${pad(i, 3)}`, sessionId: session.id, index: i, blob, mime: 'audio/wav',
        durationSec: Math.round((part.length / sampleRate) * 10) / 10, transcript: null, partial: false,
      });
      setProgress('impProgWrap', 'impProg', 0.1 + 0.9 * ((i + 1) / count));
    }
    await DB.put('sessions', session);
    setMsg($('impMsg'), `${count}개 구간으로 저장했습니다.`, 'ok');
    $('fileInput').value = '';
    setProgress('impProgWrap', 'impProg', null);
    openDetail(session.id);
  } catch (e) {
    setProgress('impProgWrap', 'impProg', null);
    const msg = (e && e.message && /3시간/.test(e.message)) ? e.message
      : '파일을 읽지 못했습니다. 지원하지 않는 형식이거나 휴대폰 메모리가 부족할 수 있습니다. 녹음 앱에서 1시간 이하로 나눠 저장한 뒤 다시 시도하십시오.';
    setMsg($('impMsg'), msg, 'err');
  } finally {
    $('btnImport').disabled = !$('fileInput').files[0];
  }
});

/* ---------------- AI 호출 ---------------- */
class ApiError extends Error {
  constructor(msg, status, retry) { super(msg); this.status = status; this.retry = retry; }
}
async function parseError(res, provider) {
  let detail = '';
  try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.type)) || JSON.stringify(j).slice(0, 200); }
  catch (e) { try { detail = (await res.text()).slice(0, 200); } catch (e2) { /* 무시 */ } }
  const name = { openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude' }[provider];
  let hint = '';
  if (res.status === 401 || res.status === 403) hint = 'API 키가 맞지 않거나 권한이 없습니다. 설정에서 키를 확인하십시오.';
  else if (res.status === 404) hint = '모델 ID를 찾을 수 없습니다. 설정에서 "모델 목록 불러오기"로 다시 선택하십시오.';
  else if (res.status === 429) hint = '사용 한도 또는 요금 잔액을 확인하십시오. 잠시 후 다시 시도합니다.';
  else if (res.status === 413) hint = '전송 파일이 너무 큽니다.';
  const retry = res.status === 429 || res.status >= 500;
  return new ApiError(`${name} 오류(${res.status}) ${hint}\n${detail}`.trim(), res.status, retry);
}
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const network = !(e instanceof ApiError);
      if (!(network || e.retry) || i === tries - 1) break;
      await sleep(2000 * Math.pow(2, i));
    }
  }
  if (!(last instanceof ApiError)) {
    last = new ApiError('인터넷 연결을 확인하십시오. (' + (last && last.message ? last.message : '네트워크 오류') + ')', 0, true);
  }
  throw last;
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// gpt-transcribe 전용 매개변수(keywords·languages)를 서버가 거부하면 이 세션 동안은 빼고 보낸다
let openaiCompatMode = false;
async function sttOpenAI(seg, key, model, prevText) {
  const isGT = /^gpt-transcribe/.test(model);
  const build = (compat) => {
    const fd = new FormData();
    fd.append('file', seg.blob, 'segment' + extOf(seg.mime));
    fd.append('model', model);
    fd.append('prompt', sttPromptText(prevText));
    if (isGT) {
      if (!compat) {
        fd.append('languages[]', 'ko');
        vocabList().forEach((w) => fd.append('keywords[]', w));
      }
    } else {
      fd.append('language', 'ko');
      fd.append('response_format', 'json');
      fd.append('temperature', '0');
    }
    return fd;
  };
  const send = (compat) => fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: build(compat),
  });
  let res = await send(openaiCompatMode);
  if (!res.ok && res.status === 400 && isGT && !openaiCompatMode) {
    openaiCompatMode = true;
    res = await send(true);
  }
  if (!res.ok) throw await parseError(res, 'openai');
  const j = await res.json();
  return (j.text || '').trim();
}
async function sttGemini(seg, key, model, prevText, wavBlob) {
  // Gemini는 WAV(16kHz·모노)로 변환해 인라인 전송(5분 ≈ 9.6MB, 20MB 한도 이내)
  let wav = wavBlob || seg.blob;
  if (!wavBlob && seg.mime !== 'audio/wav') {
    const { data, sampleRate } = await decodeToMono16k(seg.blob);
    wav = encodeWav(data, sampleRate);
  }
  const b64 = await blobToBase64(wav);
  let prompt = GEMINI_STT_PROMPT;
  const v = vocabList();
  if (v.length) prompt += '\n등장할 수 있는 이름·지명·단지명(들리는 경우에만 이 표기로 적으세요): ' + v.join(', ');
  if (prevText) prompt += '\n참고: 바로 앞 구간의 마지막 내용입니다. 이 부분은 다시 적지 말고 이 음성에 담긴 내용만 받아 적으세요: "' + tailText(prevText, CONTEXT_CHARS) + '"';
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: b64 } }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res, 'gemini');
  const j = await res.json();
  return geminiText(j);
}
function geminiText(j) {
  const c = j.candidates && j.candidates[0];
  if (!c || !c.content || !c.content.parts) {
    const reason = (c && c.finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || '응답 없음';
    throw new ApiError(`Gemini가 결과를 돌려주지 않았습니다(${reason}).`, 0, false);
  }
  return c.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
}

async function sumOpenAI(text, key, model, tpl) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SUM_SYSTEM }, { role: 'user', content: tpl.prompt + '\n\n[전사문]\n' + text }],
    }),
  });
  if (!res.ok) throw await parseError(res, 'openai');
  const j = await res.json();
  return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
}
async function sumGemini(text, key, model, tpl) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SUM_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: tpl.prompt + '\n\n[전사문]\n' + text }] }],
    }),
  });
  if (!res.ok) throw await parseError(res, 'gemini');
  return geminiText(await res.json());
}
async function sumClaude(text, key, model, tpl) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model, max_tokens: 8000, system: SUM_SYSTEM,
      messages: [{ role: 'user', content: tpl.prompt + '\n\n[전사문]\n' + text }],
    }),
  });
  if (!res.ok) throw await parseError(res, 'claude');
  const j = await res.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function listModels(provider, purpose) {
  const key = getKeys()[provider];
  if (!key) throw new Error('먼저 해당 AI의 API 키를 입력하고 "설정 저장"을 누르십시오.');
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key } });
    if (!res.ok) throw await parseError(res, 'openai');
    const ids = ((await res.json()).data || []).map((m) => m.id);
    return (purpose === 'stt'
      ? ids.filter((id) => /transcribe|whisper/.test(id) && !/realtime|live/.test(id))
      : ids.filter((id) => /^(gpt|o\d)/.test(id) && !/audio|realtime|transcribe|tts|image|search|embedding|live/.test(id))).sort();
  }
  if (provider === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await parseError(res, 'gemini');
    return ((await res.json()).models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/.test(m.name) && !/image|tts|embedding|live/.test(m.name))
      .map((m) => m.name.replace(/^models\//, '')).sort();
  }
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
  });
  if (!res.ok) throw await parseError(res, 'claude');
  return ((await res.json()).data || []).map((m) => m.id);
}

/* ---------------- 변환·정리 작업 ---------------- */
const Job = { running: false };

function joinTranscript(segs) {
  let t = 0;
  return segs.map((s) => {
    const head = `[${fmtDur(t)} ~ ${fmtDur(t + (s.durationSec || 0))}]`;
    t += s.durationSec || 0;
    return head + (s.warn ? ' [인식 확인 필요]' : '') + '\n' + (s.transcript || '(인식된 내용 없음)');
  }).join('\n\n');
}

async function runTranscribe(id) {
  const keys = getKeys();
  const provider = settings.sttProvider;
  const key = keys[provider];
  const model = (settings.sttModel[provider] || '').trim();
  const msg = $('dMsg');
  if (!key) { setMsg(msg, '설정에서 ' + (provider === 'openai' ? 'OpenAI' : 'Gemini') + ' API 키를 입력하십시오.', 'err'); return; }
  if (!model) { setMsg(msg, '설정에서 텍스트 변환 모델 ID를 입력하십시오.', 'err'); return; }
  const segs = await DB.segs(id);
  if (!segs.length) { setMsg(msg, '변환할 녹음 구간이 없습니다.', 'err'); return; }
  Job.running = true; setBusy(true);
  await requestWakeLock();
  try {
    let done = segs.filter((s) => s.transcript != null).length;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.transcript != null) continue;
      setMsg(msg, `텍스트 변환 중… 구간 ${done + 1}/${segs.length}\n변환이 끝날 때까지 이 화면을 켜 두십시오.`);
      setProgress('dProgWrap', 'dProg', done / segs.length);
      // 앞 구간의 끝부분을 문맥으로 전달(구간 경계에서 끊기는 문장의 인식 개선)
      let prevText = '';
      for (let k = i - 1; k >= 0; k--) { if (segs[k].transcript && !segs[k].silent) { prevText = segs[k].transcript; break; } }
      // 디코딩: 무음 판정 + Gemini용 WAV 준비(실패해도 원본 그대로 전송)
      let mono = null;
      try { mono = await decodeToMono16k(s.blob); } catch (e) { mono = null; }
      if (mono && isSilent(mono.data)) {
        s.transcript = '(무음 구간)'; s.silent = true; s.warn = false;
      } else {
        const wav = (provider === 'gemini' && mono && s.mime !== 'audio/wav') ? encodeWav(mono.data, mono.sampleRate) : null;
        mono = null;
        const call = (ctx) => (provider === 'openai' ? sttOpenAI(s, key, model, ctx) : sttGemini(s, key, model, ctx, wav));
        let text = await withRetry(() => call(prevText));
        let warn = false;
        if (looksBroken(text)) {
          // 반복 인식 오류: 문맥 없이 한 번 더 시도하고, 그래도 이상하면 표시만 남김
          const again = await withRetry(() => call(''));
          if (!looksBroken(again)) text = again; else warn = true;
        }
        s.transcript = text; s.silent = false; s.warn = warn;
      }
      await DB.put('segments', s);
      done++;
      setProgress('dProgWrap', 'dProg', done / segs.length);
    }
    const ses = await DB.get('sessions', id);
    ses.transcript = joinTranscript(segs);
    ses.status = 'transcribed';
    ses.sttModel = `${provider}:${model}`;
    await DB.put('sessions', ses);
    setMsg(msg, '텍스트 변환을 마쳤습니다.', 'ok');
    selectTab('raw');
  } catch (e) {
    setMsg(msg, (e.message || '변환 실패') + '\n이미 변환된 구간은 보관되어 있으며, "텍스트 변환"을 다시 누르면 남은 구간부터 이어서 합니다.', 'err');
  } finally {
    Job.running = false; setBusy(false);
    setProgress('dProgWrap', 'dProg', null);
    if (!Rec.active) releaseWakeLock();
    await renderDetail();
  }
}

async function runSummarize(id) {
  const ses = await DB.get('sessions', id);
  const msg = $('dMsg');
  if (!ses.transcript) { setMsg(msg, '먼저 "텍스트 변환"을 하십시오.', 'err'); return; }
  const provider = settings.sumProvider;
  const key = getKeys()[provider];
  const model = (settings.sumModel[provider] || '').trim();
  const name = { openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude' }[provider];
  if (!key) { setMsg(msg, `설정에서 ${name} API 키를 입력하십시오.`, 'err'); return; }
  if (!model) { setMsg(msg, '설정에서 AI 정리 모델 ID를 입력하십시오.', 'err'); return; }
  const type = $('sumType').value;
  const tpl = SUM_TEMPLATES[type];
  Job.running = true; setBusy(true);
  await requestWakeLock();
  setMsg(msg, `${name}로 ${tpl.label === '상담정리' ? '상담 정리' : '회의록'}를 작성하는 중입니다. 분량에 따라 1~3분 걸릴 수 있습니다.`);
  setProgress('dProgWrap', 'dProg', 0.5);
  try {
    const fn = provider === 'openai' ? sumOpenAI : provider === 'gemini' ? sumGemini : sumClaude;
    const out = await withRetry(() => fn(ses.transcript, key, model, tpl), 2);
    if (!out) throw new ApiError('AI가 빈 결과를 돌려주었습니다. 다른 모델로 다시 시도하십시오.', 0, false);
    ses.summary = out; ses.summaryType = type; ses.summaryModel = `${provider}:${model}`;
    ses.status = 'summarized';
    await DB.put('sessions', ses);
    setMsg(msg, 'AI 정리를 마쳤습니다.', 'ok');
    selectTab('sum');
  } catch (e) {
    setMsg(msg, e.message || '정리 실패', 'err');
  } finally {
    Job.running = false; setBusy(false);
    setProgress('dProgWrap', 'dProg', null);
    if (!Rec.active) releaseWakeLock();
    await renderDetail();
  }
}
function setBusy(b) {
  ['btnTranscribe', 'btnSummarize', 'btnDelete', 'btnRename', 'sumType'].forEach((id) => { $(id).disabled = b; });
  $('btnBack').disabled = b;
}

/* ---------------- 작업 기록·상세 ---------------- */
const STATUS = {
  recording: ['녹음 중', 'warn'], interrupted: ['중단됨(저장분 보관)', 'warn'], recorded: ['녹음 완료', ''],
  transcribed: ['변환 완료', ''], summarized: ['정리 완료', ''],
};
// 작업 기록 선택 삭제
let selMode = false;
const selected = new Set();
let historyIds = [];
function updateSelBar() {
  $('histSelBar').hidden = !selMode;
  $('btnSelMode').hidden = selMode || historyIds.length === 0;
  $('btnSelDel').textContent = `삭제 (${selected.size})`;
  $('btnSelDel').disabled = selected.size === 0;
  $('btnSelAll').textContent = (selected.size === historyIds.length && historyIds.length) ? '전체 해제' : '전체 선택';
}
async function renderHistory() {
  const list = (await DB.all('sessions')).sort((a, b) => b.createdAt - a.createdAt);
  historyIds = list.map((s) => s.id);
  for (const id of [...selected]) if (!historyIds.includes(id)) selected.delete(id);
  if (!list.length) selMode = false;
  const box = $('historyList');
  box.innerHTML = '';
  $('historyEmpty').hidden = list.length > 0;
  for (const s of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'item' + (selMode ? ' selectable' : '') + (selected.has(s.id) ? ' checked' : '');
    b.dataset.id = s.id;
    if (selMode) b.setAttribute('aria-pressed', selected.has(s.id) ? 'true' : 'false');
    const st = STATUS[s.status] || ['', ''];
    const t = document.createElement('div'); t.className = 't';
    if (selMode) { const ck = document.createElement('span'); ck.className = 'ck'; ck.textContent = selected.has(s.id) ? '☑' : '☐'; t.appendChild(ck); }
    t.appendChild(document.createTextNode(s.title));
    const m = document.createElement('div'); m.className = 'm';
    m.textContent = `${fmtDate(s.createdAt)} · ${fmtDur(s.durationSec || 0)} · ${s.source === 'file' ? '파일' : '녹음'}`;
    const c = document.createElement('span'); c.className = 'chip' + (st[1] ? ' ' + st[1] : ''); c.textContent = st[0];
    m.appendChild(c);
    b.append(t, m);
    b.addEventListener('click', () => {
      if (!selMode) { openDetail(s.id); return; }
      if (selected.has(s.id)) selected.delete(s.id); else selected.add(s.id);
      renderHistory();
    });
    box.appendChild(b);
  }
  updateSelBar();
}
$('btnSelMode').addEventListener('click', () => { selMode = true; selected.clear(); renderHistory(); });
$('btnSelCancel').addEventListener('click', () => { selMode = false; selected.clear(); renderHistory(); });
$('btnSelAll').addEventListener('click', () => {
  if (selected.size === historyIds.length) selected.clear(); else historyIds.forEach((id) => selected.add(id));
  renderHistory();
});
$('btnSelDel').addEventListener('click', async () => {
  const n = selected.size;
  if (!n) return;
  if (!confirm(`선택한 ${n}건의 녹음과 텍스트를 휴대폰에서 삭제합니다. 되돌릴 수 없습니다. 삭제하시겠습니까?`)) return;
  $('btnSelDel').disabled = true;
  let ok = 0;
  for (const id of [...selected]) {
    if (Rec.session && Rec.session.id === id) continue; // 녹음 중인 항목은 삭제하지 않음
    try { await DB.deleteSession(id); ok++; } catch (e) { /* 다음 항목 계속 */ }
    selected.delete(id);
  }
  selMode = false; selected.clear();
  toast(ok === n ? `${ok}건을 삭제했습니다.` : `${ok}건을 삭제했습니다. ${n - ok}건은 삭제하지 못했습니다.`, 3500);
  renderHistory();
});
let currentTab = 'raw';
function selectTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  renderDetail();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

async function openDetail(id) {
  currentSessionId = id;
  textFileCache = null;
  currentTab = 'raw';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'raw'));
  setMsg($('dMsg'), '');
  show('detail');
  await renderDetail();
}
async function renderDetail() {
  if (!currentSessionId) return;
  const s = await DB.get('sessions', currentSessionId);
  if (!s) return;
  const segs = await DB.segs(s.id);
  const doneSegs = segs.filter((x) => x.transcript != null).length;
  $('dTitle').textContent = s.title;
  const st = STATUS[s.status] || [''];
  $('dMeta').textContent = `${fmtDate(s.createdAt)} · ${fmtDur(s.durationSec || 0)} · 구간 ${segs.length}개 · ${st[0]}`;
  $('btnTranscribe').textContent = s.transcript ? '텍스트 다시 변환'
    : (doneSegs > 0 ? `텍스트 변환 이어서 하기 (${doneSegs}/${segs.length})` : '텍스트 변환');
  if (s.summaryType) $('sumType').value = s.summaryType;
  const text = currentTab === 'raw' ? s.transcript : s.summary;
  $('dText').textContent = text || (currentTab === 'raw' ? '아직 텍스트 변환을 하지 않았습니다.' : '아직 AI 정리를 하지 않았습니다.');
  const has = !!text;
  // 공유는 버튼을 누른 직후 바로 실행해야 하므로(브라우저 보안 규칙) 파일 내용을 미리 만들어 둔다
  textFileCache = has ? buildTextFile(s, currentTab) : null;
  $('btnSaveTxt').disabled = !has; $('btnShareTxt').disabled = !has; $('btnCopy').disabled = !has;
}
$('btnTranscribe').addEventListener('click', async () => {
  if (Job.running || !currentSessionId) return;
  const s = await DB.get('sessions', currentSessionId);
  if (s.transcript) {
    if (!confirm('이미 변환된 텍스트가 있습니다. 처음부터 다시 변환하시겠습니까? (요금이 다시 발생합니다)')) return;
    const segs = await DB.segs(s.id);
    for (const g of segs) { g.transcript = null; await DB.put('segments', g); }
    s.transcript = ''; await DB.put('sessions', s);
  }
  runTranscribe(currentSessionId);
});
$('btnSummarize').addEventListener('click', async () => {
  if (Job.running || !currentSessionId) return;
  const s = await DB.get('sessions', currentSessionId);
  if (s.summary && !confirm('이미 정리된 내용이 있습니다. 새로 정리하시겠습니까? (기존 정리는 바뀝니다)')) return;
  runSummarize(currentSessionId);
});
$('btnRename').addEventListener('click', async () => {
  const s = await DB.get('sessions', currentSessionId);
  const name = prompt('작업 이름', s.title);
  if (name && name.trim()) { s.title = name.trim().slice(0, 80); await DB.put('sessions', s); renderDetail(); }
});
$('btnDelete').addEventListener('click', async () => {
  if (!confirm('이 작업의 녹음과 텍스트를 휴대폰에서 삭제합니다. 되돌릴 수 없습니다. 삭제하시겠습니까?')) return;
  await DB.deleteSession(currentSessionId);
  currentSessionId = null;
  toast('삭제했습니다.');
  show('history');
});

function safeName(s) { return s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40); }
let textFileCache = null;
function buildTextFile(s, tab) {
  const isRaw = tab === 'raw';
  const text = isRaw ? s.transcript : s.summary;
  if (!text) return null;
  const kind = isRaw ? '원본' : (SUM_TEMPLATES[s.summaryType] ? SUM_TEMPLATES[s.summaryType].label : 'AI정리');
  const header = `${s.title}\n작성: ${fmtDate(s.createdAt)} · 길이 ${fmtDur(s.durationSec || 0)}\n` +
    (isRaw ? `변환: ${s.sttModel || ''}` : `정리: ${s.summaryModel || ''}`) + '\n' + '-'.repeat(30) + '\n\n';
  const name = `REAL_${kind}_${fileStamp(s.createdAt)}_${safeName(s.title)}.txt`;
  return { name, text: header + text };
}
async function currentTextFile() {
  if (textFileCache) return textFileCache;
  const s = await DB.get('sessions', currentSessionId);
  return s ? buildTextFile(s, currentTab) : null;
}
function copyFallback(text) {
  // 클립보드 API가 막힌 경우를 위한 대체 복사
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok;
  } catch (e) { return false; }
}
$('btnSaveTxt').addEventListener('click', async () => {
  const f = await currentTextFile();
  if (!f) return;
  const blob = new Blob(['﻿' + f.text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('내 파일 > 다운로드 폴더에 저장했습니다.', 3500);
});
$('btnShareTxt').addEventListener('click', () => {
  // 주의: 이 함수 안에서 await 없이 바로 navigator.share를 호출해야 안드로이드에서 공유 창이 열린다
  const f = textFileCache;
  if (!f) { toast('공유할 내용이 없습니다.'); return; }
  if (!navigator.share) {
    const ok = copyFallback(f.text);
    toast(ok ? '이 브라우저는 공유를 지원하지 않아 내용을 복사했습니다. 카카오톡 등에 붙여 넣으십시오.' : '이 브라우저는 공유를 지원하지 않습니다. "txt 저장"을 사용하십시오.', 4500);
    return;
  }
  let data;
  try {
    const file = new File([f.text], f.name, { type: 'text/plain' });
    data = (navigator.canShare && navigator.canShare({ files: [file] })) ? { files: [file] } : { title: f.name, text: f.text };
  } catch (e) { data = { title: f.name, text: f.text }; }
  let p;
  try { p = navigator.share(data); }
  catch (e) { p = Promise.reject(e); }
  p.catch((e) => {
    if (e && e.name === 'AbortError') return; // 사용자가 공유 창을 닫음
    const ok = copyFallback(f.text);
    toast(`공유 창을 열지 못했습니다(${(e && e.name) || '오류'}). ` + (ok ? '내용을 복사했으니 카카오톡 등에 붙여 넣으십시오.' : '"txt 저장"을 사용하십시오.'), 5000);
  });
});
$('btnCopy').addEventListener('click', async () => {
  const f = await currentTextFile();
  if (!f) return;
  try { await navigator.clipboard.writeText(f.text); toast('복사했습니다.'); }
  catch (e) { toast(copyFallback(f.text) ? '복사했습니다.' : '복사하지 못했습니다.'); }
});

/* ---------------- 설정 화면 ---------------- */
function renderSettings() {
  const k = getKeys();
  $('sttProvider').value = settings.sttProvider;
  $('sttModel').value = settings.sttModel[settings.sttProvider] || '';
  $('sumProvider').value = settings.sumProvider;
  $('sumModel').value = settings.sumModel[settings.sumProvider] || '';
  $('keyOpenai').value = k.openai || ''; $('keyGemini').value = k.gemini || ''; $('keyClaude').value = k.claude || '';
  $('saveKeys').checked = !!settings.saveKeys;
  $('sttVocab').value = settings.vocab || '';
  setMsg($('setMsg'), ''); setMsg($('pinMsg'), '');
  renderStorage();
}
$('sttProvider').addEventListener('change', () => {
  settings.sttModel[settings.sttProvider] = $('sttModel').value.trim();
  settings.sttProvider = $('sttProvider').value;
  $('sttModel').value = settings.sttModel[settings.sttProvider] || '';
  $('sttModelList').innerHTML = '';
});
$('sumProvider').addEventListener('change', () => {
  settings.sumModel[settings.sumProvider] = $('sumModel').value.trim();
  settings.sumProvider = $('sumProvider').value;
  $('sumModel').value = settings.sumModel[settings.sumProvider] || '';
  $('sumModelList').innerHTML = '';
});
function collectSettings() {
  settings.sttProvider = $('sttProvider').value;
  settings.sttModel[settings.sttProvider] = $('sttModel').value.trim();
  settings.sumProvider = $('sumProvider').value;
  settings.sumModel[settings.sumProvider] = $('sumModel').value.trim();
  settings.saveKeys = $('saveKeys').checked;
  settings.vocab = $('sttVocab').value.slice(0, 2000);
  localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  storeKeys({ openai: $('keyOpenai').value.trim(), gemini: $('keyGemini').value.trim(), claude: $('keyClaude').value.trim() });
}
$('btnSaveSettings').addEventListener('click', () => {
  collectSettings();
  setMsg($('setMsg'), '설정을 저장했습니다.', 'ok');
});
async function fillModels(providerSel, listId, purpose, btn) {
  collectSettings();
  btn.disabled = true;
  try {
    const ids = await listModels($(providerSel).value, purpose);
    const dl = $(listId); dl.innerHTML = '';
    ids.forEach((id) => { const o = document.createElement('option'); o.value = id; dl.appendChild(o); });
    setMsg($('setMsg'), ids.length ? `모델 ${ids.length}개를 불러왔습니다. 모델 ID 칸을 누르면 목록에서 고를 수 있습니다.` : '조건에 맞는 모델이 없습니다.', ids.length ? 'ok' : 'err');
  } catch (e) { setMsg($('setMsg'), e.message || '모델 목록을 불러오지 못했습니다.', 'err'); }
  finally { btn.disabled = false; }
}
$('btnSttModels').addEventListener('click', (e) => fillModels('sttProvider', 'sttModelList', 'stt', e.currentTarget));
$('btnSumModels').addEventListener('click', (e) => fillModels('sumProvider', 'sumModelList', 'sum', e.currentTarget));
async function renderStorage() {
  try {
    const list = await DB.all('sessions');
    let txt = `작업 ${list.length}건`;
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      txt += ` · 사용 ${(est.usage / 1048576).toFixed(1)}MB / 가능 ${(est.quota / 1073741824).toFixed(1)}GB`;
    }
    if (navigator.storage && navigator.storage.persisted) {
      txt += (await navigator.storage.persisted()) ? ' · 자동 삭제 방지 설정됨' : ' · 자동 삭제 방지 미설정(첫 녹음 시 요청)';
    }
    $('storageInfo').textContent = txt;
  } catch (e) { $('storageInfo').textContent = '저장 공간 정보를 확인할 수 없습니다.'; }
}
$('btnDeleteAll').addEventListener('click', async () => {
  if (!confirm('모든 녹음과 텍스트를 휴대폰에서 삭제합니다. 되돌릴 수 없습니다. 삭제하시겠습니까?')) return;
  const list = await DB.all('sessions');
  for (const s of list) await DB.deleteSession(s.id);
  toast('모든 작업 기록을 삭제했습니다.');
  renderStorage();
});

/* ---------------- 시작 ---------------- */
async function recoverInterrupted() {
  // 앱이 녹음 도중 종료된 경우: 임시 저장분까지 보관하고 상태를 '중단됨'으로 바꾼다
  const list = await DB.all('sessions');
  for (const s of list) {
    if (s.status !== 'recording') continue;
    const segs = await DB.segs(s.id);
    s.durationSec = Math.round(segs.reduce((a, g) => a + (g.durationSec || 0), 0));
    s.status = segs.length ? 'interrupted' : 'recorded';
    for (const g of segs) if (g.partial) { g.partial = false; await DB.put('segments', g); }
    await DB.put('sessions', s);
  }
}
async function init() {
  $('appVer').textContent = APP_VERSION;
  try { await DB.open(); } catch (e) {
    document.body.innerHTML = '<p style="padding:20px">저장 공간을 열 수 없습니다. 브라우저의 시크릿 모드가 아닌 일반 모드에서 여십시오.</p>';
    return;
  }
  await recoverInterrupted();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 무시 */ });
  }
  history.replaceState({ view: 'home' }, '');
  if (localStorage.getItem(LS_PIN)) show('lock', false);
  else show('home', false);
  if (settingsMigrated) toast('OpenAI 음성 인식 모델을 새 권장 모델(gpt-transcribe)로 바꿨습니다. 설정에서 확인할 수 있습니다.', 5000);
}
init();
