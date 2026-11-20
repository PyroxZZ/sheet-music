// Small UI helpers: toast messages and dialogs (prompt / confirm / menu / folder picker).
import { icon } from './icons.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };

export function toast(message, { sticky = false, ms = 2500 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  let timer;
  const remove = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  if (!sticky) timer = setTimeout(remove, ms);
  return {
    update(msg, closeAfter) {
      el.textContent = msg;
      if (closeAfter) { clearTimeout(timer); timer = setTimeout(remove, closeAfter); }
    },
    close: remove,
  };
}

// kind: 'alert' (centred card) or 'sheet' (action sheet: bottom on phones, centred on iPad)
function dialog(html, setup, kind = 'alert') {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = `dlg dlg-${kind}`;
    d.innerHTML = html;
    document.body.appendChild(d);
    let result;
    const finish = value => {
      result = value;
      d.classList.add('closing');
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => d.close(), reduce ? 0 : 140);
    };
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    d.addEventListener('click', e => { if (e.target === d) finish(undefined); }); // tap outside
    setup(d, finish);
    d.showModal();
  });
}

export function promptText(title, value = '', okLabel = 'Save') {
  return dialog(`
    <form method="dialog" class="alert">
      <h2 class="alert-title">${esc(title)}</h2>
      <input name="v" type="text" class="text-input" autocomplete="off" value="${esc(value)}" required>
      <div class="dlg-actions">
        <button type="button" class="dlg-btn" data-cancel>Cancel</button>
        <button class="dlg-btn primary">${esc(okLabel)}</button>
      </div>
    </form>`, (d, finish) => {
    const input = d.querySelector('input');
    d.querySelector('[data-cancel]').onclick = () => finish(null);
    d.querySelector('form').onsubmit = e => { e.preventDefault(); const v = input.value.trim(); finish(v || null); };
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

export function confirmBox(title, message, okLabel = 'OK', danger = false) {
  return dialog(`
    <div class="alert">
      <h2 class="alert-title">${esc(title)}</h2>
      <p class="alert-msg">${esc(message)}</p>
      <div class="dlg-actions">
        <button class="dlg-btn" data-no>Cancel</button>
        <button class="dlg-btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button>
      </div>
    </div>`, (d, finish) => {
    d.querySelector('[data-no]').onclick = () => finish(false);
    d.querySelector('[data-yes]').onclick = () => finish(true);
  });
}

// actions: [{ label, value, danger, icon }]; opts.message adds a secondary line under the title.
export function menu(title, actions, { message = '' } = {}) {
  return dialog(`
    <div class="sheet-group">
      <div class="sheet-head">
        <h2 class="sheet-title">${esc(title)}</h2>
        ${message ? `<p class="sheet-msg">${esc(message)}</p>` : ''}
      </div>
      <div class="menu-list">
        ${actions.map((a, i) => `<button class="menu-item ${a.danger ? 'danger' : ''}" data-i="${i}">
          ${a.icon ? icon(a.icon) : ''}<span>${esc(a.label)}</span></button>`).join('')}
      </div>
    </div>
    <button class="sheet-cancel" data-cancel>Cancel</button>`, (d, finish) => {
    d.querySelectorAll('[data-i]').forEach(b => (b.onclick = () => finish(actions[+b.dataset.i].value)));
    d.querySelector('[data-cancel]').onclick = () => finish(undefined);
  }, 'sheet');
}

// Returns a folder id, null for the top level, or undefined if cancelled.
export function pickFolder(title, folders, excludeIds = new Set()) {
  const children = id => folders.filter(f => f.parentId === id).sort((a, b) => a.name.localeCompare(b.name));
  const rows = [];
  const walk = (parent, depth) => {
    for (const f of children(parent)) {
      if (excludeIds.has(f.id)) continue;
      rows.push(`<button class="menu-item tree" style="--depth:${depth + 1}" data-id="${f.id}">
        ${icon('folder')}<span>${esc(f.name)}</span></button>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return dialog(`
    <div class="sheet-group">
      <div class="sheet-head"><h2 class="sheet-title">${esc(title)}</h2></div>
      <div class="menu-list scroll">
        <button class="menu-item tree" style="--depth:0" data-id="">${icon('home')}<span>Library</span><span class="tree-note">Top level</span></button>
        ${rows.join('')}
      </div>
    </div>
    <button class="sheet-cancel" data-cancel>Cancel</button>`, (d, finish) => {
    d.querySelectorAll('[data-id]').forEach(b => (b.onclick = () => finish(b.dataset.id || null)));
    d.querySelector('[data-cancel]').onclick = () => finish(undefined);
  }, 'sheet');
}
