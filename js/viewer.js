// Full-screen music viewer with BPM-driven auto-scroll.
//
// How the scroll speed is worked out:
//   seconds per bar = (beats per bar × 4 / beat unit) ÷ (BPM × tempo note value in quarters) × 60
//   e.g. 3/4 at ♩=90  ->  3 quarters ÷ 90 × 60 = 2.0 s per bar
//
// If the PDF has bar numbers, we know where each bar starts on the page, so the scroll speeds up
// or slows down per system to stay in time. Otherwise it scrolls evenly over (bars × seconds per bar).
import * as db from './db.js';
import { loadPdf } from './pdf.js';
import { analyzePdf } from './detect.js';
import { toast } from './ui.js';

const READING_LINE = 0.3; // the bar being played sits 30% down the screen

const $ = sel => document.querySelector(sel);

let state = null;

export async function openViewer(song, onClose) {
  const bytes = await db.getPdf(song.id);
  if (!bytes) { toast('PDF missing for this song'); return; }

  song.lastOpened = Date.now();
  db.put('songs', song);

  const root = $('#viewer');
  root.hidden = false;
  document.body.classList.add('viewing');
  $('#v-title').textContent = song.title;

  const pdf = await loadPdf(bytes);
  state = {
    song, pdf, onClose,
    pages: [], // { el, canvas, w, h, top, rendered, task }
    playing: false, t: 0, lastTs: 0, raf: 0,
    countIn: 0, wake: null, userTouching: false, chromeTimer: 0,
  };
  await buildPages();
  fillSettings();
  showChrome(true);
  updateStatus();
}

function closeViewer() {
  if (!state) return;
  stop();
  for (const p of state.pages) freeCanvas(p);
  state.pdf.destroy();
  $('#v-pages').innerHTML = '';
  $('#viewer').hidden = true;
  $('#v-settings').hidden = true;
  document.body.classList.remove('viewing');
  const cb = state.onClose;
  state = null;
  cb && cb();
}

// ---------- Layout & lazy rendering ----------

async function buildPages() {
  const wrap = $('#v-pages');
  wrap.innerHTML = '';
  state.pages = [];
  for (let i = 1; i <= state.pdf.numPages; i++) {
    const page = await state.pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const el = document.createElement('div');
    el.className = 'v-page';
    wrap.appendChild(el);
    state.pages.push({ index: i, el, ratio: vp.height / vp.width, canvas: null, rendered: 0, task: null });
  }
  layout();
}

function layout() {
  const scroller = $('#v-scroll');
  const width = scroller.clientWidth;
  for (const p of state.pages) {
    p.w = width; p.h = Math.round(width * p.ratio);
    p.el.style.height = p.h + 'px';
    if (p.rendered && p.rendered !== width) freeCanvas(p);
  }
  // Read real positions (includes the top padding under the toolbar).
  for (const p of state.pages) p.top = p.el.offsetTop;
  drawMarkers();
  renderVisible();
}

function freeCanvas(p) {
  if (p.task) { try { p.task.cancel(); } catch {} p.task = null; }
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
  p.rendered = 0;
}

async function renderPage(p) {
  if (p.rendered === p.w || p.task) return;
  const page = await state.pdf.getPage(p.index);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = (p.w / page.getViewport({ scale: 1 }).width) * dpr;
  // iOS limits canvas size; stay well under ~16M pixels.
  const vp0 = page.getViewport({ scale });
  const maxPixels = 12e6;
  if (vp0.width * vp0.height > maxPixels) scale *= Math.sqrt(maxPixels / (vp0.width * vp0.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const width = p.w;
  p.task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  try {
    await p.task.promise;
  } catch { canvas.width = canvas.height = 0; return; } finally { p.task = null; }
  if (!state || p.w !== width) { canvas.width = canvas.height = 0; return; }
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); }
  p.canvas = canvas;
  p.el.prepend(canvas);
  p.rendered = width;
}

function renderVisible() {
  if (!state) return;
  const scroller = $('#v-scroll');
  const viewTop = scroller.scrollTop, vh = scroller.clientHeight;
  for (const p of state.pages) {
    const near = p.top + p.h > viewTop - vh && p.top < viewTop + 2 * vh;
    const far = p.top + p.h < viewTop - 3 * vh || p.top > viewTop + 4 * vh;
    if (near) renderPage(p);
    else if (far && p.canvas) freeCanvas(p);
  }
}

function drawMarkers() {
  for (const p of state.pages) p.el.querySelectorAll('.v-mark').forEach(m => m.remove());
  const s = state.song.scroll;
  if (!s.showMarks) return;
  for (const m of s.marks || []) {
    const p = state.pages[m.page];
    if (!p) continue;
    const tag = document.createElement('div');
    tag.className = 'v-mark';
    tag.style.top = (m.y * 100) + '%';
    tag.textContent = 'Bar ' + m.bar;
    p.el.appendChild(tag);
  }
}

// ---------- Timing ----------

function secondsPerBar(s) {
  const quartersPerBar = s.beatsPerBar * 4 / s.beatUnit;
  return quartersPerBar / (s.bpm * (s.tempoUnit || 1)) * 60;
}

// Keyframes: (time in seconds, y position in the document in px)
function keyframes() {
  const s = state.song.scroll;
  if (!s.bpm) return null;
  const spb = secondsPerBar(s);
  const docY = (page, y) => { const p = state.pages[page]; return p ? p.top + y * p.h : 0; };
  const last = state.pages[state.pages.length - 1];
  const docEnd = last.top + last.h;
  const pts = [];
  if (s.marks && s.marks.length >= 2) {
    for (const m of s.marks) pts.push({ t: (m.bar - 1) * spb, y: docY(m.page, m.y) });
    const total = Math.max(s.totalBars || 0, s.marks[s.marks.length - 1].bar);
    const end = s.endMark ? docY(s.endMark.page, s.endMark.y) : docEnd;
    pts.push({ t: total * spb, y: end });
  } else if (s.totalBars) {
    pts.push({ t: 0, y: 0 }, { t: s.totalBars * spb, y: docEnd });
  } else return null;
  // Keep strictly increasing in both time and position.
  const clean = [pts[0]];
  for (const p of pts.slice(1)) {
    const q = clean[clean.length - 1];
    if (p.t > q.t && p.y > q.y) clean.push(p);
  }
  return clean.length >= 2 ? clean : null;
}

function yAtTime(k, t) {
  if (t <= k[0].t) return k[0].y;
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      const a = k[i - 1], b = k[i];
      return a.y + (b.y - a.y) * (t - a.t) / (b.t - a.t);
    }
  }
  return k[k.length - 1].y;
}

function timeAtY(k, y) {
  if (y <= k[0].y) return k[0].t;
  for (let i = 1; i < k.length; i++) {
    if (y <= k[i].y) {
      const a = k[i - 1], b = k[i];
      return a.t + (b.t - a.t) * (y - a.y) / (b.y - a.y);
    }
  }
  return k[k.length - 1].t;
}

function scrollTopForTime(k, t) {
  const sc = $('#v-scroll');
  return yAtTime(k, t) - sc.clientHeight * READING_LINE;
}

function syncTimeToScroll() {
  const k = keyframes();
  if (!k) return;
  const sc = $('#v-scroll');
  state.t = timeAtY(k, sc.scrollTop + sc.clientHeight * READING_LINE);
}

// ---------- Playback ----------

function play() {
  const s = state.song.scroll;
  const k = keyframes();
  if (!k) {
    toast(s.bpm ? 'Enter the number of bars in Settings' : 'Set the BPM in Settings first');
    openSettings();
    return;
  }
  syncTimeToScroll();
  if (state.t >= k[k.length - 1].t - 0.05) state.t = 0;
  $('#v-scroll').scrollTop = scrollTopForTime(k, state.t);
  state.playing = true;
  state.countIn = s.countIn ? s.beatsPerBar : 0;
  state.countStart = performance.now();
  state.lastTs = 0;
  acquireWakeLock();
  $('#v-play').classList.add('playing');
  $('#v-play').setAttribute('aria-label', 'Pause');
  showChrome(false);
  state.raf = requestAnimationFrame(tick);
}

function stop() {
  if (!state) return;
  state.playing = false;
  cancelAnimationFrame(state.raf);
  $('#v-count').hidden = true;
  $('#v-play').classList.remove('playing');
  $('#v-play').setAttribute('aria-label', 'Play');
  releaseWakeLock();
}

function tick(ts) {
  if (!state || !state.playing) return;
  const s = state.song.scroll;
  const k = keyframes();
  const sc = $('#v-scroll');

  if (state.countIn > 0) {
    const beat = secondsPerBar(s) / s.beatsPerBar;
    const beatsGone = Math.floor((ts - state.countStart) / 1000 / beat);
    const left = state.countIn - beatsGone;
    const c = $('#v-count');
    if (left > 0) { c.hidden = false; c.textContent = left; state.raf = requestAnimationFrame(tick); return; }
    c.hidden = true;
    state.countIn = 0;
  }

  if (state.lastTs && !state.userTouching) {
    const dt = Math.min(0.1, (ts - state.lastTs) / 1000);
    state.t += dt;
    sc.scrollTop = scrollTopForTime(k, state.t);
  }
  state.lastTs = ts;
  updateStatus();
  if (state.t >= k[k.length - 1].t) { stop(); toast('End of piece'); showChrome(true); return; }
  state.raf = requestAnimationFrame(tick);
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wake) {
      state.wake = await navigator.wakeLock.request('screen');
      state.wake.addEventListener('release', () => { if (state) state.wake = null; });
    }
  } catch { /* not supported: screen may dim on long pieces */ }
}
function releaseWakeLock() {
  if (state && state.wake) { state.wake.release().catch(() => {}); state.wake = null; }
}

function updateStatus() {
  const s = state.song.scroll;
  const el = $('#v-status');
  const k = keyframes();
  if (!k) { el.textContent = s.bpm ? `♩ = ${s.bpm}` : 'No tempo set'; return; }
  const spb = secondsPerBar(s);
  const bar = Math.min(Math.floor(state.t / spb) + 1, Math.round(k[k.length - 1].t / spb));
  const total = Math.round(k[k.length - 1].t / spb);
  el.textContent = `Bar ${bar} / ${total} · ${s.bpm} BPM · ${s.beatsPerBar}/${s.beatUnit}`;
}

// ---------- Chrome (toolbar) ----------

function showChrome(show) {
  const v = $('#viewer');
  v.classList.toggle('chrome-hidden', !show);
}

// ---------- Settings panel ----------

const NOTE_LABELS = [[1, '♩ quarter'], [1.5, '♩. dotted quarter'], [2, '𝅗𝅥 half'], [3, '𝅗𝅥. dotted half'], [0.5, '♪ eighth']];

function fillSettings() {
  const s = state.song.scroll;
  $('#s-bpm').value = s.bpm || '';
  $('#s-unit').innerHTML = NOTE_LABELS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('#s-unit').value = String(s.tempoUnit || 1);
  $('#s-num').value = s.beatsPerBar;
  $('#s-den').value = String(s.beatUnit);
  $('#s-bars').value = s.totalBars || '';
  $('#s-countin').checked = !!s.countIn;
  $('#s-marks').checked = !!s.showMarks;
  renderDetectInfo();
}

function renderDetectInfo() {
  const d = state.song.scroll.detected;
  const el = $('#s-detected');
  if (!d) { el.textContent = 'Not analysed yet.'; return; }
  const parts = [];
  const how = { text: 'PDF text', ocr: 'OCR (scanned)', 'text+ocr': 'PDF text + OCR', none: 'nothing readable' }[d.method] || d.method;
  parts.push(`Read using: ${how}.`);
  if (d.bpm) parts.push(`Tempo: ${d.bpm} BPM ${d.tempoSource === 'word' ? `(estimated from “${d.tempoText}”)` : `(from “${d.tempoText}”)`}.`);
  parts.push(`Time signature: ${d.beatsPerBar}/${d.beatUnit}${d.timeSigSource === 'assumed' ? ' (assumed)' : ''}.`);
  if (d.marks.length) parts.push(`Found ${d.marks.length} system starts; about ${d.totalBars} bars.`);
  el.textContent = [...parts, ...d.notes].join(' ');
}

function readSettings() {
  const s = state.song.scroll;
  const bpm = parseFloat($('#s-bpm').value);
  s.bpm = bpm > 0 ? Math.min(400, bpm) : null;
  s.tempoUnit = parseFloat($('#s-unit').value) || 1;
  s.beatsPerBar = Math.max(1, parseInt($('#s-num').value, 10) || 4);
  s.beatUnit = parseInt($('#s-den').value, 10) || 4;
  const bars = parseInt($('#s-bars').value, 10);
  s.totalBars = bars > 0 ? bars : null;
  s.countIn = $('#s-countin').checked;
  s.showMarks = $('#s-marks').checked;
  db.put('songs', state.song);
  drawMarkers();
  updateStatus();
}

function openSettings() { $('#v-settings').hidden = false; showChrome(true); }

async function redetect() {
  const t = toast('Analysing PDF…', { sticky: true });
  try {
    const d = await analyzePdf(state.pdf, msg => t.update(msg));
    state.song.scroll = scrollFromDetection(d, state.song.scroll);
    await db.put('songs', state.song);
    fillSettings();
    drawMarkers();
    updateStatus();
    t.update('Done', 1500);
  } catch (e) {
    console.error(e);
    t.update('Analysis failed', 2500);
  }
}

export function scrollFromDetection(d, previous = {}) {
  return {
    detected: d,
    bpm: d.bpm,
    tempoUnit: d.tempoUnit,
    beatsPerBar: d.beatsPerBar,
    beatUnit: d.beatUnit,
    totalBars: d.totalBars,
    marks: d.marks,
    endMark: d.endMark,
    countIn: previous.countIn ?? true,
    showMarks: previous.showMarks ?? false,
  };
}

// ---------- Wiring ----------

export function initViewer() {
  const sc = $('#v-scroll');
  $('#v-back').addEventListener('click', closeViewer);
  $('#v-play').addEventListener('click', () => (state.playing ? stop() : play()));
  $('#v-restart').addEventListener('click', () => {
    const wasPlaying = state.playing; stop();
    sc.scrollTop = 0; state.t = 0; updateStatus();
    if (wasPlaying) play();
  });
  $('#v-gear').addEventListener('click', () => {
    const p = $('#v-settings'); p.hidden = !p.hidden;
  });
  $('#s-close').addEventListener('click', () => { $('#v-settings').hidden = true; });
  $('#v-settings').addEventListener('input', readSettings);
  $('#v-settings').addEventListener('change', readSettings);
  for (const btn of document.querySelectorAll('[data-bpm]')) {
    btn.addEventListener('click', () => {
      const cur = parseFloat($('#s-bpm').value) || 100;
      $('#s-bpm').value = Math.max(20, cur + +btn.dataset.bpm);
      readSettings();
    });
  }
  $('#s-redetect').addEventListener('click', redetect);

  sc.addEventListener('scroll', () => renderVisible(), { passive: true });
  // Let the musician drag to a new spot while playing; we pick up from there.
  sc.addEventListener('touchstart', () => { if (state) state.userTouching = true; }, { passive: true });
  const release = () => {
    if (!state || !state.userTouching) return;
    state.userTouching = false;
    setTimeout(() => { if (state && state.playing) syncTimeToScroll(); }, 350); // after momentum
  };
  sc.addEventListener('touchend', release, { passive: true });
  sc.addEventListener('touchcancel', release, { passive: true });

  // Tap on the music toggles the toolbars.
  let downAt = 0, downY = 0;
  sc.addEventListener('pointerdown', e => { downAt = Date.now(); downY = e.clientY; });
  sc.addEventListener('pointerup', e => {
    if (Date.now() - downAt < 250 && Math.abs(e.clientY - downY) < 10) {
      const v = $('#viewer');
      showChrome(v.classList.contains('chrome-hidden'));
    }
  });

  window.addEventListener('resize', () => {
    if (!state) return;
    syncTimeToScroll();
    const t = state.t;
    layout();
    const k = keyframes();
    if (k) sc.scrollTop = scrollTopForTime(k, t);
  });
  document.addEventListener('visibilitychange', () => {
    if (!state) return;
    if (document.hidden) stop();
  });
}
