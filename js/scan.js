// Photo scanner: photograph sheet music page by page -> find the paper edges -> straighten the page
// -> clean it to crisp black on white -> combine all pages into one PDF that is stored like any import.
//
// Everything runs on the device (no internet needed).
import { icon } from './icons.js';
import { promptText, confirmBox, toast } from './ui.js';

const MAX_SRC = 2400;   // longest side of the photo we work with (keeps memory sane on iOS)
const MAX_OUT = 2000;   // longest side of the finished page (~180 dpi on A4: sharp enough for OCR)

// =====================================================================================
// Image processing (pure functions on ImageData-like objects: { data, width, height })
// =====================================================================================

function toGray(img) {
  const { data, width, height } = img;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  return g;
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// Find the four corners of the (bright) sheet of paper. Returns points in the image's coordinates,
// ordered top-left, top-right, bottom-right, bottom-left. Falls back to a slightly inset rectangle.
export function detectQuad(img) {
  const { width: W, height: H } = img;
  const fallback = [
    { x: W * 0.04, y: H * 0.04 }, { x: W * 0.96, y: H * 0.04 },
    { x: W * 0.96, y: H * 0.96 }, { x: W * 0.04, y: H * 0.96 },
  ];
  const gray = toGray(img);
  const t = otsu(gray);
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = gray[i] > t ? 1 : 0;

  // Largest connected bright region = the paper.
  const label = new Int32Array(W * H);
  let bestLabel = 0, bestSize = 0, next = 1;
  const stack = new Int32Array(W * H);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    let sp = 0, size = 0;
    stack[sp++] = s; label[s] = next;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !label[p - W]) { label[p - W] = next; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !label[p + W]) { label[p + W] = next; stack[sp++] = p + W; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
    next++;
  }
  if (bestSize < W * H * 0.15) return fallback;

  // Extreme points of that region along the diagonals are the corners.
  let tl = null, tr = null, br = null, bl = null;
  let vtl = Infinity, vtr = -Infinity, vbr = -Infinity, vbl = -Infinity;
  for (let p = 0; p < label.length; p++) {
    if (label[p] !== bestLabel) continue;
    const x = p % W, y = (p / W) | 0;
    if (x + y < vtl) { vtl = x + y; tl = { x, y }; }
    if (x - y > vtr) { vtr = x - y; tr = { x, y }; }
    if (x + y > vbr) { vbr = x + y; br = { x, y }; }
    if (y - x > vbl) { vbl = y - x; bl = { x, y }; }
  }
  const quad = [tl, tr, br, bl];
  // Sanity check: the shape must be a reasonably large convex quadrilateral.
  if (polygonArea(quad) < W * H * 0.12 || !isConvex(quad)) return fallback;
  return quad;
}

function polygonArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}
function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

// Homography mapping the output rectangle (0,0)-(w,h) onto the quad in the photo.
function homography(w, h, q) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], { x, y } = q[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  // Gaussian elimination.
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const hm = new Array(8);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * hm[k];
    hm[r] = s / A[r][r];
  }
  return hm; // [a,b,c,d,e,f,g,h]: x=(a u+b v+c)/(g u+h v+1), y=(d u+e v+f)/(g u+h v+1)
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

// Straighten the quad into a flat page. Returns { data (RGBA), width, height }.
export function warp(img, quad) {
  let w = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  let h = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const s = Math.min(1, MAX_OUT / Math.max(w, h));
  w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
  const [a, b, c, d, e, f, g, hh] = homography(w, h, quad);
  const { data: src, width: SW, height: SH } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  let o = 0;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++, o += 4) {
      const den = g * u + hh * v + 1;
      let x = (a * u + b * v + c) / den, y = (d * u + e * v + f) / den;
      if (x < 0) x = 0; else if (x > SW - 1.001) x = SW - 1.001;
      if (y < 0) y = 0; else if (y > SH - 1.001) y = SH - 1.001;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * SW + x0) * 4, i10 = i00 + 4, i01 = i00 + SW * 4, i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = src[i00 + ch] + (src[i10 + ch] - src[i00 + ch]) * fx;
        const bot = src[i01 + ch] + (src[i11 + ch] - src[i01 + ch]) * fx;
        out[o + ch] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

// "Scanner" look: remove shadows/uneven light, make paper pure white and ink black. In place.
export function enhance(img) {
  const { data, width: W, height: H } = img;
  const gray = toGray(img);
  // Estimate the paper brightness everywhere: bright-ish value per block, then smooth.
  const B = Math.max(16, Math.round(Math.max(W, H) / 48));
  const bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  let grid = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * B; y < Math.min(H, (by + 1) * B); y += 2) {
        for (let x = bx * B; x < Math.min(W, (bx + 1) * B); x += 2) { hist[gray[y * W + x]]++; n++; }
      }
      // 90th percentile ignores the ink and isolated glare.
      let acc = 0, v = 255;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.9) { v = i; break; } }
      grid[by * bw + bx] = Math.max(v, 40);
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const g2 = new Float32Array(grid.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) { s += grid[yy * bw + xx]; n++; }
      }
      g2[y * bw + x] = s / n;
    }
    grid = g2;
  }
  for (let y = 0; y < H; y++) {
    const gy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = gy | 0, y1 = Math.min(bh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < W; x++) {
      const gx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = gx | 0, x1 = Math.min(bw - 1, x0 + 1), fx = gx - x0;
      const bg = (grid[y0 * bw + x0] * (1 - fx) + grid[y0 * bw + x1] * fx) * (1 - fy)
               + (grid[y1 * bw + x0] * (1 - fx) + grid[y1 * bw + x1] * fx) * fy;
      const n = gray[y * W + x] / bg;               // 1 = paper, lower = ink
      let v = (n - 0.42) / (0.86 - 0.42);            // levels
      v = v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1.7); // deepen mid-greys so thin staff lines stay solid
      const out = v * 255;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = out;
    }
  }
  return img;
}

// =====================================================================================
// Minimal PDF writer: one JPEG image per page, A4 width.
// =====================================================================================

export function makePdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = part => { const b = typeof part === 'string' ? enc.encode(part) : part; chunks.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  const pageObj = i => 3 + i * 3, contentObj = i => 4 + i * 3, imageObj = i => 5 + i * 3;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  pages.forEach((p, i) => {
    const pw = 595.28, ph = +(pw * p.height / p.width).toFixed(2);
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(pageObj(i), () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`));
    obj(contentObj(i), () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(imageObj(i), () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push('\nendstream');
    });
  });
  const total = 3 + n * 3;
  const xref = length;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// =====================================================================================
// Canvas helpers
// =====================================================================================

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')); };
    img.src = url;
  });
}

function canvasFrom(source, maxSide, rotate = 0) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * s), h = Math.round(sh * s);
  const c = document.createElement('canvas');
  const turned = rotate % 180 !== 0;
  c.width = turned ? h : w; c.height = turned ? w : h;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rotate * Math.PI / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  return c;
}

const toBlob = (canvas, quality = 0.85) =>
  new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));

function free(canvas) { if (canvas) canvas.width = canvas.height = 0; }

// =====================================================================================
// Scanner UI
// =====================================================================================

let S = null; // current session

export function startScan(onDone) {
  if (S) return;
  const root = document.createElement('div');
  root.className = 'scan';
  root.innerHTML = `
    <header class="scan-bar scan-top">
      <button class="scan-btn" data-act="cancel">Cancel</button>
      <div class="scan-title">Scan music</div>
      <button class="scan-btn strong" data-act="save" disabled>Save</button>
    </header>
    <main class="scan-pages">
      <div class="scan-empty">
        <div class="scan-empty-icon">${icon('camera')}</div>
        <h2>Photograph your sheet music</h2>
        <p>Lay each page flat on a darker surface in good light and take one photo per page. The page edges are found automatically – you can adjust them before saving.</p>
      </div>
      <div class="scan-grid"></div>
    </main>
    <footer class="scan-bar scan-bottom">
      <button class="scan-round" data-act="library" aria-label="Choose from photos">${icon('image')}</button>
      <button class="scan-shutter" data-act="camera" aria-label="Take photo"><span></span></button>
      <div class="scan-count" aria-live="polite"></div>
    </footer>

    <section class="scan-crop" hidden>
      <header class="scan-bar scan-top">
        <button class="scan-btn" data-act="crop-cancel">Cancel</button>
        <div class="scan-title">Adjust corners</div>
        <button class="scan-btn strong" data-act="crop-done">Use page</button>
      </header>
      <div class="crop-stage"><div class="crop-box"><img alt=""><svg class="crop-svg"></svg></div><div class="loupe" hidden></div></div>
      <footer class="scan-bar scan-bottom crop-tools">
        <button class="scan-tool" data-act="rotate">${icon('rotate-cw')}<span>Rotate</span></button>
        <button class="scan-tool" data-act="reset">${icon('crop')}<span>Full photo</span></button>
        <button class="scan-tool" data-act="auto">${icon('wand')}<span>Auto-detect</span></button>
        <button class="scan-tool toggle" data-act="mode" aria-pressed="true">${icon('file-music')}<span>Clean B&amp;W</span></button>
      </footer>
      <div class="crop-busy" hidden><div class="spinner"></div><span>Straightening page…</span></div>
    </section>

    <input type="file" accept="image/*" capture="environment" data-in="camera" hidden>
    <input type="file" accept="image/*" multiple data-in="library" hidden>`;
  document.body.appendChild(root);
  document.body.classList.add('scanning');

  S = { root, onDone, pages: [], queue: [], edit: null };
  const q = sel => root.querySelector(sel);

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'cancel') cancel();
    else if (act === 'save') save();
    else if (act === 'camera') q('[data-in=camera]').click();
    else if (act === 'library') q('[data-in=library]').click();
    else if (act === 'crop-cancel') cropCancel();
    else if (act === 'crop-done') cropDone();
    else if (act === 'rotate') rotate();
    else if (act === 'reset') { const { width: w, height: h } = S.edit.canvas; S.edit.quad = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]; drawQuad(); }
    else if (act === 'auto') { S.edit.quad = autoQuad(S.edit.canvas); drawQuad(); }
    else if (act === 'mode') { S.edit.mode = S.edit.mode === 'clean' ? 'color' : 'clean'; syncMode(); }
    else if (act === 'page-edit') editExisting(+b.dataset.i);
    else if (act === 'page-delete') deletePage(+b.dataset.i);
    else if (act === 'page-left') movePage(+b.dataset.i, -1);
    else if (act === 'page-right') movePage(+b.dataset.i, 1);
  });
  for (const inp of root.querySelectorAll('input[type=file]')) {
    inp.addEventListener('change', () => {
      const files = [...inp.files]; inp.value = '';
      S.queue.push(...files);
      if (!S.edit) nextInQueue();
    });
  }
  setupHandles();
  window.addEventListener('resize', onResize);
  renderPages();
}

function onResize() { if (S && S.edit) layoutCrop(); }

function close() {
  if (!S) return;
  for (const p of S.pages) URL.revokeObjectURL(p.thumbUrl);
  if (S.edit) { free(S.edit.canvas); URL.revokeObjectURL(S.edit.url); }
  S.root.remove();
  document.body.classList.remove('scanning');
  window.removeEventListener('resize', onResize);
  S = null;
}

async function cancel() {
  if (S.pages.length && !(await confirmBox('Discard scan?', `${S.pages.length} scanned page(s) will be lost.`, 'Discard', true))) return;
  close();
}

function renderPages() {
  const q = sel => S.root.querySelector(sel);
  const n = S.pages.length;
  q('.scan-empty').hidden = n > 0;
  q('[data-act=save]').disabled = n === 0;
  q('.scan-count').textContent = n ? `${n} page${n === 1 ? '' : 's'}` : '';
  q('.scan-grid').innerHTML = S.pages.map((p, i) => `
    <figure class="scan-page">
      <button class="scan-thumb" data-act="page-edit" data-i="${i}" aria-label="Adjust page ${i + 1}"><img src="${p.thumbUrl}" alt=""></button>
      <figcaption>
        <button class="scan-mini" data-act="page-left" data-i="${i}" aria-label="Move earlier" ${i === 0 ? 'disabled' : ''}>${icon('chevron-left')}</button>
        <span>Page ${i + 1}</span>
        <button class="scan-mini" data-act="page-right" data-i="${i}" aria-label="Move later" ${i === n - 1 ? 'disabled' : ''}>${icon('chevron-right')}</button>
        <button class="scan-mini danger" data-act="page-delete" data-i="${i}" aria-label="Delete page">${icon('trash')}</button>
      </figcaption>
    </figure>`).join('');
}

function movePage(i, d) {
  const j = i + d;
  if (j < 0 || j >= S.pages.length) return;
  [S.pages[i], S.pages[j]] = [S.pages[j], S.pages[i]];
  renderPages();
}

async function deletePage(i) {
  if (!(await confirmBox('Delete page?', `Page ${i + 1} will be removed from this scan.`, 'Delete', true))) return;
  const [p] = S.pages.splice(i, 1);
  URL.revokeObjectURL(p.thumbUrl);
  renderPages();
}

// ---------- Crop editor ----------

function autoQuad(canvas) {
  // Detect on a small copy for speed, then scale the corners back up.
  const small = canvasFrom(canvas, 320);
  const ctx = small.getContext('2d');
  const quad = detectQuad(ctx.getImageData(0, 0, small.width, small.height));
  const sx = canvas.width / small.width, sy = canvas.height / small.height;
  free(small);
  // Pull each corner ~1% towards the centre so no sliver of table shows along the edges.
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4, cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  return quad.map(p => ({ x: (p.x + (cx - p.x) * 0.012) * sx, y: (p.y + (cy - p.y) * 0.012) * sy }));
}

async function nextInQueue() {
  const file = S.queue.shift();
  if (!file) return;
  try {
    const img = await loadImage(file);
    const canvas = canvasFrom(img, MAX_SRC);
    openEditor({ canvas, quad: autoQuad(canvas), mode: 'clean', source: file, rotation: 0, index: -1 });
  } catch (e) {
    toast(e.message);
    nextInQueue();
  }
}

async function editExisting(i) {
  const p = S.pages[i];
  const img = await loadImage(p.source);
  const canvas = canvasFrom(img, MAX_SRC, p.rotation);
  openEditor({ canvas, quad: p.quad.map(c => ({ ...c })), mode: p.mode, source: p.source, rotation: p.rotation, index: i });
}

async function openEditor(edit) {
  S.edit = edit;
  const view = S.root.querySelector('.scan-crop');
  view.hidden = false;
  const blob = await toBlob(edit.canvas, 0.8);
  edit.url = URL.createObjectURL(blob);
  const img = view.querySelector('.crop-box img');
  img.onload = () => layoutCrop();
  img.src = edit.url;
  syncMode();
}

function syncMode() {
  const b = S.root.querySelector('[data-act=mode]');
  b.setAttribute('aria-pressed', String(S.edit.mode === 'clean'));
  b.querySelector('span').textContent = S.edit.mode === 'clean' ? 'Clean B&W' : 'Original colour';
}

function layoutCrop() {
  const e = S.edit;
  const stage = S.root.querySelector('.crop-stage');
  const box = S.root.querySelector('.crop-box');
  const pad = 28;
  const aw = stage.clientWidth - pad * 2, ah = stage.clientHeight - pad * 2;
  const s = Math.min(aw / e.canvas.width, ah / e.canvas.height);
  e.scale = s;
  box.style.width = e.canvas.width * s + 'px';
  box.style.height = e.canvas.height * s + 'px';
  drawQuad();
}

function drawQuad() {
  const e = S.edit;
  const svg = S.root.querySelector('.crop-svg');
  const w = e.canvas.width * e.scale, h = e.canvas.height * e.scale;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const pts = e.quad.map(p => [p.x * e.scale, p.y * e.scale]);
  const poly = pts.map(p => p.join(',')).join(' ');
  svg.innerHTML = `
    <path class="crop-shade" fill-rule="evenodd" d="M0 0H${w}V${h}H0Z M${pts.map(p => p.join(' ')).join(' L')}Z"/>
    <polygon class="crop-line" points="${poly}"/>
    ${pts.map((p, i) => `<circle class="crop-handle" data-h="${i}" cx="${p[0]}" cy="${p[1]}" r="13"/><circle class="crop-hit" data-h="${i}" cx="${p[0]}" cy="${p[1]}" r="30"/>`).join('')}`;
}

function setupHandles() {
  const svg = S.root.querySelector('.crop-svg');
  const loupe = S.root.querySelector('.loupe');
  let active = -1;
  svg.addEventListener('pointerdown', ev => {
    const h = ev.target.closest('[data-h]');
    if (!h) return;
    active = +h.dataset.h;
    svg.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    move(ev);
  });
  const move = ev => {
    if (active < 0) return;
    const e = S.edit;
    const r = svg.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
    const y = Math.max(0, Math.min(r.height, ev.clientY - r.top));
    e.quad[active] = { x: x / e.scale, y: y / e.scale };
    drawQuad();
    // Magnifier above the finger for precise placement.
    const Z = 3, L = 120;
    loupe.hidden = false;
    loupe.style.backgroundImage = `url("${e.url}")`;
    loupe.style.backgroundSize = `${r.width * Z}px ${r.height * Z}px`;
    loupe.style.backgroundPosition = `${-x * Z + L / 2}px ${-y * Z + L / 2}px`;
    const stage = S.root.querySelector('.crop-stage').getBoundingClientRect();
    loupe.style.left = (ev.clientX - stage.left - L / 2) + 'px';
    loupe.style.top = Math.max(0, ev.clientY - stage.top - L - 40) + 'px';
  };
  svg.addEventListener('pointermove', move);
  const up = () => { active = -1; loupe.hidden = true; };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
}

async function rotate() {
  const e = S.edit;
  e.rotation = (e.rotation + 90) % 360;
  const img = await loadImage(e.source);
  free(e.canvas);
  e.canvas = canvasFrom(img, MAX_SRC, e.rotation);
  e.quad = autoQuad(e.canvas);
  URL.revokeObjectURL(e.url);
  e.url = URL.createObjectURL(await toBlob(e.canvas, 0.8));
  S.root.querySelector('.crop-box img').src = e.url;
}

function closeEditor() {
  const e = S.edit;
  free(e.canvas);
  URL.revokeObjectURL(e.url);
  S.edit = null;
  S.root.querySelector('.scan-crop').hidden = true;
  S.root.querySelector('.crop-busy').hidden = true;
}

function cropCancel() {
  closeEditor();
  nextInQueue();
}

async function cropDone() {
  const e = S.edit;
  if (!isConvex(e.quad) || polygonArea(e.quad) < 100) { toast('The corners cross over – drag them to the page corners'); return; }
  S.root.querySelector('.crop-busy').hidden = false;
  await new Promise(r => setTimeout(r, 30)); // let the spinner paint
  try {
    const ctx = e.canvas.getContext('2d');
    const flat = warp(ctx.getImageData(0, 0, e.canvas.width, e.canvas.height), e.quad);
    if (e.mode === 'clean') enhance(flat);
    const out = document.createElement('canvas');
    out.width = flat.width; out.height = flat.height;
    out.getContext('2d').putImageData(new ImageData(flat.data, flat.width, flat.height), 0, 0);
    const jpeg = await toBlob(out, 0.85);
    free(out);
    const page = {
      source: e.source, rotation: e.rotation, quad: e.quad, mode: e.mode,
      jpeg, width: flat.width, height: flat.height, thumbUrl: URL.createObjectURL(jpeg),
    };
    if (e.index >= 0) { URL.revokeObjectURL(S.pages[e.index].thumbUrl); S.pages[e.index] = page; }
    else S.pages.push(page);
  } catch (err) {
    console.error(err);
    toast('Could not process that page: ' + err.message);
  }
  closeEditor();
  renderPages();
  nextInQueue();
}

// ---------- Save ----------

async function save() {
  const now = new Date();
  const def = `Scan ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const title = await promptText('Name this music', def, 'Save');
  if (!title) return;
  const pages = [];
  for (const p of S.pages) pages.push({ jpeg: new Uint8Array(await p.jpeg.arrayBuffer()), width: p.width, height: p.height });
  const pdf = makePdf(pages);
  const onDone = S.onDone;
  close();
  onDone(pdf.buffer, title);
}
