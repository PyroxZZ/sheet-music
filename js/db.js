// IndexedDB storage. Everything lives on the device and survives closing the app.
// Stores:
//   folders: { id, name, parentId (null = root), createdAt }
//   songs:   { id, title, folderId, createdAt, lastOpened, pageCount, thumb, scroll: {...} }
//   files:   { id (same as song id), data: ArrayBuffer }   <- PDF bytes kept separately so lists stay fast

const DB_NAME = 'sheet-music';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function getAll(store) {
  const db = await open();
  return reqP(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, id) {
  const db = await open();
  return reqP(db.transaction(store).objectStore(store).get(id));
}

export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}

export async function addSong(song, pdfBytes) {
  const db = await open();
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  tx.objectStore('songs').put(song);
  tx.objectStore('files').put({ id: song.id, data: pdfBytes });
  return done(tx);
}

export async function deleteSongs(ids) {
  const db = await open();
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('songs').delete(id);
    tx.objectStore('files').delete(id);
  }
  return done(tx);
}

export async function deleteFolders(ids) {
  const db = await open();
  const tx = db.transaction('folders', 'readwrite');
  for (const id of ids) tx.objectStore('folders').delete(id);
  return done(tx);
}

export async function getPdf(id) {
  const rec = await get('files', id);
  return rec ? rec.data : null;
}

// Ask iOS/Safari to treat our storage as persistent (not evictable under storage pressure).
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}
