// Settings page: how pages turn, what the music screen shows, and auto-scroll.
// Opened from the library's ⋯ menu or from Tempo & scroll in the music view.
import { dialog } from './ui.js';
import { icon } from './icons.js';
import { pref, setPref } from './prefs.js';

const select = (key, options) => `
  <span class="s-select"><select data-pref="${key}" aria-label="${key}">
    ${options.map(([v, l]) => `<option value="${v}"${pref(key) === v ? ' selected' : ''}>${l}</option>`).join('')}
  </select>${icon('chevron-down')}</span>`;
const toggle = key => `<input class="switch" type="checkbox" data-pref="${key}"${pref(key) === '1' ? ' checked' : ''}>`;
const row = (label, control, hint = '') => `
  <label class="s-row"><span class="s-label">${label}${hint ? `<span class="s-hint">${hint}</span>` : ''}</span>${control}</label>`;

export function openSettings() {
  return dialog(`
    <div class="settings-page">
      <div class="s-head"><h2>Settings</h2><button class="nav-btn strong" data-done>Done</button></div>
      <div class="s-body">
        <h3 class="s-group-title">Page turning</h3>
        <div class="s-group">
          ${row('Tap sides', select('swapTaps', [['0', 'Right = next page'], ['1', 'Left = next page']]), 'The middle of the page always shows or hides the toolbars.')}
          ${row('Upright iPad', select('halfTurn', [['1', 'Half-page turns'], ['0', 'Whole page turns']]), 'Half-page: the top half shows the next page while you finish the bottom.')}
          ${row('Sideways iPad', select('spreadTurn', [['one', 'Turn one page'], ['both', 'Turn both pages']]), 'One page: the page you finished is replaced by the next. Both: like turning a book page.')}
          ${row('Page list', toggle('pageList'), 'Small pages down the left side, so you can see what is next and jump to a page.')}
        </div>

        <h3 class="s-group-title">Display</h3>
        <div class="s-group">
          ${row('Layout', select('view', [['auto', 'Automatic'], ['pages', 'Pages'], ['scroll', 'Scroll']]), 'Automatic: whole pages on iPad, one continuous strip on iPhone.')}
          ${row('Trim page margins', toggle('trim'), 'Cuts the white borders so the notes are bigger.')}
          ${row('Stage light', select('stage', [['normal', 'Normal'], ['warm', 'Warm'], ['dark', 'Dark (white on black)']]))}
        </div>

        <h3 class="s-group-title">Auto-scroll</h3>
        <div class="s-group">
          ${row('Play button on the music', toggle('playBtn'), 'Off: start auto-scroll from Tempo &amp; scroll. Handy if you mostly turn pages yourself.')}
          ${row('Music being played sits', select('readLine', [['0.3', 'Higher up'], ['0.45', 'In the middle'], ['0.55', 'Lower down']]), 'Scrolling waits until the music reaches this point, so what you are playing is not jammed at the top.')}
        </div>
      </div>
    </div>`, (d, finish) => {
    d.classList.add('dlg-settings');
    d.querySelector('[data-done]').onclick = () => finish();
    d.addEventListener('change', e => {
      const el = e.target.closest('[data-pref]');
      if (el) setPref(el.dataset.pref, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
    });
  });
}
