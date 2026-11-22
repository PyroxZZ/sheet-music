// Markup: draw on the music with Apple Pencil or a finger, like Markup in the iPad Preview app.
//
// - Apple Pencil always draws (it switches Markup on by itself). Fingers draw only while Markup is on
//   and "Draw with finger" is on; the first time a Pencil is used, fingers go back to turning pages.
// - Two-finger tap = undo, three-finger tap = redo (anywhere on the music).
// - Markings are saved with the song (song.ink), in page units: x 0..1000 across the full page,
//   y 0..1000*H/W down it. That keeps them in place whatever the layout, trim or screen size.
import { getStroke } from '../vendor/perfect-freehand/perfect-freehand.mjs';
import * as db from './db.js';
import { pref, setPref } from './prefs.js';
import { toast } from './ui.js';


const NS = 'http://www.w3.org/2000/svg';
const $ = sel => document.querySelector(sel);

export const COLORS = {
  pen: ['#1c1c1e', '#e03131', '#1971c2', '#2f9e44'],
  hl: ['#ffd43b', '#8ce99a', '#ffa8c5', '#74c0fc'],
};
// Line thickness in page units (page width = 1000): a smooth range per tool, plus 3 presets for a tap.
const SIZES = { pen: [2.2, 3.6, 6], hl: [12, 20, 30] };
const RANGE = { pen: [1, 24], hl: [6, 60] };
const ERASER = 14;

let song = null;        // the open song (PDF only)
let undoStack = [], redoStack = [];
let saveTimer = 0;
let hooks = {};         // from the viewer: { turnPage(dir) }
let drawing = null;     // { pointerId, type, page, svg, stroke, path, removed }
const touches = new Map(); // touch pointers on the music: id -> { x, y }
let gesture = null;     // { max, start, moved }

// ---------- Song open / close ----------

export function inkOpen(s) {
  song = s.kind === 'score' ? null : s;
  undoStack = []; redoStack = [];
  setMarkup(false);
  $('#viewer').classList.toggle('has-ink', !!song);
}

export function inkClose() {
  if (drawing) finishStroke();
  flushSave();
  setMarkup(false);
  song = null;
}

const strokesOf = page => {
  if (!song.ink) song.ink = { v: 1, pages: {} };
  return song.ink.pages[page] || (song.ink.pages[page] = []);
};

let dirty = false;
function save() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}
function flushSave() {
  clearTimeout(saveTimer);
  if (song && dirty) db.put('songs', song).catch(e => console.warn('Saving markings failed', e));
  dirty = false;
}

// ---------- Drawing layers ----------

// The markings layer for page p (viewer page record). w/h: CSS size, or omitted to fill its box.
export function inkSvg(p, w, h) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ink');
  const page = p.index - 1;
  svg.dataset.page = page;
  const k = 1000 / p.W, ph = p.H * k;
  const [x0, y0, x1, y1] = p.crop;
  svg.setAttribute('viewBox', `${x0 * 1000} ${y0 * ph} ${(x1 - x0) * 1000} ${(y1 - y0) * ph}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  if (w) { svg.style.width = w + 'px'; svg.style.height = h + 'px'; }
  if (song) drawStrokes(svg, song.ink?.pages[page] || []);
  return svg;
}

function drawStrokes(svg, strokes) {
  svg.replaceChildren(...strokes.map(s => strokePath(s)));
}

function refresh(page) {
  const strokes = song.ink?.pages[page] || [];
  for (const svg of document.querySelectorAll(`#viewer svg.ink[data-page="${page}"]`)) drawStrokes(svg, strokes);
}

function strokePath(s, path = document.createElementNS(NS, 'path')) {
  const pts = [];
  for (let i = 0; i < s.p.length; i += 3) pts.push([s.p[i], s.p[i + 1], s.p[i + 2]]);
  const hl = s.t === 'hl';
  const outline = getStroke(pts, {
    size: s.s, thinning: hl ? 0 : 0.55, smoothing: 0.5, streamline: hl ? 0.6 : 0.45,
    simulatePressure: !!s.sp && !hl, last: true,
    start: { cap: true }, end: { cap: true },
  });
  path.setAttribute('d', outlineToPath(outline));
  path.setAttribute('fill', s.c);
  path.setAttribute('class', hl ? 'ink-hl' : 'ink-pen');
  return path;
}

// Smooth closed path through the outline points (quadratic curves between midpoints).
function outlineToPath(pts) {
  if (pts.length < 2) return '';
  const f = n => +n.toFixed(2);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}Q`;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    d += `${f(x0)},${f(y0)} ${f((x0 + x1) / 2)},${f((y0 + y1) / 2)} `;
  }
  return d + 'Z';
}

// ---------- Undo / redo ----------

function apply(a, reverse) {
  const list = strokesOf(a.page);
  const add = reverse ? a.remove : a.add, remove = reverse ? a.add : a.remove;
  for (const s of remove) { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); }
  list.push(...add);
  refresh(a.page);
  save();
}

function record(a) {
  undoStack.push(a);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  updateButtons();
}

export function undo() {
  const a = undoStack.pop();
  if (!a) return false;
  apply(a, true); redoStack.push(a); updateButtons();
  return true;
}
export function redo() {
  const a = redoStack.pop();
  if (!a) return false;
  apply(a, false); undoStack.push(a); updateButtons();
  return true;
}

// ---------- Markup mode and toolbar ----------

const markupOn = () => $('#viewer').classList.contains('markup');
const fingerDraws = () => pref('inkFinger') !== '0';
const tool = () => pref('inkTool');
const colorKey = t => (t === 'hl' ? 'inkHlColor' : 'inkPenColor');
const sizeKey = t => (t === 'hl' ? 'inkHlSize' : 'inkPenSize');
// Stored as a number; older versions stored a preset index '0' / '1' / '2'.
function sizeOf(t) {
  const v = pref(sizeKey(t));
  if (v === '0' || v === '1' || v === '2') return SIZES[t][+v];
  const n = parseFloat(v);
  return n > 0 ? Math.max(RANGE[t][0], Math.min(RANGE[t][1], n)) : SIZES[t][1];
}
// Screen pixels per page unit for the music on screen now (layout, zoom and screen size included).
function screenScale() {
  for (const svg of document.querySelectorAll('#viewer svg.ink')) {
    const w = svg.getBoundingClientRect().width, vb = svg.viewBox.baseVal;
    if (w > 0 && vb && vb.width) return w / vb.width;
  }
  return 0.7;
}

export function setMarkup(on) {
  const v = $('#viewer');
  if (on && (!song || v.classList.contains('is-locked'))) return;
  v.classList.toggle('markup', on);
  $('#v-markup').hidden = !on;
  if (on) { v.classList.remove('chrome-hidden'); renderToolbar(); }
  updateFingerClass();
}

function updateFingerClass() {
  $('#viewer').classList.toggle('finger-draws', markupOn() && fingerDraws());
}

function renderToolbar() {
  const t = tool();
  for (const b of document.querySelectorAll('#v-markup [data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  const colors = $('#v-markup .mk-colors');
  const size = $('#v-markup [data-mk=size]');
  if (t === 'eraser') { colors.innerHTML = ''; size.hidden = true; }
  else {
    const cur = pref(colorKey(t));
    colors.innerHTML = COLORS[t].map(c => `<button class="mk-color${c === cur ? ' on' : ''}" data-color="${c}" style="--c:${c}" aria-label="Colour"></button>`).join('');
    size.hidden = false;
    const d = Math.max(4, Math.min(26, sizeOf(t) * screenScale()));
    size.innerHTML = `<span class="mk-dot" style="--d:${d.toFixed(1)}px;--c:${cur}"></span>`;
  }
  const f = $('#v-markup [data-mk=finger]');
  f.classList.toggle('on', fingerDraws());
  f.setAttribute('aria-pressed', fingerDraws());
  updateButtons();
}

function updateButtons() {
  const u = $('#v-markup [data-mk=undo]'), r = $('#v-markup [data-mk=redo]');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

function onToolbar(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) setPref('inkTool', b.dataset.tool);
  else if (b.dataset.color) setPref(colorKey(tool()), b.dataset.color);
  else {
    const a = b.dataset.mk;
    if (a === 'undo') undo();
    else if (a === 'redo') redo();
    else if (a === 'finger') {
      setPref('inkFinger', fingerDraws() ? '0' : '1');
      toast(fingerDraws() ? 'Fingers draw' : 'Fingers turn pages · Apple Pencil draws', { ms: 1800 });
    }
    else if (a === 'prev') hooks.turnPage?.(-1);
    else if (a === 'next') hooks.turnPage?.(1);
    else if (a === 'done') setMarkup(false);
  }
  renderToolbar();
  updateFingerClass();
}

// ---------- Size: press the size button and slide up (thicker) or down (thinner) ----------
// A card above the button shows the line as a circle at its real size on the page, with a track.
// A quick tap steps through thin / medium / thick.
const TRACK = 200; // px of finger / Pencil travel for the whole range

function sizeToT(t, s) { const [a, b] = RANGE[t]; return Math.sqrt((s - a) / (b - a)); } // finer control when thin
function tToSize(t, x) { const [a, b] = RANGE[t]; return a + (b - a) * x * x; }

function initSizeSlider() {
  const btn = $('#v-markup [data-mk=size]'), pop = $('#mk-size-pop');
  let drag = null;
  const show = (t, s) => {
    const scale = screenScale(), d = s * scale, c = pref(colorKey(t));
    const circle = pop.querySelector('.msp-circle');
    circle.style.width = circle.style.height = Math.max(2, Math.min(150, d)) + 'px';
    circle.style.setProperty('--c', c);
    circle.classList.toggle('hl', t === 'hl');
    pop.querySelector('.msp-fill').style.height = (sizeToT(t, s) * 100).toFixed(1) + '%';
    pop.querySelector('.msp-val').textContent = d < 10 ? d.toFixed(1) + ' pt' : Math.round(d) + ' pt';
  };
  btn.addEventListener('pointerdown', e => {
    const t = tool();
    if (t === 'eraser') return;
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch {}
    drag = { id: e.pointerId, y: e.clientY, t, t0: sizeToT(t, sizeOf(t)), s: sizeOf(t), moved: false };
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(innerWidth - 168, r.left + r.width / 2 - 80)) + 'px';
    pop.style.bottom = (innerHeight - r.top + 12) + 'px';
    pop.hidden = false;
    show(t, drag.s);
  });
  btn.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY; // up = positive = thicker
    if (Math.abs(dy) > 6) drag.moved = true;
    if (!drag.moved) return;
    const x = Math.max(0, Math.min(1, drag.t0 + dy / TRACK));
    drag.s = tToSize(drag.t, x);
    show(drag.t, drag.s);
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    pop.hidden = true;
    if (d.moved) setPref(sizeKey(d.t), d.s.toFixed(2));
    else { // tap: next preset up from the current size (wrapping to thin)
      const next = SIZES[d.t].find(v => v > d.s + 0.01) ?? SIZES[d.t][0];
      setPref(sizeKey(d.t), String(next));
    }
    renderToolbar();
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
}

// ---------- Pointer input ----------

// The page layer under a point: the last one in page order wins (a half page lies over a full one).
function layerAt(x, y) {
  let hit = null;
  for (const svg of document.querySelectorAll('#viewer svg.ink')) {
    const r = svg.parentElement.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = svg;
  }
  return hit;
}

function toPage(svg, x, y) {
  const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
  return [vb.x + (x - r.left) / r.width * vb.width, vb.y + (y - r.top) / r.height * vb.height];
}

const onMusic = e => e.target.closest && e.target.closest('#v-scroll, #v-paged');

function onDown(e) {
  if (!song || !onMusic(e)) return;
  const v = $('#viewer');
  if (e.pointerType === 'touch') {
    if (e.isPrimary) { touches.clear(); gesture = null; } // first finger of a new touch: start clean
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) gesture = { max: 1, start: performance.now(), moved: false };
    else if (gesture) gesture.max = Math.max(gesture.max, touches.size);
    if (touches.size >= 2) {
      if (drawing && drawing.type === 'touch') cancelStroke(); // it was the start of a gesture
      e.stopPropagation();
      return;
    }
    if (drawing && drawing.type === 'pen') { e.stopPropagation(); return; } // palm while writing
  }
  if (v.classList.contains('is-locked') || drawing) return;
  const isPen = e.pointerType === 'pen';
  if (!isPen && !(markupOn() && (e.pointerType === 'mouse' || fingerDraws()))) return;
  const svg = layerAt(e.clientX, e.clientY);
  if (!svg) return;
  e.stopPropagation();
  e.preventDefault();
  if (isPen) {
    if (!markupOn()) setMarkup(true);
    if (pref('inkFinger') === 'auto') { // first Pencil use: fingers go back to turning pages
      setPref('inkFinger', '0');
      updateFingerClass(); renderToolbar();
      toast('Apple Pencil draws, fingers turn pages. Change it with the hand button.', { ms: 3500 });
    }
  }
  try { v.setPointerCapture(e.pointerId); } catch {}
  const page = +svg.dataset.page;
  const t = tool();
  drawing = { pointerId: e.pointerId, type: e.pointerType, page, svg, tool: t, removed: [] };
  if (t === 'eraser') { erase(e); return; }
  drawing.stroke = {
    t, c: pref(colorKey(t)), s: +sizeOf(t).toFixed(2), sp: !isPen, p: [],
  };
  drawing.path = document.createElementNS(NS, 'path');
  svg.appendChild(drawing.path);
  addPoints(e);
}

function addPoints(e) {
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of list.length ? list : [e]) {
    const [x, y] = toPage(drawing.svg, ev.clientX, ev.clientY);
    const pr = drawing.type === 'pen' ? (ev.pressure || 0.5) : 0.5;
    drawing.stroke.p.push(+x.toFixed(1), +y.toFixed(1), +pr.toFixed(2));
  }
  strokePath(drawing.stroke, drawing.path);
}

function erase(e) {
  const list = strokesOf(drawing.page);
  const [x, y] = toPage(drawing.svg, e.clientX, e.clientY);
  let hit = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i], r = ERASER + s.s / 2;
    for (let j = 0; j < s.p.length; j += 3) {
      if (Math.abs(s.p[j] - x) < r && Math.abs(s.p[j + 1] - y) < r && Math.hypot(s.p[j] - x, s.p[j + 1] - y) < r) {
        drawing.removed.push(s); list.splice(i, 1); hit = true; break;
      }
    }
  }
  if (hit) refresh(drawing.page);
}

function onMove(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const t = touches.get(e.pointerId);
    if (gesture && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) gesture.moved = true; // below the zoom / move thresholds
  }
  if (!drawing || e.pointerId !== drawing.pointerId) return;
  e.stopPropagation();
  if (drawing.tool === 'eraser') erase(e);
  else addPoints(e);
}

function onUp(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.delete(e.pointerId);
    if (gesture && gesture.max >= 2) {
      e.stopPropagation(); // not a page-turn tap
      if (!touches.size) {
        const quick = performance.now() - gesture.start < 450 && !gesture.moved;
        if (quick && gesture.max === 2) toast(undo() ? 'Undo' : 'Nothing to undo', { ms: 900 });
        else if (quick && gesture.max === 3) toast(redo() ? 'Redo' : 'Nothing to redo', { ms: 900 });
        gesture = null;
      }
      return;
    }
    if (!touches.size) gesture = null;
  }
  if (!drawing || e.pointerId !== drawing.pointerId) return;
  e.stopPropagation();
  finishStroke();
}

function onCancel(e) {
  if (touches.has(e.pointerId)) { touches.delete(e.pointerId); if (!touches.size) gesture = null; }
  if (drawing && e.pointerId === drawing.pointerId) finishStroke();
}

function finishStroke() {
  const d = drawing;
  drawing = null;
  if (d.tool === 'eraser') {
    if (d.removed.length) record({ page: d.page, add: [], remove: d.removed });
    save();
    return;
  }
  d.path.remove();
  if (d.stroke.p.length < 3) return;
  strokesOf(d.page).push(d.stroke);
  record({ page: d.page, add: [d.stroke], remove: [] });
  refresh(d.page);
  save();
}

function cancelStroke() {
  if (!drawing) return;
  if (drawing.path) drawing.path.remove();
  if (drawing.removed.length) { strokesOf(drawing.page).push(...drawing.removed); refresh(drawing.page); }
  drawing = null;
}

// ---------- Wiring ----------

export function initInk(h) {
  hooks = h;
  const v = $('#viewer');
  // Capture phase on #viewer: decide before the page-turn tap handlers on the music see the event.
  v.addEventListener('pointerdown', onDown, true);
  v.addEventListener('pointermove', onMove, true);
  v.addEventListener('pointerup', onUp, true);
  v.addEventListener('pointercancel', onCancel, true);
  // Apple Pencil must not scroll the music (fingers still can, unless they are drawing).
  v.addEventListener('touchstart', e => {
    if (!song || v.classList.contains('is-locked') || !onMusic(e)) return;
    const stylus = [...e.changedTouches].some(t => t.touchType === 'stylus');
    if (stylus || (markupOn() && fingerDraws() && e.touches.length === 1)) e.preventDefault();
  }, { passive: false });
  $('#v-markup').addEventListener('click', onToolbar);
  initSizeSlider();
  window.addEventListener('prefchange', e => { if (/^ink/.test(e.detail) && markupOn()) renderToolbar(); });
}
