// Create/edit dialog for tasks and events, plus detail popovers.
import { $, $$, html, raw, render, icon, modal, popover, closePopover, confirmDialog, esc } from './dom.js';
import {
  addDays, addMinutes, dayKey, fmtDayLong, fmtDayShort, fmtDuration, fmtRange, fmtTime, fmtRelativeDue, fmtWeekday,
  fromDateTimeInputs, parseDayKey, parseWhen, sameDay, startOfDay, toDateInput, toTimeInput, MIN,
} from '../dates.js';
import { COLORS, describeRepeat, expandEvents } from '../events.js';
import { dueDate, planSchedule, taskProgress } from '../scheduler.js';
import * as ops from '../ops.js';

const LAST_KIND = 'pace:lastKind';
const getLastKind = () => { try { return localStorage.getItem(LAST_KIND) || 'task'; } catch { return 'task'; } };
const setLastKind = (k) => { try { localStorage.setItem(LAST_KIND, k); } catch { /* ignore */ } };

/** "5h", "90m", "1.5", "2h 30m", "2:30" → minutes */
export function parseDuration(s) {
  const str = String(s).trim().toLowerCase();
  if (!str) return 0;
  if (/^\d+:\d{1,2}$/.test(str)) { const [h, m] = str.split(':').map(Number); return h * 60 + m; }
  let total = 0, matched = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)/g)) {
    matched = true;
    total += parseFloat(m[1]) * (m[2].startsWith('h') ? 60 : 1);
  }
  if (!matched && /^\d+(\.\d+)?$/.test(str)) total = parseFloat(str) * 60; // bare number = hours
  return Math.round(total);
}

const bufferLabel = (h) => (!h ? 'on the due date' : h % 24 === 0 ? `${h / 24} ${h === 24 ? 'day' : 'days'} early` : `${h} hours early`);
const BUFFER_OPTIONS = [[null, 'Default'], [0, 'On the due date'], [12, '12 hours early'], [24, '1 day early'], [48, '2 days early'], [72, '3 days early'], [168, '1 week early']];

function repeatOptions(start) {
  const wd = fmtWeekday(start, 'long');
  return [
    ['', 'Does not repeat'],
    ['daily', 'Every day'],
    ['weekdays', 'Every weekday (Mon–Fri)'],
    ['weekly', `Weekly on ${wd}`],
    ['biweekly', `Every 2 weeks on ${wd}`],
    ['custom', 'Weekly on certain days…'],
    ['monthly', `Monthly on day ${start.getDate()}`],
  ];
}

function repeatKey(r) {
  if (!r || !r.freq) return '';
  if (r.freq === 'daily') return 'daily';
  if (r.freq === 'monthly') return 'monthly';
  if (r.freq === 'weekly') {
    const d = r.byDay || [];
    if (d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x))) return 'weekdays';
    if (d.length > 1) return 'custom';
    return r.interval === 2 ? 'biweekly' : 'weekly';
  }
  return '';
}

function buildRepeat(key, start, customDays, until) {
  const base = { interval: 1, until: until || null };
  switch (key) {
    case 'daily': return { ...base, freq: 'daily' };
    case 'weekdays': return { ...base, freq: 'weekly', byDay: [1, 2, 3, 4, 5] };
    case 'weekly': return { ...base, freq: 'weekly', byDay: [start.getDay()] };
    case 'biweekly': return { ...base, freq: 'weekly', interval: 2, byDay: [start.getDay()] };
    case 'custom': return { ...base, freq: 'weekly', byDay: customDays.length ? customDays : [start.getDay()] };
    case 'monthly': return { ...base, freq: 'monthly' };
    default: return null;
  }
}

/** Describe how the scheduler would spread a draft task. */
function previewPlan(v, draft) {
  const sim = { ...v, tasks: [...v.tasks.filter((t) => t.id !== draft.id), draft] };
  const { blocks, info } = planSchedule(sim);
  const now = new Date();
  const mine = blocks.filter((b) => b.taskId === draft.id && b.status === 'planned' && new Date(b.end) > now);
  const byDay = new Map();
  for (const b of mine) {
    const k = dayKey(new Date(b.start));
    byDay.set(k, (byDay.get(k) || 0) + (new Date(b.end) - new Date(b.start)) / MIN);
  }
  const i = info[draft.id] || {};
  return { days: [...byDay.entries()].map(([k, m]) => ({ d: parseDayKey(k), m })), risk: i.risk, unplaced: i.unplaced || 0 };
}

function previewHtml(p, draft) {
  if (!draft.estimateMin) return html`<p class="muted">Add how long this will take and Pace will find the time.</p>`;
  if (!p.days.length) {
    return html`<p class="warn-text">${icon('alert')} There’s no free time before it’s due. Try a later due date or widen your work hours in Settings.</p>`;
  }
  const max = Math.max(...p.days.map((x) => x.m));
  const total = p.days.reduce((s, x) => s + x.m, 0);
  return html`
    <div class="spread">
      ${p.days.slice(0, 14).map((x) => html`<div class="spread-day" title="${fmtDayShort(x.d)}: ${fmtDuration(x.m)}">
        <i style="height:${Math.max(12, (x.m / max) * 100)}%"></i><span>${fmtWeekday(x.d, 'narrow')}</span></div>`)}
    </div>
    <p class="${p.risk === 'late' ? 'warn-text' : 'muted'}">
      ${p.risk === 'late'
        ? html`${icon('alert')} Only ${fmtDuration(total)} fits before it’s due. ${fmtDuration(p.unplaced)} won’t be scheduled.`
        : html`${fmtDuration(total)} across ${p.days.length} ${p.days.length === 1 ? 'day' : 'days'}, done by ${fmtDayShort(p.days[p.days.length - 1].d)}.${p.risk === 'tight' ? ' This uses your buffer time.' : ''}`}
    </p>`;
}

/**
 * Open the editor.
 * opts: { start, end, kind, taskId, eventId, occurrence, prefill, onClose }
 */
export function openEditor(app, opts = {}) {
  closePopover();
  const v = app.store.v;
  const editingTask = opts.taskId ? v.tasks.find((t) => t.id === opts.taskId) : null;
  const editingEvent = opts.eventId ? v.events.find((e) => e.id === opts.eventId) : null;
  let kind = editingTask ? 'task' : editingEvent ? 'event' : opts.kind || getLastKind();
  const isEdit = !!(editingTask || editingEvent);

  const now = new Date();
  const start = opts.start || (() => { const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; })();
  const end = opts.end || addMinutes(start, 60);
  const pre = opts.prefill || {};
  const defaultDue = opts.start ? start : (() => { const d = addDays(startOfDay(now), 7); d.setHours(23, 59); return d; })();

  const t = editingTask || {};
  const due = editingTask ? dueDate(editingTask) : pre.due ? parseWhen(pre.due) : defaultDue;
  const ev = editingEvent || {};
  const evStart = editingEvent ? parseWhen(ev.start) : start;
  const evEnd = editingEvent ? parseWhen(ev.end) : end;
  const evAllDay = editingEvent ? ev.allDay : false;
  const personalCals = v.calendars.filter((c) => c.kind === 'personal');

  const dlg = modal(html`
    <form class="editor" method="dialog" novalidate>
      <header class="editor-head">
        ${isEdit ? html`<h2>${kind === 'task' ? 'Edit task' : 'Edit event'}</h2>` : html`
          <div class="seg small" role="tablist" aria-label="Type">
            <button type="button" role="tab" data-kind="task" aria-selected="${kind === 'task'}">${icon('task')} Task</button>
            <button type="button" role="tab" data-kind="event" aria-selected="${kind === 'event'}">${icon('event')} Event</button>
          </div>`}
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </header>
      <input class="title-input" name="title" placeholder="${kind === 'task' ? 'What do you need to get done?' : 'Add title'}" value="${t.title || ev.title || pre.title || ''}" autocomplete="off" autofocus>

      <div class="kind-task" ${kind !== 'task' ? raw('hidden') : ''}>
        <div class="grid2">
          <div class="field"><label>Due</label>
            <div class="row gap-s"><input type="date" name="dueDate" value="${toDateInput(due)}"><input type="time" name="dueTime" value="${toTimeInput(due)}"></div>
          </div>
          <div class="field"><label for="ed-est">Time needed</label>
            <input id="ed-est" name="estimate" placeholder="e.g. 5h or 90m" value="${t.estimateMin ? fmtDuration(t.estimateMin) : pre.estimateMin ? fmtDuration(pre.estimateMin) : ''}" autocomplete="off">
          </div>
        </div>
        <div class="chips" role="group" aria-label="Quick durations">
          ${['30m', '1h', '2h', '3h', '5h', '8h', '10h'].map((d) => html`<button type="button" class="chip-btn" data-est="${d}">${d}</button>`)}
        </div>
        <div class="preview" aria-live="polite"></div>
        <div class="grid2">
          <div class="field"><label for="ed-mode">How to schedule</label>
            <select id="ed-mode" name="mode">
              <option value="spread" ${t.mode !== 'asap' ? raw('selected') : ''}>Spread across days</option>
              <option value="asap" ${t.mode === 'asap' ? raw('selected') : ''}>As soon as possible</option>
            </select></div>
          <div class="field"><label for="ed-buf">Finish</label>
            <select id="ed-buf" name="buffer">
              ${BUFFER_OPTIONS.map(([val, label]) => html`<option value="${val ?? ''}" ${(t.bufferHours ?? null) === val ? raw('selected') : ''}>${val === null ? `Default (${bufferLabel(v.settings.bufferHours)})` : label}</option>`)}
            </select></div>
        </div>
        <div class="field"><label>Priority</label>
          <div class="seg small wide" role="radiogroup">
            ${[[1, 'Low'], [2, 'Normal'], [3, 'High']].map(([p, l]) => html`<label><input type="radio" name="priority" value="${p}" ${(t.priority || 2) === p ? raw('checked') : ''}><span>${l}</span></label>`)}
          </div>
        </div>
      </div>

      <div class="kind-event" ${kind !== 'event' ? raw('hidden') : ''}>
        <div class="field"><label>When</label>
          <div class="row gap-s wrap">
            <input type="date" name="evDate" value="${toDateInput(evStart)}">
            <span class="timebits row gap-s" ${evAllDay ? raw('hidden') : ''}><input type="time" name="evStart" value="${toTimeInput(evStart)}"><span class="muted">to</span><input type="time" name="evEnd" value="${toTimeInput(evEnd)}"></span>
            <label class="check"><input type="checkbox" name="allDay" ${evAllDay ? raw('checked') : ''}> All day</label>
          </div>
        </div>
        <div class="grid2">
          <div class="field"><label for="ed-rep">Repeat</label>
            <select id="ed-rep" name="repeat">${repeatOptions(evStart).map(([k, l]) => html`<option value="${k}" ${repeatKey(ev.repeat) === k ? raw('selected') : ''}>${l}</option>`)}</select>
          </div>
          <div class="field until" ${ev.repeat?.freq ? '' : raw('hidden')}><label for="ed-until">Until</label>
            <input id="ed-until" type="date" name="until" value="${ev.repeat?.until || ''}"></div>
        </div>
        <div class="weekdays" ${repeatKey(ev.repeat) === 'custom' ? '' : raw('hidden')} role="group" aria-label="Days">
          ${[0, 1, 2, 3, 4, 5, 6].map((d) => html`<label><input type="checkbox" name="byDay" value="${d}" ${(ev.repeat?.byDay || []).includes(d) ? raw('checked') : ''}><span>${fmtWeekday(new Date(2023, 0, 1 + d), 'narrow')}</span></label>`)}
        </div>
        <label class="check"><input type="checkbox" name="busy" ${ev.busy === false ? '' : raw('checked')}> Keep this time free of work sessions</label>
        <div class="grid2">
          <div class="field"><label for="ed-loc">Location</label><input id="ed-loc" name="location" value="${ev.location || ''}" autocomplete="off"></div>
          ${personalCals.length > 1 ? html`<div class="field"><label for="ed-cal">Calendar</label><select id="ed-cal" name="calendarId">${personalCals.map((c) => html`<option value="${c.id}" ${(ev.calendarId || 'personal') === c.id ? raw('selected') : ''}>${c.name}</option>`)}</select></div>` : ''}
        </div>
      </div>

      <div class="field"><label for="ed-notes">Notes</label><textarea id="ed-notes" name="notes" rows="2">${t.notes || ev.notes || pre.notes || ''}</textarea></div>
      <div class="field"><label>Color</label>
        <div class="swatches" role="radiogroup">
          ${COLORS.map((c) => html`<label title="${c.name}"><input type="radio" name="color" value="${c.hex}" ${(t.color || ev.color || pre.color) === c.hex ? raw('checked') : ''}><span style="--c:${c.hex}"></span></label>`)}
        </div>
      </div>
      <p class="error" role="alert" hidden></p>
      <footer class="row gap">
        ${isEdit ? html`<button type="button" class="btn danger-text" data-delete>${icon('trash')} Delete</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">${isEdit ? 'Save' : kind === 'task' ? 'Add task' : 'Add event'}</button>
      </footer>
    </form>`, { cls: 'editor-modal', label: 'Edit', onClose: opts.onClose });

  const form = $('form', dlg);
  const errEl = $('.error', form);
  const showError = (m) => { errEl.textContent = m; errEl.hidden = !m; };

  const setKind = (k) => {
    kind = k;
    $$('[data-kind]', form).forEach((b) => b.setAttribute('aria-selected', b.dataset.kind === k));
    $('.kind-task', form).hidden = k !== 'task';
    $('.kind-event', form).hidden = k !== 'event';
    form.elements.title.placeholder = k === 'task' ? 'What do you need to get done?' : 'Add title';
    $('[type=submit]', form).textContent = isEdit ? 'Save' : k === 'task' ? 'Add task' : 'Add event';
    if (k === 'task') updatePreview();
  };
  $$('[data-kind]', form).forEach((b) => b.onclick = () => setKind(b.dataset.kind));
  $$('[data-close]', form).forEach((b) => b.onclick = () => dlg.close());
  $$('[data-est]', form).forEach((b) => b.onclick = () => { form.estimate.value = b.dataset.est; updatePreview(); });

  const draftTask = () => {
    const d = fromDateTimeInputs(form.dueDate.value, form.dueTime.value || '23:59');
    return {
      ...t,
      id: t.id || '__draft__',
      title: form.elements.title.value,
      due: isNaN(d) ? null : d.toISOString(),
      estimateMin: parseDuration(form.estimate.value),
      mode: form.mode.value,
      bufferHours: form.buffer.value === '' ? null : Number(form.buffer.value),
      priority: Number(form.querySelector('[name=priority]:checked')?.value || 2),
      status: 'open',
      createdAt: t.createdAt || Date.now(),
    };
  };
  let pv;
  const updatePreview = () => {
    clearTimeout(pv);
    pv = setTimeout(() => {
      const d = draftTask();
      const el = $('.preview', form);
      if (!el) return;
      if (!d.due) return render(el, html``);
      render(el, previewHtml(previewPlan(app.store.v, d), d));
    }, 120);
  };
  ['dueDate', 'dueTime', 'estimate', 'mode', 'buffer'].forEach((n) => form[n].addEventListener('input', updatePreview));
  $$('[name=priority]', form).forEach((r) => r.addEventListener('change', updatePreview));
  if (kind === 'task') updatePreview();

  form.allDay.onchange = () => { $('.timebits', form).hidden = form.allDay.checked; };
  form.repeat.onchange = () => {
    $('.weekdays', form).hidden = form.repeat.value !== 'custom';
    $('.until', form).hidden = !form.repeat.value;
  };

  $('[data-delete]', form)?.addEventListener('click', async () => {
    if (editingTask) {
      dlg.close();
      ops.deleteTask(app.store, editingTask.id);
      app.toast(`Deleted “${editingTask.title}”.`, { undo: true });
    } else if (editingEvent) {
      await deleteEventFlow(app, editingEvent, opts.occurrence);
      dlg.close();
    }
  });

  form.onsubmit = (e) => {
    e.preventDefault();
    const title = form.elements.title.value.trim();
    const color = form.querySelector('[name=color]:checked')?.value || null;
    const notes = form.notes.value;
    if (kind === 'task') {
      const d = draftTask();
      if (!title) return showError('Give the task a name.');
      if (!d.due) return showError('Pick a due date.');
      if (!d.estimateMin) return showError('Enter how long it will take, like 2h or 45m.');
      const fields = { title, due: d.due, estimateMin: d.estimateMin, mode: d.mode, bufferHours: d.bufferHours, priority: d.priority, notes, ...(color ? { color } : {}) };
      setLastKind('task');
      dlg.close();
      if (editingTask) ops.updateTask(app.store, editingTask.id, fields);
      else {
        const task = ops.createTask(app.store, { ...fields, source: pre.source || null });
        const p = taskProgress(app.store.v, task);
        const info = p.info || {};
        app.toast(info.risk === 'late'
          ? `Added. ${fmtDuration(info.unplaced)} won’t fit before it’s due.`
          : `Added “${task.title}”. ${fmtDuration(p.planned)} scheduled before it’s due.`, { undo: true });
      }
      opts.afterSave?.();
    } else {
      if (!title) return showError('Give the event a name.');
      const allDay = form.allDay.checked;
      let s, en;
      if (allDay) {
        s = form.evDate.value;
        const prevSpan = editingEvent?.allDay ? Math.max(1, Math.round((parseDayKey(editingEvent.end) - parseDayKey(editingEvent.start)) / 864e5)) : 1;
        en = dayKey(addDays(parseDayKey(s), prevSpan));
      } else {
        const a = fromDateTimeInputs(form.evDate.value, form.evStart.value);
        let b = fromDateTimeInputs(form.evDate.value, form.evEnd.value);
        if (b <= a) b = addDays(b, 1); // ends after midnight
        s = a.toISOString(); en = b.toISOString();
      }
      const startD = parseWhen(s);
      const byDay = $$('[name=byDay]:checked', form).map((x) => Number(x.value));
      const fields = {
        title, start: s, end: en, allDay, busy: form.busy.checked,
        repeat: buildRepeat(form.repeat.value, startD, byDay, form.until.value),
        location: form.location.value, notes, color,
        calendarId: form.calendarId?.value || ev.calendarId || 'personal',
      };
      setLastKind('event');
      dlg.close();
      if (editingEvent) ops.updateEvent(app.store, editingEvent.id, fields);
      else ops.createEvent(app.store, fields);
      app.toast(editingEvent ? 'Event saved.' : `Added “${title}”. Your plan moved around it.`, { undo: true });
    }
  };
  return dlg;
}

async function deleteEventFlow(app, ev, occurrence) {
  if (ev.repeat?.freq && occurrence) {
    const scope = await confirmDialog({
      title: 'Delete repeating event',
      choices: [{ value: 'one', label: 'Only this one' }, { value: 'all', label: 'All events', danger: true }],
    });
    if (!scope) return false;
    ops.deleteEvent(app.store, ev.id, { occurrence, scope });
  } else {
    ops.deleteEvent(app.store, ev.id);
  }
  app.toast(`Deleted “${ev.title}”.`, { undo: true });
  return true;
}

// ---------------------------------------------------------------- details

const RISK_TEXT = {
  ok: 'On track',
  tight: 'Using buffer time',
  late: 'Not enough time',
  overdue: 'Overdue',
};

function taskSummary(v, task) {
  const p = taskProgress(v, task);
  const info = p.info || {};
  const due = dueDate(task);
  let line;
  if (task.status === 'done') line = 'Completed';
  else if (info.risk === 'late') line = `${fmtDuration(info.unplaced)} doesn’t fit before it’s due`;
  else if (info.risk === 'overdue') line = 'Past due. Pace scheduled the rest as soon as possible.';
  else if (p.done >= p.est) line = 'All the time is done. Mark it complete?';
  else if (info.finish) line = `Scheduled to finish ${fmtDayShort(new Date(info.finish))}`;
  else line = '';
  return { p, info, due, line };
}

export function showTask(app, id, anchor) {
  const v = app.store.v;
  const task = v.tasks.find((t) => t.id === id);
  if (!task) return;
  const { p, info, due, line } = taskSummary(v, task);
  const upcoming = v.blocks.filter((b) => b.taskId === id && b.status === 'planned' && new Date(b.end) > new Date())
    .sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 5);
  const pop = popover(anchor, html`
    <div class="pop-head" style="--c:${task.color}">
      <span class="sw"></span>
      <div><h3 class="${task.status === 'done' ? 'struck' : ''}">${task.title}</h3>
      <p class="muted">Due ${fmtRelativeDue(due)}${task.status !== 'done' && info.risk && info.risk !== 'ok' ? html` <span class="risk ${info.risk}">${RISK_TEXT[info.risk]}</span>` : ''}</p></div>
      <button class="icon-btn" data-x aria-label="Close">${icon('x')}</button>
    </div>
    <div class="progress"><i style="width:${p.pct * 100}%;--c:${task.color}"></i></div>
    <p class="small muted">${fmtDuration(p.done)} of ${fmtDuration(p.est)} done${p.planned ? `, ${fmtDuration(p.planned)} planned` : ''}${p.missed ? `, ${fmtDuration(p.missed)} missed` : ''}${line ? `. ${line}` : ''}</p>
    ${upcoming.length ? html`<ul class="sessions">${upcoming.map((b) => html`<li><span>${fmtDayShort(new Date(b.start))}</span><span class="muted">${fmtRange(new Date(b.start), new Date(b.end))}</span>${b.pinned ? html`<span class="muted" title="Pinned">${icon('pin')}</span>` : ''}</li>`)}</ul>` : ''}
    ${task.notes ? html`<p class="notes">${task.notes}</p>` : ''}
    <div class="pop-actions">
      ${task.status === 'done'
        ? html`<button class="btn" data-reopen>Reopen</button>`
        : html`<button class="btn primary" data-complete>${icon('check')} Mark complete</button>`}
      <button class="btn" data-edit>${icon('edit')} Edit</button>
      <button class="icon-btn" data-del aria-label="Delete task" title="Delete">${icon('trash')}</button>
    </div>`, { cls: 'detail' });

  $('[data-x]', pop).onclick = closePopover;
  $('[data-edit]', pop).onclick = () => openEditor(app, { taskId: id });
  $('[data-complete]', pop)?.addEventListener('click', () => { closePopover(); app.completeTask(task); });
  $('[data-reopen]', pop)?.addEventListener('click', () => { closePopover(); ops.updateTask(app.store, id, { status: 'open' }); app.toast('Task reopened and rescheduled.', { undo: true }); });
  $('[data-del]', pop).onclick = () => { closePopover(); ops.deleteTask(app.store, id); app.toast(`Deleted “${task.title}”.`, { undo: true }); };
}

function showBlock(app, id, anchor) {
  const v = app.store.v;
  const b = v.blocks.find((x) => x.id === id);
  if (!b) return;
  const task = v.tasks.find((t) => t.id === b.taskId);
  const s = new Date(b.start), e = new Date(b.end);
  const missed = b.status === 'planned' && e <= new Date();
  const { p, due } = taskSummary(v, task);
  const pop = popover(anchor, html`
    <div class="pop-head" style="--c:${task.color}">
      <span class="sw ring"></span>
      <div><h3>${task.title}</h3>
      <p class="muted">${fmtDayLong(s)}, ${fmtRange(s, e)}</p></div>
      <button class="icon-btn" data-x aria-label="Close">${icon('x')}</button>
    </div>
    <p class="small">${b.status === 'done' ? 'You checked this session off.' : missed ? 'This session was missed. Check it off if you did it, or skip it and Pace will make up the time.' : `A ${fmtDuration((e - s) / MIN)} work session${b.pinned ? ', pinned to this time' : ''}.`}</p>
    <div class="progress"><i style="width:${p.pct * 100}%;--c:${task.color}"></i></div>
    <p class="small muted">${fmtDuration(p.done)} of ${fmtDuration(p.est)} done. Due ${fmtRelativeDue(due)}.</p>
    <div class="pop-actions">
      ${b.status === 'done'
        ? html`<button class="btn" data-undone>Mark not done</button>`
        : html`<button class="btn primary" data-done>${icon('check')} Check off</button>${missed ? html`<button class="btn" data-skip>Skip</button>` : ''}`}
      ${b.pinned && b.status !== 'done' ? html`<button class="btn" data-unpin>Unpin</button>` : ''}
      <button class="btn" data-task>Task details</button>
    </div>`, { cls: 'detail' });
  $('[data-x]', pop).onclick = closePopover;
  $('[data-done]', pop)?.addEventListener('click', () => { closePopover(); app.toggleBlock(b); });
  $('[data-undone]', pop)?.addEventListener('click', () => { closePopover(); app.toggleBlock(b); });
  $('[data-skip]', pop)?.addEventListener('click', () => { closePopover(); ops.setBlockStatus(app.store, id, 'skipped'); app.toast('Skipped. The time was added back to the plan.', { undo: true }); });
  $('[data-unpin]', pop)?.addEventListener('click', () => { closePopover(); ops.unpinBlock(app.store, id); app.toast('Unpinned. Pace can move this session again.', { undo: true }); });
  $('[data-task]', pop).onclick = () => showTask(app, task.id, anchor);
}

function showEvent(app, id, anchor) {
  const v = app.store.v;
  const [eventId, occurrence] = id.split('@');
  const ev = v.events.find((x) => x.id === eventId);
  if (!ev) return;
  const cal = v.calendars.find((c) => c.id === ev.calendarId);
  const readOnly = cal?.kind !== 'personal';
  const inst = (() => {
    const day = occurrence ? parseDayKey(occurrence) : startOfDay(parseWhen(ev.start));
    return expandEvents(v, addDays(day, -2), addDays(day, 3), { includeHidden: true }).find((x) => x.id === id);
  })() || { start: parseWhen(ev.start), end: parseWhen(ev.end), allDay: ev.allDay };
  const when = inst.allDay
    ? (() => { const last = addDays(inst.end, -1); return sameDay(inst.start, last) ? fmtDayLong(inst.start) : `${fmtDayShort(inst.start)} – ${fmtDayShort(last)}`; })()
    : `${fmtDayLong(inst.start)}, ${fmtRange(inst.start, inst.end)}`;
  const busy = ev.busy !== false && !ev.allDay && cal?.blocksTime !== false;
  const pop = popover(anchor, html`
    <div class="pop-head" style="--c:${ev.color || cal?.color}">
      <span class="sw"></span>
      <div><h3>${ev.title}</h3><p class="muted">${when}</p>
      ${ev.repeat?.freq ? html`<p class="muted small">${icon('repeat')} ${describeRepeat(ev.repeat, parseWhen(ev.start))}</p>` : ''}</div>
      <button class="icon-btn" data-x aria-label="Close">${icon('x')}</button>
    </div>
    ${ev.location ? html`<p class="small">${ev.location}</p>` : ''}
    ${ev.notes ? html`<p class="notes">${ev.notes.slice(0, 1200)}</p>` : ''}
    <p class="small muted">${cal?.name}${readOnly ? ', imported' : ''}. ${busy ? 'Work won’t be scheduled during this.' : 'Doesn’t block work time.'}</p>
    <div class="pop-actions">
      ${readOnly ? '' : html`<button class="btn" data-edit>${icon('edit')} Edit</button>`}
      ${!inst.allDay && readOnly ? html`<button class="btn" data-busy>${busy ? 'Allow work during this' : 'Block work during this'}</button>` : ''}
      <button class="btn" data-totask title="Create a task due at this time">Make it a task</button>
      ${readOnly ? '' : html`<button class="icon-btn" data-del aria-label="Delete event" title="Delete">${icon('trash')}</button>`}
    </div>`, { cls: 'detail' });
  $('[data-x]', pop).onclick = closePopover;
  $('[data-edit]', pop)?.addEventListener('click', () => openEditor(app, { eventId, occurrence }));
  $('[data-del]', pop)?.addEventListener('click', async () => { closePopover(); await deleteEventFlow(app, ev, occurrence); });
  $('[data-busy]', pop)?.addEventListener('click', () => {
    closePopover();
    ops.updateEvent(app.store, eventId, { busy: !busy, userBusy: !busy });
    app.toast(busy ? 'Pace can now schedule work during this event.' : 'Pace will keep this time free.', { undo: true });
  });
  $('[data-totask]', pop).onclick = () => {
    const due = inst.allDay ? (() => { const d = new Date(inst.start); d.setHours(23, 59); return d; })() : inst.start;
    openEditor(app, { kind: 'task', prefill: { title: ev.title, due: due.toISOString(), notes: ev.notes?.slice(0, 2000), color: ev.color || cal?.color } });
  };
}

export function showItem(app, kind, id, anchor) {
  if (kind === 'block') showBlock(app, id, anchor);
  else if (kind === 'task') showTask(app, id, anchor);
  else showEvent(app, id, anchor);
}

export { esc };
