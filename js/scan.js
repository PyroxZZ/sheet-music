// Photo scanner: photograph sheet music page by page -> find the paper edges -> straighten the page
// -> clean it to crisp black on white (optionally traced into vector outlines, so it looks and zooms like
// a real PDF) -> combine all pages into one PDF that is stored like any import.
//
// Everything runs on the device (no internet needed).
import { icon } from './icons.js';
import { promptText, confirmBox, toast } from './ui.js';
import { vectorPageContent } from './vectorize.js';

// Resolution limits. iOS Safari refuses canvases above 16.7 M pixels and is stingy with total canvas
// memory, so we stay well below that: a 12 MP (4032x3024) photo is reduced to 3600x2700 = 9.7 MP
// (39 MB RGBA), which still keeps ~90% of its linear detail. The page itself rarely fills more than
// ~80% of the photo, so ~2900 px is about all the real detail there is; MAX_OUT = 3000 (A4 at
// 3000x2121 ≈ 255 dpi, 6.4 MP) keeps all of it without inventing pixels.
const MAX_SRC = 3600;
const MAX_OUT = 3000;
const ANALYSIS = 1600;  // longest side of the reduced copy used to find staff lines

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
const tick = () => new Promise(r => setTimeout(r, 0));

// ---------- Page shape ----------

// True height/width ratio of the photographed rectangle, from the perspective of its corners
// (Zhang & He, "Whiteboard scanning"): the camera's focal length follows from the quad; if that is
// ill-conditioned (nearly straight-on shot, cropped photo) a typical phone lens is assumed.
function perspectiveAspect(q, W, H) {
  const cx = W / 2, cy = H / 2;
  const P = p => [p.x - cx, p.y - cy, 1];
  const m1 = P(q[0]), m2 = P(q[1]), m3 = P(q[3]), m4 = P(q[2]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3), k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]), n3 = m3.map((v, i) => k3 * v - m1[i]);
  const L = Math.max(W, H);
  let f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  if (!(f2 > (0.45 * L) ** 2 && f2 < (2.5 * L) ** 2)) f2 = (0.75 * L) ** 2; // ~26 mm-equivalent phone lens
  const a = n2[0] ** 2 + n2[1] ** 2 + n2[2] ** 2 * f2, b = n3[0] ** 2 + n3[1] ** 2 + n3[2] ** 2 * f2;
  const r = Math.sqrt(b / a);
  return Number.isFinite(r) && r > 0.3 && r < 3.5 ? r : null;
}

// Output size of the flattened page: true proportions (snapped to A4 / Letter / 9x12 / Legal when close),
// sampled as finely as the photo allows, capped at MAX_OUT.
function pageShape(quad, W, H) {
  const wpx = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  const hpx = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  let ratio = perspectiveAspect(quad, W, H) || hpx / wpx;
  for (const std of [Math.SQRT2, 11 / 8.5, 4 / 3, 14 / 8.5]) {
    if (Math.abs(ratio / std - 1) < 0.03) { ratio = std; break; }
    if (Math.abs(ratio * std - 1) < 0.03) { ratio = 1 / std; break; }
  }
  const h = Math.max(hpx, wpx * ratio), w = h / ratio;
  const s = Math.min(1, MAX_OUT / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ---------- Resampling ----------
// A "map" turns an output pixel (u,v) into page coordinates (x,y): the page as the plain perspective
// warp would show it (0..pw, 0..ph). It is evaluated on a coarse grid and interpolated in between;
// the homography then takes page coordinates to the photo. Everything is sampled from the photo once.

const identityMap = (u, v, p) => { p[0] = u; p[1] = v; };

function makeGrid(w, h, step, map) {
  const gw = Math.ceil((w - 1) / step) + 2, gh = Math.ceil((h - 1) / step) + 2;
  const gx = new Float32Array(gw * gh), gy = new Float32Array(gw * gh);
  const p = [0, 0];
  for (let j = 0, k = 0; j < gh; j++) for (let i = 0; i < gw; i++, k++) { map(i * step, j * step, p); gx[k] = p[0]; gy[k] = p[1]; }
  return { gw, gh, step, gx, gy };
}

// Returns row(v) -> fills and returns [xs, ys]: photo coordinates of every pixel of output row v.
function rowMapper(w, grid, hm, pw, ph, SW, SH) {
  const { gw, gh, step, gx, gy } = grid;
  const ax = new Float32Array(gw), ay = new Float32Array(gw);
  const xs = new Float32Array(w), ys = new Float32Array(w);
  const [a, b, c, d, e, f, g, hh] = hm;
  const out = [xs, ys];
  return v => {
    const t = v / step, j = Math.min(gh - 2, t | 0), fy = t - j;
    for (let i = 0, k = j * gw; i < gw; i++, k++) {
      ax[i] = gx[k] + (gx[k + gw] - gx[k]) * fy;
      ay[i] = gy[k] + (gy[k + gw] - gy[k]) * fy;
    }
    for (let u = 0; u < w; u++) {
      const s = u / step, i = Math.min(gw - 2, s | 0), fx = s - i;
      let px = ax[i] + (ax[i + 1] - ax[i]) * fx, py = ay[i] + (ay[i + 1] - ay[i]) * fx;
      // Never sample beyond the page outline (that would pull in the table).
      if (px < 0) px = 0; else if (px > pw) px = pw;
      if (py < 0) py = 0; else if (py > ph) py = ph;
      const den = g * px + hh * py + 1;
      let x = (a * px + b * py + c) / den, y = (d * px + e * py + f) / den;
      if (x < 0) x = 0; else if (x > SW - 1.001) x = SW - 1.001;
      if (y < 0) y = 0; else if (y > SH - 1.001) y = SH - 1.001;
      xs[u] = x; ys[u] = y;
    }
    return out;
  };
}

// Catmull-Rom weights for fraction t.
function cubicW(t, w) {
  const t2 = t * t, t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}

// Resample a single-channel image (Uint8, stride SW) or RGBA (channels = 4, first 3 used) through the
// map. cubic = sharper bicubic (final output); otherwise bilinear (analysis copies).
function render(src, SW, SH, channels, hm, pw, ph, w, h, map, cubic) {
  const grid = makeGrid(w, h, 8, map);
  const row = rowMapper(w, grid, hm, pw, ph, SW, SH);
  const out = new Uint8ClampedArray(w * h * (channels === 1 ? 1 : 4));
  const wx = new Float32Array(4), wy = new Float32Array(4);
  const nc = channels === 1 ? 1 : 3, oc = channels === 1 ? 1 : 4;
  for (let v = 0, o = 0; v < h; v++) {
    const [xs, ys] = row(v);
    for (let u = 0; u < w; u++, o += oc) {
      const x = xs[u], y = ys[u];
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      if (!cubic || x0 < 1 || y0 < 1 || x0 > SW - 3 || y0 > SH - 3) {
        const i00 = (y0 * SW + x0) * channels, i10 = i00 + channels, i01 = i00 + SW * channels, i11 = i01 + channels;
        for (let ch = 0; ch < nc; ch++) {
          const top = src[i00 + ch] + (src[i10 + ch] - src[i00 + ch]) * fx;
          const bot = src[i01 + ch] + (src[i11 + ch] - src[i01 + ch]) * fx;
          out[o + ch] = top + (bot - top) * fy;
        }
      } else {
        cubicW(fx, wx); cubicW(fy, wy);
        const rs = SW * channels, base = ((y0 - 1) * SW + x0 - 1) * channels;
        for (let ch = 0; ch < nc; ch++) {
          let acc = 0;
          for (let r = 0, i = base + ch; r < 4; r++, i += rs) {
            acc += wy[r] * (wx[0] * src[i] + wx[1] * src[i + channels] + wx[2] * src[i + 2 * channels] + wx[3] * src[i + 3 * channels]);
          }
          out[o + ch] = acc; // clamped by the array type
        }
      }
      if (oc === 4) out[o + 3] = 255;
    }
  }
  return out;
}

// ---------- Paper level (shadow / uneven light removal) ----------

// Brightness of the bare paper everywhere: a bright-ish percentile per block, smoothed.
function paperLevel(gray, W, H) {
  const B = Math.max(16, Math.round(Math.max(W, H) / 48));
  const bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  let grid = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  const st = B >= 32 ? 3 : 2;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * B; y < Math.min(H, (by + 1) * B); y += st) {
        for (let x = bx * B, r = y * W; x < Math.min(W, (bx + 1) * B); x += st) { hist[gray[r + x]]++; n++; }
      }
      // 90th percentile ignores the ink and isolated glare.
      let acc = 0, v = 255;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.9) { v = i; break; } }
      grid[by * bw + bx] = Math.max(v, 40);
    }
  }
  // A block filled with ink (thick beams, clusters) reads too dark: lift it towards its brightest neighbours.
  const g0 = grid.slice();
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < bw && yy < bh && g0[yy * bw + xx] > m) m = g0[yy * bw + xx];
    }
    if (g0[y * bw + x] < m * 0.8) grid[y * bw + x] = m * 0.9;
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
  // Precomputed horizontal positions for fast row interpolation.
  const ix = new Int32Array(W), fxs = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const gx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5));
    ix[x] = gx | 0; fxs[x] = gx - (gx | 0);
  }
  // Fills `row` (Float32Array(W)) with the paper brightness of image row y.
  return (y, row) => {
    const gy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = gy | 0, y1 = Math.min(bh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < W; x++) {
      const x0 = ix[x], x1 = Math.min(bw - 1, x0 + 1), fx = fxs[x];
      row[x] = (grid[y0 * bw + x0] * (1 - fx) + grid[y0 * bw + x1] * fx) * (1 - fy)
             + (grid[y1 * bw + x0] * (1 - fx) + grid[y1 * bw + x1] * fx) * fy;
    }
  };
}

function inkMask(gray, W, H) {
  const level = paperLevel(gray, W, H);
  const mask = new Uint8Array(W * H), row = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    level(y, row);
    for (let x = 0, i = y * W; x < W; x++, i++) mask[i] = gray[i] < row[x] * 0.75 ? 1 : 0;
  }
  return mask;
}

// ---------- Staff lines: the built-in ruler of sheet music ----------

// Typical staff-line thickness and line-to-line distance, from vertical run lengths.
function staffMetrics(mask, W, H) {
  const black = new Uint32Array(64), white = new Uint32Array(256);
  for (let x = 1; x < W; x += 3) {
    let run = 0, cur = mask[x], seenBlack = false;
    for (let y = 0, p = x; y < H; y++, p += W) {
      if (mask[p] === cur) { run++; continue; }
      if (cur) { if (run < 64) black[run]++; seenBlack = true; }
      else if (seenBlack && run < 256) white[run]++;
      cur = mask[p]; run = 1;
    }
  }
  let t = 1, gap = 2;
  for (let i = 1; i < 64; i++) if (black[i] > black[t]) t = i;
  for (let i = 2; i < 256; i++) if (white[i] > white[gap]) gap = i;
  // Sub-pixel refinement around the modes.
  const refine = (h, m) => { const a = h[m - 1] || 0, b = h[m], c = h[m + 1] || 0; return m + (a + b + c ? (c - a) / (a + b + c) : 0); };
  const tt = refine(black, t), d = tt + refine(white, gap);
  if (white[gap] < 50 || d < 5 || d > H / 12 || tt > d / 2) return null;
  return { t: tt, d };
}

// Median of a numeric array (copy).
function median(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Finds staves (groups of 5 equally spaced lines) in narrow vertical strips and links them across the
// page. Returns a model { f(x,y,p), theta, staves, maxShift } that maps a point of the straightened
// page to where it lies in the analysed image (same pixel scale), or null.
function staffModel(mask, W, H, { t, d }) {
  const sw = Math.max(Math.round(1.5 * d), Math.round(W / 64));
  const nS = Math.floor(W / sw);
  if (nS < 8) return null;
  const proj = new Uint16Array(nS * H);
  for (let y = 0; y < H; y++) {
    const r = y * W;
    for (let s = 0; s < nS; s++) {
      let c = 0;
      for (let x = s * sw, e = x + sw; x < e; x++) c += mask[r + x];
      proj[s * H + y] = c;
    }
  }
  const half = Math.max(1, Math.ceil(t / 2));
  const thr = 0.45 * Math.max(1, t) * sw;
  const q = new Float32Array(H);
  const groups = []; // per strip: [{ c, sp }]
  for (let s = 0; s < nS; s++) {
    const P = proj.subarray(s * H, (s + 1) * H);
    for (let y = 0; y < H; y++) {
      let acc = 0;
      for (let k = -half; k <= half; k++) { const yy = y + k; if (yy >= 0 && yy < H) acc += P[yy]; }
      q[y] = acc;
    }
    // Peaks (local maxima above threshold), at least half a line distance apart.
    let peaks = [];
    for (let y = 1; y < H - 1; y++) {
      if (q[y] < thr || q[y] < q[y - 1] || q[y] <= q[y + 1]) continue;
      const last = peaks[peaks.length - 1];
      if (last && y - last.y < d * 0.5) { if (q[y] > last.v) { last.y = y; last.v = q[y]; } continue; }
      peaks.push({ y, v: q[y] });
    }
    // Sub-pixel centre of each peak.
    const ys = peaks.map(({ y }) => {
      let m = 0, n = 0;
      for (let k = -half - 1; k <= half + 1; k++) { const yy = y + k; if (yy >= 0 && yy < H) { m += P[yy] * yy; n += P[yy]; } }
      return n ? m / n : y;
    });
    const used = new Uint8Array(ys.length), gs = [];
    for (let i = 0; i < ys.length; i++) {
      if (used[i]) continue;
      const seq = [i];
      let gap = d;
      for (let k = 1; k < 5; k++) {
        const target = ys[seq[k - 1]] + gap;
        let best = -1, bd = d * 0.25;
        for (let j = seq[k - 1] + 1; j < ys.length && ys[j] < target + bd; j++) {
          if (!used[j] && Math.abs(ys[j] - target) <= bd) { bd = Math.abs(ys[j] - target); best = j; }
        }
        if (best < 0) break;
        seq.push(best);
        gap = (ys[best] - ys[seq[0]]) / k;
      }
      if (seq.length < 5) continue;
      const sp = (ys[seq[4]] - ys[seq[0]]) / 4;
      let ok = true;
      for (let k = 1; k < 5; k++) if (Math.abs(ys[seq[k]] - ys[seq[k - 1]] - sp) > Math.max(1, 0.2 * d)) ok = false;
      if (!ok) continue;
      // A further line at the same spacing (ledger lines, a 6-line staff) makes the group ambiguous.
      const y0 = ys[seq[0]], y4 = ys[seq[4]];
      if (ys.some(y => Math.abs(y - (y0 - sp)) < 0.25 * d || Math.abs(y - (y4 + sp)) < 0.25 * d)) continue;
      for (const k of seq) used[k] = 1;
      gs.push({ c: seq.reduce((a, k) => a + ys[k], 0) / 5, sp });
    }
    groups.push(gs);
  }
  const xc = s => (s + 0.5) * sw;

  // Link staves strip by strip into chains.
  let chains = [];
  for (let s = 0; s < nS; s++) {
    for (const g of groups[s]) {
      let best = null, bd = d * 1.2;
      for (const ch of chains) {
        const n = ch.s.length, ls = ch.s[n - 1];
        if (ls === s || s - ls > 10) continue;
        let slope = 0;
        if (n >= 2) { const k = Math.max(0, n - 4); slope = (ch.c[n - 1] - ch.c[k]) / (xc(ch.s[n - 1]) - xc(ch.s[k])); }
        slope = Math.max(-0.5, Math.min(0.5, slope));
        const dd = Math.abs(g.c - (ch.c[n - 1] + slope * (xc(s) - xc(ls))));
        if (dd < bd) { bd = dd; best = ch; }
      }
      if (best) { best.s.push(s); best.c.push(g.c); }
      else chains.push({ s: [s], c: [g.c] });
    }
  }
  chains = chains.filter(ch => ch.s.length >= Math.max(5, 0.3 * nS) && xc(ch.s[ch.s.length - 1]) - xc(ch.s[0]) >= 0.4 * W);
  if (!chains.length) return null;

  // Clean each chain: drop samples that disagree with their neighbours (note heads, beams).
  for (const ch of chains) {
    const keepS = [], keepC = [];
    for (let i = 0; i < ch.s.length; i++) {
      const nb = [];
      for (let k = Math.max(0, i - 2); k <= Math.min(ch.s.length - 1, i + 2); k++) if (k !== i) nb.push(ch.c[k]);
      if (Math.abs(ch.c[i] - median(nb)) <= Math.max(1.5, 0.3 * d)) { keepS.push(ch.s[i]); keepC.push(ch.c[i]); }
    }
    ch.s = keepS; ch.c = keepC;
  }
  chains = chains.filter(ch => ch.s.length >= Math.max(5, 0.3 * nS));
  if (!chains.length) return null;

  // Global tilt: median of robust (Theil-Sen) slopes, so a curled edge does not tip the whole page.
  const slopes = chains.map(ch => {
    const sl = [];
    for (let i = 0; i < ch.s.length; i++) for (let j = i + 1; j < ch.s.length; j++) sl.push((ch.c[j] - ch.c[i]) / (xc(ch.s[j]) - xc(ch.s[i])));
    return median(sl);
  });
  let theta = Math.max(-0.1, Math.min(0.1, median(slopes)));
  const cx = W / 2, cy = H / 2;

  // Smooth curve per chain at every strip centre (local linear fit), extrapolated a little at the ends.
  const sig = 1.5 * sw;
  for (const ch of chains) {
    ch.base = median(ch.c.map((c, i) => c - theta * (xc(ch.s[i]) - cx)));
    const D = new Float32Array(nS);
    const fit = x => {
      let sw0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < ch.s.length; i++) {
        const dx = xc(ch.s[i]) - x, wgt = Math.exp(-dx * dx / (2 * sig * sig));
        sw0 += wgt; sx += wgt * dx; sy += wgt * ch.c[i]; sxx += wgt * dx * dx; sxy += wgt * dx * ch.c[i];
      }
      const den = sw0 * sxx - sx * sx;
      const slope = Math.abs(den) > 1e-9 ? (sw0 * sxy - sx * sy) / den : 0;
      return { y: (sy - slope * sx) / sw0, slope };
    };
    const s0 = ch.s[0], s1 = ch.s[ch.s.length - 1];
    const e0 = fit(xc(s0)), e1 = fit(xc(s1));
    const maxExt = 0.12 * W;
    for (let s = 0; s < nS; s++) {
      let y;
      if (s < s0) y = e0.y + e0.slope * Math.max(-maxExt, xc(s) - xc(s0));
      else if (s > s1) y = e1.y + e1.slope * Math.min(maxExt, xc(s) - xc(s1));
      else y = fit(xc(s)).y;
      D[s] = y - (ch.base + theta * (xc(s) - cx));
    }
    ch.D = D;
  }
  chains.sort((a, b) => a.base - b.base);
  // Two chains on the same staff (a gap split it): keep the better covered one.
  chains = chains.filter((ch, i) => !chains.some((o, j) => j !== i && Math.abs(o.base - ch.base) < 2 * d &&
    (o.s.length > ch.s.length || (o.s.length === ch.s.length && j < i))));

  // Drop staves whose bending disagrees with both neighbours (mis-linked chains).
  if (chains.length >= 4) {
    chains = chains.filter((ch, i) => {
      if (i === 0 || i === chains.length - 1) return true;
      const A = chains[i - 1], B = chains[i + 1], w = (ch.base - A.base) / (B.base - A.base);
      let e = 0;
      for (let s = 0; s < nS; s++) e += Math.abs(ch.D[s] - (A.D[s] + (B.D[s] - A.D[s]) * w));
      return e / nS <= Math.max(1.5, 0.35 * d);
    });
  }

  const n = chains.length;
  let maxShift = 0;
  const bases = chains.map(c => c.base);
  // With a single staff there is nothing to interpolate between: straighten the tilt only.
  if (n < 2) for (const ch of chains) ch.D.fill(0);
  for (const ch of chains) for (const v of ch.D) maxShift = Math.max(maxShift, Math.abs(v));
  // Per strip: trend of the shift with height, to extend it above the first / below the last staff.
  const trend = new Float32Array(nS);
  if (n >= 2) {
    const mb = bases.reduce((a, b) => a + b, 0) / n;
    let vb = 0; for (const b of bases) vb += (b - mb) ** 2;
    for (let s = 0; s < nS; s++) {
      let md = 0; for (const ch of chains) md += ch.D[s]; md /= n;
      let cv = 0; for (let i = 0; i < n; i++) cv += (bases[i] - mb) * (chains[i].D[s] - md);
      trend[s] = vb > 0 ? Math.max(-0.12, Math.min(0.12, cv / vb)) : 0;
    }
  }
  const cos = Math.cos(Math.atan(theta)), sin = Math.sin(Math.atan(theta));
  const ext = 0.25 * H;
  const f = (x, y, p) => {
    const x1 = cx + (x - cx) * cos - (y - cy) * sin;
    const y1 = cy + (x - cx) * sin + (y - cy) * cos;
    let dy = 0;
    if (n >= 2) {
      const sp = Math.max(0, Math.min(nS - 1.001, x1 / sw - 0.5)), s0 = sp | 0, fs = sp - s0;
      const Dat = i => chains[i].D[s0] + (chains[i].D[s0 + 1] - chains[i].D[s0]) * fs;
      const yb = y1 - theta * (x1 - cx);
      if (yb <= bases[0]) dy = Dat(0) + (trend[s0] + (trend[s0 + 1] - trend[s0]) * fs) * Math.max(-ext, yb - bases[0]);
      else if (yb >= bases[n - 1]) dy = Dat(n - 1) + (trend[s0] + (trend[s0 + 1] - trend[s0]) * fs) * Math.min(ext, yb - bases[n - 1]);
      else {
        let i = 0;
        while (i < n - 2 && yb > bases[i + 1]) i++;
        const w = (yb - bases[i]) / (bases[i + 1] - bases[i]);
        dy = Dat(i) + (Dat(i + 1) - Dat(i)) * w;
      }
    }
    p[0] = x1; p[1] = y1 + dy;
  };
  return { f, theta, staves: n, maxShift, debug: () => chains.map(c => ({ base: +c.base.toFixed(1), s: c.s.join(','), c: c.c.map(v => v.toFixed(1)).join(','), D: Array.from(c.D, v => v.toFixed(1)).join(',') })) };
}

// How well ink lines up in horizontal rows, measured in narrow vertical bands: straight, level staff
// lines score high; bent or tilted ones are smeared over more rows and score lower.
function lineEnergy(mask, W, H) {
  const bands = 12, bw = Math.floor(W / bands), proj = new Float64Array(H);
  let E = 0, tot = 0;
  for (let b = 0; b < bands; b++) {
    proj.fill(0);
    for (let y = 0; y < H; y++) {
      let c = 0;
      for (let x = b * bw, r = y * W, e = x + bw; x < e; x++) c += mask[r + x];
      proj[y] = c;
    }
    for (let y = 0; y < H; y++) { E += proj[y] * proj[y]; tot += proj[y]; }
  }
  return tot ? E / tot / bw : 0;
}

// A correction must never fold the page over itself: page coordinates have to keep increasing
// along every row and column of the output.
function monotonic(map, w, h) {
  const n = 48, p = [0, 0];
  const X = new Float64Array((n + 1) * (n + 1)), Y = new Float64Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { map(w * i / n, h * j / n, p); X[j * (n + 1) + i] = p[0]; Y[j * (n + 1) + i] = p[1]; }
  const mx = w / n * 0.3, my = h / n * 0.3;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const k = j * (n + 1) + i;
    if (i < n && X[k + 1] - X[k] < mx) return false;
    if (j < n && Y[k + n + 1] - Y[k] < my) return false;
  }
  return true;
}

// Works out how to flatten a bent page and level a tilted one, using the staff lines. Returns a map
// (output pixel -> page coordinates) or null when the page is fine as it is (or not sheet music).
// Each candidate correction is checked: it is only used if staff lines really come out straighter.
function flattenMap(srcGray, SW, SH, hm, w, h, info) {
  const r = Math.min(1, ANALYSIS / Math.max(w, h));
  const aw = Math.round(w * r), ah = Math.round(h * r);
  const analyse = map => inkMask(render(srcGray, SW, SH, 1, hm, w, h, aw, ah, (x, y, p) => map(x / r, y / r, p), false), aw, ah);
  let mask = analyse(identityMap);
  const metrics = staffMetrics(mask, aw, ah);
  if (!metrics) { info.flatten = 'no staff lines'; return null; }
  let map = identityMap, best = null, bestE = lineEnergy(mask, aw, ah);
  info.energy = [+bestE.toFixed(4)];
  info.passes = [];
  for (let pass = 0; pass < 3; pass++) {
    const model = staffModel(mask, aw, ah, metrics);
    if (!model) break;
    if (info.debug) info.debug.push(model.debug());
    info.passes.push({ theta: +(model.theta * 180 / Math.PI).toFixed(2), staves: model.staves, maxShift: +(model.maxShift / r).toFixed(1) });
    if (Math.abs(model.theta) < 0.0004 && model.maxShift < 0.35) break; // already flat and level
    const prev = map;
    const next = (u, v, p) => { model.f(u * r, v * r, p); prev(p[0] / r, p[1] / r, p); };
    if (!monotonic(next, w, h)) { info.passes[info.passes.length - 1].rejected = 'folds'; break; }
    map = next;
    mask = analyse(map);
    const E = lineEnergy(mask, aw, ah);
    info.energy.push(+E.toFixed(4));
    if (E > bestE * 1.002) { bestE = E; best = map; } else break;
  }
  info.flatten = best ? 'applied' : 'not needed';
  return best;
}

// ---------- Clean black & white ----------

// Separable [1 2 1]/4 blur, in place, applied twice (≈ Gaussian, sigma 1 px).
function blur121(a, W, H) {
  const prev = new Float32Array(W), cur = new Float32Array(W);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      const r = y * W;
      let l = a[r];
      for (let x = 0; x < W; x++) {
        const c = a[r + x], rt = x < W - 1 ? a[r + x + 1] : c;
        a[r + x] = (l + 2 * c + rt) * 0.25; l = c;
      }
    }
    prev.set(a.subarray(0, W));
    for (let y = 0; y < H; y++) {
      const r = y * W;
      cur.set(a.subarray(r, r + W));
      const nx = y < H - 1 ? r + W : r;
      for (let x = 0; x < W; x++) a[r + x] = (prev[x] + 2 * cur[x] + a[nx + x]) * 0.25;
      prev.set(cur);
    }
  }
}

// "Scanner" look on a grey page: shadows and uneven light removed, paper pure white, ink black, thin
// lines kept solid, edges kept smooth (grey anti-aliasing, no jaggies), stray specks removed.
// Returns a new Uint8ClampedArray.
function cleanGray(gray, W, H) {
  const N = W * H;
  const level = paperLevel(gray, W, H);
  const n = new Float32Array(N), row = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    level(y, row);
    for (let x = 0, i = y * W; x < W; x++, i++) n[i] = gray[i] / row[x];
  }
  // Unsharp mask: restore the crispness lost to the camera and resampling.
  const bl = n.slice();
  blur121(bl, W, H);
  const AMT = 0.8;
  const hist = new Uint32Array(1024); // n in [0, 1.5)
  for (let i = 0; i < N; i++) {
    const v = n[i] + AMT * (n[i] - bl[i]);
    n[i] = v;
    const k = v <= 0 ? 0 : v >= 1.4999 ? 1023 : (v * 682.6) | 0;
    hist[k]++;
  }
  // Levels from the page itself: white point just below the paper's noise, black point near the ink.
  const binV = k => (k + 0.5) / 682.6;
  let paperPeak = 0;
  for (let k = Math.round(0.8 * 682.6); k < 1023; k++) if (hist[k] > hist[paperPeak]) paperPeak = k;
  // Spread of the paper below its peak (the side the ink sits on).
  let below = 0, total = 0;
  for (let k = Math.round(0.6 * 682.6); k < 1024; k++) total += hist[k];
  let lowerQ = paperPeak;
  for (let k = paperPeak; k >= 0; k--) { below += hist[k]; if (below >= total * 0.12) { lowerQ = k; break; } }
  const pv = binV(paperPeak);
  const sigma = Math.max(0.01, (pv - binV(lowerQ)) / 1.2);
  const hi = Math.max(0.72, Math.min(0.93, pv - 3 * sigma));
  let inkN = 0, inkAcc = 0, inkMed = 0.25;
  for (let k = 0; k < Math.round(0.55 * 682.6); k++) inkN += hist[k];
  if (inkN > N * 0.002) {
    for (let k = 0; k < 1024; k++) { inkAcc += hist[k]; if (inkAcc >= inkN / 2) { inkMed = binV(k); break; } }
  }
  const lo = Math.min(hi - 0.25, Math.max(0.12, inkMed + 0.12));
  const GAMMA = 1.6;
  const lut = new Uint8ClampedArray(1024);
  for (let k = 0; k < 1024; k++) {
    const v = (binV(k) - lo) / (hi - lo);
    lut[k] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(255 * Math.pow(v, GAMMA));
  }
  const out = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) {
    const v = n[i];
    out[i] = lut[v <= 0 ? 0 : v >= 1.4999 ? 1023 : (v * 682.6) | 0];
  }
  // Speckle removal: tiny (or faint, small) islands of non-white are dust, paper texture or noise.
  // Dark slivers hugging the page edge (table, shadow, the next page) go as well.
  const k2 = (W / 2100) ** 2;
  const aSmall = Math.max(3, Math.round(6 * k2)), aFaint = Math.max(10, Math.round(40 * k2));
  const seen = new Uint8Array(n.buffer, 0, N); seen.fill(0);
  const queue = new Int32Array(bl.buffer, 0, N);
  for (let s = 0; s < N; s++) {
    if (seen[s] || out[s] >= 250) continue;
    let head = 0, tail = 0, minV = 255, x0 = W, x1 = 0, y0 = H, y1 = 0;
    queue[tail++] = s; seen[s] = 1;
    while (head < tail) {
      const p = queue[head++];
      if (out[p] < minV) minV = out[p];
      const x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (!seen[q] && out[q] < 250) { seen[q] = 1; queue[tail++] = q; }
        }
      }
    }
    const mx = W * 0.03, my = H * 0.03;
    const edge = (y0 === 0 && y1 < my) || (y1 === H - 1 && y0 > H - 1 - my) || (x0 === 0 && x1 < mx) || (x1 === W - 1 && x0 > W - 1 - mx)
      || y1 < my / 2 || y0 > H - 1 - my / 2 || x1 < mx / 2 || x0 > W - 1 - mx / 2; // nothing real sits that close to the edge
    if (minV >= 200 || tail <= aSmall || (tail <= aFaint && minV > 120) || edge) {
      for (let i = 0; i < tail; i++) out[queue[i]] = 255;
    }
  }
  return out;
}

// =====================================================================================
// Page pipeline
// =====================================================================================

// Flatten (perspective + page curl + tilt) a photo region into an upright page.
// mode 'clean' / 'vector' -> black & white scan look, anything else -> original colours.
// Returns { data (RGBA), width, height, info }. Yields to the UI between the heavy steps.
export async function processPage(img, quad, mode = 'clean', opts = {}) {
  const T0 = performance.now();
  const { data, width: SW, height: SH } = img;
  const { w, h } = pageShape(quad, SW, SH);
  const hm = homography(w, h, quad);
  const info = { width: w, height: h, debug: opts.debug ? [] : undefined };
  const srcGray = toGray(img);
  await tick();
  const map = opts.flatten === false ? null : flattenMap(srcGray, SW, SH, hm, w, h, info);
  info.tFlatten = Math.round(performance.now() - T0);
  await tick();
  let out, gray = null;
  if (mode === 'clean' || mode === 'vector') {
    const g = render(srcGray, SW, SH, 1, hm, w, h, w, h, map || identityMap, true);
    info.tRender = Math.round(performance.now() - T0);
    await tick();
    const c = cleanGray(g, w, h);
    gray = c;
    out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, o = 0; i < c.length; i++, o += 4) { out[o] = out[o + 1] = out[o + 2] = c[i]; out[o + 3] = 255; }
  } else {
    out = render(data, SW, SH, 4, hm, w, h, w, h, map || identityMap, true);
  }
  info.tTotal = Math.round(performance.now() - T0);
  return { data: out, gray, width: w, height: h, info };
}

// Straighten the quad into a flat page (perspective, true proportions, and page curl / tilt when staff
// lines are found). Returns { data (RGBA), width, height }.
export function warp(img, quad, { flatten = true } = {}) {
  const { width: SW, height: SH } = img;
  const { w, h } = pageShape(quad, SW, SH);
  const hm = homography(w, h, quad);
  const map = flatten ? flattenMap(toGray(img), SW, SH, hm, w, h, {}) : null;
  return { data: render(img.data, SW, SH, 4, hm, w, h, w, h, map || identityMap, true), width: w, height: h };
}

// "Scanner" look: remove shadows/uneven light, make paper pure white and ink black. In place.
export function enhance(img) {
  const { data, width: W, height: H } = img;
  const c = cleanGray(toGray(img), W, H);
  for (let i = 0, o = 0; i < c.length; i++, o += 4) data[o] = data[o + 1] = data[o + 2] = c[i];
  return img;
}

// =====================================================================================
// Minimal PDF writer, A4 width: per page either traced vector outlines (clean scans) or a JPEG (colour).
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
    if (p.vector) { // traced outlines: crisp at any zoom, like a real PDF
      obj(pageObj(i), () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << >> /Contents ${contentObj(i)} 0 R >>`));
      obj(contentObj(i), () => {
        push(`<< /Length ${p.vector.bytes.length}${p.vector.compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
        push(p.vector.bytes);
        push('\nendstream');
      });
      obj(imageObj(i), () => push('null'));
      return;
    }
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

export function startScan(onDone, files = []) {
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
    else if (act === 'mode') {
      S.edit.mode = MODES[(MODES.indexOf(S.edit.mode) + 1) % MODES.length];
      try { localStorage.setItem('scanMode2', S.edit.mode); } catch {}
      syncMode();
    }
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
  // Photos chosen with Import (e.g. pictures sent to the phone) go straight to corner adjustment.
  if (files.length) { S.queue.push(...files); nextInQueue(); }
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
    openEditor({ canvas, quad: autoQuad(canvas), mode: lastMode(), source: file, rotation: 0, index: -1 });
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

// Page look, chosen per page with the mode button (the last choice is remembered for the next scan):
//   vector - the cleaned page traced into vector outlines: razor sharp at any zoom, like a printed PDF (default)
//   clean  - cleaned black & white photo
//   color  - the original photo colours, just straightened
const MODES = ['vector', 'clean', 'color'];
const MODE_LABEL = { clean: 'Clean B&W', vector: 'Sharp (traced)', color: 'Original colour' };
const MODE_ICON = { clean: 'file-music', vector: 'scan-line', color: 'image' };
function lastMode() {
  try { const m = localStorage.getItem('scanMode2'); if (MODES.includes(m)) return m; } catch {}
  return 'vector';
}

function syncMode() {
  const b = S.root.querySelector('[data-act=mode]');
  const m = MODES.includes(S.edit.mode) ? S.edit.mode : 'vector';
  b.setAttribute('aria-pressed', String(m !== 'color'));
  b.innerHTML = `${icon(MODE_ICON[m])}<span>${MODE_LABEL[m]}</span>`;
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
    const flat = await processPage(ctx.getImageData(0, 0, e.canvas.width, e.canvas.height), e.quad, e.mode);
    const out = document.createElement('canvas');
    out.width = flat.width; out.height = flat.height;
    out.getContext('2d').putImageData(new ImageData(flat.data, flat.width, flat.height), 0, 0);
    const jpeg = await toBlob(out, e.mode === 'color' ? 0.85 : 0.8);
    free(out);
    // 'Sharp (traced)' pages are saved as vector outlines (the JPEG stays as the preview / fallback).
    let vector = null;
    if (e.mode === 'vector' && flat.gray) {
      try { vector = await vectorPageContent(flat.gray, flat.width, flat.height); }
      catch (err) { console.warn('Vector trace failed, keeping the image', err); }
    }
    const page = {
      source: e.source, rotation: e.rotation, quad: e.quad, mode: e.mode,
      jpeg, vector, width: flat.width, height: flat.height, thumbUrl: URL.createObjectURL(jpeg),
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
  for (const p of S.pages) {
    pages.push(p.vector ? { vector: p.vector, width: p.width, height: p.height }
      : { jpeg: new Uint8Array(await p.jpeg.arrayBuffer()), width: p.width, height: p.height });
  }
  const pdf = makePdf(pages);
  const onDone = S.onDone;
  close();
  onDone(pdf.buffer, title);
}
