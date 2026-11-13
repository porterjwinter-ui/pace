// Every change to the user's data goes through here, so the UI and the assistant behave the same.
import { Store, uid } from './store.js';
import { dayKey, parseDayKey, parseWhen } from './dates.js';
import { colorFor } from './events.js';

const put = Store.put, drop = Store.drop;

export function createTask(store, fields, opts = {}) {
  return store.mutate((v) => put(v, 'tasks', {
    id: uid('t_'),
    title: fields.title?.trim() || 'Untitled task',
    notes: fields.notes || '',
    due: fields.due,
    estimateMin: Math.max(15, Math.round(fields.estimateMin || v.settings.defaultEstimate || 60)),
    priority: fields.priority || 2,
    color: fields.color || colorFor(v.tasks.length + 2),
    mode: fields.mode || 'spread',
    bufferHours: fields.bufferHours ?? null,
    notBefore: fields.notBefore || null,
    status: 'open',
    source: fields.source || null,
    createdAt: Date.now(),
  }), { label: opts.label || 'Create task' });
}

export function updateTask(store, id, patch, opts = {}) {
  return store.mutate((v) => {
    const t = v.tasks.find((x) => x.id === id);
    if (!t) throw new Error('Task not found');
    const next = { ...t, ...patch };
    if (patch.status === 'done' && t.status !== 'done') next.completedAt = Date.now();
    if (patch.status === 'open') next.completedAt = null;
    return put(v, 'tasks', next);
  }, { label: opts.label || 'Edit task' });
}

export function deleteTask(store, id, opts = {}) {
  return store.mutate((v) => {
    drop(v, 'tasks', id);
    for (const b of v.blocks.filter((x) => x.taskId === id)) drop(v, 'blocks', b.id);
  }, { label: opts.label || 'Delete task' });
}

export function createEvent(store, fields, opts = {}) {
  return store.mutate((v) => put(v, 'events', {
    id: uid('e_'),
    calendarId: fields.calendarId || 'personal',
    title: fields.title?.trim() || '(No title)',
    start: fields.start,
    end: fields.end,
    allDay: !!fields.allDay,
    busy: fields.busy !== false,
    repeat: fields.repeat || null,
    overrides: {},
    location: fields.location || '',
    notes: fields.notes || '',
    color: fields.color || null,
  }), { label: opts.label || 'Create event' });
}

export function updateEvent(store, id, patch, opts = {}) {
  return store.mutate((v) => {
    const e = v.events.find((x) => x.id === id);
    if (!e) throw new Error('Event not found');
    return put(v, 'events', { ...e, ...patch });
  }, { label: opts.label || 'Edit event' });
}

/** Move/resize one occurrence of a repeating event without touching the rest. */
export function overrideOccurrence(store, id, occurrence, value, opts = {}) {
  return store.mutate((v) => {
    const e = v.events.find((x) => x.id === id);
    if (!e) throw new Error('Event not found');
    return put(v, 'events', { ...e, overrides: { ...(e.overrides || {}), [occurrence]: value } });
  }, { label: opts.label || 'Edit event' });
}

/** scope: 'one' (just this occurrence) | 'all' */
export function deleteEvent(store, id, { occurrence = null, scope = 'all', label } = {}) {
  if (occurrence && scope === 'one') return overrideOccurrence(store, id, occurrence, null, { label: label || 'Delete event' });
  return store.mutate((v) => drop(v, 'events', id), { label: label || 'Delete event' });
}

export function setBlockStatus(store, blockId, status, opts = {}) {
  return store.mutate((v) => {
    const b = v.blocks.find((x) => x.id === blockId);
    if (!b) throw new Error('Work session not found');
    return put(v, 'blocks', { ...b, status });
  }, { label: opts.label || (status === 'done' ? 'Check off' : 'Update session') });
}

/** Pin a work session at a new time; the rest of the plan flows around it. */
export function moveBlock(store, blockId, start, end, opts = {}) {
  return store.mutate((v) => {
    const b = v.blocks.find((x) => x.id === blockId);
    if (!b) throw new Error('Work session not found');
    return put(v, 'blocks', { ...b, start: new Date(start).toISOString(), end: new Date(end).toISOString(), pinned: true });
  }, { label: opts.label || 'Move session' });
}

export function unpinBlock(store, blockId) {
  return store.mutate((v) => {
    const b = v.blocks.find((x) => x.id === blockId);
    if (b) put(v, 'blocks', { ...b, pinned: false });
  }, { label: 'Unpin session' });
}

/** Mark missed sessions as skipped so they stop showing as missed. */
export function dismissMissed(store) {
  const now = new Date();
  return store.mutate((v) => {
    for (const b of v.blocks) if (b.status === 'planned' && new Date(b.end) <= now) put(v, 'blocks', { ...b, status: 'skipped' });
  }, { label: 'Clear missed' });
}

export function updateSettings(store, patch, opts = {}) {
  return store.mutate((v) => { v.settings = { ...v.settings, ...patch, updatedAt: Date.now() }; }, { replan: opts.replan ?? true, label: 'Settings' });
}

export function upsertCalendar(store, cal, opts = {}) {
  return store.mutate((v) => put(v, 'calendars', { visible: true, blocksTime: true, ...cal, id: cal.id || uid('c_') }), { replan: opts.replan ?? true, label: opts.label || 'Calendar' });
}

export function deleteCalendar(store, id) {
  return store.mutate((v) => {
    drop(v, 'calendars', id);
    for (const e of v.events.filter((x) => x.calendarId === id)) drop(v, 'events', e.id);
  }, { label: 'Remove calendar' });
}

/**
 * Replace a calendar's imported events. Keeps per-event user choices (busy toggle) across refreshes.
 * If cal.asTasks, events become tasks instead (deduped by source uid; existing tasks keep their edits).
 */
export function applyImport(store, cal, parsed) {
  return store.mutate((v) => {
    const c = put(v, 'calendars', { visible: true, blocksTime: true, ...cal, lastFetched: Date.now() });
    const existing = new Map(v.events.filter((e) => e.calendarId === c.id).map((e) => [e.uid, e]));
    const seen = new Set();
    let events = 0, tasks = 0;

    if (c.asTasks) {
      const bySource = new Map(v.tasks.filter((t) => t.source?.calendarId === c.id).map((t) => [t.source.uid, t]));
      const items = [...parsed.events.map((e) => ({ uid: e.uid, title: e.title, due: e.allDay ? e.start : e.start, notes: e.notes })),
        ...parsed.todos.filter((t) => t.due && !t.completed).map((t) => ({ uid: t.uid, title: t.title, due: t.due, notes: t.notes }))];
      for (const it of items) {
        if (bySource.has(it.uid)) {
          const t = bySource.get(it.uid);
          if (t.due !== it.due || t.title !== it.title) put(v, 'tasks', { ...t, due: it.due, title: it.title });
          continue;
        }
        if (parseWhen(it.due) < new Date(Date.now() - 864e5)) continue; // skip past assignments
        put(v, 'tasks', {
          id: uid('t_'), title: it.title, notes: it.notes || '', due: it.due,
          estimateMin: c.taskEstimate || v.settings.defaultEstimate || 60, priority: 2, color: c.color,
          mode: 'spread', bufferHours: null, status: 'open', source: { calendarId: c.id, uid: it.uid }, createdAt: Date.now(),
        });
        tasks++;
      }
      for (const e of existing.values()) drop(v, 'events', e.id);
    } else {
      for (const e of parsed.events) {
        const id = `i_${c.id}_${hash(e.uid)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const prev = existing.get(e.uid);
        const item = {
          id, uid: e.uid, calendarId: c.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay,
          busy: prev?.userBusy ?? e.busy, userBusy: prev?.userBusy, location: e.location, notes: e.notes, url: e.url,
        };
        if (!prev || JSON.stringify({ ...prev, updatedAt: 0 }) !== JSON.stringify({ ...item, updatedAt: 0 })) put(v, 'events', item);
        events++;
      }
      for (const e of existing.values()) if (!seen.has(e.id)) drop(v, 'events', e.id);
      // Import VTODOs with due dates as tasks.
      const known = new Set(v.tasks.map((t) => t.source?.uid).filter(Boolean));
      for (const t of parsed.todos) {
        if (!t.due || t.completed || known.has(t.uid) || parseWhen(t.due) < new Date()) continue;
        put(v, 'tasks', {
          id: uid('t_'), title: t.title, notes: t.notes || '', due: t.due, estimateMin: v.settings.defaultEstimate || 60,
          priority: 2, color: c.color, mode: 'spread', bufferHours: null, status: 'open', source: { calendarId: c.id, uid: t.uid }, createdAt: Date.now(),
        });
        tasks++;
      }
    }
    return { calendar: c, events, tasks };
  }, { label: 'Import calendar' });
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

/** Parse "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (local) into a stored value. */
export function localValue(str, { allDay = false } = {}) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return allDay ? str : (() => { const d = parseDayKey(str); d.setHours(23, 59); return d.toISOString(); })();
  const d = new Date(str.replace(/Z$/, ''));
  if (isNaN(d)) return null;
  return allDay ? dayKey(d) : d.toISOString();
}
