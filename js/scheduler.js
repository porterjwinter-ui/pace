// Auto-scheduler: spreads each task's remaining hours across free time before its due date.
//
// 1. Keep history (done/skipped/missed blocks), pinned blocks, and the block in progress.
// 2. Free time = availability windows − busy events (padded by the break buffer) − kept blocks.
// 3. Tasks are planned earliest-deadline-first. Each aims to finish `bufferHours` before it's due,
//    with its hours spread evenly over the days available, respecting min/max session length
//    and a daily work cap. If that's impossible it may use the buffer, and anything left is flagged.
import { addDays, atMinutes, dayKey, parseWhen, roundUp, startOfDay, HOUR, MIN, DAY } from './dates.js';
import { expandEvents } from './events.js';

const GRAN = 15;
const HORIZON_DAYS = 180;

export const dueDate = (task) => {
  const d = parseWhen(task.due);
  if (typeof task.due === 'string' && task.due.length === 10) d.setHours(23, 59, 0, 0);
  return d;
};

const minutes = (b) => (new Date(b.end) - new Date(b.start)) / MIN;
const blockId = (taskId, start) => `b_${taskId}_${(+start).toString(36)}`;

/** Subtract interval [s, e) (ms) from a sorted list of free slots, in place. */
function carve(slots, s, e) {
  for (let i = slots.length - 1; i >= 0; i--) {
    const sl = slots[i];
    if (e <= sl.s || s >= sl.e) continue;
    const parts = [];
    if (sl.s < s) parts.push({ s: sl.s, e: s });
    if (e < sl.e) parts.push({ s: e, e: sl.e });
    slots.splice(i, 1, ...parts);
  }
}

function pickEvenly(list, k) {
  if (k >= list.length) return list.slice();
  const out = [];
  for (let i = 0; i < k; i++) out.push(list[Math.floor((i * list.length) / k)]);
  return out;
}

export function planSchedule(vault, now = new Date()) {
  const s = vault.settings;
  const breakMs = (s.breakMinutes || 0) * MIN;
  const minBlock = Math.max(GRAN, s.minBlock || 30);
  const maxBlock = Math.max(minBlock, s.maxBlock || 120);
  const start = roundUp(now, GRAN);
  const tasks = new Map(vault.tasks.map((t) => [t.id, t]));

  // 1. Blocks we keep.
  const kept = [];
  for (const b of vault.blocks) {
    const t = tasks.get(b.taskId);
    if (!t) continue;
    const bs = new Date(b.start), be = new Date(b.end);
    if (b.status === 'done' || b.status === 'skipped') kept.push(b);
    else if (t.status === 'done') continue;
    else if (be <= now || b.pinned || bs < now) kept.push(b);
  }

  const open = vault.tasks.filter((t) => t.status !== 'done' && t.due && t.estimateMin > 0);
  const info = {};
  if (!open.length) return { blocks: kept, info };

  let horizon = addDays(startOfDay(start), 1);
  for (const t of open) { const d = dueDate(t); if (d > horizon) horizon = d; }
  const cap = addDays(startOfDay(start), HORIZON_DAYS);
  if (horizon > cap) horizon = cap;
  horizon = addDays(startOfDay(horizon), 1);

  // 2. Busy time.
  const busy = [];
  for (const ev of expandEvents(vault, startOfDay(start), horizon, { includeHidden: true })) {
    if (ev.busy) busy.push({ s: +ev.start - breakMs, e: +ev.end + breakMs });
  }
  const usedByDay = new Map();
  for (const b of kept) {
    const be = +new Date(b.end);
    const bs = +new Date(b.start);
    const k = dayKey(new Date(bs));
    if (b.status !== 'skipped') usedByDay.set(k, (usedByDay.get(k) || 0) + minutes(b));
    if (be > +start && b.status !== 'skipped') busy.push({ s: bs - breakMs, e: be + breakMs });
  }

  const days = [];
  for (let d = startOfDay(start); d < horizon; d = addDays(d, 1)) {
    const slots = [];
    for (const [a, z] of s.availability[d.getDay()] || []) {
      const ws = Math.max(+atMinutes(d, a), +start);
      const we = +atMinutes(d, z);
      if (we - ws >= GRAN * MIN) slots.push({ s: ws, e: we });
    }
    for (const b of busy) if (b.e > +d && b.s < +d + DAY + HOUR * 2) carve(slots, b.s, b.e);
    const key = dayKey(d);
    const capMin = Math.max(0, (s.maxDailyMinutes || 1440) - (usedByDay.get(key) || 0));
    days.push({ d, key, slots: slots.filter((x) => x.e - x.s >= GRAN * MIN), cap: capMin, used: 0 });
  }

  const freeIn = (day, from, to) => {
    let m = 0;
    for (const sl of day.slots) m += Math.max(0, Math.min(sl.e, to) - Math.max(sl.s, from));
    return Math.min(m / MIN, day.cap - day.used);
  };

  const newBlocks = [];

  function placeInDay(day, task, want, from, to) {
    let placed = 0;
    for (let i = 0; i < day.slots.length && placed < want; i++) {
      const sl = day.slots[i];
      const bs = Math.max(sl.s, from);
      const room = (Math.min(sl.e, to) - bs) / MIN;
      const need = Math.min(minBlock, want - placed);
      if (room < need) continue;
      const len = Math.floor(Math.min(want - placed, maxBlock, room) / GRAN) * GRAN;
      if (len < need || len <= 0) continue;
      const be = bs + len * MIN;
      newBlocks.push({ id: blockId(task.id, bs), taskId: task.id, start: new Date(bs).toISOString(), end: new Date(be).toISOString(), status: 'planned', pinned: false });
      carve(day.slots, bs - breakMs, be + breakMs);
      placed += len;
      day.used += len;
      i = -1; // slots changed; rescan from the start
    }
    return placed;
  }

  function allocate(task, R, from, to) {
    const eligible = () => days.filter((day) => +day.d < to && +day.d + DAY > from && freeIn(day, from, to) >= Math.min(minBlock, R));
    let list = eligible();
    if (!list.length || R <= 0) return R;
    let share = task.mode === 'asap' ? R : Math.max(Math.ceil(R / list.length / GRAN) * GRAN, Math.min(minBlock, R));
    let chosen = task.mode === 'asap' ? list : pickEvenly(list, Math.ceil(R / share));
    for (let pass = 0; pass < 12 && R > 0; pass++) {
      let progress = false;
      for (const day of chosen) {
        if (R <= 0) break;
        const want = Math.min(share, R, day.cap - day.used);
        if (want < Math.min(minBlock, R)) continue;
        const got = placeInDay(day, task, want, from, to);
        if (got) { R -= got; progress = true; }
      }
      list = eligible();
      if (!list.length || (!progress && pass > 0)) break;
      chosen = list;
      share = task.mode === 'asap' ? R : Math.max(Math.ceil(R / list.length / GRAN) * GRAN, Math.min(minBlock, R));
    }
    return R;
  }

  // 3. Plan each task.
  const items = open.map((t) => {
    let done = 0, scheduled = 0;
    for (const b of kept) {
      if (b.taskId !== t.id) continue;
      if (b.status === 'done') done += minutes(b);
      else if (b.status === 'planned' && new Date(b.end) > now) scheduled += (new Date(b.end) - Math.max(+new Date(b.start), +now)) / MIN;
    }
    const due = dueDate(t);
    const buffer = (t.bufferHours ?? s.bufferHours ?? 0) * HOUR;
    const notBefore = t.notBefore ? Math.max(+parseWhen(t.notBefore), +start) : +start;
    const remaining = Math.max(0, Math.ceil((t.estimateMin - done - scheduled - (t.loggedMin || 0)) / GRAN) * GRAN);
    return { t, due: +due, target: Math.max(+due - buffer, notBefore + HOUR), notBefore, remaining, done };
  });
  items.sort((a, b) => a.target - b.target || (b.t.priority || 2) - (a.t.priority || 2) || (a.t.createdAt || 0) - (b.t.createdAt || 0));

  for (const it of items) {
    let R = it.remaining;
    let risk = 'ok';
    if (it.due <= +now) {
      risk = 'overdue';
      R = allocate(it.t, R, it.notBefore, it.notBefore + 3 * DAY);
    } else {
      R = allocate(it.t, R, it.notBefore, Math.min(it.target, it.due));
      if (R > 0) { R = allocate(it.t, R, it.notBefore, it.due); risk = 'tight'; }
      if (R > 0) risk = 'late';
    }
    const mine = newBlocks.filter((b) => b.taskId === it.t.id);
    const last = mine.reduce((m, b) => Math.max(m, +new Date(b.end)), 0);
    info[it.t.id] = { risk, unplaced: R, finish: last ? new Date(last).toISOString() : null };
  }

  return { blocks: [...kept, ...newBlocks], info };
}

/** Progress numbers for one task from its blocks. */
export function taskProgress(vault, task, now = new Date()) {
  let done = task.loggedMin || 0, planned = 0, missed = 0, next = null;
  for (const b of vault.blocks) {
    if (b.taskId !== task.id) continue;
    const m = minutes(b);
    if (b.status === 'done') done += m;
    else if (b.status === 'planned') {
      if (new Date(b.end) <= now) missed += m;
      else {
        planned += m;
        if (!next || new Date(b.start) < new Date(next.start)) next = b;
      }
    }
  }
  const est = task.estimateMin || 0;
  return { done, planned, missed, est, pct: est ? Math.min(1, done / est) : 0, next, info: vault.planInfo?.[task.id] };
}
