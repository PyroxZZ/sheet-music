// Full-screen music viewer with BPM-driven auto-scroll.
//
// Two kinds of music:
//   - PDF (imported or scanned): the pages are drawn as images. Timing comes from the detected tempo,
//     time signature and printed bar numbers:
//       seconds per bar = (beats per bar × 4 / beat unit) ÷ (BPM × tempo note value in quarters) × 60
//       e.g. 3/4 at ♩=90  ->  3 quarters ÷ 90 × 60 = 2.0 s per bar
//   - MusicXML ("score"): the notes are redrawn with Verovio for this screen, and Verovio gives the exact
//     start time of every bar in playing order (repeats included), so the scroll can jump back for repeats.
//
// The scroll follows "keyframes": (time, position) pairs. Between keyframes it moves smoothly; a keyframe
// pair with the same time and a lower position is an instant jump back (a repeat).
import * as db from './db.js';
import { loadPdf } from './pdf.js';
import { analyzePdf } from './detect.js';
import { toast } from './ui.js';

const READING_LINE = 0.3; // the bar being played sits 30% down the screen

const $ = sel => document.querySelector(sel);

let state = null;
let pageAnim = 0; // rAF id of a tap page-turn animation

export async function openViewer(song, onClose, playlist = [], direction = 0) {
  const bytes = await db.getPdf(song.id);
  if (!bytes) { toast('The file for this song is missing'); return; }

  song.lastOpened = Date.now();
  db.put('songs', song);

  const root = $('#viewer');
  const wasOpen = !root.hidden;
  root.hidden = false;
  document.body.classList.add('viewing');
  $('#v-title').textContent = song.title;
  root.classList.toggle('is-score', song.kind === 'score');

  state = {
    song, onClose, playlist, kind: song.kind === 'score' ? 'score' : 'pdf', bytes,
    pdf: null, score: null,
    pages: [], frames: null,
    playing: false, t: 0, lastTs: 0, raf: 0,
    countIn: 0, wake: null, userTouching: false, curBar: null,
  };
  updateSongNav();
  if (!wasOpen) animateIn(root, 'v-enter');
  else if (direction) animateIn($('#v-pages'), direction > 0 ? 'v-next' : 'v-prev');

  const sc = $('#v-scroll');
  sc.scrollTop = 0;
  if (state.kind === 'pdf') {
    state.pdf = await loadPdf(bytes);
    await buildPdfPages();
  } else {
    await buildScore();
  }
  fillSettings();
  showChrome(true);
  updateStatus();
}

function animateIn(el, cls) {
  el.classList.remove('v-enter', 'v-next', 'v-prev');
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

function teardown() {
  if (!state) return;
  stop();
  for (const p of state.pages) freeCanvas(p);
  if (state.pdf) state.pdf.destroy();
  $('#v-pages').innerHTML = '';
  $('#v-settings').hidden = true;
}

function closeViewer() {
  if (!state) return;
  teardown();
  const cb = state.onClose;
  state = null;
  const root = $('#viewer');
  root.classList.add('v-leave');
  const done = () => {
    root.classList.remove('v-leave');
    root.hidden = true;
    document.body.classList.remove('viewing');
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
  else setTimeout(done, 220);
  cb && cb();
}

// ---------- Next / previous song ----------

function siblings() {
  const list = state.playlist || [];
  const i = list.findIndex(s => s.id === state.song.id);
  return { list, i, prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
}

function updateSongNav() {
  const { list, i, prev, next } = siblings();
  $('#v-prev').disabled = !prev;
  $('#v-next').disabled = !next;
  $('#v-pos').textContent = list.length > 1 && i >= 0 ? `${i + 1} of ${list.length}` : '';
}

async function switchSong(dir) {
  const { prev, next } = siblings();
  const target = dir > 0 ? next : prev;
  if (!target) return;
  const { onClose, playlist } = state;
  teardown();
  state = null;
  try { await openViewer(target, onClose, playlist, dir); }
  catch (e) { console.error(e); toast('Could not open: ' + e.message); }
}

// ---------- PDF: layout & lazy rendering ----------

async function buildPdfPages() {
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
  if (state.kind === 'score') { computeFrames(); return; }
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
  computeFrames();
}

function freeCanvas(p) {
  if (p.task) { try { p.task.cancel(); } catch {} p.task = null; }
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
  p.rendered = 0;
}

async function renderPage(p) {
  if (p.rendered === p.w || p.task) return;
  const st = state;
  const page = await st.pdf.getPage(p.index);
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
  if (state !== st || p.w !== width) { canvas.width = canvas.height = 0; return; }
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); }
  p.canvas = canvas;
  p.el.prepend(canvas);
  p.rendered = width;
}

function renderVisible() {
  if (!state || state.kind !== 'pdf') return;
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

// ---------- MusicXML score ----------

async function buildScore() {
  const wrap = $('#v-pages');
  wrap.innerHTML = '<div class="v-loading"><div class="spinner"></div><span>Engraving music…</span></div>';
  const st = state;
  const { renderScore } = await import('./score.js');
  const width = $('#v-scroll').clientWidth;
  const r = await renderScore(st.bytes, st.song.format, width, st.song.scroll.zoom || 1);
  if (state !== st) return;
  st.score = r;
  wrap.innerHTML = r.svgs.map(svg => `<div class="v-page v-score">${svg}</div>`).join('');
  for (const svg of wrap.querySelectorAll('svg')) { svg.removeAttribute('width'); svg.removeAttribute('height'); }
  st.measureEls = new Map();
  for (const b of r.bars) if (!st.measureEls.has(b.id)) st.measureEls.set(b.id, document.getElementById(b.id));
  computeFrames();
}

async function rerenderScore() {
  const sc = $('#v-scroll');
  const t = state.t;
  await buildScore();
  if (state.frames) sc.scrollTop = scrollTopForTime(state.frames, t);
}

function scoreFrames() {
  const st = state, r = st.score;
  if (!r || !r.bars.length || !st.song.scroll.bpm) return null;
  const sc = $('#v-scroll');
  const base = sc.getBoundingClientRect().top - sc.scrollTop;
  const systems = [...$('#v-pages').querySelectorAll('g.system')];
  const sysBox = systems.map(g => { const b = g.getBoundingClientRect(); return { top: b.top - base, bottom: b.bottom - base }; });
  const sysIndex = new Map(systems.map((g, i) => [g, i]));
  const k = (st.song.scroll.baseTempo || r.tempo) / st.song.scroll.bpm; // tempo change from the file's tempo
  const pts = [];
  let runStart = 0;
  const sysOf = b => { const el = st.measureEls.get(b.id); const g = el && el.closest('g.system'); return g ? sysIndex.get(g) : null; };
  const bars = r.bars.map(b => ({ ...b, sys: sysOf(b) })).filter(b => b.sys != null);
  if (!bars.length) return null;
  for (let i = 1; i <= bars.length; i++) {
    if (i < bars.length && bars[i].sys === bars[runStart].sys) continue;
    const s = bars[runStart].sys;
    const t0 = bars[runStart].t * k;
    const t1 = (i < bars.length ? bars[i].t : r.end) * k;
    const y0 = sysBox[s].top;
    const y1 = s + 1 < sysBox.length ? sysBox[s + 1].top : sysBox[s].bottom;
    const last = pts[pts.length - 1];
    if (!last || last.t !== t0 || last.y !== y0) pts.push({ t: t0, y: y0 });
    pts.push({ t: t1, y: y1 });
    runStart = i;
  }
  st.barTimes = bars.map(b => ({ t: b.t * k, n: b.n, id: b.id }));
  return pts.length >= 2 ? pts : null;
}

// ---------- Timing ----------

function secondsPerBar(s) {
  const quartersPerBar = s.beatsPerBar * 4 / s.beatUnit;
  return quartersPerBar / (s.bpm * (s.tempoUnit || 1)) * 60;
}

function pdfFrames() {
  const s = state.song.scroll;
  if (!s.bpm || !state.pages.length) return null;
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
    pts.push({ t: 0, y: state.pages[0].top }, { t: s.totalBars * spb, y: docEnd });
  } else return null;
  // Keep strictly increasing in both time and position.
  const clean = [pts[0]];
  for (const p of pts.slice(1)) {
    const q = clean[clean.length - 1];
    if (p.t > q.t && p.y > q.y) clean.push(p);
  }
  return clean.length >= 2 ? clean : null;
}

// Recompute after layout or settings changes (not every frame).
function computeFrames() {
  if (!state) return;
  state.frames = state.kind === 'score' ? scoreFrames() : pdfFrames();
}
const keyframes = () => state.frames;
const endTime = k => k[k.length - 1].t;

function yAtTime(k, t) {
  if (t <= k[0].t) return k[0].y;
  for (let i = 1; i < k.length; i++) {
    if (t < k[i].t || (t === k[i].t && i === k.length - 1)) {
      const a = k[i - 1], b = k[i];
      return b.t === a.t ? b.y : a.y + (b.y - a.y) * (t - a.t) / (b.t - a.t);
    }
  }
  return k[k.length - 1].y;
}

// Inverse: which time shows position y? With repeats a position occurs more than once,
// so pick the occurrence closest to the current time.
function timeAtY(k, y, near = 0) {
  if (y <= k[0].y) return k[0].t;
  let best = null, bestDist = Infinity;
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1], b = k[i];
    if (b.y <= a.y || b.t === a.t || y < a.y || y > b.y) continue; // only forward-moving segments
    const t = a.t + (b.t - a.t) * (y - a.y) / (b.y - a.y);
    const d = Math.abs(t - near);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best ?? endTime(k);
}

function scrollTopForTime(k, t) {
  const sc = $('#v-scroll');
  return yAtTime(k, t) - sc.clientHeight * READING_LINE;
}

const clampScroll = (sc, v) => Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, v));

function syncTimeToScroll() {
  const k = keyframes();
  if (!k) return;
  const sc = $('#v-scroll');
  // Already where the current time says we should be? Then keep the time (the scroll position alone is
  // ambiguous near the top/bottom, where it can't move any further).
  if (Math.abs(sc.scrollTop - clampScroll(sc, scrollTopForTime(k, state.t))) <= 4) return;
  if (sc.scrollTop <= 1) { state.t = 0; return; } // scrolled right to the top = start of the piece
  state.t = timeAtY(k, sc.scrollTop + sc.clientHeight * READING_LINE, state.t);
}

// ---------- Playback ----------

function play() {
  const s = state.song.scroll;
  const k = keyframes();
  if (!k) {
    if (state.kind === 'score' && !state.score) { toast('Still preparing the music…'); return; }
    toast(s.bpm ? 'Enter the number of bars in Tempo & scroll' : 'Set the BPM in Tempo & scroll first');
    openSettings();
    return;
  }
  syncTimeToScroll();
  if (state.t >= endTime(k) - 0.05) state.t = 0;
  $('#v-scroll').scrollTop = scrollTopForTime(k, state.t);
  state.playing = true;
  state.countIn = s.countIn ? (s.beatsPerBar || 4) : 0;
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

function beatSeconds(s) {
  return state.kind === 'score' ? 60 / s.bpm : secondsPerBar(s) / s.beatsPerBar;
}

function tick(ts) {
  if (!state || !state.playing) return;
  const s = state.song.scroll;
  const k = keyframes();
  const sc = $('#v-scroll');
  if (!k) { stop(); return; }

  if (state.countIn > 0) {
    const beatsGone = Math.floor((ts - state.countStart) / 1000 / beatSeconds(s));
    const left = state.countIn - beatsGone;
    const c = $('#v-count');
    if (left > 0) { c.hidden = false; c.textContent = left; state.raf = requestAnimationFrame(tick); return; }
    c.hidden = true;
    state.countIn = 0;
  }

  if (state.lastTs && !state.userTouching && !pageAnim) {
    const dt = Math.min(0.1, (ts - state.lastTs) / 1000);
    state.t += dt;
    sc.scrollTop = scrollTopForTime(k, state.t);
  }
  state.lastTs = ts;
  updateStatus();
  if (state.t >= endTime(k)) { stop(); toast('End of piece'); showChrome(true); return; }
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
  // Only touch the DOM when the text changes (this runs every animation frame while playing).
  const show = (main, sub) => { const h = `<span class="st-main">${main}</span><span class="st-sub">${sub}</span>`; if (el.innerHTML !== h) el.innerHTML = h; };
  if (state.kind === 'score') {
    if (!k || !state.barTimes) { show(s.bpm ? `${s.bpm} BPM` : 'Preparing…', 'MusicXML'); return; }
    let cur = state.barTimes[0];
    for (const b of state.barTimes) { if (b.t <= state.t + 1e-6) cur = b; else break; }
    const lastN = [...state.barTimes].reverse().find(b => b.n)?.n || state.barTimes.length;
    show(`Bar ${cur.n || '–'} of ${lastN}`, `${s.bpm} BPM · MusicXML`);
    highlightBar(state.playing || state.t > 0 ? cur.id : null);
    return;
  }
  if (!k) { show(s.bpm ? `${s.bpm} BPM` : 'No tempo set', s.bpm ? 'Set total bars to scroll' : 'Open Tempo &amp; scroll'); return; }
  const spb = secondsPerBar(s);
  const bar = Math.min(Math.floor(state.t / spb) + 1, Math.round(endTime(k) / spb));
  const total = Math.round(endTime(k) / spb);
  show(`Bar ${bar} of ${total}`, `${s.bpm} BPM · ${s.beatsPerBar}/${s.beatUnit}`);
}

function highlightBar(id) {
  if (state.curBar === id) return;
  if (state.curBar) state.measureEls.get(state.curBar)?.classList.remove('cur');
  state.curBar = id;
  if (id) state.measureEls.get(id)?.classList.add('cur');
}

// ---------- Chrome (toolbar) ----------

function showChrome(show) {
  $('#viewer').classList.toggle('chrome-hidden', !show);
}

// ---------- Tap to turn the page ----------

function turnPage(dir) {
  const sc = $('#v-scroll');
  const bars = [...document.querySelectorAll('#viewer .v-bar')].filter(b => getComputedStyle(b).opacity !== '0');
  const covered = bars.reduce((h, b) => h + b.offsetHeight, 0);
  const step = Math.max(120, (sc.clientHeight - covered) * 0.88);
  const from = sc.scrollTop;
  const to = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, from + dir * step));
  if (to === from) return;
  cancelAnimationFrame(pageAnim);
  const start = performance.now(), dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 320;
  const ease = x => 1 - Math.pow(1 - x, 3);
  const stepFn = now => {
    const x = dur ? Math.min(1, (now - start) / dur) : 1;
    sc.scrollTop = from + (to - from) * ease(x);
    if (x < 1) pageAnim = requestAnimationFrame(stepFn);
    else {
      pageAnim = 0;
      if (state) { syncTimeToScroll(); updateStatus(); }
    }
  };
  pageAnim = requestAnimationFrame(stepFn);
}

// ---------- Settings panel ----------

const NOTE_LABELS = [[1, 'Quarter note'], [1.5, 'Dotted quarter'], [2, 'Half note'], [3, 'Dotted half'], [0.5, 'Eighth note']];

function fillSettings() {
  const s = state.song.scroll;
  $('#s-bpm').value = s.bpm || '';
  $('#s-unit').innerHTML = NOTE_LABELS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('#s-unit').value = String(s.tempoUnit || 1);
  $('#s-num').value = s.beatsPerBar;
  $('#s-den').value = String(s.beatUnit || 4);
  $('#s-bars').value = s.totalBars || '';
  $('#s-countin').checked = !!s.countIn;
  $('#s-marks').checked = !!s.showMarks;
  $('#s-zoom-val').textContent = Math.round((s.zoom || 1) * 100) + '%';
  renderDetectInfo();
}

function renderDetectInfo() {
  const el = $('#s-detected');
  if (state.kind === 'score') {
    const s = state.song.scroll;
    el.textContent = `MusicXML: the notes are redrawn for this screen. Tempo from the file: ${s.baseTempo || '–'} BPM. Repeats are followed automatically.`;
    return;
  }
  const d = state.song.scroll.detected;
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
  s.countIn = $('#s-countin').checked;
  if (state.kind === 'pdf') {
    s.tempoUnit = parseFloat($('#s-unit').value) || 1;
    s.beatsPerBar = Math.max(1, parseInt($('#s-num').value, 10) || 4);
    s.beatUnit = parseInt($('#s-den').value, 10) || 4;
    const bars = parseInt($('#s-bars').value, 10);
    s.totalBars = bars > 0 ? bars : null;
    s.showMarks = $('#s-marks').checked;
  }
  db.put('songs', state.song);
  // Keep the same musical position when the tempo changes.
  const k0 = keyframes();
  const y = k0 ? yAtTime(k0, state.t) : null;
  if (state.kind === 'pdf') drawMarkers();
  computeFrames();
  const k = keyframes();
  if (k && y != null) state.t = timeAtY(k, y, state.t);
  updateStatus();
}

async function changeZoom(delta) {
  const s = state.song.scroll;
  s.zoom = Math.max(0.6, Math.min(1.8, Math.round(((s.zoom || 1) + delta) * 10) / 10));
  $('#s-zoom-val').textContent = Math.round(s.zoom * 100) + '%';
  db.put('songs', state.song);
  await rerenderScore();
}

function openSettings() { $('#v-settings').hidden = false; showChrome(true); }

async function redetect() {
  if (state.kind !== 'pdf') return;
  const t = toast('Analysing PDF…', { sticky: true });
  try {
    const d = await analyzePdf(state.pdf, msg => t.update(msg));
    state.song.scroll = scrollFromDetection(d, state.song.scroll);
    await db.put('songs', state.song);
    fillSettings();
    drawMarkers();
    computeFrames();
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
  $('#v-prev').addEventListener('click', () => switchSong(-1));
  $('#v-next').addEventListener('click', () => switchSong(1));
  $('#v-play').addEventListener('click', () => { if (state.playing) { stop(); showChrome(true); } else play(); });
  $('#v-restart').addEventListener('click', () => {
    const wasPlaying = state.playing; stop();
    sc.scrollTop = 0; state.t = 0; updateStatus();
    if (wasPlaying) play();
  });
  $('#v-gear').addEventListener('click', () => {
    const p = $('#v-settings'); p.hidden = !p.hidden;
  });
  $('#s-close').addEventListener('click', () => { $('#v-settings').hidden = true; });
  $('#v-settings').addEventListener('input', e => { if (!e.target.closest('[data-zoom]')) readSettings(); });
  $('#v-settings').addEventListener('change', e => { if (!e.target.closest('[data-zoom]')) readSettings(); });
  for (const btn of document.querySelectorAll('[data-bpm]')) {
    btn.addEventListener('click', () => {
      const cur = parseFloat($('#s-bpm').value) || 100;
      $('#s-bpm').value = Math.max(20, cur + +btn.dataset.bpm);
      readSettings();
    });
  }
  for (const btn of document.querySelectorAll('[data-zoom]')) btn.addEventListener('click', () => changeZoom(+btn.dataset.zoom));
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

  // Taps on the music (like the Books app):
  //   toolbars showing -> any tap hides them (no page turn)
  //   toolbars hidden  -> top strip shows them, left quarter = previous page, rest = next page
  // Horizontal swipe = next / previous song.
  let downAt = 0, downX = 0, downY = 0;
  sc.addEventListener('pointerdown', e => { downAt = Date.now(); downX = e.clientX; downY = e.clientY; });
  sc.addEventListener('pointerup', e => {
    if (!state) return;
    const dx = e.clientX - downX, dy = e.clientY - downY, dt = Date.now() - downAt;
    if (dt < 600 && Math.abs(dx) > 80 && Math.abs(dy) < 50) { switchSong(dx < 0 ? 1 : -1); return; }
    if (dt > 300 || Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    if (!$('#v-settings').hidden) { $('#v-settings').hidden = true; return; }
    if (!$('#viewer').classList.contains('chrome-hidden')) { showChrome(false); return; }
    const r = sc.getBoundingClientRect();
    const topStrip = Math.max(90, r.height * 0.12);
    if (e.clientY - r.top < topStrip) { showChrome(true); return; }
    turnPage(e.clientX - r.left < r.width * 0.25 ? -1 : 1);
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!state) return;
    syncTimeToScroll();
    const t = state.t;
    if (state.kind === 'score') {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state) rerenderScore(); }, 250); // re-layout notes for the new width
      return;
    }
    layout();
    const k = keyframes();
    if (k) sc.scrollTop = scrollTopForTime(k, t);
  });
  document.addEventListener('visibilitychange', () => {
    if (!state) return;
    if (document.hidden) stop();
  });
}
