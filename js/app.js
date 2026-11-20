// Library screen: folders, songs, import, search, sort, backup.
import * as db from './db.js';
import { loadPdf, makeThumbnail } from './pdf.js';
import { analyzePdf } from './detect.js';
import { openViewer, initViewer, scrollFromDetection } from './viewer.js';
import { toast, promptText, confirmBox, menu, pickFolder, esc } from './ui.js';

const $ = sel => document.querySelector(sel);

const state = {
  folderId: null,
  query: '',
  sort: localStorageGet('sort') || 'name-asc',
  folders: [],
  songs: [],
};

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function reload() {
  [state.folders, state.songs] = await Promise.all([db.getAll('folders'), db.getAll('songs')]);
  if (state.folderId && !state.folders.some(f => f.id === state.folderId)) state.folderId = null;
  render();
}

function folderPath(id) {
  const path = [];
  let f = state.folders.find(x => x.id === id);
  while (f) { path.unshift(f); f = state.folders.find(x => x.id === f.parentId); }
  return path;
}

function descendantFolderIds(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of state.folders) if (out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

function sortSongs(list) {
  const by = {
    'name-asc': (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
    'name-desc': (a, b) => b.title.localeCompare(a.title, undefined, { numeric: true }),
    'newest': (a, b) => b.createdAt - a.createdAt,
    'oldest': (a, b) => a.createdAt - b.createdAt,
    'recent': (a, b) => (b.lastOpened || 0) - (a.lastOpened || 0),
  }[state.sort];
  return [...list].sort(by);
}
function sortFolders(list) {
  const dir = state.sort === 'name-desc' ? -1 : 1;
  return [...list].sort((a, b) => dir * a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function countIn(folderId) {
  const ids = descendantFolderIds(folderId);
  return state.songs.filter(s => ids.has(s.folderId)).length;
}

function render() {
  // Breadcrumbs
  const crumbs = [`<button class="crumb" data-folder="">Library</button>`];
  for (const f of folderPath(state.folderId)) crumbs.push(`<span class="sep">›</span><button class="crumb" data-folder="${f.id}">${esc(f.name)}</button>`);
  $('#crumbs').innerHTML = crumbs.join('');
  $('#crumbs').hidden = !!state.query;

  let folders, songs;
  const q = norm(state.query.trim());
  if (q) {
    folders = state.folders.filter(f => norm(f.name).includes(q));
    songs = state.songs.filter(s => norm(s.title).includes(q));
  } else {
    folders = state.folders.filter(f => f.parentId === state.folderId);
    songs = state.songs.filter(s => s.folderId === state.folderId);
  }
  folders = sortFolders(folders);
  songs = sortSongs(songs);

  const pathLabel = id => folderPath(id).map(f => f.name).join(' › ') || 'Library';
  const html = [];
  for (const f of folders) {
    const n = countIn(f.id);
    html.push(`
      <div class="card folder" data-open-folder="${f.id}">
        <div class="thumb folder-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg></div>
        <div class="meta"><div class="title">${esc(f.name)}</div>
          <div class="sub">${q ? esc(pathLabel(f.parentId)) + ' · ' : ''}${n} song${n === 1 ? '' : 's'}</div></div>
        <button class="more" data-folder-menu="${f.id}" aria-label="Folder options">⋯</button>
      </div>`);
  }
  for (const s of songs) {
    const sc = s.scroll || {};
    const info = [sc.bpm ? `${sc.bpm} BPM` : 'no tempo', `${s.pageCount} p.`];
    html.push(`
      <div class="card song" data-open-song="${s.id}">
        <div class="thumb">${s.thumb ? `<img src="${s.thumb}" alt="">` : ''}</div>
        <div class="meta"><div class="title">${esc(s.title)}</div>
          <div class="sub">${q ? esc(pathLabel(s.folderId)) + ' · ' : ''}${info.join(' · ')}</div></div>
        <button class="more" data-song-menu="${s.id}" aria-label="Song options">⋯</button>
      </div>`);
  }
  $('#grid').innerHTML = html.join('');
  const empty = !folders.length && !songs.length;
  $('#empty').hidden = !empty;
  $('#empty').innerHTML = q
    ? `<p>No songs or folders match “${esc(state.query)}”.</p>`
    : `<p><strong>This folder is empty.</strong></p><p>Tap <b>Import PDF</b> to add sheet music, or <b>New folder</b> to organise.</p>`;
}

// ---------- Actions ----------

async function newFolder() {
  const name = await promptText('New folder', '', 'Create');
  if (!name) return;
  await db.put('folders', { id: db.uid(), name, parentId: state.folderId, createdAt: Date.now() });
  reload();
}

async function importFiles(files) {
  for (const file of files) {
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast(`${file.name} is not a PDF`); continue; }
    const t = toast(`Importing ${file.name}…`, { sticky: true });
    try {
      const bytes = await file.arrayBuffer();
      const pdf = await loadPdf(bytes);
      const thumb = await makeThumbnail(pdf);
      const detected = await analyzePdf(pdf, msg => t.update(`${file.name}: ${msg}`));
      const song = {
        id: db.uid(),
        title: file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim(),
        folderId: state.folderId,
        createdAt: Date.now(),
        lastOpened: 0,
        pageCount: pdf.numPages,
        thumb,
        scroll: scrollFromDetection(detected),
      };
      pdf.destroy();
      await db.addSong(song, bytes);
      t.update(`Added “${song.title}”${detected.bpm ? ` · ${detected.bpm} BPM` : ''}`, 2500);
    } catch (e) {
      console.error(e);
      t.update(`Could not import ${file.name}: ${e.message || e}`, 4000);
    }
    await reload();
  }
}

async function songMenu(id) {
  const song = state.songs.find(s => s.id === id);
  const choice = await menu(song.title, [
    { label: 'Rename', value: 'rename' },
    { label: 'Move to folder…', value: 'move' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (choice === 'rename') {
    const name = await promptText('Rename song', song.title);
    if (name) { song.title = name; await db.put('songs', song); }
  } else if (choice === 'move') {
    const target = await pickFolder('Move to…', state.folders);
    if (target !== undefined) { song.folderId = target; await db.put('songs', song); }
  } else if (choice === 'delete') {
    if (await confirmBox('Delete song?', `“${song.title}” and its PDF will be removed from this iPad.`, 'Delete', true)) {
      await db.deleteSongs([id]);
    }
  }
  reload();
}

async function folderMenu(id) {
  const folder = state.folders.find(f => f.id === id);
  const choice = await menu(folder.name, [
    { label: 'Rename', value: 'rename' },
    { label: 'Move to folder…', value: 'move' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (choice === 'rename') {
    const name = await promptText('Rename folder', folder.name);
    if (name) { folder.name = name; await db.put('folders', folder); }
  } else if (choice === 'move') {
    const target = await pickFolder('Move to…', state.folders, descendantFolderIds(id));
    if (target !== undefined) { folder.parentId = target; await db.put('folders', folder); }
  } else if (choice === 'delete') {
    const ids = descendantFolderIds(id);
    const songIds = state.songs.filter(s => ids.has(s.folderId)).map(s => s.id);
    const msg = `This deletes “${folder.name}”, ${ids.size - 1} subfolder(s) and ${songIds.length} song(s) inside it.`;
    if (await confirmBox('Delete folder?', msg, 'Delete', true)) {
      await db.deleteSongs(songIds);
      await db.deleteFolders([...ids]);
    }
  }
  reload();
}

// ---------- Backup ----------

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function exportBackup() {
  const t = toast('Preparing backup…', { sticky: true });
  try {
    const files = {};
    for (const s of state.songs) {
      const data = await db.getPdf(s.id);
      if (data) files[s.id] = bufToBase64(data);
    }
    const json = JSON.stringify({ app: 'sheet-music', version: 1, exportedAt: Date.now(), folders: state.folders, songs: state.songs, files });
    const name = `sheet-music-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    t.close();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Sheet music backup' }); // choose “Save to Files”
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  } catch (e) {
    if (e.name !== 'AbortError') { console.error(e); t.update('Backup failed: ' + e.message, 4000); }
  }
}

async function importBackup(file) {
  const t = toast('Restoring backup…', { sticky: true });
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'sheet-music') throw new Error('Not a backup from this app');
    for (const f of data.folders) await db.put('folders', f);
    for (const s of data.songs) if (data.files[s.id]) await db.addSong(s, base64ToBuf(data.files[s.id]));
    t.update(`Restored ${data.songs.length} songs and ${data.folders.length} folders`, 3000);
  } catch (e) {
    console.error(e);
    t.update('Restore failed: ' + e.message, 4000);
  }
  reload();
}

async function appMenu() {
  let storage = '';
  try {
    const est = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted();
    storage = ` · ${(est.usage / 1048576).toFixed(1)} MB used${persisted ? ' · persistent' : ''}`;
  } catch {}
  const choice = await menu(`Library${storage}`, [
    { label: 'Back up library (save to Files)', value: 'export' },
    { label: 'Restore from backup…', value: 'import' },
  ]);
  if (choice === 'export') exportBackup();
  if (choice === 'import') $('#backup-input').click();
}

// ---------- Wiring ----------

function init() {
  $('#sort').value = state.sort;
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; localStorageSet('sort', state.sort); render(); });
  $('#search').addEventListener('input', e => { state.query = e.target.value; render(); });
  $('#btn-folder').addEventListener('click', newFolder);
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#btn-menu').addEventListener('click', appMenu);
  $('#file-input').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; importFiles(f); });
  $('#backup-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });

  $('#crumbs').addEventListener('click', e => {
    const b = e.target.closest('[data-folder]');
    if (b) { state.folderId = b.dataset.folder || null; render(); }
  });
  $('#grid').addEventListener('click', e => {
    const fm = e.target.closest('[data-folder-menu]');
    if (fm) { e.stopPropagation(); return folderMenu(fm.dataset.folderMenu); }
    const sm = e.target.closest('[data-song-menu]');
    if (sm) { e.stopPropagation(); return songMenu(sm.dataset.songMenu); }
    const f = e.target.closest('[data-open-folder]');
    if (f) { state.folderId = f.dataset.openFolder; state.query = ''; $('#search').value = ''; render(); return; }
    const s = e.target.closest('[data-open-song]');
    if (s) {
      const song = state.songs.find(x => x.id === s.dataset.openSong);
      openViewer(song, reload).catch(err => { console.error(err); toast('Could not open: ' + err.message); });
    }
  });

  initViewer();
  db.requestPersistence();
  reload();

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then(reg => reg.update()).catch(console.warn);
    // A new version was installed: reload into it (but never in the middle of reading music).
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (document.body.classList.contains('viewing')) toast('Update ready – it will apply next time you open the app');
      else location.reload();
    });
  }

  // Show an install hint in Safari when not yet added to the Home Screen.
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    $('#install-hint').hidden = false;
  }
  $('#install-hint button').addEventListener('click', () => ($('#install-hint').hidden = true));
}

init();
