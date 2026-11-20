// Reads a sheet-music PDF and works out what auto-scroll needs:
//   - tempo (e.g. "♩ = 120", or a word like "Allegro")
//   - time signature (e.g. 3/4)
//   - where each system starts, from the printed bar numbers, so the scroll can follow the music
//
// Step 1: use the PDF's built-in text (PDFs exported from MuseScore, Sibelius, Finale, Dorico... have it).
// Step 2: if a page has no text (a scan or a photo), use OCR (Tesseract) to read it.
import { renderPageToCanvas } from './pdf.js';

// ---------- Tempo ----------

const NOTE_GLYPHS = [
  // [characters, length in quarter notes]
  ['♩\u{1D15F}q', 1],   // quarter
  ['\u{1D15E}h', 2],         // half
  ['♪\u{1D160}e', 0.5], // eighth
  ['\u{1D15D}w', 4],                     // whole
];
const DOT_GLYPHS = '.·';

const TEMPO_WORDS = [
  // Compound terms first so "Allegro moderato" doesn't match plain "Allegro".
  ['allegro vivace', 150], ['allegro moderato', 116], ['allegro ma non troppo', 120],
  ['prestissimo', 200], ['presto', 176], ['vivacissimo', 172], ['vivace', 160], ['allegro', 132], ['allegretto', 112], ['moderato', 108], ['andantino', 84],
  ['andante', 76], ['adagietto', 72], ['adagio', 66], ['larghetto', 63], ['lento', 52], ['largo', 50], ['grave', 40],
  ['very fast', 176], ['fast', 144], ['brightly', 140], ['lively', 140], ['moderately', 108], ['moderate', 108],
  ['walking', 92], ['slowly', 66], ['very slow', 50], ['slow', 66],
];

function noteValueBefore(text) {
  // Look at the few characters right before "=" to find the note symbol (and a dot after it).
  const chars = Array.from(text.replace(/\s+/g, '')).slice(-3);
  let unit = null, dotted = false;
  for (const ch of chars) {
    if (DOT_GLYPHS.includes(ch) && unit) { dotted = true; continue; }
    for (const [set, len] of NOTE_GLYPHS) if (set.includes(ch)) { unit = len; dotted = false; }
  }
  if (!unit) return 1;
  return dotted ? unit * 1.5 : unit;
}

function findTempo(lines) {
  const markRe = /=\s*(?:c\.|ca\.?|circa|~)?\s*(\d{2,3})\b/i;
  const bpmRe = /(?:\b(\d{2,3})\s*bpm\b)|(?:\bbpm\s*[:=]?\s*(\d{2,3})\b)|(?:\bM\.?\s?M\.?\s*[:=]?\s*(\d{2,3})\b)/i;
  for (const line of lines) {
    const m = line.text.match(markRe);
    if (m) {
      const bpm = +m[1];
      if (bpm >= 30 && bpm <= 300) {
        return { bpm, tempoUnit: noteValueBefore(line.text.slice(0, m.index)), tempoSource: 'marking',
                 tempoText: line.text.trim(), page: line.page, y: line.y };
      }
    }
    const b = line.text.match(bpmRe);
    if (b) {
      const bpm = +(b[1] || b[2] || b[3]);
      if (bpm >= 30 && bpm <= 300) {
        return { bpm, tempoUnit: 1, tempoSource: 'marking', tempoText: line.text.trim(), page: line.page, y: line.y };
      }
    }
  }
  // No number: fall back to a tempo word near the top of the first page.
  for (const line of lines) {
    if (line.page !== 0 || line.y > 0.5) continue;
    const t = line.text.toLowerCase();
    for (const [word, bpm] of TEMPO_WORDS) {
      if (new RegExp(`\\b${word}\\b`).test(t)) {
        return { bpm, tempoUnit: 1, tempoSource: 'word', tempoText: line.text.trim(), page: line.page, y: line.y };
      }
    }
  }
  return null;
}

// ---------- Time signature ----------

const TS_DIGITS = ''; // SMuFL timeSig0..9

function findTimeSig(items) {
  const firstPage = items.filter(i => i.page === 0);
  for (const it of firstPage) {
    if (/[\u{1D134}]/u.test(it.str)) return { beatsPerBar: 4, beatUnit: 4 };
    if (/[\u{1D135}]/u.test(it.str)) return { beatsPerBar: 2, beatUnit: 2 };
  }
  // Stacked time-signature digits: same x, numerator above denominator.
  const atoms = [];
  for (const it of firstPage) {
    const digits = Array.from(it.str).filter(c => TS_DIGITS.includes(c)).map(c => TS_DIGITS.indexOf(c));
    if (digits.length) atoms.push({ x: it.x, y: it.y, value: +digits.join('') });
  }
  atoms.sort((a, b) => a.y - b.y || a.x - b.x);
  const pair = stackedPair(atoms);
  if (pair) return pair;

  // Some notation fonts draw time signatures as ordinary digits: look for two stacked numbers
  // near the left of the first page (e.g. "3" directly above "4").
  const plain = firstPage
    .filter(it => /^\d{1,2}$/.test(it.str.trim()) && it.x < 0.35 && it.y < 0.6)
    .map(it => ({ x: it.x, y: it.y, value: +it.str.trim(), item: it }));
  return stackedPair(plain);
}

function stackedPair(atoms) {
  atoms.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const top of atoms) {
    const bottom = atoms.find(b => b !== top && Math.abs(b.x - top.x) < 0.015 && b.y > top.y && b.y - top.y < 0.04);
    if (bottom && [1, 2, 4, 8, 16, 32].includes(bottom.value) && top.value >= 1 && top.value <= 32) {
      // Mark these so they are not mistaken for bar numbers later.
      if (top.item) top.item.isTimeSig = bottom.item.isTimeSig = true;
      return { beatsPerBar: top.value, beatUnit: bottom.value };
    }
  }
  return null;
}

// ---------- Bar numbers -> system positions ----------

function groupLines(items) {
  const byPage = new Map();
  for (const it of items) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it);
  }
  const lines = [];
  for (const [page, list] of [...byPage].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.y - b.y);
    let current = null;
    for (const it of list) {
      const tol = Math.max(0.006, (it.h || 0) * 0.6);
      if (current && Math.abs(it.y - current.y) <= tol) current.items.push(it);
      else { current = { page, y: it.y, items: [it] }; lines.push(current); }
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map(i => i.str).join(' ');
  }
  return lines;
}

const median = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function findBarMarks(lines, pageCount, tempo) {
  const candidates = [];
  for (const line of lines) {
    if (line.y < 0.04 || line.y > 0.96) continue; // page headers / footers / page numbers
    if (tempo && line.page === tempo.page && Math.abs(line.y - tempo.y) < 0.01) continue;
    const nums = line.items.filter(i => !i.isTimeSig && /^\d{1,3}$/.test(i.str.trim()) && i.x < 0.3);
    if (!nums.length) continue;
    const leftmost = nums[0];
    const bar = +leftmost.str.trim();
    if (bar < 2) continue;
    candidates.push({ bar, page: line.page, y: leftmost.y - (leftmost.h || 0.01) });
  }
  // Keep the longest chain of increasing bar numbers (filters out fingerings, tuplets, etc.).
  const n = candidates.length;
  const len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const d = candidates[i].bar - candidates[j].bar;
      if (d >= 1 && d <= 40 && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
  }
  let best = -1;
  for (let i = 0; i < n; i++) if (best < 0 || len[i] > len[best]) best = i;
  const marks = [];
  for (let i = best; i >= 0; i = prev[i]) marks.unshift(candidates[i]);
  if (marks.length < 2) return { marks: [], totalBars: null };

  const barsPerSystem = median(marks.slice(1).map((m, i) => m.bar - marks[i].bar)) || 4;
  const spacing = median(marks.slice(1)
    .map((m, i) => (m.page === marks[i].page ? m.y - marks[i].y : null))
    .filter(v => v && v > 0.03)) || 0.12;

  // Bar 1 is normally not numbered: put it one system above the first number.
  const first = marks[0];
  if (first.bar > 1) {
    let y = first.y - spacing, page = first.page;
    if (y < 0.04) { if (page > 0) { page -= 1; y = 0.85; } else y = 0.04; }
    marks.unshift({ bar: 1, page, y });
  }
  const last = marks[marks.length - 1];
  const totalBars = Math.round(last.bar + barsPerSystem - 1);
  return { marks, totalBars, endMark: { page: last.page, y: Math.min(0.97, last.y + spacing) } };
}

// ---------- Text extraction ----------

async function textItems(pdf, pageIndex) {
  const page = await pdf.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const out = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const [x, y] = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
    const h = Math.hypot(item.transform[2], item.transform[3]);
    out.push({ str: item.str, page: pageIndex, x: x / vp.width, y: y / vp.height, h: h / vp.height });
  }
  return out;
}

// ---------- OCR (only loaded when needed) ----------

let tesseractWorker;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

async function getOcrWorker() {
  if (tesseractWorker) return tesseractWorker;
  const base = new URL('../vendor/tesseract/', import.meta.url).href;
  if (!window.Tesseract) await loadScript(base + 'tesseract.min.js');
  tesseractWorker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'core',
    langPath: base + 'lang',
    workerBlobURL: false,
  });
  await tesseractWorker.setParameters({ tessedit_pageseg_mode: '11' }); // sparse text: good for scores
  return tesseractWorker;
}

async function ocrItems(pdf, pageIndex) {
  const worker = await getOcrWorker();
  const canvas = await renderPageToCanvas(pdf, pageIndex + 1, 1800, 1);
  const W = canvas.width, H = canvas.height;
  const { data } = await worker.recognize(canvas);
  canvas.width = canvas.height = 0;
  const out = [];
  for (const w of data.words || []) {
    const str = (w.text || '').trim();
    if (!str || w.confidence < 40) continue;
    out.push({ str, page: pageIndex, x: w.bbox.x0 / W, y: w.bbox.y1 / H, h: (w.bbox.y1 - w.bbox.y0) / H });
  }
  return out;
}

// ---------- Main ----------

export async function analyzePdf(pdf, onProgress = () => {}) {
  const pageCount = pdf.numPages;
  let items = [];
  let method = 'text';
  for (let p = 0; p < pageCount; p++) {
    onProgress(`Reading page ${p + 1} of ${pageCount}…`);
    items.push(...await textItems(pdf, p));
  }

  const hasText = items.filter(i => i.page === 0).length >= 3;
  let notes = [];
  if (!hasText) {
    method = 'ocr';
    items = [];
    const limit = Math.min(pageCount, 20);
    try {
      for (let p = 0; p < limit; p++) {
        onProgress(`Scanned PDF – OCR page ${p + 1} of ${limit}…`);
        items.push(...await ocrItems(pdf, p));
      }
    } catch (e) {
      console.warn('OCR failed', e);
      notes.push('OCR could not run (it needs internet the first time).');
      method = 'none';
    }
  }

  let lines = groupLines(items);
  let tempo = findTempo(lines);

  // Text PDF but no tempo number found? The marking may be drawn as graphics – try OCR on page 1.
  if (hasText && (!tempo || tempo.tempoSource === 'word')) {
    try {
      onProgress('Looking for the tempo marking (OCR)…');
      const ocrLines = groupLines(await ocrItems(pdf, 0));
      const t = findTempo(ocrLines);
      if (t && (!tempo || t.tempoSource === 'marking')) { tempo = t; method = 'text+ocr'; }
    } catch (e) { console.warn('OCR for tempo failed', e); }
  }

  const timeSig = findTimeSig(items);
  const bars = findBarMarks(lines, pageCount, tempo);

  if (!tempo) notes.push('No tempo found – set the BPM yourself.');
  if (!timeSig) notes.push('Time signature assumed 4/4.');
  if (!bars.marks.length) notes.push('No bar numbers found – enter the number of bars for an even scroll.');

  return {
    method,
    bpm: tempo ? tempo.bpm : null,
    tempoUnit: tempo ? tempo.tempoUnit : 1,
    tempoSource: tempo ? tempo.tempoSource : null,
    tempoText: tempo ? tempo.tempoText : null,
    beatsPerBar: timeSig ? timeSig.beatsPerBar : 4,
    beatUnit: timeSig ? timeSig.beatUnit : 4,
    timeSigSource: timeSig ? 'detected' : 'assumed',
    marks: bars.marks,
    endMark: bars.endMark || null,
    totalBars: bars.totalBars,
    notes,
  };
}
