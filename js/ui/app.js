import { $, $$, html, raw, render, icon, toast as showToast, popover, closePopover, confirmDialog } from './dom.js';
import {
  addDays, addMonths, dayKey, fmtDayLong, fmtDuration, fmtMonth, fmtMonthYear, fmtWeekday, parseDayKey, sameDay,
  setClock, startOfDay, startOfMonth, startOfWeek, MIN,
} from '../dates.js';
import { COLORS } from '../events.js';
import { dueDate, taskProgress } from '../scheduler.js';
import { renderCalendar, viewDays, tickNow } from './calendar.js';
import { openEditor, showItem, showTask } from './editor.js';
import { createPanel, taskRow } from './panel.js';
import { openSettings, openOnboarding } from './settings.js';
import { openImport, refreshLinkedCalendars } from './importer.js';
import { logoMark } from './auth.js';
import { signOut } from '../account.js';
import * as ops from '../ops.js';

const VIEW_KEY = 'pace:view';
const SIDEBAR_KEY = 'pace:sidebar';
const ls = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const narrow = () => window.innerWidth < 760;

export function startApp(root, store, session, { onSignOut, isNew = false }) {
  const app = {
    store,
    session,
    ui: {
      view: ls.get(VIEW_KEY, narrow() ? 'day' : 'week'),
      cursor: new Date(),
      panel: null,
      sidebar: narrow() ? false : ls.get(SIDEBAR_KEY, '1') === '1',
      showAllTasks: false,
      showDone: false,
      miniCursor: startOfMonth(new Date()),
      resetScroll: true,
      screen: 'calendar', // phone tabs: calendar | tasks
      miniOpen: false,
    },
  };

  // ---------------------------------------------------------- shell
  render(root, html`
    <div class="app ${app.ui.sidebar ? '' : 'no-sidebar'}">
      <header class="topbar">
        <button class="icon-btn wide-only" data-menu aria-label="Toggle sidebar">${icon('menu')}</button>
        <a class="brand wide-only" href="./" aria-label="Pace home">${logoMark(26)}<span>Pace</span></a>
        <button class="btn today-btn" data-today aria-label="Today"><span class="wide-only">Today</span><span class="today-num phone-only" aria-hidden="true">${new Date().getDate()}</span></button>
        <div class="nav-arrows wide-only">
          <button class="icon-btn" data-prev aria-label="Previous">${icon('left')}</button>
          <button class="icon-btn" data-next aria-label="Next">${icon('right')}</button>
        </div>
        <button class="range-title" data-title aria-expanded="false" aria-live="polite"><span></span>${icon('down', 'phone-only')}</button>
        <div class="missed-slot"></div>
        <span class="grow"></span>
        <div class="seg view-seg" role="tablist" aria-label="View">
          ${[['day', 'Day', 'd'], ['week', 'Week', 'w'], ['month', 'Month', 'm']].map(([k, l, key]) => html`<button role="tab" data-view="${k}" title="${l} (${key})">${l}</button>`)}
        </div>
        <button class="icon-btn sync wide-only" data-sync aria-label="Sync status"></button>
        <button class="icon-btn wide-only" data-assistant aria-label="Open assistant" title="Assistant for today (a)">${icon('sparkle')}</button>
        <button class="icon-btn wide-only" data-settings aria-label="Settings" title="Settings">${icon('sliders')}</button>
        <button class="avatar" data-account aria-label="Account">${session.username.slice(0, 1).toUpperCase()}</button>
      </header>
      <aside class="sidebar" aria-label="Sidebar"></aside>
      <div class="scrim" data-scrim></div>
      <main class="main">
        <div class="mini-drop" hidden></div>
        <div class="calendar"></div>
        <div class="tasks-screen" hidden></div>
      </main>
      <aside class="panel" hidden aria-label="Day assistant"></aside>
      <button class="fab" data-fab aria-label="Add task">${icon('plus')}</button>
      <nav class="tabbar" aria-label="Sections">
        <button data-tab="calendar">${icon('calendar')}<span>Calendar</span></button>
        <button data-tab="tasks">${icon('task')}<span>Tasks</span></button>
        <button data-tab="assistant">${icon('sparkle')}<span>Assistant</span></button>
        <button data-tab="settings">${icon('sliders')}<span>Settings</span></button>
      </nav>
    </div>`);

  const shell = $('.app', root);
  const calEl = $('.calendar', root);
  const sideEl = $('.sidebar', root);
  const tasksEl = $('.tasks-screen', root);
  const miniEl = $('.mini-drop', root);
  const panel = createPanel(app, $('.panel', root));

  // ---------------------------------------------------------- API
  Object.assign(app, {
    render: () => schedule(),
    setView(view, date) {
      app.ui.view = view;
      if (date) app.ui.cursor = date;
      app.ui.resetScroll = true;
      ls.set(VIEW_KEY, view);
      renderAll();
    },
    go(dir) {
      const { view, cursor } = app.ui;
      app.ui.cursor = view === 'month' ? addMonths(startOfMonth(cursor), dir) : addDays(cursor, (view === 'day' ? 1 : 7) * dir);
      app.ui.miniCursor = startOfMonth(app.ui.cursor);
      renderAll();
    },
    today() { app.ui.cursor = new Date(); app.ui.miniCursor = startOfMonth(new Date()); app.ui.resetScroll = true; renderAll(); },
    openPanel(date, scope = 'day') {
      closePopover();
      app.ui.panel = { date: startOfDay(date), scope };
      app.ui.panelFocused = false;
      shell.classList.add('with-panel');
      panel.draw();
    },
    closePanel() { app.ui.panel = null; shell.classList.remove('with-panel'); panel.draw(); },
    showItem: (kind, id, anchor) => showItem(app, kind, id, anchor),
    openEditor: (opts) => openEditor(app, opts),
    openImport: (opts) => openImport(app, opts),
    openSettings: (tab) => openSettings(app, tab),
    toast(message, { undo = false, action, onAction, tone } = {}) {
      if (undo) showToast(message, { action: 'Undo', onAction: () => { const l = store.undo(); if (l) showToast(`Undid: ${l.toLowerCase()}`); }, tone });
      else showToast(message, { action, onAction, tone });
    },
    toggleBlock(blk) {
      const task = store.v.tasks.find((t) => t.id === blk.taskId);
      if (blk.status === 'done') {
        ops.setBlockStatus(store, blk.id, 'planned');
        app.toast('Unchecked. Pace updated your plan.', { undo: true });
        return;
      }
      ops.setBlockStatus(store, blk.id, 'done');
      const p = taskProgress(store.v, task);
      if (p.done >= p.est && task.status !== 'done') {
        app.toast(`All ${fmtDuration(p.est)} of “${task.title}” done.`, { action: 'Mark complete', onAction: () => app.completeTask(task) });
      } else {
        app.toast(`Nice. ${fmtDuration(Math.max(0, p.est - p.done))} left on “${task.title}”.`, { undo: true });
      }
    },
    completeTask(task) {
      ops.updateTask(store, task.id, { status: 'done' });
      app.toast(`Completed “${task.title}”.`, { undo: true });
    },
    applyTheme() {
      const t = store.v.settings.theme;
      if (t === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.dataset.theme = t;
    },
    async signOut(forget) {
      stop();
      await store.saveLocal().catch(() => {});
      if (store.dirty && session.gh) await store.sync().catch(() => {});
      await signOut({ forgetDevice: forget, userId: session.userId });
      onSignOut();
    },
  });

  // ---------------------------------------------------------- render
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); }

  function renderAll() {
    setClock(store.v.settings.clock);
    const phoneTasks = narrow() && app.ui.screen === 'tasks';
    renderTop();
    if (!narrow()) renderSidebar();
    calEl.hidden = phoneTasks;
    tasksEl.hidden = !phoneTasks;
    if (phoneTasks) renderTasksScreen();
    else renderCalendar(app, calEl);
    renderMiniDrop();
    $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === app.ui.screen && !(app.ui.panel && narrow()))));
    if (app.ui.panel) panel.draw();
  }

  function rangeTitle() {
    const { view, cursor } = app.ui;
    if (narrow()) {
      const sameYear = cursor.getFullYear() === new Date().getFullYear();
      const d = view === 'week' ? viewDays(app)[3] : cursor;
      return new Intl.DateTimeFormat(undefined, sameYear ? { month: 'long' } : { month: 'short', year: 'numeric' }).format(d);
    }
    if (view === 'month') return fmtMonthYear(cursor);
    if (view === 'day') return fmtDayLong(cursor);
    const days = viewDays(app);
    const a = days[0], b = days[days.length - 1];
    if (a.getMonth() === b.getMonth()) return fmtMonthYear(a);
    if (a.getFullYear() === b.getFullYear()) return `${fmtMonth(a)} – ${fmtMonth(b)} ${b.getFullYear()}`;
    return `${fmtMonth(a)} ${a.getFullYear()} – ${fmtMonth(b)} ${b.getFullYear()}`;
  }

  function missedBlocks() {
    const now = new Date(), cutoff = addDays(now, -14);
    return store.v.blocks.filter((b) => b.status === 'planned' && new Date(b.end) <= now && new Date(b.end) > cutoff
      && store.v.tasks.find((t) => t.id === b.taskId && t.status !== 'done'));
  }

  function renderTop() {
    $('.range-title span', root).textContent = app.ui.screen === 'tasks' && narrow() ? 'Tasks' : rangeTitle();
    $('[data-title]', root).setAttribute('aria-expanded', String(app.ui.miniOpen));
    $('[data-title]', root).classList.toggle('static', app.ui.screen === 'tasks' && narrow());
    $$('[data-view]', root).forEach((b) => b.setAttribute('aria-selected', b.dataset.view === app.ui.view));
    const missed = missedBlocks();
    const slot = $('.missed-slot', root);
    if (missed.length) {
      const mins = missed.reduce((m, b) => m + (new Date(b.end) - new Date(b.start)) / MIN, 0);
      render(slot, html`<button class="missed-pill" data-missed>${missed.length} missed ${missed.length === 1 ? 'session' : 'sessions'}, ${fmtDuration(mins)}</button>`);
      $('[data-missed]', slot).onclick = (e) => {
        const pop = popover(e.currentTarget, html`
          <h3>Missed work sessions</h3>
          <p class="small muted">Check off any you actually did. The rest can be moved into your upcoming free time.</p>
          <ul class="missed-list">${missed.slice(0, 8).map((b) => {
            const t = store.v.tasks.find((x) => x.id === b.taskId);
            return html`<li><button class="tick" data-done="${b.id}" style="--c:${t.color}" aria-label="Check off">${icon('check')}</button><span>${t.title}</span><span class="muted small">${fmtWeekday(new Date(b.start))} ${fmtDuration((new Date(b.end) - new Date(b.start)) / MIN)}</span></li>`;
          })}</ul>
          <div class="pop-actions"><button class="btn primary" data-resched>Reschedule the rest</button></div>`, { width: 320 });
        $$('[data-done]', pop).forEach((b) => b.onclick = () => { ops.setBlockStatus(store, b.dataset.done, 'done'); b.closest('li').classList.add('checked'); });
        $('[data-resched]', pop).onclick = () => { closePopover(); ops.dismissMissed(store); app.toast('Rescheduled into your free time.', { undo: true }); };
      };
    } else render(slot, '');
    renderSync();
  }

  function renderSync() {
    const b = $('[data-sync]', root);
    const s = store.status;
    const map = {
      local: ['device', 'Saved on this device only'],
      idle: ['cloud', 'Waiting to sync'],
      syncing: ['cloud', 'Syncing…'],
      synced: ['cloudCheck', `Encrypted and synced to ${session.gh?.owner}/${session.gh?.repo}`],
      offline: ['cloudOff', 'Offline. Changes are saved here and will sync later.'],
      error: ['alert', `Sync problem: ${store.syncError}`],
    };
    const [i, label] = map[s] || map.idle;
    render(b, html`${icon(i)}`);
    b.title = label;
    b.setAttribute('aria-label', label);
    b.dataset.state = s;
  }

  function miniMonth() {
    const m = app.ui.miniCursor;
    const start = startOfWeek(m, store.v.settings.weekStartsOn);
    const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
    const today = new Date();
    const visible = viewDays(app);
    const busyDays = new Set(store.v.blocks.filter((b) => b.status !== 'skipped').map((b) => dayKey(new Date(b.start))));
    return html`<div class="mini">
      <div class="mini-head"><span>${fmtMonthYear(m)}</span>
        <button class="icon-btn small" data-mprev aria-label="Previous month">${icon('left')}</button>
        <button class="icon-btn small" data-mnext aria-label="Next month">${icon('right')}</button></div>
      <div class="mini-grid">
        ${days.slice(0, 7).map((d) => html`<span class="mini-wd">${fmtWeekday(d, 'narrow')}</span>`)}
        ${days.map((d) => html`<button class="mini-day ${d.getMonth() !== m.getMonth() ? 'other' : ''} ${sameDay(d, today) ? 'today' : ''} ${app.ui.view !== 'month' && visible.some((x) => sameDay(x, d)) ? 'in-view' : ''}" data-mini="${dayKey(d)}">${d.getDate()}${busyDays.has(dayKey(d)) ? raw('<i></i>') : ''}</button>`)}
      </div>
    </div>`;
  }

  function tasksSection({ limit = 6, heading = true } = {}) {
    const v = store.v;
    const open = v.tasks.filter((t) => t.status !== 'done').sort((a, b) => dueDate(a) - dueDate(b));
    const done = v.tasks.filter((t) => t.status === 'done').sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    const shown = app.ui.showAllTasks || !limit ? open : open.slice(0, limit);
    const atRisk = open.filter((t) => ['late', 'overdue'].includes(v.planInfo?.[t.id]?.risk)).length;
    return html`<section class="side-sec">
      ${heading ? html`<div class="side-head"><h2>Tasks</h2>${atRisk ? html`<span class="risk late">${atRisk} need more time</span>` : ''}</div>`
        : atRisk ? html`<p class="risk-banner">${icon('alert')} ${atRisk} ${atRisk === 1 ? 'task doesn’t' : 'tasks don’t'} have enough time before ${atRisk === 1 ? 'its' : 'their'} due date.</p>` : ''}
      ${open.length ? html`<ul class="task-list">${shown.map((t) => taskRow(v, t))}</ul>
        ${limit && open.length > limit ? html`<button class="btn-text small" data-all>${app.ui.showAllTasks ? 'Show fewer' : `Show all ${open.length}`}</button>` : ''}`
        : html`<p class="muted small empty-note">Add a task with a due date and how long it takes. Pace will block out the time.</p>`}
      ${done.length ? html`<button class="btn-text small" data-done>${app.ui.showDone ? 'Hide' : 'Show'} ${done.length} completed</button>
        ${app.ui.showDone ? html`<ul class="task-list done">${done.slice(0, 30).map((t) => taskRow(v, t))}</ul>` : ''}` : ''}
    </section>`;
  }

  function calendarsSection() {
    const v = store.v;
    return html`<section class="side-sec">
      <div class="side-head"><h2>Calendars</h2><button class="icon-btn small" data-add-cal aria-label="Add calendar" title="Add or import">${icon('plus')}</button></div>
      <ul class="cal-list">
        ${v.calendars.map((c) => html`<li>
          <label class="cal-item" style="--c:${c.color}"><input type="checkbox" data-vis="${c.id}" ${c.visible !== false ? raw('checked') : ''}><span class="box">${icon('check')}</span><span class="cal-name">${c.name}</span>
          ${c.asTasks ? html`<span class="tag">Tasks</span>` : c.blocksTime === false ? html`<span class="tag">Free</span>` : ''}</label>
          <button class="icon-btn small" data-cal="${c.id}" aria-label="Options for ${c.name}">${icon('more')}</button>
        </li>`)}
      </ul>
      <button class="btn-text small" data-import>${icon('upload')} Import a calendar</button>
    </section>`;
  }

  function bindSections(el, rerender) {
    const v = store.v;
    $$('.task-list [data-kind=task]', el).forEach((b) => b.onclick = () => showTask(app, b.dataset.id, b));
    $('[data-all]', el)?.addEventListener('click', () => { app.ui.showAllTasks = !app.ui.showAllTasks; rerender(); });
    $('[data-done]', el)?.addEventListener('click', () => { app.ui.showDone = !app.ui.showDone; rerender(); });
    $$('[data-vis]', el).forEach((cb) => cb.onchange = () => {
      const c = v.calendars.find((x) => x.id === cb.dataset.vis);
      ops.upsertCalendar(store, { ...c, visible: cb.checked }, { replan: false, label: 'Show calendar' });
    });
    $$('[data-cal]', el).forEach((b) => b.onclick = () => calendarMenu(v.calendars.find((c) => c.id === b.dataset.cal), b));
    $('[data-import]', el).onclick = () => app.openImport();
    $('[data-add-cal]', el).onclick = (e) => {
      const pop = popover(e.currentTarget, html`<div class="menu">
        <button data-a="import">${icon('upload')} Import or subscribe</button>
        <button data-a="new">${icon('plus')} New personal calendar</button></div>`, { width: 240 });
      $('[data-a=import]', pop).onclick = () => { closePopover(); app.openImport(); };
      $('[data-a=new]', pop).onclick = () => {
        closePopover();
        const name = prompt('Name for the new calendar', 'Sports');
        if (name?.trim()) ops.upsertCalendar(store, { name: name.trim(), color: COLORS[(v.calendars.length + 3) % COLORS.length].hex, kind: 'personal' });
      };
    };
  }

  function bindMini(el, rerender) {
    $('[data-mprev]', el).onclick = () => { app.ui.miniCursor = addMonths(app.ui.miniCursor, -1); rerender(); };
    $('[data-mnext]', el).onclick = () => { app.ui.miniCursor = addMonths(app.ui.miniCursor, 1); rerender(); };
    $$('[data-mini]', el).forEach((b) => b.onclick = () => {
      app.ui.cursor = parseDayKey(b.dataset.mini);
      app.ui.resetScroll = true;
      app.ui.miniOpen = false;
      app.ui.screen = 'calendar';
      renderAll();
    });
  }

  function renderSidebar() {
    const keepScroll = sideEl.scrollTop;
    render(sideEl, html`
      <div class="create-row">
        <button class="btn create" data-new-task>${icon('plus')} New task</button>
        <button class="icon-btn create-more" data-new-event aria-label="New event" title="New event">${icon('event')}</button>
      </div>
      ${miniMonth()}
      ${tasksSection()}
      ${calendarsSection()}
      <p class="side-foot">${icon('lock')} End-to-end encrypted</p>`);
    sideEl.scrollTop = keepScroll;
    $('[data-new-task]', sideEl).onclick = () => app.openEditor({ kind: 'task' });
    $('[data-new-event]', sideEl).onclick = () => app.openEditor({ kind: 'event' });
    bindMini(sideEl, renderSidebar);
    bindSections(sideEl, renderSidebar);
  }

  /** Phone: the Tasks tab. */
  function renderTasksScreen() {
    const keepScroll = tasksEl.scrollTop;
    render(tasksEl, html`
      ${tasksSection({ limit: 0, heading: false })}
      ${calendarsSection()}
      <p class="side-foot">${icon('lock')} End-to-end encrypted${session.gh ? `, synced to ${session.gh.owner}/${session.gh.repo}` : ', saved on this device'}</p>`);
    tasksEl.scrollTop = keepScroll;
    bindSections(tasksEl, renderTasksScreen);
  }

  /** Phone: tap the title to pick a date. */
  function renderMiniDrop() {
    const show = narrow() && app.ui.miniOpen;
    miniEl.hidden = !show;
    if (!show) { render(miniEl, ''); return; }
    render(miniEl, miniMonth());
    bindMini(miniEl, renderMiniDrop);
  }

  function calendarMenu(c, anchor) {
    const pop = popover(anchor, html`
      <h3>${c.name}</h3>
      <div class="swatches small">${COLORS.map((x) => html`<label title="${x.name}"><input type="radio" name="calcolor" value="${x.hex}" ${x.hex === c.color ? raw('checked') : ''}><span style="--c:${x.hex}"></span></label>`)}</div>
      <div class="menu">
        ${c.asTasks ? '' : html`<label class="check"><input type="checkbox" data-blocks ${c.blocksTime !== false ? raw('checked') : ''}> Keep time during these events free of work</label>`}
        <button data-rename>${icon('edit')} Rename</button>
        ${c.kind === 'ics-url' ? html`<button data-refresh>${icon('refresh')} Refresh now</button>` : ''}
        ${c.id !== 'personal' ? html`<button data-remove class="danger-text">${icon('trash')} Remove calendar</button>` : ''}
      </div>
      ${c.lastFetched ? html`<p class="small muted">Updated ${new Date(c.lastFetched).toLocaleString()}</p>` : ''}`, { width: 280 });
    $$('[name=calcolor]', pop).forEach((r) => r.onchange = () => ops.upsertCalendar(store, { ...c, color: r.value }, { replan: false, label: 'Calendar color' }));
    $('[data-blocks]', pop)?.addEventListener('change', (e) => ops.upsertCalendar(store, { ...c, blocksTime: e.target.checked }));
    $('[data-rename]', pop).onclick = () => {
      closePopover();
      const name = prompt('Calendar name', c.name);
      if (name?.trim()) ops.upsertCalendar(store, { ...c, name: name.trim() }, { replan: false, label: 'Rename calendar' });
    };
    $('[data-refresh]', pop)?.addEventListener('click', async () => {
      closePopover();
      app.toast(`Refreshing “${c.name}”…`);
      const [r] = await refreshLinkedCalendars(store, { force: true, only: c.id });
      app.toast(r?.ok ? `“${c.name}” is up to date.` : `Couldn’t refresh: ${r?.error}`, { tone: r?.ok ? '' : 'bad' });
    });
    $('[data-remove]', pop)?.addEventListener('click', async () => {
      closePopover();
      const ok = await confirmDialog({ title: `Remove “${c.name}”?`, body: c.asTasks ? 'Its events are removed. Tasks you already have stay.' : 'Its events will be removed from Pace. The original calendar isn’t affected.', confirm: 'Remove', danger: true });
      if (ok) { ops.deleteCalendar(store, c.id); app.toast(`Removed “${c.name}”.`, { undo: true }); }
    });
  }

  // ---------------------------------------------------------- events
  const closeSidebar = () => { app.ui.sidebar = false; shell.classList.add('no-sidebar'); };
  $('[data-menu]', root).onclick = () => {
    app.ui.sidebar = !app.ui.sidebar;
    shell.classList.toggle('no-sidebar', !app.ui.sidebar);
    if (!narrow()) ls.set(SIDEBAR_KEY, app.ui.sidebar ? '1' : '0');
  };
  $('[data-scrim]', root).onclick = () => { closeSidebar(); if (narrow() && app.ui.panel) app.closePanel(); };
  $('[data-today]', root).onclick = () => { app.ui.screen = 'calendar'; app.ui.miniOpen = false; app.today(); };
  $('[data-prev]', root).onclick = () => app.go(-1);
  $('[data-next]', root).onclick = () => app.go(1);
  $$('[data-view]', root).forEach((b) => b.onclick = () => { app.ui.screen = 'calendar'; app.ui.miniOpen = false; app.setView(b.dataset.view); });
  $('[data-title]', root).onclick = () => {
    if (!narrow()) return;
    app.ui.miniOpen = !app.ui.miniOpen;
    app.ui.miniCursor = startOfMonth(app.ui.cursor);
    renderAll();
  };

  // Phone tab bar.
  $$('[data-tab]', root).forEach((b) => b.onclick = () => {
    const t = b.dataset.tab;
    closePopover();
    if (t === 'assistant') return app.openPanel(app.ui.view === 'day' ? app.ui.cursor : new Date(), 'day');
    if (t === 'settings') return app.openSettings();
    if (app.ui.panel) app.closePanel();
    app.ui.miniOpen = false;
    if (t === 'calendar' && app.ui.screen === 'calendar') return app.today();
    app.ui.screen = t;
    renderAll();
  });

  // Swipe left/right on the calendar to move between days, weeks or months.
  let swipe = null;
  calEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('.item.armed')) { swipe = null; return; }
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  calEl.addEventListener('touchend', (e) => {
    if (!swipe || calEl.querySelector('.item.dragging')) { swipe = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - swipe.t < 700) {
      calEl.classList.remove('slide-l', 'slide-r');
      void calEl.offsetWidth;
      calEl.classList.add(dx < 0 ? 'slide-l' : 'slide-r');
      app.go(dx < 0 ? 1 : -1);
    }
    swipe = null;
  }, { passive: true });
  $('[data-assistant]', root).onclick = () => (app.ui.panel ? app.closePanel() : app.openPanel(app.ui.view === 'day' ? app.ui.cursor : new Date(), app.ui.view === 'month' ? 'month' : 'day'));
  $('[data-settings]', root).onclick = () => app.openSettings();
  $('[data-fab]', root).onclick = () => app.openEditor({ kind: 'task' });
  $('[data-sync]', root).onclick = (e) => {
    if (!session.gh) return app.openSettings('account');
    const btn = e.currentTarget;
    store.sync().then(() => { if (store.status === 'error') { app.toast(store.syncError, { tone: 'bad', action: 'Settings', onAction: () => app.openSettings('account') }); } else showToast(btn.title); });
  };
  $('[data-account]', root).onclick = (e) => {
    const pop = popover(e.currentTarget, html`
      <div class="acct"><span class="avatar big">${session.username.slice(0, 1).toUpperCase()}</span><div><b>${session.username}</b>
      <p class="small muted">${session.gh ? `Syncing to ${session.gh.owner}/${session.gh.repo}` : 'This device only'}</p></div></div>
      ${narrow() && session.gh ? html`<p class="small muted sync-line" data-state="${store.status}">${$('[data-sync]', root).title}</p>` : ''}
      <div class="menu">
        <button data-a="settings">${icon('sliders')} Settings</button>
        ${narrow() && session.gh ? html`<button data-a="sync">${icon('refresh')} Sync now</button>` : ''}
        ${narrow() ? '' : html`<button data-a="keys">${icon('list')} Keyboard shortcuts</button>`}
        <button data-a="out">${icon('logout')} Sign out</button>
      </div>`, { width: 260 });
    $('[data-a=settings]', pop).onclick = () => app.openSettings();
    $('[data-a=sync]', pop)?.addEventListener('click', () => { closePopover(); store.sync().then(() => showToast(store.status === 'error' ? store.syncError : 'Synced.')); });
    $('[data-a=keys]', pop)?.addEventListener('click', () => { closePopover(); shortcutsHelp(); });
    $('[data-a=out]', pop).onclick = () => app.signOut(false);
  };

  function shortcutsHelp() {
    const rows = [['t', 'Today'], ['d / w / m', 'Day, week, month'], ['← →  or  j k', 'Previous / next'], ['n', 'New task'], ['e', 'New event'], ['a', 'Assistant for this day'], ['i', 'Import a calendar'], ['z', 'Undo'], ['Esc', 'Close']];
    popover(document.querySelector('[data-account]'), html`<h3>Keyboard shortcuts</h3><dl class="keys">${rows.map(([k, l]) => html`<dt><kbd>${k}</kbd></dt><dd>${l}</dd>`)}</dl>`, { width: 300 });
  }

  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    const k = e.key;
    const map = {
      t: () => app.today(), d: () => app.setView('day'), w: () => app.setView('week'), m: () => app.setView('month'),
      ArrowLeft: () => app.go(-1), ArrowRight: () => app.go(1), j: () => app.go(1), k: () => app.go(-1),
      n: () => app.openEditor({ kind: 'task' }), e: () => app.openEditor({ kind: 'event' }), c: () => app.openEditor({}),
      a: () => app.openPanel(app.ui.view === 'day' ? app.ui.cursor : new Date()), i: () => app.openImport(),
      z: () => { const l = store.undo(); if (l) showToast(`Undid: ${l.toLowerCase()}`); },
      '?': shortcutsHelp,
      Escape: () => { if (app.ui.panel) app.closePanel(); },
    };
    if (map[k]) { e.preventDefault(); closePopover(); map[k](); }
  }
  document.addEventListener('keydown', onKey);

  // Drop a calendar file anywhere to import it.
  const onDragOver = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); shell.classList.add('dropping'); } };
  const onDragLeave = (e) => { if (!e.relatedTarget) shell.classList.remove('dropping'); };
  const onDrop = (e) => {
    shell.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0];
    if (f && !document.querySelector('dialog[open]')) { e.preventDefault(); app.openImport({ file: f }); }
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  store.addEventListener('change', schedule);
  store.addEventListener('sync', renderSync);

  // Timers: now line, day rollover, background sync.
  let lastDay = dayKey(new Date());
  const minute = setInterval(() => {
    tickNow(calEl);
    const k = dayKey(new Date());
    if (k !== lastDay) { lastDay = k; store.replan({ quiet: true }); }
  }, 60 * 1000);
  const fiveMin = setInterval(() => schedule(), 5 * 60 * 1000);
  const syncTimer = setInterval(() => { if (document.visibilityState === 'visible' && session.gh) store.sync(); }, 2 * 60 * 1000);
  const onVis = () => {
    if (document.visibilityState === 'hidden') store.scheduleSave();
    if (document.visibilityState === 'visible') {
      $('.today-num', root).textContent = new Date().getDate();
      if (session.gh && Date.now() - store.lastSync > 20 * 1000) store.sync();
      refreshLinkedCalendars(store).catch(() => {});
    } else if (store.dirty && session.gh) store.sync();
  };
  const onOnline = () => session.gh && store.sync();
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('online', onOnline);
  let lastWidth = window.innerWidth;
  const onResize = () => {
    if ((lastWidth < 760) !== narrow()) {
      app.ui.sidebar = !narrow() && ls.get(SIDEBAR_KEY, '1') === '1';
      shell.classList.toggle('no-sidebar', !app.ui.sidebar);
      schedule();
    }
    lastWidth = window.innerWidth;
  };
  // Keep the assistant's composer above the on-screen keyboard.
  const vv = window.visualViewport;
  const onViewport = () => {
    document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    document.documentElement.style.setProperty('--vvtop', `${vv.offsetTop}px`);
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);
  if (vv) onViewport();
  window.addEventListener('resize', onResize);

  function stop() {
    clearInterval(minute); clearInterval(fiveMin); clearInterval(syncTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('resize', onResize);
    vv?.removeEventListener('resize', onViewport);
    vv?.removeEventListener('scroll', onViewport);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
    store.removeEventListener('change', schedule);
    store.removeEventListener('sync', renderSync);
    closePopover();
  }

  app.applyTheme();
  renderAll();
  if (!store.v.onboarded) openOnboarding(app);
  else refreshLinkedCalendars(store).catch(() => {});
  void isNew;
  return app;
}
