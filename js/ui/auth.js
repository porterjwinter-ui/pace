import { $, $$, html, raw, render, icon } from './dom.js';
import { createAccount, signIn, lastUsername } from '../account.js';

const REPO_KEY = 'pace:lastRepo';
const lastRepo = () => { try { return localStorage.getItem(REPO_KEY) || ''; } catch { return ''; } };
const saveRepo = (r) => { try { localStorage.setItem(REPO_KEY, r); } catch { /* ignore */ } };

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Pace%20sync&description=Lets%20Pace%20save%20encrypted%20data%20to%20your%20private%20repo&contents=write&expires_in=366';
const REPO_URL = 'https://github.com/new?name=pace-data&visibility=private&description=Encrypted%20data%20for%20Pace';

export function logoMark(size = 28) {
  return raw(`<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--accent)"/>
    <path d="M9 9.5h14M9 16h8M9 22.5h5" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".55"/>
    <path d="m17.5 21 2.6 2.6 4.9-5.6" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`);
}

function githubFields(prefix, open) {
  return html`
    <div class="field">
      <label for="${prefix}-repo">Private repository</label>
      <input id="${prefix}-repo" name="repo" placeholder="your-name/pace-data" autocomplete="off" spellcheck="false" value="${lastRepo()}" ${open ? raw('required') : ''}>
      <p class="hint">Owner and name of a private repo. <a href="${REPO_URL}" target="_blank" rel="noopener">Create one</a></p>
    </div>
    <div class="field">
      <label for="${prefix}-token">GitHub access token</label>
      <input id="${prefix}-token" name="token" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false" ${open ? raw('required') : ''}>
      <p class="hint"><a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a fine-grained token</a> with access to only that repo and <b>Contents: Read and write</b>. It’s stored encrypted with your password.</p>
    </div>`;
}

export function showAuth(root, onSession) {
  let tab = lastUsername() ? 'signin' : 'create';
  let showGh = false;
  let storage = 'github';
  let busy = false;

  const draw = (error = '') => {
    const username = $('#a-user', root)?.value ?? lastUsername();
    render(root, html`
      <main class="auth">
        <section class="auth-intro">
          <div class="brand">${logoMark(34)}<span>Pace</span></div>
          <h1>Know exactly what to work on, every day.</h1>
          <p>Add a deadline and how long it’ll take. Pace finds the time in your week, spreads the work out, and moves it when your plans change.</p>
          <div class="auth-demo" aria-hidden="true">
            <div class="demo-day"><span>Mon</span><div class="demo-block w45"><i></i>Essay draft<em>45m</em></div><div class="demo-event">Swim practice</div></div>
            <div class="demo-day"><span>Tue</span><div class="demo-block w60 done"><i></i>Essay draft<em>1h</em></div><div class="demo-block w30 alt"><i></i>Lab report<em>30m</em></div></div>
            <div class="demo-day"><span>Wed</span><div class="demo-block w45"><i></i>Essay draft<em>45m</em></div><div class="demo-due">Lab report due</div></div>
          </div>
          <p class="auth-fine">${icon('lock')} Everything is encrypted in your browser before it’s saved. Only your password can unlock it.</p>
        </section>

        <section class="auth-card">
          <div class="seg" role="tablist">
            <button role="tab" aria-selected="${tab === 'signin'}" data-tab="signin">Sign in</button>
            <button role="tab" aria-selected="${tab === 'create'}" data-tab="create">Create account</button>
          </div>

          <form id="auth-form" novalidate>
            <div class="field">
              <label for="a-user">Username</label>
              <input id="a-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${username}">
            </div>
            <div class="field">
              <label for="a-pass">Password</label>
              <input id="a-pass" name="password" type="password" autocomplete="${tab === 'create' ? 'new-password' : 'current-password'}" required minlength="8">
            </div>
            ${tab === 'create' ? html`
              <div class="field">
                <label for="a-pass2">Confirm password</label>
                <input id="a-pass2" name="password2" type="password" autocomplete="new-password" required>
              </div>
              <fieldset class="field choice">
                <legend>Where to keep your data</legend>
                <label class="option"><input type="radio" name="storage" value="github" ${storage === 'github' ? raw('checked') : ''}>
                  <span><b>My private GitHub repo</b><small>Encrypted, synced across your devices</small></span></label>
                <label class="option"><input type="radio" name="storage" value="local" ${storage === 'local' ? raw('checked') : ''}>
                  <span><b>This device only</b><small>Encrypted in this browser. You can connect GitHub later.</small></span></label>
              </fieldset>
              ${storage === 'github' ? githubFields('c', true) : ''}
              <p class="hint warn">There’s no password reset. Your password is the only key to your data, so keep it somewhere safe.</p>
            ` : html`
              ${showGh ? html`<div class="gh-box">${githubFields('s', true)}</div>` : html`
                <button type="button" class="btn-text small" data-gh>First time on this device? Sign in with GitHub</button>`}
            `}
            <label class="check"><input type="checkbox" name="keep" checked> Keep me signed in on this device</label>
            ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
            <button class="btn primary wide" type="submit" ${busy ? raw('disabled') : ''}>
              ${busy ? html`<span class="spinner"></span>${tab === 'create' ? 'Creating your account…' : 'Unlocking…'}` : tab === 'create' ? 'Create account' : 'Sign in'}
            </button>
          </form>
        </section>
      </main>`);

    $$('[data-tab]', root).forEach((b) => b.onclick = () => { tab = b.dataset.tab; draw(); });
    $('[data-gh]', root)?.addEventListener('click', () => { showGh = true; draw(); $('#s-repo', root)?.focus(); });
    $$('input[name=storage]', root).forEach((r) => r.onchange = () => { storage = r.value; const p = $('#a-pass', root).value, p2 = $('#a-pass2', root).value; draw(); $('#a-pass', root).value = p; $('#a-pass2', root).value = p2; });
    $('#auth-form', root).onsubmit = submit;
    const first = !$('#a-user', root).value ? '#a-user' : '#a-pass';
    $(first, root)?.focus();
  };

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.target);
    const username = String(f.get('username') || '').trim();
    const password = String(f.get('password') || '');
    const token = String(f.get('token') || '');
    const repo = String(f.get('repo') || '');
    const keepSignedIn = f.get('keep') === 'on';
    if (!username || !password) return draw('Enter your username and password.');
    if (tab === 'create' && password !== f.get('password2')) return draw('Those passwords don’t match.');

    busy = true;
    const keepPw = password;
    draw();
    try {
      const session = tab === 'create'
        ? await createAccount({ username, password, mode: storage, token, repo, keepSignedIn })
        : await signIn({ username, password, token: showGh ? token : '', repo: showGh ? repo : '', keepSignedIn });
      if (repo) saveRepo(repo);
      onSession(session, { isNew: tab === 'create' });
    } catch (err) {
      busy = false;
      if (err.code === 'NEED_GITHUB') showGh = true;
      draw(err.message || 'Something went wrong.');
      $('#a-pass', root).value = keepPw;
      if (showGh) { $('#s-repo', root).value = repo || lastRepo(); $('#s-token', root).value = token; }
    }
  }

  draw();
}
