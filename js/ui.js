// Small UI helpers: toast messages and dialogs (prompt / confirm / menu / folder picker).

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

function dialog(html, setup) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = html;
    document.body.appendChild(d);
    let result;
    const finish = value => { result = value; d.close(); };
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    d.addEventListener('click', e => { if (e.target === d) finish(undefined); }); // tap outside
    setup(d, finish);
    d.showModal();
  });
}

export function promptText(title, value = '', okLabel = 'Save') {
  return dialog(`
    <form method="dialog">
      <h2>${esc(title)}</h2>
      <input name="v" type="text" autocomplete="off" value="${esc(value)}" required>
      <div class="dlg-actions">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary">${esc(okLabel)}</button>
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
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    <div class="dlg-actions">
      <button class="btn ghost" data-no>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button>
    </div>`, (d, finish) => {
    d.querySelector('[data-no]').onclick = () => finish(false);
    d.querySelector('[data-yes]').onclick = () => finish(true);
  });
}

// actions: [{ label, value, danger }]
export function menu(title, actions) {
  return dialog(`
    <h2>${esc(title)}</h2>
    <div class="menu-list">
      ${actions.map((a, i) => `<button class="menu-item ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
      <button class="menu-item ghost" data-cancel>Cancel</button>
    </div>`, (d, finish) => {
    d.querySelectorAll('[data-i]').forEach(b => (b.onclick = () => finish(actions[+b.dataset.i].value)));
    d.querySelector('[data-cancel]').onclick = () => finish(undefined);
  });
}

// Returns a folder id, null for the top level, or undefined if cancelled.
export function pickFolder(title, folders, excludeIds = new Set()) {
  const children = id => folders.filter(f => f.parentId === id).sort((a, b) => a.name.localeCompare(b.name));
  const rows = [];
  const walk = (parent, depth) => {
    for (const f of children(parent)) {
      if (excludeIds.has(f.id)) continue;
      rows.push(`<button class="menu-item tree" style="padding-left:${16 + depth * 20}px" data-id="${f.id}">📁 ${esc(f.name)}</button>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return dialog(`
    <h2>${esc(title)}</h2>
    <div class="menu-list scroll">
      <button class="menu-item tree" data-id="">🏠 Library (top level)</button>
      ${rows.join('')}
    </div>
    <div class="dlg-actions"><button class="btn ghost" data-cancel>Cancel</button></div>`, (d, finish) => {
    d.querySelectorAll('[data-id]').forEach(b => (b.onclick = () => finish(b.dataset.id || null)));
    d.querySelector('[data-cancel]').onclick = () => finish(undefined);
  });
}
