// Turns a cleaned scan (grey, white paper, black ink) into smooth vector outlines, so a photographed
// page prints and zooms like a real PDF: crisp edges at any size, no pixels, no grey haze.
//
// How: the outline of the ink is found with sub-pixel precision (iso-contour of the anti-aliased
// image, "marching squares"), which keeps thin staff lines and stems intact where a plain
// black/white trace would break them. The outlines are then simplified to within a third of a pixel
// and drawn as fine polygons, so real corners (stems, beams, barlines) stay sharp.

// Light smoothing of the grey image before tracing: removes camera grain on the ink edges.
function smooth(gray, W, H) {
  const a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = gray[i];
  const tmp = new Float32Array(Math.max(W, H));
  for (let y = 0; y < H; y++) { // horizontal [1 2 1]
    const r = y * W;
    for (let x = 0; x < W; x++) tmp[x] = a[r + x];
    for (let x = 0; x < W; x++) a[r + x] = (tmp[x > 0 ? x - 1 : x] + 2 * tmp[x] + tmp[x < W - 1 ? x + 1 : x]) * 0.25;
  }
  for (let x = 0; x < W; x++) { // vertical [1 2 1]
    for (let y = 0; y < H; y++) tmp[y] = a[y * W + x];
    for (let y = 0; y < H; y++) a[y * W + x] = (tmp[y > 0 ? y - 1 : y] + 2 * tmp[y] + tmp[y < H - 1 ? y + 1 : y]) * 0.25;
  }
  return a;
}

// Closed outlines of the ink (value < level) as arrays of [x0, y0, x1, y1, ...] in pixel units.
export function traceContours(gray, W, H, { level = 128, blur = false } = {}) {
  const src = blur ? smooth(gray, W, H) : gray;
  // Pad with one pixel of paper all round so every outline closes.
  const PW = W + 2, PH = H + 2;
  const v = new Float32Array(PW * PH).fill(255);
  for (let y = 0; y < H; y++) v.set(src.subarray ? src.subarray(y * W, y * W + W) : Array.prototype.slice.call(src, y * W, y * W + W), (y + 1) * PW + 1);

  // Edge ids: horizontal edge from grid point (x,y) to (x+1,y) = 2*(y*PW+x); vertical (x,y)-(x,y+1) = +1.
  const next = new Int32Array(PW * PH * 2).fill(-1);
  const hE = (x, y) => 2 * (y * PW + x), vE = (x, y) => 2 * (y * PW + x) + 1;
  const inside = i => v[i] < level;
  const pt = e => { // sub-pixel crossing point of an edge
    const g = e >> 1, x = g % PW, y = (g - x) / PW;
    const a = v[g], b = (e & 1) ? v[g + PW] : v[g + 1];
    const t = Math.min(1, Math.max(0, (level - a) / (b - a)));
    return (e & 1) ? [x, y + t] : [x + t, y];
  };
  // Link e1 -> e2 so that the ink is always on the same side (consistent winding). The side is
  // decided on the cell's fixed geometry (edge midpoints), never on the interpolated points, which
  // can coincide with a corner and give no answer.
  const mpt = (e, x, y) => {
    const g = e >> 1, ex = g % PW, ey = (g - ex) / PW;
    return (e & 1) ? [ex - x, ey - y + 0.5] : [ex - x + 0.5, ey - y];
  };
  let cellX = 0, cellY = 0;
  const link = (e1, e2, cx, cy, cornerInside) => {
    const [x1, y1] = mpt(e1, cellX, cellY), [x2, y2] = mpt(e2, cellX, cellY);
    const cross = (x2 - x1) * (cy - cellY - y1) - (y2 - y1) * (cx - cellX - x1);
    if ((cross > 0) === cornerInside) next[e1] = e2; else next[e2] = e1;
  };

  for (let y = 0; y < PH - 1; y++) {
    for (let x = 0; x < PW - 1; x++) {
      const i = y * PW + x;
      cellX = x; cellY = y;
      const tl = inside(i), tr = inside(i + 1), br = inside(i + PW + 1), bl = inside(i + PW);
      const c = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (c === 0 || c === 15) continue;
      const T = hE(x, y), B = hE(x, y + 1), L = vE(x, y), R = vE(x + 1, y);
      switch (c) {
        case 8: case 7: link(L, T, x, y, tl); break;               // TL corner cut off
        case 4: case 11: link(T, R, x + 1, y, tr); break;          // TR
        case 2: case 13: link(R, B, x + 1, y + 1, br); break;      // BR
        case 1: case 14: link(B, L, x, y + 1, bl); break;          // BL
        case 12: case 3: link(L, R, x, y, tl); break;              // top / bottom halves
        case 9: case 6: link(T, B, x, y, tl); break;               // left / right halves
        case 10: case 5: { // saddle: decide by the centre
          const centre = (v[i] + v[i + 1] + v[i + PW] + v[i + PW + 1]) / 4 < level;
          if (centre === tl) { // the two corners that differ from the centre are cut off
            link(T, R, x + 1, y, tr); link(B, L, x, y + 1, bl);
          } else {
            link(L, T, x, y, tl); link(R, B, x + 1, y + 1, br);
          }
          break;
        }
      }
    }
  }

  const contours = [];
  let broken = 0;
  for (let e = 0; e < next.length; e++) {
    if (next[e] < 0) continue;
    const pts = [];
    let cur = e, guard = 0;
    let closed = false;
    while (cur >= 0 && guard++ < 4e6) {
      const [px, py] = pt(cur);
      pts.push(px - 0.5, py - 0.5); // back to image pixel coordinates (pixel centres at +0.5)
      const n = next[cur]; next[cur] = -1; cur = n;
      if (cur === e) { closed = true; break; }
    }
    if (!closed) broken++;
    if (closed && pts.length >= 6) contours.push(pts);
  }
  contours.broken = broken;
  return contours;
}

// Signed area of a closed outline (pixels²).
function area(p) {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return s / 2;
}

// Douglas-Peucker on a closed outline: drop points closer than `tol` px to the simplified line.
function simplify(p, tol) {
  const n = p.length / 2;
  if (n < 8) return p;
  // Split the loop at its first point and the point farthest from it.
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const tol2 = tol * tol;
  const stack = [0, far, far, n];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    if (b - a < 2) continue;
    const ax = p[2 * a], ay = p[2 * a + 1], bi = b % n, bx = p[2 * bi], by = p[2 * bi + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = p[2 * i] - ax, py = p[2 * i + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol2) { keep[wi] = 1; stack.push(a, wi, wi, b); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

const fmt = v => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

// PDF path operators for one outline. The sub-pixel outline, simplified to within a third of a pixel,
// is already smooth to the eye at any zoom, so it is drawn as straight segments: no curve fitting
// that could round off the sharp junctions of stems, staff lines and beams.
function pathOps(p, out) {
  const n = p.length / 2;
  if (n < 3) return;
  out.push(`${fmt(p[0])} ${fmt(p[1])} m`);
  for (let i = 1; i < n; i++) out.push(`${fmt(p[2 * i])} ${fmt(p[2 * i + 1])} l`);
  out.push('h');
}

// Vector page from a cleaned grey scan. Returns { ops: string (PDF content in pixel units), paths }.
// Tiny islands (dust) are dropped; holes (open noteheads, letters) come out right via even-odd fill.
export function vectorizePage(gray, W, H, opts = {}) {
  const contours = traceContours(gray, W, H, opts);
  const minArea = Math.max(2, (W / 2100) ** 2 * 3);
  const ops = [];
  let paths = 0;
  for (const c of contours) {
    if (Math.abs(area(c)) < minArea) continue;
    pathOps(simplify(c, opts.tolerance ?? 0.3), ops);
    paths++;
  }
  ops.push('f*');
  return { ops: ops.join('\n'), paths, broken: contours.broken };
}

// Compress a PDF content stream (zlib, /FlateDecode). Falls back to uncompressed where unsupported.
export async function deflate(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') return { bytes, compressed: false };
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), compressed: true };
}

// Complete PDF page content for a cleaned scan, A4 width (595.28 pt), black ink. Returns
// { bytes, compressed, paths } ready for makePdf's `vector` page field.
export async function vectorPageContent(gray, W, H, opts) {
  const { ops, paths, broken } = vectorizePage(gray, W, H, opts);
  const s = 595.28 / W, ph = 595.28 * H / W;
  // Pixel coordinates (y down) -> PDF points (y up).
  const text = `q ${s.toFixed(6)} 0 0 ${(-s).toFixed(6)} 0 ${ph.toFixed(2)} cm 0 g\n${ops}\nQ`;
  return { ...(await deflate(text)), paths, broken };
}
