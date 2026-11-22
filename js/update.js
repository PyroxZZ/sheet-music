// "Check for updates": fetch the newest app files right now and reload, instead of waiting for the
// background update. The service worker re-downloads every app file into its cache (all or nothing,
// so the app never ends up half-updated or broken offline), then the page reloads.
import { toast } from './ui.js';

function askWorker(message, timeout = 30000) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return Promise.resolve(null);
  return new Promise(resolve => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeout);
    ch.port1.onmessage = e => { clearTimeout(timer); resolve(e.data); };
    sw.postMessage(message, [ch.port2]);
  });
}

export const appVersion = () => askWorker('version', 3000);

export async function updateApp() {
  const t = toast('Checking for updates…', { sticky: true });
  const online = await fetch('./sw.js', { cache: 'no-store' }).then(r => r.ok).catch(() => false);
  if (!online) { t.update('No internet connection – try again later', 3000); return; }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.update();
      const w = reg.installing || reg.waiting;
      if (w) { // a new version: wait until it has installed and taken over
        t.update('Downloading the new version…');
        await new Promise(r => {
          const done = () => (w.state === 'activated' || w.state === 'redundant') && r();
          w.addEventListener('statechange', done); done(); setTimeout(r, 30000);
        });
      }
    }
    t.update('Downloading app files…');
    const res = await askWorker('refresh');
    if (res && res !== 'ok') { t.update('Update failed – check your connection', 3000); return; }
  } catch (e) {
    console.warn(e);
  }
  t.update('Updated – reloading…');
  setTimeout(() => location.reload(), 300);
}
