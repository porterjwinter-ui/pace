// The assistant: an OpenRouter chat model with tools that read and change the user's plan.
import { addDays, dayKey, fmtDayShort, fmtDuration, fmtTime, parseDayKey, startOfDay, startOfMonth, startOfWeek, tzName, daysInMonth } from './dates.js';
import { expandEvents } from './events.js';
import { dueDate, taskProgress } from './scheduler.js';
import * as ops from './ops.js';

export const DEFAULT_MODEL = '~google/gemini-flash-latest';
export const SUGGESTED_MODELS = [
  { id: '~google/gemini-flash-latest', name: 'Gemini Flash (latest)', note: 'Fast and inexpensive' },
  { id: '~anthropic/claude-sonnet-latest', name: 'Claude Sonnet (latest)', note: 'Thoughtful planning' },
  { id: '~google/gemini-pro-latest', name: 'Gemini Pro (latest)', note: 'Most capable Gemini' },
];
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

let modelCache = null;
/** Models that support tool calling, for the settings picker. */
export async function listModels() {
  if (modelCache) return modelCache;
  const res = await fetch('https://openrouter.ai/api/v1/models');
  const { data } = await res.json();
  modelCache = data
    .filter((m) => (m.supported_parameters || []).includes('tools') && !m.id.endsWith(':batch'))
    .map((m) => ({ id: m.id, name: m.name }));
  return modelCache;
}

export function scopeRange(scope, date, weekStartsOn = 0) {
  if (scope === 'month') { const s = startOfMonth(date); return [s, addDays(s, daysInMonth(s))]; }
  if (scope === 'week') { const s = startOfWeek(date, weekStartsOn); return [s, addDays(s, 7)]; }
  const s = startOfDay(date);
  return [s, addDays(s, 1)];
}

const local = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Plain-text agenda for a range, with ids the model can act on. */
export function describeRange(vault, from, to) {
  const now = new Date();
  const tasks = new Map(vault.tasks.map((t) => [t.id, t]));
  const lines = [];
  for (let d = new Date(from); d < to; d = addDays(d, 1)) {
    const end = addDays(d, 1);
    const items = [];
    for (const e of expandEvents(vault, d, end)) {
      const cal = vault.calendars.find((c) => c.id === e.calendarId);
      const when = e.allDay ? 'all day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`;
      items.push({ t: e.allDay ? 0 : +e.start, s: `${when} Event: ${e.title}${e.busy ? '' : ' (free time)'}${cal && cal.kind !== 'personal' ? ` [from ${cal.name}, read-only]` : ''} (event_id ${e.eventId}${e.occurrence ? `, occurrence ${e.occurrence}` : ''})` });
    }
    for (const b of vault.blocks) {
      const s = new Date(b.start), en = new Date(b.end);
      if (s < d || s >= end || b.status === 'skipped') continue;
      const t = tasks.get(b.taskId);
      const state = b.status === 'done' ? 'done' : en <= now ? 'missed' : 'planned';
      items.push({ t: +s, s: `${fmtTime(s)}–${fmtTime(en)} Work session: ${t?.title} [${state}${b.pinned ? ', pinned' : ''}] (block_id ${b.id}, task_id ${b.taskId})` });
    }
    for (const t of vault.tasks) {
      const due = dueDate(t);
      if (due >= d && due < end) items.push({ t: +due, s: `${fmtTime(due)} DUE: ${t.title}${t.status === 'done' ? ' (completed)' : ''} (task_id ${t.id})` });
    }
    items.sort((a, b) => a.t - b.t);
    lines.push(`${fmtDayShort(d)} (${dayKey(d)})`);
    if (!items.length) lines.push('  nothing scheduled');
    for (const it of items) lines.push('  - ' + it.s);
  }
  return lines.join('\n');
}

function describeTasks(vault) {
  const open = vault.tasks.filter((t) => t.status !== 'done').sort((a, b) => dueDate(a) - dueDate(b));
  if (!open.length) return 'No open tasks.';
  return open.map((t) => {
    const p = taskProgress(vault, t);
    const info = p.info || {};
    const risk = { ok: 'on track', tight: 'using its buffer', late: `${fmtDuration(info.unplaced)} doesn’t fit before the deadline`, overdue: 'overdue' }[info.risk] || 'on track';
    return `- ${t.title} (task_id ${t.id}): due ${fmtDayShort(dueDate(t))} ${fmtTime(dueDate(t))}; ${fmtDuration(t.estimateMin)} total, ${fmtDuration(p.done)} done, ${fmtDuration(p.planned)} planned${p.missed ? `, ${fmtDuration(p.missed)} missed` : ''}; ${risk}; priority ${['', 'low', 'normal', 'high'][t.priority || 2]}`;
  }).join('\n');
}

function describeSettings(s) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hm = (m) => fmtTime(new Date(2000, 0, 1, Math.floor(m / 60), m % 60));
  const avail = s.availability.map((w, i) => `${names[i]} ${w.length ? w.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(', ') : 'off'}`).join('; ');
  return `Work hours: ${avail}. At most ${fmtDuration(s.maxDailyMinutes)} of task work per day. Sessions ${s.minBlock}–${s.maxBlock} min with ${s.breakMinutes} min breaks. Tasks aim to finish ${s.bufferHours}h before they're due.`;
}

function systemPrompt(vault, scope, date) {
  const [from, to] = scopeRange(scope, date, vault.settings.weekStartsOn);
  const label = scope === 'day' ? fmtDayShort(date) : scope === 'week' ? `the week of ${fmtDayShort(from)}` : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
  return `You are the planning assistant inside Pace, the user's calendar and task planner. Right now it is ${fmtDayShort(new Date())} ${fmtTime(new Date())} (${tzName()}). The user opened you from ${label}.

How Pace works: every task has a due date and an estimate of how long it takes. Pace automatically books "work sessions" for tasks in the user's free time before the due date, spread across days and finishing early to leave a buffer. Events (classes, practice, swimming, etc.) block time. Whenever tasks or events change, Pace replans on its own; you don't need to call replan after other tools.
${describeSettings(vault.settings)}

Guidelines:
- Be concise, warm, and practical. Prefer short paragraphs and tight bullet lists. Talk in plain language, never mention ids to the user.
- Use tools to make the changes the user asks for. For a clear request, just do it and then say what changed. Ask before deleting more than one item, and never invent tasks the user didn't ask for.
- When adding a task, if the user didn't say how long it takes, make a sensible estimate and say what you picked.
- If the user asks about dates outside the schedule below, call get_schedule.
- Times in tool arguments are the user's local time as "YYYY-MM-DDTHH:mm" (no timezone); dates are "YYYY-MM-DD".
- Imported calendar events are read-only. To keep someone free during part of a day (sick, trip, practice), create a personal event that blocks time.

Schedule for ${label}:
${describeRange(vault, from, to)}

Open tasks:
${describeTasks(vault)}`;
}

const TOOLS = [
  fn('get_schedule', 'Get events, work sessions and due dates for a date range (max 62 days).', {
    start_date: { type: 'string', description: 'YYYY-MM-DD' }, end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
  }, ['start_date', 'end_date']),
  fn('create_task', 'Add a task. Pace will schedule work sessions for it automatically.', {
    title: { type: 'string' },
    due: { type: 'string', description: 'Local due time YYYY-MM-DDTHH:mm, or YYYY-MM-DD for end of that day' },
    estimate_minutes: { type: 'integer', description: 'Total time the work needs' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    schedule_style: { type: 'string', enum: ['spread', 'asap'], description: 'spread = even across days (default); asap = as early as possible' },
    finish_early_hours: { type: 'number', description: 'Buffer before the due date. Omit to use the default.' },
    notes: { type: 'string' },
  }, ['title', 'due', 'estimate_minutes']),
  fn('update_task', 'Change a task. Set status to "done" to complete it.', {
    task_id: { type: 'string' }, title: { type: 'string' }, due: { type: 'string' }, estimate_minutes: { type: 'integer' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] }, status: { type: 'string', enum: ['open', 'done'] }, notes: { type: 'string' },
  }, ['task_id']),
  fn('delete_task', 'Delete a task and its work sessions.', { task_id: { type: 'string' } }, ['task_id']),
  fn('create_event', 'Add a personal event. Busy events block time so work sessions move around them.', {
    title: { type: 'string' },
    start: { type: 'string', description: 'YYYY-MM-DDTHH:mm, or YYYY-MM-DD when all_day' },
    end: { type: 'string', description: 'YYYY-MM-DDTHH:mm, or YYYY-MM-DD (exclusive) when all_day' },
    all_day: { type: 'boolean' },
    blocks_time: { type: 'boolean', description: 'Default true' },
    repeat: {
      type: 'object',
      properties: {
        freq: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        by_day: { type: 'array', items: { type: 'integer' }, description: 'Weekly only: 0=Sun … 6=Sat' },
        until: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
    notes: { type: 'string' },
  }, ['title', 'start', 'end']),
  fn('update_event', 'Change a personal event (all occurrences if it repeats).', {
    event_id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, blocks_time: { type: 'boolean' },
  }, ['event_id']),
  fn('delete_event', 'Delete a personal event. Pass occurrence (YYYY-MM-DD) to delete only that day of a repeating event.', {
    event_id: { type: 'string' }, occurrence: { type: 'string' },
  }, ['event_id']),
  fn('set_session_status', 'Check off a work session (done), skip it, or reopen it (planned).', {
    block_id: { type: 'string' }, status: { type: 'string', enum: ['done', 'skipped', 'planned'] },
  }, ['block_id', 'status']),
  fn('move_session', 'Move a work session to a new time and pin it there.', {
    block_id: { type: 'string' }, start: { type: 'string', description: 'YYYY-MM-DDTHH:mm' }, duration_minutes: { type: 'integer' },
  }, ['block_id', 'start']),
  fn('replan', 'Rebuild the whole plan from now on (e.g. after missed sessions).', {}, []),
];

function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const PRIORITY = { low: 1, normal: 2, high: 3 };
const parseLocal = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? parseDayKey(s) : new Date(String(s).replace(/Z$/, '')));

/** Runs a tool call. Returns { result (sent to model), summary (shown to user), mutated }. */
function runTool(store, name, args, label) {
  const v = store.v;
  const opt = { label };
  switch (name) {
    case 'get_schedule': {
      const from = parseDayKey(args.start_date);
      let to = addDays(parseDayKey(args.end_date), 1);
      if (to - from > 62 * 864e5) to = addDays(from, 62);
      return { result: describeRange(v, from, to) };
    }
    case 'create_task': {
      const due = ops.localValue(args.due);
      if (!due) throw new Error('Invalid due date');
      const t = ops.createTask(store, {
        title: args.title, due, estimateMin: args.estimate_minutes, priority: PRIORITY[args.priority] || 2,
        mode: args.schedule_style, bufferHours: args.finish_early_hours ?? null, notes: args.notes,
      }, opt);
      const p = taskProgress(store.v, t);
      return { result: `Created task ${t.id}. ${fmtDuration(p.planned)} scheduled; status ${p.info?.risk || 'ok'}.`, summary: `Added “${t.title}”, ${fmtDuration(t.estimateMin)}, due ${fmtDayShort(dueDate(t))}`, mutated: true };
    }
    case 'update_task': {
      const patch = {};
      if (args.title) patch.title = args.title;
      if (args.due) patch.due = ops.localValue(args.due);
      if (args.estimate_minutes) patch.estimateMin = args.estimate_minutes;
      if (args.priority) patch.priority = PRIORITY[args.priority];
      if (args.status) patch.status = args.status;
      if (args.notes !== undefined) patch.notes = args.notes;
      const t = ops.updateTask(store, args.task_id, patch, opt);
      return { result: 'Updated.', summary: args.status === 'done' ? `Completed “${t.title}”` : `Updated “${t.title}”`, mutated: true };
    }
    case 'delete_task': {
      const t = v.tasks.find((x) => x.id === args.task_id);
      if (!t) throw new Error('Task not found');
      ops.deleteTask(store, t.id, opt);
      return { result: 'Deleted.', summary: `Deleted “${t.title}”`, mutated: true };
    }
    case 'create_event': {
      const allDay = !!args.all_day;
      const start = allDay ? args.start.slice(0, 10) : parseLocal(args.start).toISOString();
      let end = allDay ? (args.end || '').slice(0, 10) : parseLocal(args.end).toISOString();
      if (allDay && (!end || end <= start)) end = dayKey(addDays(parseDayKey(start), 1));
      if (!allDay && new Date(end) <= new Date(start)) throw new Error('End must be after start');
      const repeat = args.repeat?.freq ? { freq: args.repeat.freq, interval: 1, byDay: args.repeat.by_day || null, until: args.repeat.until || null } : null;
      const e = ops.createEvent(store, { title: args.title, start, end, allDay, busy: args.blocks_time !== false, repeat, notes: args.notes }, opt);
      return { result: `Created event ${e.id}.`, summary: `Added “${e.title}” ${allDay ? `on ${fmtDayShort(parseDayKey(start))}` : `${fmtDayShort(new Date(start))}, ${fmtTime(new Date(start))}`}${repeat ? ' (repeats)' : ''}`, mutated: true };
    }
    case 'update_event': {
      const e = v.events.find((x) => x.id === args.event_id);
      if (!e) throw new Error('Event not found');
      if (v.calendars.find((c) => c.id === e.calendarId)?.kind !== 'personal') throw new Error('Imported events are read-only');
      const patch = {};
      if (args.title) patch.title = args.title;
      if (args.start) patch.start = e.allDay ? args.start.slice(0, 10) : parseLocal(args.start).toISOString();
      if (args.end) patch.end = e.allDay ? args.end.slice(0, 10) : parseLocal(args.end).toISOString();
      if (args.blocks_time !== undefined) patch.busy = args.blocks_time;
      ops.updateEvent(store, e.id, patch, opt);
      return { result: 'Updated.', summary: `Updated “${args.title || e.title}”`, mutated: true };
    }
    case 'delete_event': {
      const e = v.events.find((x) => x.id === args.event_id);
      if (!e) throw new Error('Event not found');
      if (v.calendars.find((c) => c.id === e.calendarId)?.kind !== 'personal') throw new Error('Imported events are read-only');
      ops.deleteEvent(store, e.id, { occurrence: args.occurrence, scope: args.occurrence ? 'one' : 'all', label });
      return { result: 'Deleted.', summary: `Removed “${e.title}”${args.occurrence ? ` on ${fmtDayShort(parseDayKey(args.occurrence))}` : ''}`, mutated: true };
    }
    case 'set_session_status': {
      const b = ops.setBlockStatus(store, args.block_id, args.status, opt);
      const t = v.tasks.find((x) => x.id === b.taskId);
      const verb = { done: 'Checked off', skipped: 'Skipped', planned: 'Reopened' }[args.status];
      return { result: 'Done.', summary: `${verb} ${fmtDuration((new Date(b.end) - new Date(b.start)) / 6e4)} of “${t?.title}”`, mutated: true };
    }
    case 'move_session': {
      const b = v.blocks.find((x) => x.id === args.block_id);
      if (!b) throw new Error('Work session not found');
      const start = parseLocal(args.start);
      const dur = args.duration_minutes ? args.duration_minutes * 6e4 : new Date(b.end) - new Date(b.start);
      ops.moveBlock(store, b.id, start, new Date(+start + dur), opt);
      const t = v.tasks.find((x) => x.id === b.taskId);
      return { result: 'Moved and pinned.', summary: `Moved “${t?.title}” to ${fmtDayShort(start)}, ${fmtTime(start)}`, mutated: true };
    }
    case 'replan':
      store.mutate(() => {}, { label });
      return { result: 'Replanned.', summary: 'Rebuilt the plan', mutated: true };
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

/**
 * Run one assistant turn.
 * history: [{ role: 'user'|'assistant', content }]  (already includes the new user message)
 * Callbacks: onText(fullText), onAction({ summary, ok })
 * Returns { text, actions }.
 */
export async function runAgent({ store, scope, date, history, label, onText, onAction, signal }) {
  const s = store.v.settings;
  if (!s.aiKey) throw new Error('NO_KEY');
  const messages = [
    { role: 'system', content: systemPrompt(store.v, scope, date) },
    ...history.slice(-24).map((m) => ({ role: m.role, content: m.content })),
  ];
  const actions = [];
  let text = '';

  for (let round = 0; round < 8; round++) {
    const { content, toolCalls } = await complete({ key: s.aiKey, model: s.aiModel || DEFAULT_MODEL, messages, signal, onDelta: (t) => onText?.(text + t) });
    text += content;
    if (!toolCalls.length) break;
    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let out;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        out = runTool(store, call.function.name, args, label);
        if (out.summary) { actions.push({ summary: out.summary, ok: true }); onAction?.(actions[actions.length - 1]); }
      } catch (e) {
        out = { result: `Error: ${e.message}` };
        if (call.function.name !== 'get_schedule') { actions.push({ summary: `Couldn’t ${call.function.name.replace(/_/g, ' ')}: ${e.message}`, ok: false }); onAction?.(actions[actions.length - 1]); }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: out.result });
    }
    if (text && !text.endsWith('\n')) text += '\n\n';
  }
  return { text: text.trim(), actions };
}

/** One streamed chat completion. Returns { content, toolCalls }. */
async function complete({ key, model, messages, signal, onDelta }) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'Pace',
      },
      body: JSON.stringify({ model, messages, tools: TOOLS, stream: true }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Couldn’t reach OpenRouter. Check your connection.');
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    if (res.status === 401) throw new Error('OpenRouter rejected the API key. Check it in Settings → Assistant.');
    if (res.status === 402) throw new Error('Your OpenRouter account is out of credits.');
    if (res.status === 429) throw new Error('OpenRouter is rate limiting requests. Wait a moment and try again.');
    throw new Error(msg || `OpenRouter error ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', content = '';
  const calls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) throw new Error(json.error.message || 'The model returned an error.');
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; onDelta?.(content); }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name = tc.function.name;
        const a = tc.function?.arguments;
        if (a) calls[i].function.arguments += typeof a === 'string' ? a : JSON.stringify(a);
      }
    }
  }
  return { content, toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` })) };
}
