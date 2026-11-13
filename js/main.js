import { showAuth } from './ui/auth.js';
import { startApp } from './ui/app.js';
import { resumeSession } from './account.js';
import { Store } from './store.js';
import { render, html } from './ui/dom.js';

const root = document.getElementById('root');

function applyStoredTheme() {
  try {
    const t = localStorage.getItem('pace:theme');
    if (t && t !== 'system') document.documentElement.dataset.theme = t;
  } catch { /* ignore */ }
}

async function enter(session, opts = {}) {
  render(root, html`<div class="boot"><span class="spinner"></span><p>Decrypting your plan…</p></div>`);
  const store = new Store(session);
  try {
    await store.load();
  } catch (e) {
    console.error(e);
  }
  const app = startApp(root, store, session, { ...opts, onSignOut: () => { document.documentElement.removeAttribute('data-theme'); auth(); } });
  // Remember theme so the sign-in screen matches before unlocking.
  const saveTheme = () => { try { localStorage.setItem('pace:theme', store.v.settings.theme); } catch { /* ignore */ } };
  store.addEventListener('change', saveTheme);
  saveTheme();
  return app;
}

function auth() {
  showAuth(root, (session, opts) => enter(session, opts));
}

async function boot() {
  applyStoredTheme();
  if (!window.crypto?.subtle || !window.indexedDB) {
    render(root, html`<div class="boot"><p>Pace needs a modern browser with encryption support, opened over https.</p></div>`);
    return;
  }
  let session = null;
  try { session = await resumeSession(); } catch (e) { console.warn(e); }
  if (session) enter(session);
  else auth();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
