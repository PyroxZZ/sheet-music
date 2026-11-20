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
//
// PDFs can be shown two ways (Tempo & scroll -> Layout):
//   Scroll - one long continuous strip of pages.
//   Pages  - (default on iPad) whole pages that never move under your eyes. Portrait: one page with
//            half-page turns (the top half shows the next page while you read the bottom half).
//            Landscape: two pages side by side like a book; the page you finished is replaced by the next.
// In Pages layout, positions are "virtual" (pages stacked at a fixed width) so the same keyframes work.
import * as db from './db.js';
import { loadPdf } from './pdf.js';
import { analyzePdf } from './detect.js';
import { toast } from './ui.js';
import { pref } from './prefs.js';

// Where the music being played sits on the screen while scrolling (Settings: higher / middle / lower).
// Scrolling only starts once the music reaches this line, so the start isn't jammed against the top.
const readLine = () => parseFloat(pref('readLine')) || 0.45;

const $ = sel => document.querySelector(sel);

// Pages layout: chosen, or automatically on iPad-sized screens.
function wantPaged() {
  if (!state || state.kind !== 'pdf') return false;
  const v = pref('view');
  return v === 'pages' || (v === 'auto' && Math.min(innerWidth, innerHeight) >= 700);
}
function applyStage() {
  const v = $('#viewer');
  v.classList.toggle('stage-warm', pref('stage') === 'warm');
  v.classList.toggle('stage-dark', pref('stage') === 'dark');
  v.classList.toggle('play-hidden', pref('playBtn') !== '1');
}

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
    paged: false, pv: { c: 0, half: false }, pcache: new Map(), shown: new Set(),
  };
  applyStage();
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
  for (const e of state.pcache.values()) if (e.canvas) e.canvas.width = e.canvas.height = 0;
  state.pcache.clear();
  if (state.pdf) state.pdf.destroy();
  $('#v-pages').innerHTML = '';
  $('#v-stage').innerHTML = '';
  $('#v-strip').innerHTML = '';
  $('#viewer').classList.remove('is-paged', 'has-strip');
  $('#v-pages').hidden = false;
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
  const st = state;
  const info = await pageInfo();
  if (state !== st) return;
  const trim = pref('trim') === '1';
  for (let i = 1; i <= st.pdf.numPages; i++) {
    const page = await st.pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const el = document.createElement('div');
    el.className = 'v-page';
    wrap.appendChild(el);
    const pi = info && info[i - 1];
    const crop = trim && pi ? pi.crop : [0, 0, 1, 1];
    const ratio = ((crop[3] - crop[1]) * vp.height) / ((crop[2] - crop[0]) * vp.width);
    // Blank bands (between systems) in this page's own 0..1 range: used to place half-page splits.
    const gaps = pi ? pi.gaps.map(g => (g - crop[1]) / (crop[3] - crop[1])).filter(g => g > 0 && g < 1) : [];
    st.pages.push({ index: i, el, W: vp.width, H: vp.height, crop, ratio, gaps, canvas: null, rendered: 0, task: null });
  }
  buildStrip();
  setMode();
}

// ---------- Page list (left side) ----------

const stripOn = () => state.kind === 'pdf' && state.pages.length >= 2 && pref('pageList') === '1' && innerWidth >= 700;

function buildStrip() {
  const strip = $('#v-strip');
  strip.innerHTML = '';
  const on = stripOn();
  $('#viewer').classList.toggle('has-strip', on);
  if (!on) return;
  const st = state;
  state.pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'vs-item';
    b.dataset.page = i;
    b.setAttribute('aria-label', `Page ${i + 1}`);
    b.innerHTML = `<span class="vs-thumb" style="aspect-ratio:1/${p.ratio.toFixed(4)}"></span><span class="vs-num">${i + 1}</span>`;
    strip.appendChild(b);
  });
  // Small pictures of the pages, drawn after the music itself is on screen.
  setTimeout(async () => {
    for (const [i, p] of st.pages.entries()) {
      if (state !== st) return;
      const { canvas, task } = drawPage(st, p, 72, 72 * p.ratio);
      try { await (await task).promise; } catch { continue; }
      strip.querySelector(`[data-page="${i}"] .vs-thumb`)?.appendChild(canvas);
    }
  }, 400);
  updateStrip();
}

// Highlight the pages on screen (and the one being played), keeping them in view in the list.
function updateStrip() {
  if (!state || !$('#viewer').classList.contains('has-strip')) return;
  const cur = new Set();
  let playingPage = -1;
  const k = keyframes();
  if (k && (state.playing || state.t > 0)) playingPage = pageAtTime(k, state.t).c;
  if (state.paged) {
    for (const it of state.layoutItems || []) cur.add(it.i);
  } else {
    const sc = $('#v-scroll'), top = sc.scrollTop, bottom = top + sc.clientHeight;
    state.pages.forEach((p, i) => { if (p.top < bottom - 40 && p.top + p.h > top + 40) cur.add(i); });
  }
  let first = null;
  for (const b of $('#v-strip').children) {
    const i = +b.dataset.page;
    b.classList.toggle('cur', cur.has(i));
    b.classList.toggle('playing', i === playingPage);
    if (first == null && cur.has(i)) first = b;
  }
  const strip = $('#v-strip');
  if (first) {
    const r = first.getBoundingClientRect(), sr = strip.getBoundingClientRect();
    if (r.top < sr.top + 60 || r.bottom > sr.bottom - 20) strip.scrollTo({ top: first.offsetTop - 70, behavior: 'smooth' });
  }
}

// Tap a page in the list: go there (and carry on playing from it).
function jumpToPage(i) {
  if (state.paged) {
    const n = state.pages.length;
    let c = i;
    if (spreadOn()) c = pref('spreadTurn') === 'both' ? i - (i % 2) : Math.min(i, Math.max(0, n - 2));
    state.pv = { c, half: false };
    setTimeForView();
    drawPaged();
  } else {
    const sc = $('#v-scroll');
    const topBar = $('#viewer').classList.contains('chrome-hidden') ? 0 : $('#viewer .v-top').offsetHeight;
    sc.scrollTo({ top: Math.max(0, state.pages[i].top - topBar - sc.clientHeight * 0.04), behavior: 'smooth' });
    setTimeout(() => { if (state) { syncTimeToScroll(); updateStatus(); updateStrip(); } }, 450);
  }
  updateStatus();
}

// Where the music sits on each page (for trimming margins) and the blank bands between systems.
// Worked out once from a small rendering and saved with the song.
async function pageInfo() {
  const st = state, song = st.song;
  if (song.pageInfo && song.pageInfo.v === 1 && song.pageInfo.pages.length === st.pdf.numPages) return song.pageInfo.pages;
  const pages = [];
  try {
    for (let i = 1; i <= st.pdf.numPages; i++) {
      const page = await st.pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 300 / vp1.width });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (state !== st) return null;
      const { data, width: w, height: h } = ctx.getImageData(0, 0, c.width, c.height);
      c.width = c.height = 0;
      const rows = new Uint16Array(h), cols = new Uint16Array(w);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (data[o] + data[o + 1] + data[o + 2] < 480) { rows[y]++; cols[x]++; }
      }
      // Ignore the outermost specks (scan dust, page edge): need 2+ ink pixels in a row / column.
      let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
      while (y0 < h && rows[y0] < 2) y0++;
      while (y1 > y0 && rows[y1] < 2) y1--;
      while (x0 < w && cols[x0] < 2) x0++;
      while (x1 > x0 && cols[x1] < 2) x1--;
      let crop = [0, 0, 1, 1];
      if (y0 < y1 && x0 < x1) {
        const pad = 0.025 * w; // breathing room around the music
        crop = [Math.max(0, (x0 - pad) / w), Math.max(0, (y0 - pad) / h), Math.min(1, (x1 + 1 + pad) / w), Math.min(1, (y1 + 1 + pad) / h)];
        if ((crop[2] - crop[0]) * (crop[3] - crop[1]) < 0.2) crop = [0, 0, 1, 1]; // something odd: don't trim
      }
      const gaps = [];
      for (let y = 0, run = 0; y <= h; y++) {
        if (y < h && rows[y] === 0) { run++; continue; }
        if (run >= 3) gaps.push(+((y - run / 2) / h).toFixed(4));
        run = 0;
      }
      pages.push({ crop: crop.map(v => +v.toFixed(4)), gaps });
    }
  } catch (e) { console.warn('Page analysis failed', e); return null; }
  song.pageInfo = { v: 1, pages };
  db.put('songs', song);
  return pages;
}

// Page y (0..1 of the full page, as detection stores it) -> 0..1 of the shown (trimmed) page.
const cropY = (p, y) => Math.max(0, Math.min(1, (y - p.crop[1]) / (p.crop[3] - p.crop[1])));

// Pick Scroll or Pages layout and lay out. Called on open and whenever the layout setting or screen changes.
function setMode() {
  const paged = wantPaged();
  state.paged = paged;
  $('#viewer').classList.toggle('is-paged', paged);
  $('#v-pages').hidden = paged;
  $('#viewer').classList.toggle('has-strip', stripOn());
  if (paged) for (const p of state.pages) freeCanvas(p);
  else $('#v-stage').innerHTML = '';
  layout();
  const k = keyframes();
  if (!paged && k) $('#v-scroll').scrollTop = scrollTopForTime(k, state.t); // keep the musical position
}

function layout() {
  if (state.kind === 'score') { computeFrames(); return; }
  if (state.paged) {
    // Virtual stacking: every page 1000 units wide, so keyframes stay the same whatever is on screen.
    let top = 0;
    for (const p of state.pages) { p.vTop = top; p.vH = 1000 * p.ratio; top += p.vH; }
    computeFrames();
    const k = keyframes();
    if (k) state.pv = viewForTime(k, state.t);
    drawPaged();
    return;
  }
  const scroller = $('#v-scroll');
  const width = scroller.clientWidth;
  for (const p of state.pages) {
    p.w = width; p.h = Math.round(width * p.ratio);
    p.el.style.height = p.h + 'px';
    if (p.rendered && p.rendered !== width) freeCanvas(p);
  }
  // Read real positions (includes the top padding under the toolbar).
  for (const p of state.pages) { p.top = p.el.offsetTop; p.vTop = p.top; p.vH = p.h; }
  drawMarkers();
  renderVisible();
  computeFrames();
}

function freeCanvas(p) {
  if (p.task) { try { p.task.cancel(); } catch {} p.task = null; }
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
  p.rendered = 0;
}

// Draw the shown (trimmed) part of a page at a CSS size. Returns { canvas, task }.
function drawPage(st, p, cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let k = dpr;
  const maxPixels = 12e6; // iOS limits canvas size; stay well under ~16M pixels
  if (cssW * cssH * k * k > maxPixels) k = Math.sqrt(maxPixels / (cssW * cssH));
  const scale = cssW * k / ((p.crop[2] - p.crop[0]) * p.W);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cssW * k));
  canvas.height = Math.max(1, Math.round(cssH * k));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = st.pdf.getPage(p.index).then(page => {
    const viewport = page.getViewport({ scale, offsetX: -p.crop[0] * p.W * scale, offsetY: -p.crop[1] * p.H * scale });
    return page.render({ canvasContext: ctx, viewport });
  });
  return { canvas, task };
}

async function renderPage(p) {
  if (p.rendered === p.w || p.task) return;
  const st = state;
  const width = p.w;
  const { canvas, task } = drawPage(st, p, p.w, p.h);
  p.task = { cancel: () => task.then(t => t.cancel()).catch(() => {}) };
  try {
    await (await task).promise;
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
    tag.style.top = (cropY(p, m.y) * 100) + '%';
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
  const docY = (page, y) => { const p = state.pages[page]; return p ? p.vTop + cropY(p, y) * p.vH : 0; };
  const last = state.pages[state.pages.length - 1];
  const docEnd = last.vTop + last.vH;
  const pts = [];
  if (s.marks && s.marks.length >= 2) {
    for (const m of s.marks) pts.push({ t: (m.bar - 1) * spb, y: docY(m.page, m.y) });
    const total = Math.max(s.totalBars || 0, s.marks[s.marks.length - 1].bar);
    const end = s.endMark ? docY(s.endMark.page, s.endMark.y) : docEnd;
    pts.push({ t: total * spb, y: end });
  } else if (s.totalBars) {
    pts.push({ t: 0, y: state.pages[0].vTop }, { t: s.totalBars * spb, y: docEnd });
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
  state.musicEnd = musicEnd();
}

// Bottom of the last line of music, in scroll coordinates (Scroll layout).
function musicEnd() {
  const k = state.frames;
  if (state.kind === 'score') return k ? k[k.length - 1].y : null;
  const i = state.pages.length - 1, p = state.pages[i];
  if (!p || state.paged) return null;
  const ink = state.song.pageInfo?.pages?.[i]?.crop?.[3] ?? 1;
  return p.top + cropY(p, ink) * p.h;
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
  const top = yAtTime(k, t) - sc.clientHeight * readLine();
  if (state.musicEnd == null) return top;
  // Stop once the last bar is in view: never scroll the end of the music up into empty space.
  const v = $('#viewer');
  const bottomBar = v.classList.contains('chrome-hidden') ? 0 : v.querySelector('.v-bottom').offsetHeight;
  return Math.min(top, Math.max(0, state.musicEnd + 24 - (sc.clientHeight - bottomBar)));
}

const clampScroll = (sc, v) => Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, v));

function syncTimeToScroll() {
  const k = keyframes();
  if (!k || state.paged) return; // in Pages layout the time is set by the page turns themselves
  const sc = $('#v-scroll');
  // Already where the current time says we should be? Then keep the time (the scroll position alone is
  // ambiguous near the top/bottom, where it can't move any further).
  if (Math.abs(sc.scrollTop - clampScroll(sc, scrollTopForTime(k, state.t))) <= 4) return;
  if (sc.scrollTop <= 1) { state.t = 0; return; } // scrolled right to the top = start of the piece
  state.t = timeAtY(k, sc.scrollTop + sc.clientHeight * readLine(), state.t);
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
  if (state.paged) { state.pv = viewForTime(k, state.t); drawPaged(); }
  else $('#v-scroll').scrollTop = scrollTopForTime(k, state.t);
  state.playing = true;
  state.countIn = s.countIn ? (s.beatsPerBar || 4) : 0;
  state.countStart = performance.now();
  state.lastTs = 0;
  acquireWakeLock();
  $('#viewer').classList.add('is-playing');
  $('#s-autoplay span').textContent = 'Pause auto-scroll';
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
  $('#v-cursor')?.classList.remove('on');
  $('#viewer').classList.remove('is-playing');
  $('#s-autoplay span').textContent = 'Start auto-scroll';
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
    if (state.paged) {
      const v = viewForTime(k, state.t);
      if (v.c !== state.pv.c || v.half !== state.pv.half) { state.pv = v; drawPaged(); }
      placeCursor(k);
    } else sc.scrollTop = scrollTopForTime(k, state.t);
    if (ts - (state.stripTs || 0) > 500) { state.stripTs = ts; updateStrip(); }
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

// True for a one-page PDF, or when all the music is visible without scrolling.
function fitsOneScreen() {
  if (state.kind === 'pdf' && state.pdf && state.pdf.numPages === 1) return true;
  if (state.paged) return false;
  const sc = $('#v-scroll'), last = $('#v-pages').lastElementChild;
  if (!last) return true;
  return last.offsetTop + last.offsetHeight <= sc.clientHeight * 1.05;
}

// Scroll layout: move on by most of a screen, keeping the last lines you read at the top for context,
// and land the next page (PDF) or the next line of music (MusicXML) a little below the top edge,
// not jammed against it.
// Setlist: at the end (or start) of a song, a page turn moves on to the next (or previous) song.
function turnPage(dir) {
  if (!turnWithinSong(dir) && state.playlist?.setlist) {
    const { prev, next } = siblings();
    if (dir > 0 ? next : prev) switchSong(dir);
  }
}

// Returns false when there is no further page in that direction.
function turnWithinSong(dir) {
  if (state.paged) return pagedTurn(dir);
  const sc = $('#v-scroll');
  const chromeShown = !$('#viewer').classList.contains('chrome-hidden');
  const topBar = chromeShown ? $('#viewer .v-top').offsetHeight : 0;
  const bottomBar = chromeShown ? $('#viewer .v-bottom').offsetHeight : 0;
  const vis = sc.clientHeight - topBar - bottomBar;
  const breath = topBar + Math.round(sc.clientHeight * 0.07);
  const from = sc.scrollTop;
  let to = from + dir * Math.max(120, vis * 0.8);
  // Natural starting points, in scroll coordinates: lines of music (detected bar numbers in a PDF,
  // systems in MusicXML) and page tops. Land on the furthest one that still fits, so the new music
  // starts just below the top with room to breathe, never cut off above the screen.
  let starts = [];
  if (state.kind === 'pdf') {
    starts = state.pages.slice(1).map(p => p.top);
    for (const m of state.song.scroll.marks || []) {
      const p = state.pages[m.page];
      if (p) starts.push(p.top + cropY(p, m.y) * p.h - 24); // just above the bar number
    }
  } else {
    const base = sc.getBoundingClientRect().top - sc.scrollTop;
    starts = [...$('#v-pages').querySelectorAll('g.system')].map(g => g.getBoundingClientRect().top - base);
  }
  let best = null;
  for (const y of starts) {
    const cand = y - breath;
    const ahead = (cand - from) * dir;
    if (ahead <= vis * 0.3 || ahead > Math.abs(to - from) + vis * 0.1) continue;
    if (best == null || (cand - best) * dir > 0) best = cand;
  }
  if (best != null) to = best;
  to = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, to));
  if (Math.abs(to - from) < 2) return false;
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
  return true;
}

// ---------- Pages layout (iPad) ----------

const spreadOn = () => {
  const st = $('#v-stage');
  return st.clientWidth > st.clientHeight && state.pages.length >= 2;
};

// Which page (and fraction of it) is being played at time t.
function pageAtTime(k, t) {
  const y = yAtTime(k, t);
  let c = 0;
  while (c < state.pages.length - 1 && y >= state.pages[c + 1].vTop) c++;
  const p = state.pages[c];
  return { c, f: Math.max(0, Math.min(1, (y - p.vTop) / p.vH)) };
}

// What to show at time t: landscape = the page being played and the next one; portrait = the page,
// switching to the half-page view once you're past its middle.
function viewForTime(k, t) {
  const { c, f } = pageAtTime(k, t);
  const n = state.pages.length;
  if (spreadOn()) {
    if (pref('spreadTurn') === 'both') return { c: c - (c % 2), half: false }; // pages 1-2, 3-4, ...
    return { c: Math.min(c, Math.max(0, n - 2)), half: false };
  }
  return { c, half: pref('halfTurn') === '1' && c + 1 < n && f >= splitOf(c + 1, true) };
}

// Where the half-page split falls: a blank band between systems near the middle of the next page.
function splitOf(i, asTrigger = false) {
  const p = state.pages[i];
  let best = 0.5, bd = 0.2;
  for (const g of p.gaps) { const d = Math.abs(g - 0.5); if (d < bd) { bd = d; best = g; } }
  return asTrigger ? Math.max(0.35, Math.min(0.65, best)) : best;
}

const fitBox = (ratio, maxW, maxH) => { const w = Math.min(maxW, maxH / ratio); return { w, h: w * ratio }; };

// Rendered page canvases, reused across turns (keyed by page and size).
function pageCanvas(i, w, h) {
  const key = `${i}:${Math.round(w)}x${Math.round(h)}`;
  let e = state.pcache.get(key);
  if (!e) {
    const st = state;
    const { canvas, task } = drawPage(st, st.pages[i], w, h);
    e = { i, canvas, ready: task.then(t => t.promise).then(() => canvas).catch(() => null) };
    state.pcache.set(key, e);
  }
  return e;
}

function trimCache(keep) {
  for (const [key, e] of state.pcache) {
    if (!keep.has(key)) { if (e.canvas) e.canvas.width = e.canvas.height = 0; state.pcache.delete(key); }
  }
}

// Lay out the pages for the current view (state.pv) on #v-stage.
async function drawPaged() {
  const st = state;
  if (!st || !st.paged || !st.pages.length) return;
  const stage = $('#v-stage');
  const W = stage.clientWidth, H = stage.clientHeight;
  if (!W || !H) return;
  const n = st.pages.length;
  const { c, half } = st.pv;
  const items = []; // { i, x, y, w, h, clip }
  if (spreadOn()) {
    const gap = 16, sw = (W - gap) / 2;
    for (const i of [c, c + 1]) {
      if (i >= n) continue;
      const b = fitBox(st.pages[i].ratio, sw, H);
      const right = i % 2 === 1; // book order: even pages left, odd pages right
      items.push({ i, x: right ? sw + gap : sw - b.w, y: 0, w: b.w, h: b.h });
    }
  } else {
    const b = fitBox(st.pages[c].ratio, W, H);
    const x = (W - b.w) / 2;
    items.push({ i: c, x, y: 0, w: b.w, h: b.h });
    if (half && c + 1 < n) {
      // Top part of the next page laid over this one, cut at a blank band between systems.
      const nb = { w: b.w, h: b.w * st.pages[c + 1].ratio };
      items.push({ i: c + 1, x, y: 0, w: nb.w, h: nb.h, clip: Math.min(b.h, nb.h * splitOf(c + 1)) });
    }
  }
  const entries = items.map(it => pageCanvas(it.i, it.w, it.h));
  const canvases = await Promise.all(entries.map(e => e.ready));
  if (state !== st || st.pv.c !== c || st.pv.half !== half) return; // a newer view was asked for meanwhile
  const frag = document.createDocumentFragment();
  items.forEach((it, k) => {
    const box = document.createElement('div');
    box.className = 'pv-page' + (it.clip != null ? ' pv-half' : '') + (st.shown.has(it.i + (it.clip != null ? 'h' : '')) ? '' : ' pv-in');
    box.style.cssText = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.clip != null ? it.clip : it.h}px`;
    const cv = canvases[k];
    if (cv) { cv.style.width = it.w + 'px'; cv.style.height = it.h + 'px'; box.appendChild(cv); }
    frag.appendChild(box);
  });
  const cursor = document.createElement('div');
  cursor.id = 'v-cursor';
  if (st.playing) cursor.className = 'on';
  frag.appendChild(cursor);
  stage.replaceChildren(frag);
  st.layoutItems = items;
  st.shown = new Set(items.map(it => it.i + (it.clip != null ? 'h' : '')));
  const k = keyframes();
  if (k && st.playing) placeCursor(k);
  updateStrip();
  // Get the next turn ready in the background, and drop pages that are far away.
  const keep = new Set(items.map(it => `${it.i}:${Math.round(it.w)}x${Math.round(it.h)}`));
  const ahead = spreadOn() ? [c + 2] : [c + 1];
  for (const i of ahead) {
    if (i >= n) continue;
    const b = spreadOn() ? fitBox(st.pages[i].ratio, (W - 16) / 2, H) : fitBox(st.pages[i].ratio, W, H);
    const e = pageCanvas(i, b.w, b.h);
    keep.add(`${i}:${Math.round(b.w)}x${Math.round(b.h)}`);
    if (!spreadOn() && half) keep.add(`${i}:${Math.round(items[0].w)}x${Math.round(items[0].w * st.pages[i].ratio)}`);
    void e;
  }
  trimCache(keep);
}

// Small marker at the left edge of the line being played (the page itself doesn't move).
function placeCursor(k) {
  const cur = $('#v-cursor');
  if (!cur || !state.layoutItems) return;
  const { c, f } = pageAtTime(k, state.t);
  // The playing page may be shown fully or as the top half over the previous page.
  const it = state.layoutItems.find(x => x.i === c && (x.clip == null || f * x.h <= x.clip))
    || state.layoutItems.find(x => x.i === c);
  if (!it) { cur.classList.remove('on'); return; }
  cur.classList.add('on');
  cur.style.transform = `translate(${it.x + 4}px, ${it.y + f * it.h - 14}px)`;
}

// Tap turns in Pages layout. Portrait: full page -> half view -> next full page. Landscape: one page on.
function pagedTurn(dir) {
  const n = state.pages.length;
  let { c, half } = state.pv;
  if (spreadOn()) {
    if (pref('spreadTurn') === 'both') c = Math.max(0, Math.min(n - 1 - ((n - 1) % 2), c + 2 * dir));
    else c = Math.max(0, Math.min(Math.max(0, n - 2), c + dir));
    half = false;
  } else if (pref('halfTurn') !== '1') {
    c = Math.max(0, Math.min(n - 1, c + dir));
    half = false;
  } else if (dir > 0) {
    if (!half && c + 1 < n) half = true;
    else if (half) { c++; half = false; }
  } else if (half) half = false;
  else if (c > 0) { c--; half = true; }
  if (c === state.pv.c && half === state.pv.half) return false;
  state.pv = { c, half };
  setTimeForView();
  drawPaged();
  updateStatus();
  return true;
}

// Carry on playing from the view on screen: the start of the page, or of its second half.
function setTimeForView() {
  const k = keyframes();
  if (!k) return;
  const { c, half } = state.pv;
  const p = state.pages[c];
  const y = p.vTop + (half ? splitOf(c + 1, true) : 0) * p.vH + 1;
  const spb = secondsPerBar(state.song.scroll);
  state.t = Math.min(endTime(k), Math.ceil(timeAtY(k, y, state.t) / spb - 1e-6) * spb); // from a whole bar
}

// Settings changed (Settings page or Tempo & scroll): apply to the open music straight away.
async function applyPref(key) {
  if (!state) return;
  if (key === 'stage' || key === 'playBtn') { applyStage(); return; }
  if (state.kind !== 'pdf') return;
  if (key === 'trim') {
    for (const e of state.pcache.values()) if (e.canvas) e.canvas.width = e.canvas.height = 0;
    state.pcache.clear();
    await buildPdfPages();
  } else if (key === 'view') setMode();
  else if (key === 'pageList') { buildStrip(); setMode(); }
  else if (key === 'halfTurn' || key === 'spreadTurn') {
    const k = keyframes();
    if (state.paged && k) { state.pv = viewForTime(k, state.t); drawPaged(); }
  } else if (key === 'readLine') {
    const k = keyframes();
    if (k && !state.paged) $('#v-scroll').scrollTop = scrollTopForTime(k, state.t);
  }
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
    sc.scrollTop = 0; state.t = 0;
    if (state.paged) { state.pv = { c: 0, half: false }; drawPaged(); }
    updateStatus();
    if (wasPlaying) play();
  });
  $('#v-gear').addEventListener('click', () => {
    const p = $('#v-settings'); p.hidden = !p.hidden;
  });
  $('#s-close').addEventListener('click', () => { $('#v-settings').hidden = true; });
  $('#v-settings').addEventListener('input', e => { if (!e.target.closest('[data-zoom]')) readSettings(); });
  $('#v-settings').addEventListener('change', e => { if (!e.target.closest('[data-zoom]')) readSettings(); });
  $('#s-autoplay').addEventListener('click', () => {
    $('#v-settings').hidden = true;
    if (state.playing) { stop(); showChrome(true); } else play();
  });
  $('#s-more').addEventListener('click', async () => {
    const { openSettings } = await import('./settings.js');
    openSettings();
  });
  window.addEventListener('prefchange', e => applyPref(e.detail));
  $('#v-strip').addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (b && state) jumpToPage(+b.dataset.page);
  });
  sc.addEventListener('scroll', () => {
    if (state && !state.playing && !state.stripPending) {
      state.stripPending = true;
      requestAnimationFrame(() => { if (state) { state.stripPending = false; updateStrip(); } });
    }
  }, { passive: true });
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

  // Taps on the music:
  //   more than one screen of music -> left third = previous page, right third = next page,
  //                                    middle third = show / hide the toolbars
  //   music fits on one screen      -> a tap anywhere shows / hides the toolbars (nothing to turn)
  // Horizontal swipe = next / previous song.
  let downAt = 0, downX = 0, downY = 0;
  const onDown = e => { downAt = Date.now(); downX = e.clientX; downY = e.clientY; };
  const onUp = e => {
    if (!state) return;
    const dx = e.clientX - downX, dy = e.clientY - downY, dt = Date.now() - downAt;
    if (dt < 600 && Math.abs(dx) > 80 && Math.abs(dy) < 50) { switchSong(dx < 0 ? 1 : -1); return; }
    if (dt > 300 || Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    if (!$('#v-settings').hidden) { $('#v-settings').hidden = true; return; }
    const toggleChrome = () => showChrome($('#viewer').classList.contains('chrome-hidden'));
    // Music fits on one screen: nothing to turn, so a tap anywhere toggles the toolbars,
    // except in a setlist, where the sides still move to the next / previous song.
    if (fitsOneScreen() && !state.playlist?.setlist) { toggleChrome(); return; }
    const r = e.currentTarget.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    const next = pref('swapTaps') === '1' ? -1 : 1; // Settings: which side means "next page"
    if (x < 1 / 3) turnPage(-next);
    else if (x > 2 / 3) turnPage(next);
    else toggleChrome();
  };
  for (const el of [sc, $('#v-paged')]) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!state) return;
    if (state.kind === 'pdf' && (wantPaged() !== state.paged || state.paged || stripOn() !== $('#viewer').classList.contains('has-strip'))) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state) { if (stripOn() !== $('#viewer').classList.contains('has-strip')) buildStrip(); setMode(); } }, 150); // rotated: book spread <-> single page
      return;
    }
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
