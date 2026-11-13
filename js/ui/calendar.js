// Day / week / month views.
import { $, $$, html, raw, render, icon } from './dom.js';
import {
  addDays, addMinutes, dayKey, fmtHour, fmtTime, fmtWeekday, fmtDuration, minutesOfDay, parseDayKey,
  sameDay, startOfDay, startOfMonth, startOfWeek, MIN, DAY,
} from '../dates.js';
import { expandEvents } from '../events.js';
import { dueDate } from '../scheduler.js';
import * as ops from '../ops.js';

export const HOUR_PX = 48;
const SNAP = 15;

/** Everything visible in [from, to), normalized for rendering. */
export function collect(v, from, to) {
  const now = new Date();
  const tasks = new Map(v.tasks.map((t) => [t.id, t]));
  const events = expandEvents(v, from, to).map((e) => ({ kind: 'event', ...e, s: +e.start, e: +e.end }));
  const blocks = [];
  for (const b of v.blocks) {
    const s = +new Date(b.start), e = +new Date(b.end);
    if (e <= +from || s >= +to || b.status === 'skipped') continue;
    const t = tasks.get(b.taskId);
    if (!t) continue;
    const status = b.status === 'done' ? 'done' : e <= +now ? 'missed' : 'planned';
    blocks.push({ kind: 'block', id: b.id, taskId: t.id, title: t.title, color: t.color, s, e, status, pinned: b.pinned });
  }
  const dues = [];
  for (const t of v.tasks) {
    const d = dueDate(t);
    if (d < from || d >= to) continue;
    dues.push({ kind: 'due', id: t.id, title: t.title, color: t.color, at: d, done: t.status === 'done', risk: v.planInfo?.[t.id]?.risk });
  }
  return { events, blocks, dues };
}

function availableMinutes(v, day) {
  return (v.settings.availability[day.getDay()] || []).reduce((m, [a, b]) => m + (b - a), 0);
}

/** Overlap layout: assigns col / cols to each item. */
function layoutColumns(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = -Infinity;
  const flush = () => {
    const cols = [];
    for (const it of cluster) {
      let c = cols.findIndex((end) => end <= it.s);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = it.e;
      it.col = c;
    }
    for (const it of cluster) it.cols = cols.length;
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) { flush(); clusterEnd = -Infinity; }
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return items;
}

function itemHtml(it, day) {
  const dayStart = +startOfDay(day);
  const s = Math.max(it.s, dayStart), e = Math.min(it.e, dayStart + DAY);
  const top = ((s - dayStart) / MIN) * (HOUR_PX / 60);
  const height = Math.max(((e - s) / MIN) * (HOUR_PX / 60) - 2, 14);
  const w = 100 / it.cols;
  const style = `top:${top}px;height:${height}px;left:calc(${it.col * w}% + 1px);width:calc(${w}% - 3px);--c:${it.color}`;
  const short = height < 34;
  const time = `${fmtTime(new Date(it.s))} – ${fmtTime(new Date(it.e))}`;
  if (it.kind === 'block') {
    const dur = fmtDuration((it.e - it.s) / MIN);
    return html`<div class="item block ${it.status} ${it.pinned ? 'pinned' : ''} ${short ? 'short' : ''}" style="${style}" data-kind="block" data-id="${it.id}" tabindex="0"
        aria-label="${it.title}, ${time}, ${it.status}">
      <button class="tick" data-tick="${it.id}" aria-label="${it.status === 'done' ? 'Mark not done' : 'Check off'}">${icon('check')}</button>
      <div class="body"><div class="t">${it.title}</div>${short ? '' : html`<div class="m">${it.status === 'missed' ? 'Missed, ' : ''}${dur}${it.pinned ? raw(' <span class="pin-dot" title="Pinned">•</span>') : ''}</div>`}</div>
      <div class="resize" data-resize></div>
    </div>`;
  }
  return html`<div class="item event ${it.busy ? '' : 'free'} ${short ? 'short' : ''} ${it.readOnly ? 'ro' : ''}" style="${style}" data-kind="event" data-id="${it.id}" tabindex="0" aria-label="${it.title}, ${time}">
    <div class="body"><div class="t">${it.title}</div>${short ? html`<span class="m inline">${fmtTime(new Date(it.s))}</span>` : html`<div class="m">${time}</div>`}
    ${!short && it.location && height > 52 ? html`<div class="m">${it.location}</div>` : ''}</div>
    ${it.readOnly ? '' : raw('<div class="resize" data-resize></div>')}
  </div>`;
}

// ---------------------------------------------------------------- week/day
function renderTimeGrid(app, root, days) {
  const v = app.store.v;
  const from = days[0], to = addDays(days[days.length - 1], 1);
  const { events, blocks, dues } = collect(v, from, to);
  const today = new Date();
  const maxDaily = v.settings.maxDailyMinutes;

  // All-day lane: spanning events + due markers, packed into rows.
  const lane = [];
  for (const e of events.filter((x) => x.allDay)) {
    const a = Math.max(0, Math.round((startOfDay(e.start) - from) / DAY));
    const b = Math.min(days.length, Math.round((startOfDay(e.end) - from) / DAY) || a + 1);
    lane.push({ ...e, a, b: Math.max(b, a + 1) });
  }
  for (const d of dues) {
    const a = Math.round((startOfDay(d.at) - from) / DAY);
    lane.push({ ...d, a, b: a + 1 });
  }
  const rows = [];
  lane.sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a));
  for (const it of lane) {
    let r = rows.findIndex((end) => end <= it.a);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = it.b;
    it.row = r + 1;
  }

  const scroller = $('.scroller', root);
  const keepScroll = scroller ? scroller.scrollTop : null;
  const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(today).find((p) => p.type === 'timeZoneName')?.value || '';

  render(root, html`
    <div class="tg" style="--cols:${days.length}" data-cols="${days.length}">
      <div class="tg-head">
        <div class="gutter"><span class="tz">${tz}</span></div>
        <div class="tg-days">
          ${days.map((d) => {
            const k = dayKey(d);
            const dayBlocks = blocks.filter((b) => sameDay(new Date(b.s), d));
            const planned = dayBlocks.reduce((m, b) => m + (b.e - b.s) / MIN, 0);
            const done = dayBlocks.filter((b) => b.status === 'done').reduce((m, b) => m + (b.e - b.s) / MIN, 0);
            const capMin = Math.max(60, Math.min(maxDaily, availableMinutes(v, d)) || maxDaily);
            const label = planned ? `${fmtDuration(planned)} of work planned${done ? `, ${fmtDuration(done)} done` : ''}` : 'No work planned';
            return html`<button class="dayhead ${sameDay(d, today) ? 'today' : ''} ${d < startOfDay(today) ? 'past' : ''}" data-dayhead="${k}" title="${label}. Click to plan this day with the assistant.">
              <span class="wd">${fmtWeekday(d)}</span>
              <span class="num">${d.getDate()}</span>
              <span class="load" aria-label="${label}"><i class="done" style="width:${Math.min(100, (done / capMin) * 100)}%"></i><i style="width:${Math.min(100, ((planned - done) / capMin) * 100)}%"></i></span>
            </button>`;
          })}
        </div>
      </div>
      <div class="tg-allday ${lane.length ? '' : 'empty'}">
        <div class="gutter"></div>
        <div class="lane" style="grid-template-rows:repeat(${Math.max(1, rows.length)}, 22px)">
          ${lane.map((it) => it.kind === 'due'
            ? html`<button class="chip due ${it.done ? 'done' : ''} ${it.risk || ''}" style="grid-column:${it.a + 1}/${it.b + 1};grid-row:${it.row};--c:${it.color}" data-kind="task" data-id="${it.id}" title="${it.title} is due ${fmtTime(it.at)}">
                ${icon('flag')}<span>${it.title}</span><em>${fmtTime(it.at)}</em></button>`
            : html`<button class="chip allday" style="grid-column:${it.a + 1}/${it.b + 1};grid-row:${it.row};--c:${it.color}" data-kind="event" data-id="${it.id}">${it.title}</button>`)}
        </div>
      </div>
      <div class="scroller">
        <div class="tg-grid" style="height:${24 * HOUR_PX}px">
          <div class="hours">${Array.from({ length: 24 }, (_, h) => html`<div class="hour">${h ? html`<span>${fmtHour(h)}</span>` : ''}</div>`)}</div>
          <div class="cols">
            ${days.map((d) => {
              const k = dayKey(d);
              const items = layoutColumns([
                ...events.filter((e) => !e.allDay && e.s < +addDays(d, 1) && e.e > +d),
                ...blocks.filter((b) => b.s < +addDays(d, 1) && b.e > +d),
              ]);
              const avail = (v.settings.availability[d.getDay()] || []).map(([a, b]) => html`<div class="avail" style="top:${a * HOUR_PX / 60}px;height:${(b - a) * HOUR_PX / 60}px"></div>`);
              const isToday = sameDay(d, today);
              return html`<div class="col ${isToday ? 'today' : ''}" data-day="${k}">
                ${avail}
                ${items.map((it) => itemHtml(it, d))}
                ${isToday ? html`<div class="now" style="top:${minutesOfDay(today) * HOUR_PX / 60}px"></div>` : ''}
              </div>`;
            })}
          </div>
        </div>
      </div>
    </div>`);

  const sc = $('.scroller', root);
  $('.tg', root).style.setProperty('--sbw', `${sc.offsetWidth - sc.clientWidth}px`);
  if (keepScroll !== null && !app.ui.resetScroll) sc.scrollTop = keepScroll;
  else {
    const anyToday = days.some((d) => sameDay(d, today));
    const hour = anyToday ? Math.max(0, today.getHours() - 2) : v.settings.scrollHour ?? 8;
    sc.scrollTop = hour * HOUR_PX;
  }
  app.ui.resetScroll = false;
  bindTimeGrid(app, root, days);
}

function bindTimeGrid(app, root, days) {
  const store = app.store;
  const colsEl = $('.cols', root);
  const sc = $('.scroller', root);

  $$('[data-dayhead]', root).forEach((b) => b.onclick = () => app.openPanel(parseDayKey(b.dataset.dayhead), 'day'));
  $$('.lane [data-kind]', root).forEach((b) => b.onclick = () => app.showItem(b.dataset.kind, b.dataset.id, b));
  $$('[data-tick]', root).forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const blk = store.v.blocks.find((x) => x.id === b.dataset.tick);
    if (!blk) return;
    app.toggleBlock(blk);
  });

  const yToMin = (clientY) => {
    const r = colsEl.getBoundingClientRect();
    return Math.max(0, Math.min(24 * 60, ((clientY - r.top) / HOUR_PX) * 60));
  };
  const xToDay = (clientX) => {
    const r = colsEl.getBoundingClientRect();
    const i = Math.max(0, Math.min(days.length - 1, Math.floor(((clientX - r.left) / r.width) * days.length)));
    return days[i];
  };
  const snap = (m) => Math.round(m / SNAP) * SNAP;

  colsEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-tick]')) return;
    const itemEl = e.target.closest('.item');
    const touch = e.pointerType === 'touch';
    const startX = e.clientX, startY = e.clientY;
    let moved = false;

    if (!itemEl) {
      // Create: click for a 1h slot, or drag to size it.
      const day = xToDay(e.clientX);
      const anchor = snap(yToMin(e.clientY) - SNAP / 2);
      const col = colsEl.querySelector(`[data-day="${dayKey(day)}"]`);
      let ghost = null;
      let a = anchor, b = anchor + 60;
      const draw = () => {
        if (!ghost) { ghost = document.createElement('div'); ghost.className = 'ghost'; col.append(ghost); }
        ghost.style.top = `${Math.min(a, b) * HOUR_PX / 60}px`;
        ghost.style.height = `${Math.abs(b - a) * HOUR_PX / 60}px`;
        ghost.textContent = `${fmtTime(addMinutes(day, Math.min(a, b)))} – ${fmtTime(addMinutes(day, Math.max(a, b)))}`;
      };
      const move = (ev) => {
        if (touch) { if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) moved = true; return; }
        if (!moved && Math.abs(ev.clientY - startY) < 5) return;
        moved = true;
        const m = snap(yToMin(ev.clientY));
        a = m >= anchor ? anchor : m;
        b = m >= anchor ? Math.max(anchor + SNAP, m) : anchor + SNAP;
        draw();
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
      };
      const cancel = () => { cleanup(); ghost?.remove(); }; // the browser took over (scrolling)
      const up = () => {
        cleanup();
        if (touch && moved) return; // that was a scroll or swipe
        if (!moved) { a = anchor; b = anchor + 60; draw(); }
        const start = addMinutes(startOfDay(day), Math.min(a, b));
        const end = addMinutes(startOfDay(day), Math.max(a, b));
        app.openEditor({ start, end, anchor: ghost, onClose: () => ghost?.remove() });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      return;
    }

    // Existing item: click to open, drag to move, drag the bottom edge to resize.
    const kind = itemEl.dataset.kind, id = itemEl.dataset.id;
    const resizing = !!e.target.closest('[data-resize]');
    const info = kind === 'block' ? store.v.blocks.find((b) => b.id === id) : findInstance(app, id, days);
    const editable = kind === 'block' ? info && info.status !== 'done' : info && !info.readOnly;
    const s0 = info ? +new Date(info.start) : 0, e0 = info ? +new Date(info.end) : 0;
    const grabMin = yToMin(e.clientY);
    let ns = s0, ne = e0;
    let ghost = null;
    // Touch: hold for a moment to pick the item up; moving sooner is a scroll.
    let armed = !touch;
    let holdTimer = null;
    if (touch && editable) {
      holdTimer = setTimeout(() => {
        armed = true;
        itemEl.classList.add('armed');
        navigator.vibrate?.(12);
      }, 380);
    }
    const blockScroll = (ev) => { if (armed && touch) ev.preventDefault(); };
    colsEl.addEventListener('touchmove', blockScroll, { passive: false });

    const move = (ev) => {
      const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (!editable || !armed) { if (dist > 8) { moved = true; clearTimeout(holdTimer); } return; }
      if (!moved && dist < 5) return;
      if (!moved) {
        moved = true;
        ghost = itemEl.cloneNode(true);
        ghost.classList.add('dragging');
        itemEl.classList.add('drag-src');
      }
      const delta = snap(yToMin(ev.clientY) - grabMin) * MIN;
      if (resizing) {
        ns = s0;
        ne = Math.max(s0 + SNAP * MIN, e0 + delta);
      } else {
        const day = xToDay(ev.clientX);
        const origDay = startOfDay(new Date(s0));
        const shift = +startOfDay(day) - +origDay;
        ns = s0 + delta + shift;
        ne = e0 + delta + shift;
      }
      const dayOf = startOfDay(new Date(ns));
      const col = colsEl.querySelector(`[data-day="${dayKey(dayOf)}"]`);
      if (!col) return;
      if (ghost.parentNode !== col) col.append(ghost);
      ghost.style.left = '1px';
      ghost.style.width = 'calc(100% - 3px)';
      ghost.style.top = `${minutesOfDay(new Date(ns)) * HOUR_PX / 60}px`;
      ghost.style.height = `${Math.max(14, (ne - ns) / MIN * HOUR_PX / 60 - 2)}px`;
      const m = ghost.querySelector('.m');
      if (m) m.textContent = `${fmtTime(new Date(ns))} – ${fmtTime(new Date(ne))}`;
    };
    const cleanup = () => {
      clearTimeout(holdTimer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      colsEl.removeEventListener('touchmove', blockScroll);
      itemEl.classList.remove('armed');
    };
    const cancel = () => { cleanup(); ghost?.remove(); itemEl.classList.remove('drag-src'); };
    const up = () => {
      cleanup();
      if (!moved) { app.showItem(kind, id, itemEl); return; }
      if (!editable || !armed || !ghost) return;
      ghost.remove();
      itemEl.classList.remove('drag-src');
      if (ns === s0 && ne === e0) return;
      if (kind === 'block') {
        ops.moveBlock(store, id, ns, ne);
        app.toast('Session pinned. The rest of the plan moved around it.', { undo: true });
      } else {
        commitEventMove(app, info, ns, ne);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });

  // Keyboard: Enter opens the focused item.
  colsEl.addEventListener('keydown', (e) => {
    const it = e.target.closest?.('.item');
    if (it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); app.showItem(it.dataset.kind, it.dataset.id, it); }
  });
  void sc;
}

function findInstance(app, id, days) {
  const from = addDays(days[0], -1), to = addDays(days[days.length - 1], 2);
  return expandEvents(app.store.v, from, to).find((x) => x.id === id);
}

export function commitEventMove(app, inst, ns, ne) {
  const store = app.store;
  const toVal = (ms) => new Date(ms).toISOString();
  if (inst.recurring) {
    ops.overrideOccurrence(store, inst.eventId, inst.occurrence, { start: toVal(ns), end: toVal(ne) });
    app.toast('Moved this occurrence only.', { undo: true });
  } else {
    ops.updateEvent(store, inst.eventId, { start: toVal(ns), end: toVal(ne) });
    app.toast('Event moved. Your plan updated around it.', { undo: true });
  }
}

// ---------------------------------------------------------------- month
function renderMonth(app, root) {
  const v = app.store.v;
  const cursor = app.ui.cursor;
  const first = startOfMonth(cursor);
  const gridStart = startOfWeek(first, v.settings.weekStartsOn);
  const weeks = Math.ceil(((first - gridStart) / DAY + new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()) / 7);
  const gridEnd = addDays(gridStart, weeks * 7);
  const { events, blocks, dues } = collect(v, gridStart, gridEnd);
  const today = new Date();
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));
  const MAX = 3;

  render(root, html`
    <div class="month" style="--rows:${weeks}">
      <div class="m-head">${days.slice(0, 7).map((d) => html`<div>${fmtWeekday(d)}</div>`)}</div>
      <div class="m-grid">
        ${days.map((d) => {
          const next = addDays(d, 1);
          const items = [
            ...events.filter((e) => e.allDay && e.start < next && e.end > d).map((e) => ({ ...e, sort: 0 })),
            ...dues.filter((x) => sameDay(x.at, d)).map((x) => ({ ...x, sort: 1 })),
            ...events.filter((e) => !e.allDay && sameDay(e.start, d)).map((e) => ({ ...e, sort: 2 })),
          ].sort((a, b) => a.sort - b.sort || (a.s || 0) - (b.s || 0));
          const work = blocks.filter((b) => sameDay(new Date(b.s), d));
          const workMin = work.reduce((m, b) => m + (b.e - b.s) / MIN, 0);
          const doneMin = work.filter((b) => b.status === 'done').reduce((m, b) => m + (b.e - b.s) / MIN, 0);
          const shown = items.slice(0, MAX);
          const k = dayKey(d);
          return html`<div class="m-cell ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${sameDay(d, today) ? 'today' : ''} ${d < startOfDay(today) ? 'past' : ''}" data-cell="${k}">
            <button class="m-num" data-goto="${k}" aria-label="Open ${d.toDateString()}">${d.getDate() === 1 ? `${new Intl.DateTimeFormat(undefined, { month: 'short' }).format(d)} 1` : d.getDate()}</button>
            <div class="m-items">
              ${shown.map((it) => it.kind === 'due'
                ? html`<button class="m-item due ${it.done ? 'done' : ''} ${it.risk || ''}" style="--c:${it.color}" data-kind="task" data-id="${it.id}">${icon('flag')}<span>${it.title}</span></button>`
                : it.allDay
                  ? html`<button class="m-item allday" style="--c:${it.color}" data-kind="event" data-id="${it.id}"><span>${it.title}</span></button>`
                  : html`<button class="m-item timed" style="--c:${it.color}" data-kind="event" data-id="${it.id}"><i></i><em>${fmtTime(it.start)}</em><span>${it.title}</span></button>`)}
              ${items.length > MAX ? html`<button class="m-more" data-more="${k}">${items.length - MAX} more</button>` : ''}
            </div>
            ${workMin ? html`<div class="m-work" title="${fmtDuration(workMin)} of work planned"><span class="bar"><i style="width:${(doneMin / workMin) * 100}%"></i></span>${fmtDuration(workMin)}</div>` : ''}
          </div>`;
        })}
      </div>
    </div>`);

  $$('[data-goto]', root).forEach((b) => b.onclick = (e) => { e.stopPropagation(); app.setView('day', parseDayKey(b.dataset.goto)); });
  $$('.m-item', root).forEach((b) => b.onclick = (e) => { e.stopPropagation(); app.showItem(b.dataset.kind, b.dataset.id, b); });
  $$('[data-more]', root).forEach((b) => b.onclick = (e) => { e.stopPropagation(); app.openPanel(parseDayKey(b.dataset.more), 'day'); });
  $$('[data-cell]', root).forEach((c) => c.onclick = () => app.openPanel(parseDayKey(c.dataset.cell), 'day'));
  $$('[data-cell]', root).forEach((c) => c.ondblclick = () => {
    const d = parseDayKey(c.dataset.cell);
    d.setHours(9);
    app.openEditor({ start: d, end: addMinutes(d, 60), anchor: c });
  });
}

// ---------------------------------------------------------------- entry
export function viewDays(app) {
  const { view, cursor } = app.ui;
  if (view === 'day') return [startOfDay(cursor)];
  if (view === '3day') return [0, 1, 2].map((i) => addDays(startOfDay(cursor), i));
  const s = startOfWeek(cursor, app.store.v.settings.weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

export function renderCalendar(app, root) {
  root.dataset.view = app.ui.view;
  if (app.ui.view === 'month') renderMonth(app, root);
  else renderTimeGrid(app, root, viewDays(app));
}

/** Cheap per-minute refresh of the now line. */
export function tickNow(root) {
  const now = $('.now', root);
  if (now) now.style.top = `${minutesOfDay(new Date()) * HOUR_PX / 60}px`;
}
