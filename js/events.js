// Turns stored events (some repeating) into concrete instances for a date range.
import { addDays, addMonths, dayKey, parseDayKey, parseWhen, startOfDay, DAY } from './dates.js';

export const COLORS = [
  { id: 'emerald', hex: '#0E8A63', name: 'Emerald' },
  { id: 'ocean', hex: '#1F73B7', name: 'Ocean' },
  { id: 'iris', hex: '#5B5BD6', name: 'Iris' },
  { id: 'orchid', hex: '#A24CC2', name: 'Orchid' },
  { id: 'rose', hex: '#D6406E', name: 'Rose' },
  { id: 'coral', hex: '#E0602F', name: 'Coral' },
  { id: 'amber', hex: '#B9800A', name: 'Amber' },
  { id: 'olive', hex: '#6B8A1A', name: 'Olive' },
  { id: 'teal', hex: '#0E8799', name: 'Teal' },
  { id: 'slate', hex: '#5F6B7E', name: 'Slate' },
];
export const colorFor = (i) => COLORS[Math.abs(i) % COLORS.length].hex;

const MAX_ITER = 4000;

/** Occurrence start dates (local) of a repeating event that fall inside [from, to). */
function occurrences(ev, from, to) {
  const base = parseWhen(ev.start);
  const r = ev.repeat;
  const until = r.until ? addDays(parseDayKey(r.until), 1) : null;
  const end = until && until < to ? until : to;
  const interval = Math.max(1, r.interval || 1);
  const out = [];
  const timeOf = (d) => { const x = new Date(d); x.setHours(base.getHours(), base.getMinutes(), 0, 0); return x; };
  let count = 0;
  const push = (d) => {
    count++;
    if (r.count && count > r.count) return false;
    if (d >= end) return false;
    if (d >= from || +d + (ev._dur || 0) > +from) out.push(d);
    return true;
  };

  if (r.freq === 'daily') {
    let d = new Date(base);
    // Jump close to the range to avoid iterating years of history.
    if (!r.count && from > base) {
      const skip = Math.floor((startOfDay(from) - startOfDay(base)) / DAY / interval) - 1;
      if (skip > 0) d = timeOf(addDays(base, skip * interval));
    }
    for (let i = 0; i < MAX_ITER && push(d); i++) d = timeOf(addDays(d, interval));
  } else if (r.freq === 'weekly') {
    const days = (r.byDay && r.byDay.length ? [...r.byDay] : [base.getDay()]).sort();
    let week = addDays(startOfDay(base), -base.getDay());
    if (!r.count && from > base) {
      const skip = Math.floor((startOfDay(from) - week) / (7 * DAY) / interval) - 1;
      if (skip > 0) week = addDays(week, skip * 7 * interval);
    }
    outer: for (let i = 0; i < MAX_ITER; i++) {
      for (const wd of days) {
        const d = timeOf(addDays(week, wd));
        if (d < base) continue;
        if (!push(d)) break outer;
      }
      week = addDays(week, 7 * interval);
    }
  } else if (r.freq === 'monthly') {
    for (let i = 0; i < MAX_ITER; i++) {
      const d = timeOf(addMonths(new Date(base.getFullYear(), base.getMonth(), 1), i * interval));
      if (base.getDate() > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()) continue;
      d.setDate(base.getDate());
      if (!push(d)) break;
    }
  } else if (r.freq === 'yearly') {
    for (let i = 0; i < MAX_ITER; i++) {
      const d = timeOf(new Date(base.getFullYear() + i * interval, base.getMonth(), base.getDate()));
      if (d.getMonth() !== base.getMonth()) continue; // Feb 29
      if (!push(d)) break;
    }
  }
  return out;
}

/**
 * All event instances overlapping [from, to).
 * Instance: { id, eventId, calendarId, title, start, end, allDay, busy, color, location, notes, recurring, readOnly, occurrence }
 */
export function expandEvents(vault, from, to, { includeHidden = false } = {}) {
  const cals = new Map(vault.calendars.map((c) => [c.id, c]));
  const out = [];
  for (const ev of vault.events) {
    const cal = cals.get(ev.calendarId);
    if (!cal) continue;
    if (!includeHidden && cal.visible === false) continue;
    const start = parseWhen(ev.start);
    const end = parseWhen(ev.end);
    const dur = Math.max(0, end - start);
    const make = (s, occurrence) => {
      const ov = occurrence && ev.overrides ? ev.overrides[occurrence] : undefined;
      if (ov === null) return;
      const st = ov ? parseWhen(ov.start) : s;
      const en = ov ? parseWhen(ov.end) : new Date(+s + dur);
      if (en <= from || st >= to) return;
      out.push({
        id: occurrence ? `${ev.id}@${occurrence}` : ev.id,
        eventId: ev.id,
        calendarId: ev.calendarId,
        title: ev.title,
        start: st,
        end: en,
        allDay: !!ev.allDay,
        busy: ev.busy !== false && !ev.allDay && cal.blocksTime !== false,
        color: ev.color || cal.color,
        location: ev.location || '',
        notes: ev.notes || '',
        url: ev.url || '',
        recurring: !!occurrence,
        occurrence,
        readOnly: cal.kind !== 'personal',
      });
    };
    if (ev.repeat && ev.repeat.freq) {
      ev._dur = dur;
      // Overrides can move an occurrence into range even if its original date isn't.
      for (const d of occurrences(ev, new Date(+from - 7 * DAY), new Date(+to + 7 * DAY))) make(d, dayKey(d));
      delete ev._dur;
    } else {
      make(start, null);
    }
  }
  return out;
}

export function describeRepeat(r, start) {
  if (!r || !r.freq) return 'Does not repeat';
  const every = r.interval > 1 ? `Every ${r.interval} ` : 'Every ';
  const names = (ds) => ds.map((d) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2023, 0, 1 + d))).join(', ');
  let s;
  if (r.freq === 'daily') s = r.interval > 1 ? `${every}days` : 'Daily';
  else if (r.freq === 'weekly') {
    const days = r.byDay?.length ? r.byDay : [start.getDay()];
    if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) s = 'Every weekday';
    else s = `${r.interval > 1 ? `${every}weeks` : 'Weekly'} on ${names(days)}`;
  } else if (r.freq === 'monthly') s = r.interval > 1 ? `${every}months` : `Monthly on day ${start.getDate()}`;
  else s = 'Yearly';
  if (r.until) s += `, until ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parseDayKey(r.until))}`;
  return s;
}
