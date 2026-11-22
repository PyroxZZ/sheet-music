// App-wide preferences (kept on this device). Changing one fires a "prefchange" event on window,
// so an open viewer can apply it straight away.

const DEFAULTS = {
  view: 'auto',        // PDF layout: auto (Pages on iPad, Scroll on iPhone) | pages | scroll
  trim: '1',           // trim white page margins
  stage: 'normal',     // stage light: normal | warm | dark
  halfTurn: '1',       // upright Pages layout: half-page turns (1) or whole pages (0)
  spread: '2',         // sideways Pages layout: two pages side by side (2) or one page (1)
  spreadTurn: 'one',   // sideways Pages layout: turn one page (one) or both pages (both)
  swapTaps: '0',       // 1 = tap the left side for the next page
  pageList: '1',       // page list down the left side of the music
  playBtn: '0',        // auto-scroll button on the music's bottom bar
  readLine: '0.45',    // where the music being played sits while scrolling (fraction of the screen)
  inkTool: 'pen',      // markup tool: pen | hl (highlighter) | eraser
  inkPenColor: '#1c1c1e',
  inkHlColor: '#ffd43b',
  inkPenSize: '1',     // line thickness in page units ('0' / '1' / '2' = thin / medium / thick presets)
  inkHlSize: '1',
  inkFinger: 'auto',   // fingers draw in Markup: auto (until an Apple Pencil is used) | 1 | 0
};

export function pref(k) {
  try { return localStorage.getItem('pref.' + k) ?? DEFAULTS[k]; } catch { return DEFAULTS[k]; }
}

export function setPref(k, v) {
  try { localStorage.setItem('pref.' + k, String(v)); } catch {}
  window.dispatchEvent(new CustomEvent('prefchange', { detail: k }));
}
