// Thin wrapper around PDF.js (stored locally in /vendor so it works offline).
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

export function loadPdf(bytes) {
  // PDF.js may transfer (detach) the buffer it is given, so always hand it a copy.
  const data = new Uint8Array(bytes.slice(0));
  return pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
  }).promise;
}

// Render one page onto a new canvas at the given CSS width.
export async function renderPageToCanvas(pdf, pageNumber, cssWidth, pixelRatio = 1) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = (cssWidth / base.width) * pixelRatio;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

export async function makeThumbnail(pdf) {
  const canvas = await renderPageToCanvas(pdf, 1, 240, 1);
  const url = canvas.toDataURL('image/jpeg', 0.72);
  canvas.width = canvas.height = 0; // free memory (important on iOS)
  return url;
}
