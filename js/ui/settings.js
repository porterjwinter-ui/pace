import { $, $$, html, raw, render, icon, modal, confirmDialog } from './dom.js';
import { fmtDuration, fmtWeekday, fmtDateTime, parseWhen, setClock } from '../dates.js';
import { AVAILABILITY_PRESETS } from '../store.js';
import { listModels, SUGGESTED_MODELS, DEFAULT_MODEL } from '../agent.js';
import { changePassword, connectGitHub, updateToken, signOut } from '../account.js';
import { exportIcs, exportBackup } from './export.js';
import * as ops from '../ops.js';

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const dayName = (d) => fmtWeekday(new Date(2023, 0, 1 + d), 'long');

function availabilityEditor(av, weekStartsOn) {
  const order = DAYS.map((i) => (i + weekStartsOn) % 7);
  return html`<div class="avail-editor">
    ${order.map((d) => html`<div class="av-row" data-day="${d}">
      <span class="av-day">${dayName(d)}</span>
      <div class="av-ranges">
        ${av[d].length ? av[d].map(([a, b], i) => html`<span class="av-range" data-i="${i}">
          <input type="time" value="${hm(a)}" data-a aria-label="${dayName(d)} start"><span class="muted">–</span><input type="time" value="${hm(b)}" data-b aria-label="${dayName(d)} end">
          <button type="button" class="icon-btn small" data-rm aria-label="Remove">${icon('x')}</button></span>`) : html`<span class="muted av-off">Not available</span>`}
      </div>
      <button type="button" class="btn-text small" data-add>${icon('plus')} Add hours</button>
    </div>`)}
  </div>`;
}

function readAvailability(root) {
  const av = DAYS.map(() => []);
  for (const row of $$('.av-row', root)) {
    const d = Number(row.dataset.day);
    for (const r of $$('.av-range', row)) {
      const a = toMin($('[data-a]', r).value || '00:00'), b = toMin($('[data-b]', r).value || '00:00');
      if (b > a) av[d].push([a, b]);
    }
    av[d].sort((x, y) => x[0] - y[0]);
  }
  return av;
}

const select = (name, value, options) => html`<select name="${name}">${options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value) ? raw('selected') : ''}>${l}</option>`)}</select>`;

export function openSettings(app, tab = 'schedule') {
  const store = app.store;
  let current = tab;
  let av = structuredClone(store.v.settings.availability);

  const dlg = modal(html`<div class="settings">
    <nav class="settings-nav" role="tablist" aria-label="Settings">
      ${[['schedule', 'Schedule', 'clock'], ['calendar', 'Calendar', 'calendar'], ['assistant', 'Assistant', 'sparkle'], ['account', 'Account and sync', 'lock']].map(([k, l, i]) =>
        html`<button role="tab" data-tab="${k}" aria-selected="${k === current}">${icon(i)}<span>${l}</span></button>`)}
    </nav>
    <div class="settings-body"></div>
    <button class="icon-btn settings-close" data-close aria-label="Close settings">${icon('x')}</button>
  </div>`, { cls: 'settings-modal', label: 'Settings' });

  const body = $('.settings-body', dlg);
  $('[data-close]', dlg).onclick = () => dlg.close();
  $$('[data-tab]', dlg).forEach((b) => b.onclick = () => { current = b.dataset.tab; $$('[data-tab]', dlg).forEach((x) => x.setAttribute('aria-selected', x === b)); draw(); });

  const save = (patch, msg, replan = true) => { ops.updateSettings(store, patch, { replan }); if (msg) app.toast(msg); };

  function draw() {
    const s = store.v.settings;
    if (current === 'schedule') {
      render(body, html`
        <h2>Schedule</h2>
        <p class="muted">Pace only books work sessions inside these hours, and around your busy events.</p>
        <section>
          <div class="row between"><h3>When you can work</h3>
            <label class="inline-select">Preset ${select('preset', '', [['', 'Choose…'], ...Object.entries(AVAILABILITY_PRESETS).map(([k, p]) => [k, p.name])])}</label></div>
          <div class="av-host">${availabilityEditor(av, s.weekStartsOn)}</div>
        </section>
        <section class="grid2">
          <div class="field"><label>Most work per day</label>${select('maxDailyMinutes', s.maxDailyMinutes, [60, 90, 120, 180, 240, 300, 360, 420, 480, 600, 720].map((m) => [m, fmtDuration(m)]))}</div>
          <div class="field"><label>Finish tasks early by</label>${select('bufferHours', s.bufferHours, [[0, 'No buffer'], [6, '6 hours'], [12, '12 hours'], [24, '1 day'], [48, '2 days'], [72, '3 days']])}
            <p class="hint">Extra room before each due date, in case something comes up.</p></div>
          <div class="field"><label>Shortest session</label>${select('minBlock', s.minBlock, [15, 30, 45, 60].map((m) => [m, fmtDuration(m)]))}</div>
          <div class="field"><label>Longest session</label>${select('maxBlock', s.maxBlock, [45, 60, 90, 120, 150, 180, 240].map((m) => [m, fmtDuration(m)]))}</div>
          <div class="field"><label>Break between things</label>${select('breakMinutes', s.breakMinutes, [0, 5, 10, 15, 20, 30].map((m) => [m, m ? `${m} min` : 'None']))}
            <p class="hint">Kept free before and after events and between sessions.</p></div>
          <div class="field"><label>Default time estimate</label>${select('defaultEstimate', s.defaultEstimate, [30, 60, 90, 120, 180].map((m) => [m, fmtDuration(m)]))}</div>
        </section>
        <div class="row end"><button class="btn primary" data-save-schedule>Save schedule</button></div>`);
      const host = $('.av-host', body);
      const rebind = () => {
        $$('[data-add]', host).forEach((b) => b.onclick = () => {
          av = readAvailability(host);
          const d = Number(b.closest('.av-row').dataset.day);
          const last = av[d][av[d].length - 1];
          av[d].push(last ? [Math.min(last[1] + 60, 1380), Math.min(last[1] + 180, 1440)] : [540, 1020]);
          render(host, availabilityEditor(av, s.weekStartsOn)); rebind();
        });
        $$('[data-rm]', host).forEach((b) => b.onclick = () => {
          av = readAvailability(host);
          const d = Number(b.closest('.av-row').dataset.day);
          av[d].splice(Number(b.closest('.av-range').dataset.i), 1);
          render(host, availabilityEditor(av, s.weekStartsOn)); rebind();
        });
      };
      rebind();
      $('[name=preset]', body).onchange = (e) => {
        if (!e.target.value) return;
        av = structuredClone(AVAILABILITY_PRESETS[e.target.value].days);
        render(host, availabilityEditor(av, s.weekStartsOn)); rebind();
      };
      $('[data-save-schedule]', body).onclick = () => {
        av = readAvailability(host);
        const num = (n) => Number($(`[name=${n}]`, body).value);
        const minBlock = num('minBlock'), maxBlock = Math.max(num('maxBlock'), minBlock);
        save({ availability: av, maxDailyMinutes: num('maxDailyMinutes'), bufferHours: num('bufferHours'), minBlock, maxBlock, breakMinutes: num('breakMinutes'), defaultEstimate: num('defaultEstimate') }, 'Schedule saved. Your plan was rebuilt.');
      };
    } else if (current === 'calendar') {
      render(body, html`
        <h2>Calendar</h2>
        <section class="grid2">
          <div class="field"><label>Week starts on</label>${select('weekStartsOn', s.weekStartsOn, [[0, 'Sunday'], [1, 'Monday'], [6, 'Saturday']])}</div>
          <div class="field"><label>Time format</label>${select('clock', s.clock, [['auto', 'Automatic'], ['12h', '1:00pm'], ['24h', '13:00']])}</div>
          <div class="field"><label>Appearance</label>${select('theme', s.theme, [['system', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']])}</div>
          <div class="field"><label>Scroll to</label>${select('scrollHour', s.scrollHour, [5, 6, 7, 8, 9, 10, 12].map((h) => [h, `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? 'pm' : 'am'}`]))}
            <p class="hint">Where the day starts when you open a day or week.</p></div>
        </section>
        <section>
          <h3>Export</h3>
          <div class="row gap wrap">
            <button class="btn" data-ics>${icon('calendar')} Download plan as .ics</button>
            <button class="btn" data-backup>${icon('upload')} Download a backup</button>
          </div>
          <p class="hint">The .ics file includes your events, work sessions and due dates, for other calendar apps. The backup is unencrypted JSON, so store it carefully.</p>
        </section>`);
      $$('select', body).forEach((sel) => sel.onchange = () => {
        const val = sel.name === 'weekStartsOn' || sel.name === 'scrollHour' ? Number(sel.value) : sel.value;
        save({ [sel.name]: val }, '', false);
        if (sel.name === 'clock') setClock(val);
        if (sel.name === 'theme') app.applyTheme();
      });
      $('[data-ics]', body).onclick = () => exportIcs(store.v);
      $('[data-backup]', body).onclick = () => exportBackup(store.v, app.session.username);
    } else if (current === 'assistant') {
      const model = s.aiModel || DEFAULT_MODEL;
      render(body, html`
        <h2>Assistant</h2>
        <p class="muted">The assistant uses OpenRouter, so you can pick from many AI models. Your key is encrypted with the rest of your data and only sent to OpenRouter.</p>
        <section>
          <div class="field"><label for="ai-key">OpenRouter API key</label>
            <div class="row gap-s"><input id="ai-key" type="password" value="${s.aiKey}" placeholder="sk-or-…" autocomplete="off" spellcheck="false">
            <button type="button" class="icon-btn" data-reveal aria-label="Show key">${icon('eye')}</button></div>
            <p class="hint"><a href="https://openrouter.ai/keys" target="_blank" rel="noopener">Create a key</a>. Consider setting a credit limit on it.</p></div>
        </section>
        <section>
          <h3>Model</h3>
          <div class="model-picks">
            ${SUGGESTED_MODELS.map((m) => html`<label class="option"><input type="radio" name="model" value="${m.id}" ${model === m.id ? raw('checked') : ''}><span><b>${m.name}</b><small>${m.note}</small></span></label>`)}
            <label class="option"><input type="radio" name="model" value="__custom" ${SUGGESTED_MODELS.some((m) => m.id === model) ? '' : raw('checked')}><span><b>Another model</b><small>Any OpenRouter model that supports tools</small></span></label>
          </div>
          <div class="field custom-model" ${SUGGESTED_MODELS.some((m) => m.id === model) ? raw('hidden') : ''}>
            <input name="customModel" list="model-list" value="${SUGGESTED_MODELS.some((m) => m.id === model) ? '' : model}" placeholder="provider/model-name" autocomplete="off" spellcheck="false">
            <datalist id="model-list"></datalist>
          </div>
        </section>
        <div class="row end"><button class="btn primary" data-save-ai>Save</button></div>`);
      $('[data-reveal]', body).onclick = () => { const i = $('#ai-key', body); i.type = i.type === 'password' ? 'text' : 'password'; };
      $$('[name=model]', body).forEach((r) => r.onchange = () => {
        $('.custom-model', body).hidden = r.value !== '__custom';
        if (r.value === '__custom') {
          listModels().then((ms) => render($('#model-list', body), html`${ms.map((m) => html`<option value="${m.id}">${m.name}</option>`)}`)).catch(() => {});
        }
      });
      $('[data-save-ai]', body).onclick = () => {
        const choice = $('[name=model]:checked', body).value;
        const aiModel = choice === '__custom' ? $('[name=customModel]', body).value.trim() || DEFAULT_MODEL : choice;
        save({ aiKey: $('#ai-key', body).value.trim(), aiModel }, 'Assistant settings saved.', false);
      };
    } else {
      const sess = app.session;
      const gh = sess.gh;
      const statusText = { synced: 'Up to date', syncing: 'Syncing…', offline: 'Offline. Changes are saved here and will sync later.', error: store.syncError || 'Sync failed', idle: 'Waiting to sync', local: '' }[store.status];
      render(body, html`
        <h2>Account and sync</h2>
        <section>
          <p>Signed in as <b>${sess.username}</b>.</p>
          ${gh ? html`
            <div class="sync-card">
              <div>${icon('cloudCheck')}</div>
              <div><b>Encrypted sync to ${gh.owner}/${gh.repo}</b>
                <p class="small muted">${statusText}${store.lastSync ? `. Last synced ${fmtDateTime(new Date(store.lastSync))}` : ''}</p></div>
              <button class="btn" data-sync>${icon('refresh')} Sync now</button>
            </div>
            <details><summary>Replace GitHub token</summary>
              <form class="row gap-s" data-token><input name="token" type="password" placeholder="github_pat_…" autocomplete="off" required><button class="btn">Update</button></form>
            </details>` : html`
            <div class="sync-card">
              <div>${icon('device')}</div>
              <div><b>Saved on this device only</b><p class="small muted">Encrypted in this browser. Connect a private GitHub repo to use Pace on other devices.</p></div>
            </div>
            <form class="stack" data-connect>
              <div class="field"><label>Private repository</label><input name="repo" placeholder="your-name/pace-data" required autocomplete="off"></div>
              <div class="field"><label>GitHub access token</label><input name="token" type="password" placeholder="github_pat_…" required autocomplete="off">
                <p class="hint">Fine-grained token with access to only that repo and Contents: Read and write.</p></div>
              <div><button class="btn primary">Connect GitHub</button></div>
            </form>`}
        </section>
        <section>
          <h3>Change password</h3>
          <form class="stack" data-pw>
            <input name="old" type="password" placeholder="Current password" autocomplete="current-password" required>
            <input name="new" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" required minlength="8">
            <div><button class="btn">Change password</button></div>
          </form>
        </section>
        <section>
          <h3>Calendar links</h3>
          <div class="field"><label>Proxy for calendar links (optional)</label>
            <input name="corsProxy" value="${s.corsProxy}" placeholder="https://your-proxy.workers.dev/?url={url}" autocomplete="off" spellcheck="false">
            <p class="hint">Some calendar providers block browsers from loading their links directly. A small proxy you control fixes that; see the README for a free one-file setup.</p></div>
          <div><button class="btn" data-proxy>Save proxy</button></div>
        </section>
        <section class="danger-zone">
          <div class="row gap wrap">
            <button class="btn" data-signout>${icon('logout')} Sign out</button>
            <button class="btn danger-text" data-forget>Sign out and remove from this device</button>
          </div>
        </section>`);
      $('[data-sync]', body)?.addEventListener('click', async () => { await store.sync(); draw(); });
      $('[data-token]', body)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await updateToken(sess, e.target.token.value); app.toast('Token updated.'); store.sync(); draw(); } catch (err) { app.toast(err.message, { tone: 'bad' }); }
      });
      $('[data-connect]', body)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        try {
          await connectGitHub(sess, { token: f.token.value, repo: f.repo.value });
          store.status = 'idle';
          store.rev++;
          await store.sync();
          app.toast('Connected. Your data is now synced, encrypted.');
          app.render();
          draw();
        } catch (err) { app.toast(err.message, { tone: 'bad' }); }
      });
      $('[data-pw]', body).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        try { await changePassword(sess, f.old.value, f.new.value); f.reset(); app.toast('Password changed.'); } catch (err) { app.toast(err.message, { tone: 'bad' }); }
      });
      $('[data-proxy]', body).onclick = () => save({ corsProxy: $('[name=corsProxy]', body).value.trim() }, 'Proxy saved.', false);
      $('[data-signout]', body).onclick = async () => { dlg.close(); await app.signOut(false); };
      $('[data-forget]', body).onclick = async () => {
        const ok = await confirmDialog({
          title: 'Remove your data from this device?',
          body: gh ? 'Your encrypted copy on GitHub stays. You can sign in again with your password and token.' : 'Your data is only stored on this device. It will be permanently deleted.',
          confirm: 'Remove', danger: true,
        });
        if (ok) { dlg.close(); await app.signOut(true); }
      };
    }
  }
  draw();
}

/** First run: pick working hours and pace. */
export function openOnboarding(app) {
  const s = app.store.v.settings;
  const presets = Object.entries(AVAILABILITY_PRESETS);
  const describe = (days) => {
    const wk = days[1][0], we = days[6][0] || days[0][0];
    const t = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`; };
    return `${wk ? `Weekdays ${t(wk[0])}–${t(wk[1])}` : 'Weekdays off'}, ${we ? `weekends ${t(we[0])}–${t(we[1])}` : 'weekends off'}`;
  };
  const dlg = modal(html`<form class="onboard" method="dialog">
    <h2>When do you usually have time to work?</h2>
    <p class="muted">Pace will only schedule work in these hours, and around anything on your calendar. You can fine-tune each day later in Settings.</p>
    <div class="options">
      ${presets.map(([k, p], i) => html`<label class="option"><input type="radio" name="preset" value="${k}" ${i === 0 ? raw('checked') : ''}><span><b>${p.name}</b><small>${describe(p.days)}</small></span></label>`)}
    </div>
    <div class="grid2">
      <div class="field"><label>Most work per day</label>${select('max', s.maxDailyMinutes, [120, 180, 240, 300, 360, 480].map((m) => [m, fmtDuration(m)]))}</div>
      <div class="field"><label>Finish tasks early by</label>${select('buffer', s.bufferHours, [[0, 'No buffer'], [12, '12 hours'], [24, '1 day'], [48, '2 days']])}</div>
    </div>
    <footer class="row gap end">
      <button class="btn" value="import" type="submit">Import a calendar</button>
      <button class="btn primary" value="done" type="submit" autofocus>Start planning</button>
    </footer>
  </form>`, {
    cls: 'small-wide',
    label: 'Welcome',
    onClose: () => {
      const f = $('form', dlg);
      const preset = AVAILABILITY_PRESETS[f.preset.value];
      app.store.mutate((v) => {
        v.settings = { ...v.settings, availability: structuredClone(preset.days), maxDailyMinutes: Number(f.max.value), bufferHours: Number(f.buffer.value), updatedAt: Date.now() };
        v.onboarded = true;
      }, { undo: false });
      if (dlg.returnValue === 'import') app.openImport();
    },
  });
}

export { parseWhen };
