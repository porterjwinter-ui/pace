// Date helpers. All "day keys" are local calendar dates formatted YYYY-MM-DD.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const endOfDay = (d) => addDays(startOfDay(d), 1);
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMinutes = (d, n) => new Date(+d + n * MIN);
export const addMonths = (d, n) => { const x = new Date(d); const day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + n); x.setDate(Math.min(day, daysInMonth(x))); return x; };
export const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
export const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
export const startOfWeek = (d, weekStartsOn = 0) => {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStartsOn + 7) % 7;
  return addDays(x, -diff);
};
export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();
export const atMinutes = (day, minutes) => { const x = startOfDay(day); x.setMinutes(minutes); return x; };

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const parseDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

/** Round a date up to the next multiple of `step` minutes. */
export const roundUp = (d, step = 15) => {
  const ms = step * MIN;
  return new Date(Math.ceil(+d / ms) * ms);
};
export const roundTo = (d, step = 15) => {
  const ms = step * MIN;
  return new Date(Math.round(+d / ms) * ms);
};

/** Parse a stored time value: 'YYYY-MM-DD' (local all-day) or ISO instant. */
export const parseWhen = (v) => (typeof v === 'string' && v.length === 10 ? parseDayKey(v) : new Date(v));

// Value helpers for <input type=date|time|datetime-local>
export const toDateInput = (d) => dayKey(d);
export const toTimeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const fromDateTimeInputs = (date, time) => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
};

// ---- Formatting -------------------------------------------------------
let hour12 = undefined; // undefined = locale default
export const setClock = (fmt) => { hour12 = fmt === '24h' ? false : fmt === '12h' ? true : undefined; cache.clear(); };

const cache = new Map();
const fmt = (opts) => {
  const key = JSON.stringify(opts) + hour12;
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(undefined, { hour12, ...opts }));
  return cache.get(key);
};

export const fmtTime = (d) => {
  const s = fmt({ hour: 'numeric', minute: '2-digit' }).format(d);
  return hour12 === false ? s : s.replace(':00', '').replace(/\s?([AP])M/i, (_, a) => a.toLowerCase() + 'm');
};
export const fmtHour = (h) => {
  const d = new Date(2000, 0, 1, h);
  if (hour12 === false) return `${pad(h)}:00`;
  return fmt({ hour: 'numeric' }).format(d).replace(/\s?([AP])M/i, (_, a) => ' ' + a + 'M');
};
export const fmtRange = (a, b) => `${fmtTime(a)} – ${fmtTime(b)}`;
export const fmtWeekday = (d, style = 'short') => fmt({ weekday: style }).format(d);
export const fmtMonthYear = (d) => fmt({ month: 'long', year: 'numeric' }).format(d);
export const fmtMonth = (d, style = 'short') => fmt({ month: style }).format(d);
export const fmtDayLong = (d) => fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(d);
export const fmtDayShort = (d) => fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(d);
export const fmtDate = (d) => fmt({ month: 'short', day: 'numeric' }).format(d);
export const fmtDateTime = (d) => `${fmtDayShort(d)}, ${fmtTime(d)}`;

/** "2h 30m", "45m", "5h" */
export const fmtDuration = (minutes) => {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
};

/** Human relative due label: "today 11:59pm", "tomorrow", "in 4 days", "2 days ago" */
export const fmtRelativeDue = (due, now = new Date()) => {
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
  if (days === 0) return `today ${fmtTime(due)}`;
  if (days === 1) return `tomorrow ${fmtTime(due)}`;
  if (days === -1) return 'yesterday';
  if (days < 0) return `${-days} days ago`;
  if (days < 7) return `${fmtWeekday(due, 'long')} ${fmtTime(due)}`;
  return fmtDate(due);
};

export const tzName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
