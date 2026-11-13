// Side panel opened from a day: that day's plan plus a conversation with the assistant.
import { $, $$, html, raw, render, icon, markdown } from './dom.js';
import {
  addDays, dayKey, fmtDayLong, fmtDayShort, fmtDuration, fmtMonthYear, fmtRange, fmtTime, fmtWeekday, monthKey,
  sameDay, startOfDay, MIN,
} from '../dates.js';
import { collect } from './calendar.js';
import { dueDate, taskProgress } from '../scheduler.js';
import { runAgent, scopeRange, DEFAULT_MODEL, SUGGESTED_MODELS } from '../agent.js';
import { uid } from '../store.js';
import * as ops from '../ops.js';

const SUGGESTIONS = {
  day: ['What should I focus on?', 'I only have 2 hours free today', 'I’m sick today, move my work', 'Add swimming at 6pm'],
  week: ['How does my week look?', 'Am I on track for everything due?', 'Make Friday evening free'],
  month: ['What’s coming up this month?', 'Which weeks are busiest?', 'Am I taking on too much?'],
};

const chatKey = (scope, from) => `${scope}:${scope === 'month' ? monthKey(from) : dayKey(from)}`;

function summarySentence(v, scope, from, to) {
  const { events, blocks, dues } = collect(v, from, to);
  const work = blocks.reduce((m, b) => m + (b.e - b.s) / MIN, 0);
  const done = blocks.filter((b) => b.status === 'done').reduce((m, b) => m + (b.e - b.s) / MIN, 0);
  const missed = blocks.filter((b) => b.status === 'missed').length;
  const timed = events.filter((e) => !e.allDay);
  const parts = [];
  if (!work && !timed.length && !dues.length) return scope === 'day' ? 'Nothing planned. A free day.' : 'Nothing planned yet.';
  parts.push(work ? `${fmtDuration(work)} of work across ${blocks.length} ${blocks.length === 1 ? 'session' : 'sessions'}` : 'No work sessions');
  if (timed.length) parts.push(`${timed.length} ${timed.length === 1 ? 'event' : 'events'}`);
  if (dues.length) parts.push(`${dues.length} due`);
  let s = parts.join(', ') + '.';
  if (done) s += ` ${fmtDuration(done)} done so far.`;
  if (missed) s += ` ${missed} missed.`;
  return s;
}

function agendaDay(v, from, to) {
  const { events, blocks, dues } = collect(v, from, to);
  const items = [
    ...events.map((e) => ({ ...e, sort: e.allDay ? 0 : e.s })),
    ...blocks.map((b) => ({ ...b, sort: b.s })),
    ...dues.map((d) => ({ ...d, sort: +d.at })),
  ].sort((a, b) => a.sort - b.sort);
  if (!items.length) return html`<p class="muted empty-note">No events or work sessions. Click the calendar to add something, or ask the assistant to plan the day.</p>`;
  return html`<ul class="agenda">${items.map((it) => {
    if (it.kind === 'block') {
      return html`<li class="ag block ${it.status}" style="--c:${it.color}">
        <button class="tick" data-tick="${it.id}" aria-label="${it.status === 'done' ? 'Mark not done' : 'Check off'}">${icon('check')}</button>
        <button class="ag-main" data-kind="block" data-id="${it.id}"><span class="ag-t">${it.title}</span><span class="ag-m">${fmtRange(new Date(it.s), new Date(it.e))}${it.status === 'missed' ? ', missed' : ''}</span></button>
      </li>`;
    }
    if (it.kind === 'due') {
      return html`<li class="ag due ${it.done ? 'done' : ''}" style="--c:${it.color}">
        <span class="ag-icon">${icon('flag')}</span>
        <button class="ag-main" data-kind="task" data-id="${it.id}"><span class="ag-t">${it.title} due</span><span class="ag-m">${fmtTime(it.at)}</span></button>
      </li>`;
    }
    return html`<li class="ag event" style="--c:${it.color}">
      <span class="ag-bar"></span>
      <button class="ag-main" data-kind="event" data-id="${it.id}"><span class="ag-t">${it.title}</span><span class="ag-m">${it.allDay ? 'All day' : fmtRange(it.start, it.end)}</span></button>
    </li>`;
  })}</ul>`;
}

function agendaRange(v, from, to, scope) {
  if (scope === 'week') {
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    return html`<ul class="week-list">${days.map((d) => {
      const { events, blocks, dues } = collect(v, d, addDays(d, 1));
      const work = blocks.reduce((m, b) => m + (b.e - b.s) / MIN, 0);
      return html`<li><button data-day="${dayKey(d)}" class="${sameDay(d, new Date()) ? 'today' : ''}">
        <span class="wl-d">${fmtWeekday(d)} ${d.getDate()}</span>
        <span class="wl-bar"><i style="width:${Math.min(100, (work / Math.max(60, v.settings.maxDailyMinutes)) * 100)}%"></i></span>
        <span class="wl-m">${work ? fmtDuration(work) : '–'}${events.filter((e) => !e.allDay).length ? `, ${events.filter((e) => !e.allDay).length} ev` : ''}${dues.length ? `, ${dues.length} due` : ''}</span>
      </button></li>`;
    })}</ul>`;
  }
  const due = v.tasks.filter((t) => { const d = dueDate(t); return d >= from && d < to; }).sort((a, b) => dueDate(a) - dueDate(b));
  if (!due.length) return html`<p class="muted empty-note">Nothing due this month.</p>`;
  return html`<ul class="task-list">${due.map((t) => taskRow(v, t))}</ul>`;
}

export function taskRow(v, t) {
  const p = taskProgress(v, t);
  const risk = t.status === 'done' ? 'done' : p.info?.risk || 'ok';
  return html`<li><button class="task-row ${risk}" data-kind="task" data-id="${t.id}" style="--c:${t.color}">
    <span class="tr-top"><span class="tr-t">${t.title}</span><span class="tr-due">${fmtDayShort(dueDate(t))}</span></span>
    <span class="progress thin"><i style="width:${p.pct * 100}%"></i></span>
    <span class="tr-m">${t.status === 'done' ? 'Completed' : `${fmtDuration(p.done)} of ${fmtDuration(p.est)}`}${risk === 'late' ? html` <b class="risk late">Not enough time</b>` : risk === 'tight' ? html` <b class="risk tight">Tight</b>` : risk === 'overdue' ? html` <b class="risk overdue">Overdue</b>` : ''}</span>
  </button></li>`;
}

export function createPanel(app, root) {
  let abort = null;
  let streaming = null; // { key, text, actions }

  function close() { abort?.abort(); app.closePanel(); }

  function draw() {
    const p = app.ui.panel;
    if (!p) { root.hidden = true; render(root, ''); return; }
    root.hidden = false;
    const v = app.store.v;
    const [from, to] = scopeRange(p.scope, p.date, v.settings.weekStartsOn);
    const key = chatKey(p.scope, from);
    const chat = v.chats[key]?.messages || [];
    const title = p.scope === 'day' ? fmtDayLong(p.date) : p.scope === 'week' ? `Week of ${fmtDayShort(from)}` : fmtMonthYear(p.date);
    const hasKey = !!v.settings.aiKey;
    const prevScroll = $('.panel-body', root)?.scrollTop;
    const draft = $('#composer-input', root)?.value || '';

    render(root, html`
      <header class="panel-head">
        <div class="ph-row">
          <h2>${title}</h2>
          <button class="icon-btn" data-close aria-label="Close panel">${icon('x')}</button>
        </div>
        <div class="seg small" role="tablist" aria-label="Range">
          ${['day', 'week', 'month'].map((s) => html`<button role="tab" data-scope="${s}" aria-selected="${p.scope === s}">${s[0].toUpperCase() + s.slice(1)}</button>`)}
        </div>
      </header>
      <div class="panel-body">
        <p class="summary">${summarySentence(v, p.scope, from, to)}</p>
        ${p.scope === 'day' ? agendaDay(v, from, to) : agendaRange(v, from, to, p.scope)}
        <section class="chat" aria-label="Assistant">
          <h3 class="chat-title">${icon('sparkle')} Assistant</h3>
          ${!hasKey ? html`
            <form class="key-setup">
              <p>Chat about your ${p.scope}, and let the assistant move things around for you. Paste an OpenRouter API key to start.</p>
              <div class="row gap-s"><input name="key" type="password" placeholder="sk-or-…" autocomplete="off" spellcheck="false" aria-label="OpenRouter API key"><button class="btn primary">Save</button></div>
              <p class="hint"><a href="https://openrouter.ai/keys" target="_blank" rel="noopener">Get a key from OpenRouter</a>. It’s encrypted with your data. Uses ${SUGGESTED_MODELS.find((m) => m.id === DEFAULT_MODEL)?.name || DEFAULT_MODEL} unless you pick another model in Settings.</p>
            </form>` : ''}
          <div class="messages">
            ${chat.map((m) => messageHtml(m))}
            ${streaming && streaming.key === key ? messageHtml({ role: 'assistant', content: streaming.text, actions: streaming.actions, pending: true }) : ''}
          </div>
        </section>
      </div>
      ${hasKey ? html`
        <form class="composer">
          ${chat.length || streaming ? '' : html`<div class="suggest">${SUGGESTIONS[p.scope].map((s) => html`<button type="button" class="chip-btn" data-suggest>${s}</button>`)}</div>`}
          <div class="composer-box">
            <textarea id="composer-input" rows="1" placeholder="Ask about your ${p.scope}…" aria-label="Message the assistant">${draft}</textarea>
            ${streaming ? html`<button type="button" class="icon-btn send" data-stop aria-label="Stop">${icon('stop')}</button>`
              : html`<button class="icon-btn send" aria-label="Send">${icon('send')}</button>`}
          </div>
          ${chat.length ? html`<button type="button" class="btn-text small" data-clear>Clear conversation</button>` : ''}
        </form>` : ''}`);

    const body = $('.panel-body', root);
    if (streaming || prevScroll === undefined) body.scrollTop = body.scrollHeight;
    else body.scrollTop = prevScroll;

    $('[data-close]', root).onclick = close;
    $$('[data-scope]', root).forEach((b) => b.onclick = () => { app.ui.panel = { ...p, scope: b.dataset.scope }; draw(); });
    $$('[data-day]', root).forEach((b) => b.onclick = () => { app.ui.panel = { date: new Date(b.dataset.day + 'T00:00'), scope: 'day' }; draw(); });
    $$('[data-tick]', root).forEach((b) => b.onclick = () => { const blk = v.blocks.find((x) => x.id === b.dataset.tick); if (blk) app.toggleBlock(blk); });
    $$('.panel-body [data-kind]', root).forEach((b) => b.onclick = () => app.showItem(b.dataset.kind, b.dataset.id, b));
    $$('[data-undo]', root).forEach((b) => b.onclick = () => undoAgent(b.dataset.undo));

    const keyForm = $('.key-setup', root);
    if (keyForm) keyForm.onsubmit = (e) => {
      e.preventDefault();
      const k = keyForm.key.value.trim();
      if (!k) return;
      ops.updateSettings(app.store, { aiKey: k }, { replan: false });
      app.toast('Assistant connected.');
    };

    const composer = $('.composer', root);
    if (composer) {
      const input = $('#composer-input', root);
      const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; };
      input.addEventListener('input', grow);
      grow();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); }
      });
      composer.onsubmit = (e) => { e.preventDefault(); send(input.value); };
      $$('[data-suggest]', root).forEach((b) => b.onclick = () => send(b.textContent));
      $('[data-stop]', root)?.addEventListener('click', () => abort?.abort());
      $('[data-clear]', root)?.addEventListener('click', () => {
        app.store.mutate((vv) => { vv.chats[key] = { messages: [], updatedAt: Date.now() }; }, { replan: false, undo: false });
      });
      if (!app.ui.panelFocused) { app.ui.panelFocused = true; if (window.innerWidth > 760) input.focus(); }
    }
  }

  function messageHtml(m) {
    if (m.role === 'user') return html`<div class="msg user"><div class="bubble">${m.content}</div></div>`;
    return html`<div class="msg assistant ${m.pending ? 'pending' : ''} ${m.error ? 'error' : ''}">
      ${m.actions?.length ? html`<ul class="actions">${m.actions.map((a) => html`<li class="${a.ok ? '' : 'failed'}">${icon(a.ok ? 'check' : 'alert')}<span>${a.summary}</span></li>`)}</ul>` : ''}
      ${m.content ? html`<div class="md">${raw(markdown(m.content))}</div>` : m.pending && !m.actions?.length ? html`<div class="typing"><i></i><i></i><i></i></div>` : ''}
      ${m.undoable && !m.undone ? html`<button class="btn-text small" data-undo="${m.id}">${icon('undo')} Undo these changes</button>` : ''}
      ${m.undone ? html`<p class="small muted">Changes undone.</p>` : ''}
    </div>`;
  }

  function undoAgent(msgId) {
    const label = `agent:${msgId}`;
    let n = 0;
    while (app.store.undoStack.length && app.store.undoStack[app.store.undoStack.length - 1].label === label) { app.store.undo(); n++; }
    app.store.mutate((v) => {
      for (const c of Object.values(v.chats)) {
        const m = c.messages.find((x) => x.id === msgId);
        if (m) { m.undone = true; c.updatedAt = Date.now(); }
      }
    }, { replan: false, undo: false });
    app.toast(n ? 'Undid the assistant’s changes.' : 'Those changes were already replaced by newer edits.');
  }

  async function send(text) {
    text = text.trim();
    if (!text || streaming) return;
    const p = app.ui.panel;
    const store = app.store;
    const [from] = scopeRange(p.scope, p.date, store.v.settings.weekStartsOn);
    const key = chatKey(p.scope, from);
    const userMsg = { id: uid('m_'), role: 'user', content: text, ts: Date.now() };
    store.mutate((v) => {
      v.chats[key] ||= { messages: [], updatedAt: 0 };
      v.chats[key].messages.push(userMsg);
      v.chats[key].updatedAt = Date.now();
    }, { replan: false, undo: false });
    $('#composer-input', root) && ($('#composer-input', root).value = '');

    const msgId = uid('m_');
    streaming = { key, text: '', actions: [] };
    abort = new AbortController();
    draw();
    const history = store.v.chats[key].messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content || (m.actions || []).map((a) => a.summary).join('\n') || '(no reply)' }));
    let result;
    let error = '';
    try {
      let raf = 0;
      result = await runAgent({
        store, scope: p.scope, date: p.date, history, label: `agent:${msgId}`, signal: abort.signal,
        onText: (t) => { streaming.text = t; if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateStreaming(); }); },
        onAction: (a) => { streaming.actions = [...streaming.actions, a]; },
      });
    } catch (e) {
      if (e.name === 'AbortError') result = { text: streaming.text ? streaming.text + ' …' : '(Stopped.)', actions: streaming.actions };
      else error = e.message === 'NO_KEY' ? 'Add your OpenRouter key in Settings to use the assistant.' : e.message;
    }
    const actions = result?.actions || streaming.actions;
    const reply = {
      id: msgId, role: 'assistant', ts: Date.now(),
      content: error || result.text,
      actions,
      error: !!error,
      undoable: actions.some((a) => a.ok),
    };
    streaming = null;
    abort = null;
    store.mutate((v) => {
      v.chats[key] ||= { messages: [], updatedAt: 0 };
      v.chats[key].messages.push(reply);
      v.chats[key].messages = v.chats[key].messages.slice(-60);
      v.chats[key].updatedAt = Date.now();
    }, { replan: false, undo: false });
  }

  /** Update only the streaming bubble to avoid re-rendering the whole panel on every token. */
  function updateStreaming() {
    const el = $('.msg.pending', root);
    if (!el || !streaming) return draw();
    const md = $('.md', el) || (() => { $('.typing', el)?.remove(); const d = document.createElement('div'); d.className = 'md'; el.append(d); return d; })();
    md.innerHTML = markdown(streaming.text);
    const body = $('.panel-body', root);
    body.scrollTop = body.scrollHeight;
  }

  return { draw, close };
}
