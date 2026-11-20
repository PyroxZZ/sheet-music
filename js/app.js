// Library screen: folders, songs, import, search, sort, backup.
import * as db from './db.js';
import { loadPdf, makeThumbnail } from './pdf.js';
import { analyzePdf } from './detect.js';
import { openViewer, initViewer, scrollFromDetection } from './viewer.js';
import { toast, promptText, confirmBox, menu, pickFolder, esc } from './ui.js';
import { icon } from './icons.js';

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
  const path = folderPath(state.folderId);
  const crumbs = [`<button class="crumb" data-folder=""${path.length ? '' : ' aria-current="page"'}>${icon('library')}<span>Library</span></button>`];
  path.forEach((f, i) => crumbs.push(`<span class="sep" aria-hidden="true">${icon('chevron-right')}</span><button class="crumb" data-folder="${f.id}"${i === path.length - 1 ? ' aria-current="page"' : ''}><span>${esc(f.name)}</span></button>`));
  $('#crumbs').innerHTML = crumbs.join('');
  $('#crumbs').hidden = !!state.query || !path.length;

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
  state.visibleSongs = songs; // the order next/previous song follows in the viewer

  const pathLabel = id => folderPath(id).map(f => f.name).join(' / ') || 'Library';
  const folderCards = folders.map(f => {
    const n = countIn(f.id);
    return `
      <div class="card folder" data-open-folder="${f.id}">
        <div class="folder-ic" aria-hidden="true">${icon('folder')}</div>
        <div class="meta"><div class="title">${esc(f.name)}</div>
          <div class="sub">${q ? esc(pathLabel(f.parentId)) + ' · ' : ''}${n} song${n === 1 ? '' : 's'}</div></div>
        <button class="more" data-folder-menu="${f.id}" aria-label="Folder options">${icon('more')}</button>
      </div>`;
  });
  const songCards = songs.map(s => {
    const sc = s.scroll || {};
    const info = s.kind === 'score'
      ? ['MusicXML', sc.bpm ? `${sc.bpm} BPM` : 'No tempo']
      : [sc.bpm ? `${sc.bpm} BPM` : 'No tempo', `${s.pageCount} ${s.pageCount === 1 ? 'page' : 'pages'}`];
    return `
      <div class="card song" data-open-song="${s.id}">
        <div class="thumb">${s.thumb ? `<img src="${s.thumb}" alt="">` : `<span class="thumb-ph">${icon('file-music')}</span>`}</div>
        <div class="meta">
          <div class="meta-text"><div class="title">${esc(s.title)}</div>
            <div class="sub">${q ? esc(pathLabel(s.folderId)) + ' · ' : ''}${info.join(' · ')}</div></div>
          <button class="more" data-song-menu="${s.id}" aria-label="Song options">${icon('more')}</button>
        </div>
      </div>`;
  });
  const group = (label, cls, cards) => cards.length
    ? `<div class="group"><h2 class="group-title">${label}<span class="count">${cards.length}</span></h2><div class="${cls}">${cards.join('')}</div></div>`
    : '';
  $('#grid').innerHTML = group('Folders', 'folder-grid', folderCards) + group('Music', 'song-grid', songCards);
  const empty = !folders.length && !songs.length;
  $('#empty').hidden = !empty;
  $('#empty').innerHTML = q
    ? `<div class="empty-ic">${icon('search-x')}</div>
       <h2>No Results</h2>
       <p>No songs or folders match “${esc(state.query)}”.</p>`
    : `<div class="empty-ic">${icon(state.folderId ? 'folder-open' : 'music')}</div>
       <h2>${state.folderId ? 'This folder is empty' : 'No music yet'}</h2>
       <p>Import a PDF or scan a printed score to add it here. Use folders to keep your library organised.</p>
       <div class="empty-actions">
         <button class="tb-btn primary" data-empty-action="import">${icon('file-up')}<span class="lbl">Import PDF</span></button>
         <button class="tb-btn" data-empty-action="scan">${icon('scan-line')}<span class="lbl">Scan</span></button>
       </div>`;
}

// Slide the folder contents in, like iOS navigation: 1 = into a folder, -1 = back out.
function slide(dir) {
  for (const el of [$('#grid'), $('#empty'), $('#crumbs')]) {
    el.classList.remove('nav-in-fwd', 'nav-in-back');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'nav-in-fwd' : 'nav-in-back');
  }
  clearTimeout(slide.timer);
  slide.timer = setTimeout(() => {
    for (const el of [$('#grid'), $('#empty'), $('#crumbs')]) el.classList.remove('nav-in-fwd', 'nav-in-back');
  }, 600);
  window.scrollTo({ top: 0 });
}

// ---------- Actions ----------

async function newFolder() {
  const name = await promptText('New folder', '', 'Create');
  if (!name) return;
  await db.put('folders', { id: db.uid(), name, parentId: state.folderId, createdAt: Date.now() });
  reload();
}

// Store a PDF (from a file or from the photo scanner) as a new song in the current folder.
async function importBytes(bytes, title) {
  const t = toast(`Importing ${title}…`, { sticky: true });
  try {
    const pdf = await loadPdf(bytes);
    const thumb = await makeThumbnail(pdf);
    const detected = await analyzePdf(pdf, msg => t.update(`${title}: ${msg}`));
    const song = {
      id: db.uid(),
      title,
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
    t.update(`Could not import ${title}: ${e.message || e}`, 4000);
  }
  await reload();
}

// Store a MusicXML score (.musicxml / .xml / .mxl). The notes are redrawn by Verovio when opened.
async function importScore(bytes, fileTitle, format) {
  const t = toast(`Importing ${fileTitle}…`, { sticky: true });
  try {
    const score = await import('./score.js');
    t.update(`${fileTitle}: reading notes…`);
    const info = await score.scoreSummary(bytes, format);
    const thumb = await score.scoreThumbnail(bytes, format);
    const title = (format === 'xml' && score.titleFromXml(bytes)) || fileTitle;
    const song = {
      id: db.uid(),
      kind: 'score',
      format,
      title,
      folderId: state.folderId,
      createdAt: Date.now(),
      lastOpened: 0,
      pageCount: 0,
      bars: info.bars,
      thumb,
      scroll: { bpm: info.bpm, baseTempo: info.bpm, beatsPerBar: info.beatsPerBar, beatUnit: 4, tempoUnit: 1, countIn: true, zoom: 1 },
    };
    await db.addSong(song, bytes);
    t.update(`Added “${song.title}” · ${info.bpm} BPM · ${info.bars} bars`, 2500);
  } catch (e) {
    console.error(e);
    t.update(`Could not import ${fileTitle}: ${e.message || e}`, 4000);
  }
  await reload();
}

async function importFiles(files) {
  const { isScoreFile, formatOf } = await import('./score.js');
  for (const file of files) {
    const title = file.name.replace(/\.(pdf|musicxml|xml|mxl)$/i, '').replace(/[_]+/g, ' ').trim();
    if (isScoreFile(file.name)) { await importScore(await file.arrayBuffer(), title, formatOf(file.name)); continue; }
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast(`${file.name} is not a PDF or MusicXML file`); continue; }
    await importBytes(await file.arrayBuffer(), title);
  }
}

async function scanMusic() {
  try {
    const { startScan } = await import('./scan.js');
    startScan((bytes, title) => importBytes(bytes, title));
  } catch (e) {
    console.error(e);
    toast('Could not open the scanner: ' + e.message);
  }
}

async function songMenu(id) {
  const song = state.songs.find(s => s.id === id);
  const choice = await menu(song.title, [
    { label: 'Rename', value: 'rename', icon: 'pencil' },
    { label: 'Move to folder…', value: 'move', icon: 'move' },
    { label: 'Delete', value: 'delete', danger: true, icon: 'trash' },
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
    { label: 'Rename', value: 'rename', icon: 'pencil' },
    { label: 'Move to folder…', value: 'move', icon: 'move' },
    { label: 'Delete', value: 'delete', danger: true, icon: 'trash' },
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
    storage = `${(est.usage / 1048576).toFixed(1)} MB stored on this device${persisted ? ' · persistent storage' : ''}`;
  } catch {}
  const choice = await menu('Library', [
    { label: 'Back up library (save to Files)', value: 'export', icon: 'download' },
    { label: 'Restore from backup…', value: 'import', icon: 'upload' },
  ], { message: storage });
  if (choice === 'export') exportBackup();
  if (choice === 'import') $('#backup-input').click();
}

// ---------- Wiring ----------

// Prepend the SVG named by data-icon to static elements in index.html.
function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
}

function init() {
  hydrateIcons();
  $('#sort').value = state.sort;
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; localStorageSet('sort', state.sort); render(); });
  $('#search').addEventListener('input', e => { state.query = e.target.value; render(); });
  $('#btn-folder').addEventListener('click', newFolder);
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#btn-scan').addEventListener('click', scanMusic);
  $('#btn-menu').addEventListener('click', appMenu);
  $('#file-input').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; importFiles(f); });
  $('#backup-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });

  $('#empty').addEventListener('click', e => {
    const b = e.target.closest('[data-empty-action]');
    if (!b) return;
    if (b.dataset.emptyAction === 'import') $('#file-input').click();
    if (b.dataset.emptyAction === 'scan') scanMusic();
  });
  // Hairline under the sticky header once the content scrolls beneath it.
  const top = $('.top');
  const onScroll = () => top.classList.toggle('scrolled', window.scrollY > 2);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  $('#crumbs').addEventListener('click', e => {
    const b = e.target.closest('[data-folder]');
    if (b && (b.dataset.folder || null) !== state.folderId) { state.folderId = b.dataset.folder || null; render(); slide(-1); }
  });
  $('#grid').addEventListener('click', e => {
    const fm = e.target.closest('[data-folder-menu]');
    if (fm) { e.stopPropagation(); return folderMenu(fm.dataset.folderMenu); }
    const sm = e.target.closest('[data-song-menu]');
    if (sm) { e.stopPropagation(); return songMenu(sm.dataset.songMenu); }
    const f = e.target.closest('[data-open-folder]');
    if (f) { state.folderId = f.dataset.openFolder; state.query = ''; $('#search').value = ''; render(); slide(1); return; }
    const s = e.target.closest('[data-open-song]');
    if (s) {
      const song = state.songs.find(x => x.id === s.dataset.openSong);
      openViewer(song, reload, state.visibleSongs || []).catch(err => { console.error(err); toast('Could not open: ' + err.message); });
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
