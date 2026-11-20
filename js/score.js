// MusicXML support: the notes are redrawn crisply with Verovio (offline, on the device).
// Verovio lays the music out for the actual screen width and gives an exact timeline of every bar,
// including repeats, which the viewer uses for bar-accurate auto-scroll.

let tkPromise = null;

export function getToolkit() {
  if (!tkPromise) {
    tkPromise = (async () => {
      const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
        import('../vendor/verovio/verovio-module.mjs'),
        import('../vendor/verovio/verovio.mjs'),
      ]);
      return new VerovioToolkit(await createVerovioModule());
    })();
    tkPromise.catch(() => { tkPromise = null; });
  }
  return tkPromise;
}

export const isScoreFile = name => /\.(musicxml|xml|mxl)$/i.test(name);
export const formatOf = name => (/\.mxl$/i.test(name) ? 'mxl' : 'xml');

function load(tk, bytes, format) {
  const ok = format === 'mxl' ? tk.loadZipDataBuffer(bytes) : tk.loadData(new TextDecoder().decode(bytes));
  if (!ok) throw new Error('This file could not be read as MusicXML');
}

// Title from the MusicXML itself (plain .musicxml/.xml only).
export function titleFromXml(bytes) {
  try {
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    const t = doc.querySelector('work > work-title')?.textContent || doc.querySelector('movement-title')?.textContent;
    return t && t.trim() ? t.trim() : null;
  } catch { return null; }
}

const BASE_OPTIONS = {
  adjustPageHeight: true,
  breaks: 'auto',
  footer: 'none',
  svgViewBox: true,
  svgRemoveXlink: true,
  justifyVertically: false,
  pageMarginLeft: 40, pageMarginRight: 40, pageMarginTop: 30, pageMarginBottom: 60,
};

// Render for a given CSS width. zoom 1 = normal note size.
export async function renderScore(bytes, format, cssWidth, zoom = 1) {
  const tk = await getToolkit();
  const scale = Math.round(50 * zoom); // 50 ≈ comfortable reading size on an iPad music stand
  tk.setOptions({ ...BASE_OPTIONS, scale, pageWidth: Math.round(cssWidth * 100 / scale), pageHeight: 60000 });
  load(tk, bytes, format);
  const svgs = [];
  for (let p = 1; p <= tk.getPageCount(); p++) svgs.push(tk.renderToSVG(p));

  // Timeline: when each bar starts (ms), in playing order (repeats expanded).
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const tempo = (timemap.find(e => e.tempo) || {}).tempo || 120;
  const bars = [];
  const numbers = new Map();
  for (const e of timemap) {
    if (!e.measureOn) continue;
    const id = e.measureOn.replace(/-rend\d+$/, ''); // repeated bars get a "-rendN" suffix
    if (!numbers.has(id)) {
      let n = null;
      try { n = tk.getElementAttr(id).n || null; } catch {}
      numbers.set(id, n);
    }
    bars.push({ t: e.tstamp / 1000, id, n: numbers.get(id) });
  }
  // End of the piece = last note-off.
  const end = timemap.reduce((m, e) => Math.max(m, e.tstamp), 0) / 1000;

  // Beats per bar (for the count-in) from the first full bar.
  const beatSec = 60 / tempo;
  const beatsPerBar = bars.length > 1 ? Math.max(1, Math.round((bars[1].t - bars[0].t) / beatSec)) : 4;
  return { svgs, bars, end, tempo, beatsPerBar };
}

// Small picture of the first page for the library card.
export async function scoreThumbnail(bytes, format) {
  const tk = await getToolkit();
  tk.setOptions({ ...BASE_OPTIONS, scale: 30, pageWidth: 2100, pageHeight: 2970, adjustPageHeight: false, breaks: 'auto' });
  load(tk, bytes, format);
  const svg = tk.renderToSVG(1);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i); i.onerror = () => reject(new Error('thumbnail failed'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = 240; c.height = Math.round(240 * 2970 / 2100);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.8);
    c.width = c.height = 0;
    return data;
  } finally { URL.revokeObjectURL(url); }
}

// Tempo + bar count without keeping the rendering (used at import).
export async function scoreSummary(bytes, format) {
  const r = await renderScore(bytes, format, 800, 1);
  const lastN = [...r.bars].reverse().find(b => b.n)?.n;
  return { bpm: Math.round(r.tempo), beatsPerBar: r.beatsPerBar, bars: lastN ? +lastN || r.bars.length : r.bars.length };
}
