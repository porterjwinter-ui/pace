// Import calendars from a file, a link, or pasted text.
import { $, $$, html, raw, render, icon, modal } from './dom.js';
import { addDays, fmtDuration } from '../dates.js';
import { COLORS } from '../events.js';
import { parseCalendarText, fetchCalendarUrl, detectFormat } from '../import.js';
import { uid } from '../store.js';
import * as ops from '../ops.js';

const range = () => [addDays(new Date(), -120), addDays(new Date(), 400)];
const ASSIGNMENT_HINT = /canvas|instructure|schoology|blackboard|moodle|brightspace|d2l|classroom|assignments?/i;

export async function parseFromUrl(url, proxy) {
  const text = await fetchCalendarUrl(url, { proxy });
  const [rangeStart, rangeEnd] = range();
  return parseCalendarText(text, { filename: url, rangeStart, rangeEnd });
}

/** Re-fetch every linked calendar (on open, at most every 3 hours). */
export async function refreshLinkedCalendars(store, { force = false, only = null } = {}) {
  const due = store.v.calendars.filter((c) => c.kind === 'ics-url' && c.url && (!only || c.id === only)
    && (force || Date.now() - (c.lastFetched || 0) > 3 * 3600e3));
  const results = [];
  for (const c of due) {
    try {
      const parsed = await parseFromUrl(c.url, store.v.settings.corsProxy);
      ops.applyImport(store, { ...c }, parsed);
      results.push({ calendar: c, ok: true });
    } catch (e) {
      results.push({ calendar: c, ok: false, error: e.message });
    }
  }
  return results;
}

export function openImport(app, { file = null } = {}) {
  const store = app.store;
  let mode = 'file';
  let parsed = null;
  let source = null; // { kind, url?, name }
  let busy = false;
  let error = '';

  const dlg = modal(html`<div class="importer"></div>`, { cls: 'import-modal', label: 'Import a calendar' });
  const root = $('.importer', dlg);

  const draw = () => {
    const nextColor = COLORS[(store.v.calendars.length + 1) % COLORS.length].hex;
    const looksLikeSchool = parsed && (ASSIGNMENT_HINT.test(source?.url || '') || ASSIGNMENT_HINT.test(parsed.name || ''));
    render(root, html`
      <header class="row between"><h2>Import a calendar</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
      ${!parsed ? html`
        <p class="muted">Bring in Google Calendar, Apple Calendar, Outlook, a school portal like Canvas, or any .ics or .csv export. Busy events block time, so Pace plans around them.</p>
        <div class="seg small" role="tablist">
          ${[['file', 'File', 'upload'], ['url', 'Link', 'link'], ['paste', 'Paste', 'list']].map(([k, l, i]) => html`<button role="tab" data-mode="${k}" aria-selected="${mode === k}">${icon(i)} ${l}</button>`)}
        </div>
        ${mode === 'file' ? html`
          <label class="dropzone" tabindex="0">
            <input type="file" accept=".ics,.ical,.ifb,.vcs,.csv,.tsv,text/calendar,text/csv" hidden>
            ${icon('upload')}<b>Drop a calendar file here</b><span class="muted">or click to choose an .ics or .csv file</span>
          </label>
          <details class="howto"><summary>Where do I get a file?</summary>
            <ul>
              <li><b>Google Calendar:</b> Settings, Import and export, Export. Unzip it and import each .ics file.</li>
              <li><b>Apple Calendar:</b> select a calendar, then File, Export.</li>
              <li><b>Outlook:</b> File, Save Calendar, or Settings, Calendar, Shared calendars, Publish.</li>
            </ul>
          </details>` : mode === 'url' ? html`
          <form class="stack" data-url>
            <div class="field"><label for="imp-url">Calendar link</label>
              <input id="imp-url" name="url" type="url" placeholder="https://… or webcal://…" required autocomplete="off" spellcheck="false" autofocus>
              <p class="hint">Use the “secret address in iCal format” from Google, a public Apple or Outlook calendar link, or your school’s calendar feed. Pace re-checks links when you open it.</p></div>
            <div><button class="btn primary" ${busy ? raw('disabled') : ''}>${busy ? html`<span class="spinner"></span> Loading…` : 'Load calendar'}</button></div>
          </form>` : html`
          <form class="stack" data-paste>
            <textarea name="text" rows="8" placeholder="BEGIN:VCALENDAR…" spellcheck="false" aria-label="Calendar text"></textarea>
            <div><button class="btn primary">Read calendar</button></div>
          </form>`}
        ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
      ` : html`
        <div class="import-summary">
          <p><b>${parsed.events.length}</b> ${parsed.events.length === 1 ? 'event' : 'events'}${parsed.todos.length ? html` and <b>${parsed.todos.length}</b> to-dos` : ''} found.</p>
          ${parsed.warnings.length ? html`<details><summary class="small muted">${parsed.warnings.length} ${parsed.warnings.length === 1 ? 'note' : 'notes'} about this file</summary><ul class="small muted">${parsed.warnings.slice(0, 8).map((w) => html`<li>${w}</li>`)}</ul></details>` : ''}
        </div>
        <form class="stack" data-confirm>
          <div class="field"><label for="imp-name">Calendar name</label><input id="imp-name" name="name" value="${parsed.name || 'Imported'}" required></div>
          <div class="field"><label>Color</label>
            <div class="swatches">${COLORS.map((c) => html`<label title="${c.name}"><input type="radio" name="color" value="${c.hex}" ${c.hex === nextColor ? raw('checked') : ''}><span style="--c:${c.hex}"></span></label>`)}</div>
          </div>
          <fieldset class="field choice">
            <legend>What are these?</legend>
            <label class="option"><input type="radio" name="as" value="events" ${looksLikeSchool ? '' : raw('checked')}><span><b>Events</b><small>Things happening at a time, like classes or practice. Pace plans work around them.</small></span></label>
            <label class="option"><input type="radio" name="as" value="tasks" ${looksLikeSchool ? raw('checked') : ''}><span><b>Assignments to work on</b><small>Each one becomes a task due at that time, and Pace schedules the work before it.</small></span></label>
          </fieldset>
          <div class="field as-tasks" ${looksLikeSchool ? '' : raw('hidden')}><label for="imp-est">Time each assignment needs</label>
            <select id="imp-est" name="estimate">${[30, 60, 90, 120, 180, 240].map((m) => html`<option value="${m}" ${m === 60 ? raw('selected') : ''}>${fmtDuration(m)}</option>`)}</select>
            <p class="hint">A starting guess. Adjust any task afterwards.</p></div>
          <label class="check as-events" ${looksLikeSchool ? raw('hidden') : ''}><input type="checkbox" name="busy" checked> Keep time during these events free of work</label>
          <div class="row gap end"><button type="button" class="btn" data-back>Back</button><button class="btn primary">Import</button></div>
        </form>`}`);

    $('[data-close]', root).onclick = () => dlg.close();
    $$('[data-mode]', root).forEach((b) => b.onclick = () => { mode = b.dataset.mode; error = ''; draw(); });

    const zone = $('.dropzone', root);
    if (zone) {
      const input = $('input', zone);
      input.onchange = () => input.files[0] && readFile(input.files[0]);
      zone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
      zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readFile(f); };
    }
    $('[data-url]', root)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = e.target.url.value.trim();
      busy = true; error = ''; draw();
      try {
        parsed = await parseFromUrl(url, store.v.settings.corsProxy);
        source = { kind: 'ics-url', url };
      } catch (err) {
        error = err.code === 'CORS'
          ? 'That calendar’s server doesn’t allow browsers to load it directly. Download the .ics file and import it instead, or add a calendar proxy in Settings, Account and sync.'
          : err.message;
      }
      busy = false; draw();
    });
    $('[data-paste]', root)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await readText(e.target.text.value, 'pasted');
    });
    $('[data-back]', root)?.addEventListener('click', () => { parsed = null; draw(); });
    $$('[name=as]', root).forEach((r) => r.onchange = () => {
      $('.as-tasks', root).hidden = r.value !== 'tasks';
      $('.as-events', root).hidden = r.value === 'tasks';
    });
    $('[data-confirm]', root)?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const asTasks = f.elements.as.value === 'tasks';
      const cal = {
        id: uid('c_'),
        name: f.elements.name.value.trim() || 'Imported',
        color: f.querySelector('[name=color]:checked')?.value || nextColor,
        kind: source.kind,
        url: source.url || null,
        visible: true,
        blocksTime: asTasks ? false : f.elements.busy.checked,
        asTasks,
        taskEstimate: asTasks ? Number(f.elements.estimate.value) : null,
      };
      const res = ops.applyImport(store, cal, parsed);
      dlg.close();
      app.toast(asTasks
        ? `Added ${res.tasks} ${res.tasks === 1 ? 'assignment' : 'assignments'} as tasks and scheduled the work.`
        : `Imported ${res.events} events into “${cal.name}”.${res.tasks ? ` Also added ${res.tasks} to-dos as tasks.` : ''}`, { undo: true });
    });
  };

  async function readText(text, filename) {
    error = '';
    try {
      if (detectFormat(text, filename) === 'unknown') throw new Error('That doesn’t look like a calendar. Pace reads .ics (iCalendar) and .csv files.');
      const [rangeStart, rangeEnd] = range();
      parsed = await parseCalendarText(text, { filename, rangeStart, rangeEnd });
      source = { kind: 'ics-file' };
    } catch (err) {
      error = err.message;
    }
    draw();
  }

  async function readFile(f) {
    if (f.size > 25 * 1024 * 1024) { error = 'That file is over 25 MB. Export a smaller date range and try again.'; return draw(); }
    await readText(await f.text(), f.name);
  }

  draw();
  if (file) readFile(file);
  return dlg;
}
