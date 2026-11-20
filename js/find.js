// Find in music: the words on each page of a PDF (its own text, or OCR for scans), the songs inside
// a big PDF (its bookmarks, or the big titles at the top of pages), and searching both.
import * as db from './db.js';
import { textItems, ocrItems, pageText } from './detect.js';

export const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Make sure song.text covers every page. Text PDFs are quick; scanned pages need OCR (a few
// seconds each), so progress is reported and saved as it goes. Returns false if cancelled.
export async function ensureText(song, pdf, { onProgress = () => {}, cancelled = () => false } = {}) {
  const n = pdf.numPages;
  if (!song.text || song.text.v !== 1 || song.text.pages.length !== n) {
    // Older songs: read the PDF's own text first.
    const items = [];
    for (let p = 0; p < n; p++) items.push(...await textItems(pdf, p));
    const hasText = items.filter(i => i.page === 0).length >= 3;
    song.text = pageText(items, n, hasText ? n : 0);
    await db.put('songs', song);
  }
  const t = song.text;
  let lastSave = Date.now();
  while (t.read < n) {
    if (cancelled()) return false;
    onProgress(t.read, n);
    let items = [];
    try { items = await ocrItems(pdf, t.read); }
    catch (e) { console.warn('OCR failed', e); onProgress(-1, n); return false; }
    t.pages[t.read] = pageText(items.map(i => ({ ...i, page: 0 })), 1).pages[0];
    t.read++;
    if (Date.now() - lastSave > 3000 || t.read === n) { lastSave = Date.now(); await db.put('songs', song); }
  }
  onProgress(n, n);
  return true;
}

// Lines matching the search, in page order: [{ page, y, line }].
export function search(text, query, limit = 200) {
  const q = norm(query.trim());
  const out = [];
  if (!q || !text) return out;
  text.pages.forEach((lines, page) => {
    for (const [line, y] of lines) {
      if (norm(line).includes(q)) { out.push({ page, y, line }); if (out.length >= limit) return; }
    }
  });
  return out;
}

// Does any page contain the search? (library search) -> first match or null
const joined = new WeakMap();
export function firstMatch(song, q) {
  if (!song.text || !q) return null;
  let j = joined.get(song.text);
  if (!j) { j = norm(song.text.pages.map(l => l.map(x => x[0]).join('\n')).join('\f')); joined.set(song.text, j); }
  if (!j.includes(q)) return null;
  return search(song.text, q, 1)[0] || null;
}

// Song titles printed in the PDF: on each page, a line in the top part that is much bigger than
// the other text there. Running headers (the same title on every page) are only listed once.
export function titles(text) {
  if (!text) return [];
  const out = [];
  let prev = '';
  text.pages.forEach((lines, page) => {
    if (lines.length < 2) return;
    const hs = lines.map(l => l[2]).sort((a, b) => a - b);
    const med = hs[Math.floor(hs.length / 2)];
    let best = null;
    for (const [line, y, h] of lines) {
      if (y > 0.35 || h < med * 1.5 || h < 0.012) continue;
      if ((line.match(/\p{L}/gu) || []).length < 3 || /[=♩]|^\d+$/.test(line)) continue;
      if (!best || h > best.h) best = { page, y, h, title: line };
    }
    if (best && norm(best.title) !== prev) out.push(best);
    if (best) prev = norm(best.title);
  });
  return out;
}

// The PDF's bookmarks (table of contents), flattened two levels deep: [{ title, page }].
export async function outline(pdf) {
  let items;
  try { items = await pdf.getOutline(); } catch { return []; }
  const out = [];
  const add = async (list, depth) => {
    for (const it of list || []) {
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const page = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
          out.push({ title: it.title, page, depth });
        }
      } catch {}
      if (depth < 1) await add(it.items, depth + 1);
    }
  };
  await add(items, 0);
  return out;
}
