// Calendar import: ICS/iCalendar (via vendored ical.js) and CSV exports,
// normalized into Pace events and todos. Browser-only APIs.
import ICAL from '../vendor/ical.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_PER_SERIES = 3000;
const MAX_TOTAL = 20000;
const MAX_ITERATIONS = 100000;
const MAX_NOTES = 4000;
const DEFAULT_TIMED_MINUTES = 30;
const NOT_ICS_MESSAGE = 'This file isn’t a valid calendar (.ics). It may be damaged or not an iCalendar file — try exporting it again.';

// Cancelled events (STATUS:CANCELLED on a series, an instance override or a
// single event) are skipped entirely, so every returned event has
// cancelled: false. The field is kept for shape stability.

/** 'ics' | 'csv' | 'unknown' */
export function detectFormat(text, filename = '') {
  const body = stripBom(String(text ?? '')).trimStart();
  const ext = fileExtension(filename);
  if (/^BEGIN:VCALENDAR/im.test(body.slice(0, 20000))) return 'ics';
  if (/^BEGIN:(VEVENT|VTODO)\b/im.test(body.slice(0, 20000))) return 'ics';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (['ics', 'ical', 'icalendar', 'ifb', 'vcs'].includes(ext)) return 'ics';
  if (looksLikeCsv(body)) return 'csv';
  return 'unknown';
}

/**
 * Parse any calendar text (ICS/iCal/VCALENDAR incl. Google, Apple, Outlook, Canvas LMS feeds; or CSV exports).
 * opts.rangeStart / opts.rangeEnd: Date objects bounding recurrence expansion (non-recurring events outside the range are still included).
 * Defaults when omitted: 180 days ago .. 365 days from now.
 * Returns { name: string|null, color: string|null, events: NormalizedEvent[], todos: NormalizedTodo[], warnings: string[] }
 */
export async function parseCalendarText(text, { filename = '', rangeStart, rangeEnd } = {}) {
  const body = normalizeNewlines(stripBom(String(text ?? '')));
  const range = resolveRange(rangeStart, rangeEnd);
  const format = detectFormat(body, filename);
  if (format === 'ics') return parseIcs(body, filename, range);
  if (format === 'csv') return parseCsv(body, filename);
  throw new Error('This doesn’t look like a calendar file. Pace can import .ics (iCalendar) files and CSV exports from Google Calendar or Outlook.');
}

/**
 * Fetch an ICS subscription URL. Convert webcal:// to https://. Try a direct fetch first.
 * If that fails (network/CORS TypeError) and opts.proxy is a non-empty string, retry through the proxy:
 * if proxy contains '{url}' replace it with encodeURIComponent(url), otherwise append encodeURIComponent(url).
 * Returns the response text. Errors carry err.code: 'BAD_URL' | 'CORS' | 'NETWORK' | 'HTTP' (err.status set) | 'NOT_CALENDAR'.
 */
export async function fetchCalendarUrl(url, { proxy = '' } = {}) {
  const target = normalizeCalendarUrl(url);
  let res;
  try {
    res = await fetch(target, { cache: 'no-store', redirect: 'follow' });
  } catch {
    const proxyBase = typeof proxy === 'string' ? proxy.trim() : '';
    if (!proxyBase) throw directFetchError();
    try {
      res = await fetch(buildProxyUrl(proxyBase, target), { cache: 'no-store', redirect: 'follow' });
    } catch {
      throw codedError('NETWORK', 'Couldn’t reach this calendar, even through the CORS proxy. Check the address and your proxy setting, then try again.');
    }
  }
  if (!res.ok) throw httpError(res.status);
  const body = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(body)) {
    throw codedError('NOT_CALENDAR', 'That address didn’t return a calendar. Make sure you copied the calendar’s iCal/ICS link (often ending in .ics), not its web page.');
  }
  return body;
}

// ---------------------------------------------------------------------------
// ICS

function parseIcs(text, filename, range) {
  if (!/^BEGIN:(VCALENDAR|VEVENT|VTODO)\b/im.test(text)) throw new Error(NOT_ICS_MESSAGE);
  const ctx = createContext(range);
  const calendars = parseCalendarBlocks(text, ctx);
  calendars.forEach(registerTimezones);

  let name = null;
  let color = null;
  for (const vcal of calendars) {
    name = name || readText(vcal, 'x-wr-calname') || readText(vcal, 'name') || null;
    color = color || normalizeHexColor(readText(vcal, 'x-apple-calendar-color') || readText(vcal, 'color'));
    processCalendar(vcal, ctx);
  }

  if (ctx.skippedNoStart) ctx.warn(`Skipped ${plural(ctx.skippedNoStart, 'event')} with no start time.`);
  if (!ctx.events.length && !ctx.todos.length) ctx.warn('No events were found in this calendar for the selected dates.');
  return {
    name: name || baseName(filename),
    color,
    events: ctx.events,
    todos: ctx.todos,
    warnings: [...ctx.warnings],
  };
}

function createContext(range) {
  const ctx = {
    range,
    events: [],
    todos: [],
    warnings: new Set(),
    seenUids: new Set(),
    seenTodoUids: new Set(),
    zoneCache: new Map(),
    skippedNoStart: 0,
    capped: false,
    warn: (msg) => ctx.warnings.add(msg),
  };
  return ctx;
}

// Splits the text into VCALENDAR blocks so one broken block can't sink the rest.
function parseCalendarBlocks(text, ctx) {
  const chunks = splitCalendars(text);
  const calendars = [];
  let failures = 0;
  for (const chunk of chunks) {
    const jcal = parseChunk(chunk, ctx);
    if (!jcal) {
      failures++;
      continue;
    }
    const roots = Array.isArray(jcal[0]) ? jcal : [jcal];
    for (const root of roots) {
      if (root[0] === 'vcalendar') calendars.push(new ICAL.Component(root));
    }
  }
  if (!calendars.length) throw new Error(NOT_ICS_MESSAGE);
  if (failures) ctx.warn(`${plural(failures, 'calendar section')} couldn’t be read and ${failures === 1 ? 'was' : 'were'} skipped.`);
  return calendars;
}

function splitCalendars(text) {
  if (!/^BEGIN:VCALENDAR/im.test(text)) {
    // Bare VEVENT/VTODO content without a wrapper.
    return [`BEGIN:VCALENDAR\nVERSION:2.0\n${text.trim()}\nEND:VCALENDAR\n`];
  }
  return text
    .split(/^(?=BEGIN:VCALENDAR)/im)
    .filter((part) => /^BEGIN:VCALENDAR/i.test(part))
    .map((part) => {
      const end = part.search(/^END:VCALENDAR/im);
      return end >= 0 ? part.slice(0, end) + 'END:VCALENDAR\n' : `${part.trimEnd()}\nEND:VCALENDAR\n`;
    });
}

function parseChunk(chunk, ctx) {
  try {
    return ICAL.parse(chunk);
  } catch {
    // Retry without lines that aren't valid content lines (stray HTML, junk).
    const { text, dropped } = sanitizeIcs(chunk);
    if (!dropped) return null;
    try {
      const jcal = ICAL.parse(text);
      ctx.warn(`Ignored ${plural(dropped, 'unreadable line')} in the calendar file.`);
      return jcal;
    } catch {
      return null;
    }
  }
}

function sanitizeIcs(chunk) {
  const lines = chunk.replace(/\n[ \t]/g, '').split('\n');
  const kept = lines.filter((line) => !line.trim() || /^[A-Za-z0-9-]+(;[^:]*)?:/.test(line));
  return { text: kept.join('\n'), dropped: lines.length - kept.length };
}

function registerTimezones(vcal) {
  for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
    try {
      const tzid = vtz.getFirstPropertyValue('tzid');
      if (!tzid || ['UTC', 'Z', 'GMT'].includes(String(tzid).toUpperCase())) continue;
      ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
    } catch {
      // A broken VTIMEZONE falls back to name-based resolution later.
    }
  }
}

function processCalendar(vcal, ctx) {
  const masters = [];
  const overridesByUid = new Map();
  for (const comp of vcal.getAllSubcomponents('vevent')) {
    if (comp.hasProperty('recurrence-id')) {
      const uid = readText(comp, 'uid');
      if (!overridesByUid.has(uid)) overridesByUid.set(uid, []);
      overridesByUid.get(uid).push(comp);
    } else {
      masters.push(comp);
    }
  }

  const masterUids = new Set();
  for (const comp of masters) {
    if (ctx.capped) break;
    const uid = readText(comp, 'uid');
    if (uid) masterUids.add(uid);
    guarded(ctx, comp, () => processMaster(comp, uid ? overridesByUid.get(uid) || [] : [], ctx));
  }

  // Overrides whose series isn't in the file are imported as standalone events.
  for (const [uid, comps] of overridesByUid) {
    if (masterUids.has(uid)) continue;
    for (const comp of comps) guarded(ctx, comp, () => processOrphanOverride(comp, ctx));
  }

  for (const comp of vcal.getAllSubcomponents('vtodo')) guarded(ctx, comp, () => processTodo(comp, ctx));
}

function guarded(ctx, comp, fn) {
  try {
    fn();
  } catch {
    const title = readText(comp, 'summary');
    ctx.warn(title ? `Couldn’t read “${title}”, so it was skipped.` : 'One calendar item couldn’t be read and was skipped.');
  }
}

function processMaster(comp, overrides, ctx) {
  if (isCancelled(comp)) return;
  const fields = readEventFields(comp);
  const timing = readTiming(comp, ctx);
  if (!timing) return;
  const baseUid = readText(comp, 'uid') || generatedUid(fields.title, timing.start.value);

  if (!comp.hasProperty('rrule') && !comp.hasProperty('rdate')) {
    pushEvent(ctx, makeEvent(baseUid, fields, timing.start, timing.end));
    return;
  }

  const overrideKeys = new Set();
  for (const ov of overrides) {
    const key = recurrenceKey(ov, ctx);
    if (key) overrideKeys.add(key);
  }
  try {
    expandSeries(comp, baseUid, fields, timing, overrideKeys, ctx);
  } catch {
    ctx.warn(`The repeat rule for “${fields.title}” couldn’t be fully read; some occurrences may be missing.`);
    pushEvent(ctx, makeEvent(`${baseUid}::${timing.start.value}`, fields, timing.start, timing.end));
  }

  for (const ov of overrides) {
    guarded(ctx, ov, () => processOverride(ov, baseUid, fields, timing, ctx));
  }
}

function expandSeries(comp, baseUid, fields, timing, skipKeys, ctx) {
  const { start, end, startTime, tzid } = timing;
  const { startMs, endMs } = ctx.range;
  for (const key of exdateKeys(comp, ctx)) skipKeys.add(key);
  if (isFloating(startTime)) alignUntilWithFloatingStart(comp, tzid ? zoneFor(tzid, ctx) : null);

  const spanMs = end.ms - start.ms;
  const spanDays = start.allDay ? daysBetween(start.value, end.value) : 0;
  const iterator = new ICAL.RecurExpansion({ component: comp, dtstart: startTime });
  let emitted = 0;
  let iterations = 0;

  for (let next = iterator.next(); next; next = iterator.next()) {
    if (++iterations > MAX_ITERATIONS) {
      ctx.warn(`“${fields.title}” repeats too often to expand fully; some occurrences were left out.`);
      break;
    }
    const occStart = timeInfo(next, tzid, ctx);
    if (occStart.ms > endMs) break;
    if (skipKeys.has(occStart.value)) continue;
    const occEnd = start.allDay ? dateInfo(addDays(occStart.value, spanDays)) : instantInfo(occStart.ms + spanMs);
    if (occEnd.ms < startMs) continue;
    if (emitted >= MAX_PER_SERIES) {
      ctx.warn(`“${fields.title}” has more than ${MAX_PER_SERIES} occurrences in the selected dates; only the first ${MAX_PER_SERIES} were imported.`);
      break;
    }
    if (!pushEvent(ctx, makeEvent(`${baseUid}::${occStart.value}`, fields, occStart, occEnd))) break;
    emitted++;
  }
}

function processOverride(comp, baseUid, masterFields, masterTiming, ctx) {
  if (isCancelled(comp)) return;
  const key = recurrenceKey(comp, ctx);
  if (!key) return;
  const fields = readEventFields(comp, masterFields);
  const timing = readTiming(comp, ctx, masterTiming);
  if (!timing) return;
  const { startMs, endMs } = ctx.range;
  if (timing.start.ms > endMs || timing.end.ms < startMs) return;
  pushEvent(ctx, makeEvent(`${baseUid}::${key}`, fields, timing.start, timing.end));
}

function processOrphanOverride(comp, ctx) {
  if (isCancelled(comp)) return;
  const fields = readEventFields(comp);
  const timing = readTiming(comp, ctx);
  if (!timing) return;
  const uid = readText(comp, 'uid') || generatedUid(fields.title, timing.start.value);
  const key = recurrenceKey(comp, ctx) || timing.start.value;
  pushEvent(ctx, makeEvent(`${uid}::${key}`, fields, timing.start, timing.end));
}

function processTodo(comp, ctx) {
  if (isCancelled(comp)) return;
  const title = readText(comp, 'summary').trim() || '(No title)';
  const dueProp = comp.getFirstProperty('due');
  const due = dueProp ? timeInfo(dueProp.getFirstValue(), dueProp.getParameter('tzid'), ctx) : null;
  const status = readText(comp, 'status').toUpperCase();
  const percent = Number(comp.getFirstPropertyValue('percent-complete') || 0);
  let uid = readText(comp, 'uid') || generatedUid(title, due ? due.value : '');
  if (ctx.seenTodoUids.has(uid)) uid = `${uid}::${ctx.seenTodoUids.size}`;
  ctx.seenTodoUids.add(uid);
  ctx.todos.push({
    uid,
    title,
    due: due ? due.value : null,
    allDay: due ? due.allDay : false,
    notes: cleanNotes(readText(comp, 'description')),
    completed: status === 'COMPLETED' || comp.hasProperty('completed') || percent >= 100,
  });
}

function readEventFields(comp, fallback = null) {
  const transp = readText(comp, 'transp').toUpperCase();
  const msBusy = readText(comp, 'x-microsoft-cdo-busystatus').toUpperCase();
  return {
    title: readText(comp, 'summary').trim() || fallback?.title || '(No title)',
    location: comp.hasProperty('location') ? readText(comp, 'location').trim() : fallback?.location || '',
    notes: comp.hasProperty('description') ? cleanNotes(readText(comp, 'description')) : fallback?.notes || '',
    url: comp.hasProperty('url') ? readText(comp, 'url').trim() : fallback?.url || '',
    transparent: transp === 'TRANSPARENT' || msBusy === 'FREE',
  };
}

// Reads DTSTART/DTEND/DURATION. `fallback` (the series) supplies start and
// length for overrides that omit them.
function readTiming(comp, ctx, fallback = null) {
  const startProp = comp.getFirstProperty('dtstart') || comp.getFirstProperty('recurrence-id');
  if (!startProp) {
    if (!fallback) ctx.skippedNoStart++;
    return null;
  }
  const startTime = startProp.getFirstValue();
  const tzid = startProp.getParameter('tzid') || null;
  const start = timeInfo(startTime, tzid, ctx);
  const hasEnd = comp.hasProperty('dtend') || comp.hasProperty('duration');
  const end = !hasEnd && fallback ? shiftEnd(start, fallback) : readEnd(comp, start, ctx);
  return { start, end, startTime, tzid };
}

function shiftEnd(start, series) {
  if (start.allDay && series.start.allDay) {
    return dateInfo(addDays(start.value, daysBetween(series.start.value, series.end.value)));
  }
  return defaultEnd(start, series.end.ms - series.start.ms);
}

function readEnd(comp, start, ctx) {
  const endProp = comp.getFirstProperty('dtend');
  if (endProp) {
    const end = timeInfo(endProp.getFirstValue(), endProp.getParameter('tzid'), ctx);
    if (start.allDay) {
      const endDate = end.allDay ? end.value : localDateString(end.ms);
      if (endDate > start.value) return dateInfo(endDate);
    } else if (end.ms >= start.ms) {
      return instantInfo(end.ms);
    }
  } else if (comp.hasProperty('duration')) {
    const seconds = comp.getFirstPropertyValue('duration').toSeconds();
    if (start.allDay && seconds > 0) return dateInfo(addDays(start.value, Math.max(1, Math.ceil(seconds / 86400))));
    if (!start.allDay && seconds >= 0) return instantInfo(start.ms + seconds * 1000);
  }
  return defaultEnd(start);
}

function defaultEnd(start, spanMs = DEFAULT_TIMED_MINUTES * MINUTE) {
  if (start.allDay) return dateInfo(addDays(start.value, 1));
  return instantInfo(start.ms + Math.max(0, spanMs));
}

function recurrenceKey(comp, ctx) {
  const prop = comp.getFirstProperty('recurrence-id');
  if (!prop) return null;
  return timeInfo(prop.getFirstValue(), prop.getParameter('tzid'), ctx).value;
}

function exdateKeys(comp, ctx) {
  const keys = [];
  for (const prop of comp.getAllProperties('exdate')) {
    const tzid = prop.getParameter('tzid');
    for (const value of prop.getValues()) keys.push(timeInfo(value, tzid, ctx).value);
  }
  return keys;
}

// ical.js compares floating occurrences against a UTC UNTIL as if they were
// UTC; rewrite UNTIL as wall-clock time in the event's zone so the last
// occurrence isn't dropped (or an extra one added).
function alignUntilWithFloatingStart(comp, zone) {
  for (const prop of comp.getAllProperties('rrule')) {
    const recur = prop.getFirstValue();
    const until = recur && recur.until;
    if (!until || until.isDate || until.zone !== ICAL.Timezone.utcTimezone) continue;
    const ms = until.toUnixTime() * 1000;
    const p = zone == null ? localParts(ms) : zoneParts(ms, zone);
    recur.until = new ICAL.Time({
      year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, isDate: false,
    }, ICAL.Timezone.localTimezone);
  }
}

function makeEvent(uid, fields, start, end) {
  return {
    uid,
    title: fields.title,
    start: start.value,
    end: end.value,
    allDay: start.allDay,
    location: fields.location,
    notes: fields.notes,
    url: fields.url,
    busy: !fields.transparent && !start.allDay,
    cancelled: false,
  };
}

// Returns false once the global cap is hit.
function pushEvent(ctx, event) {
  if (ctx.events.length >= MAX_TOTAL) {
    if (!ctx.capped) ctx.warn(`This calendar has more than ${MAX_TOTAL} events in the selected dates; only the first ${MAX_TOTAL} were imported.`);
    ctx.capped = true;
    return false;
  }
  let { uid } = event;
  if (ctx.seenUids.has(uid)) {
    // Duplicate UID: keep distinct events apart by start, drop exact repeats.
    const candidate = `${uid}::${event.start}`;
    if (uid.endsWith(`::${event.start}`) || ctx.seenUids.has(candidate)) return true;
    uid = candidate;
  }
  ctx.seenUids.add(uid);
  ctx.events.push(uid === event.uid ? event : { ...event, uid });
  return true;
}

function isCancelled(comp) {
  return readText(comp, 'status').toUpperCase() === 'CANCELLED';
}

function readText(comp, name) {
  const value = comp.getFirstPropertyValue(name);
  return value == null ? '' : String(value);
}

function cleanNotes(text) {
  return String(text || '').trim().slice(0, MAX_NOTES);
}

// ---------------------------------------------------------------------------
// Time conversion

// Converts an ICAL.Time to { allDay, value, ms }: value is 'YYYY-MM-DD' for
// dates, a UTC ISO string otherwise; ms is the UTC instant (local midnight for dates).
function timeInfo(time, tzid, ctx) {
  if (time.isDate) return dateInfo(ymd(time.year, time.month, time.day));
  if (!isFloating(time)) return instantInfo(time.toUnixTime() * 1000);
  const zone = tzid ? zoneFor(tzid, ctx) : null;
  const date = zone == null
    ? new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second)
    : zonedToUtc(time.year, time.month, time.day, time.hour, time.minute, time.second, zone);
  return instantInfo(date.getTime());
}

function isFloating(time) {
  return !time.zone || time.zone === ICAL.Timezone.localTimezone || time.zone.tzid === 'floating';
}

function dateInfo(date) {
  return { allDay: true, value: date, ms: localMidnight(date) };
}

function instantInfo(ms) {
  return { allDay: false, value: new Date(ms).toISOString(), ms };
}

// Resolves a TZID with no VTIMEZONE; null means "treat as local time".
function zoneFor(tzid, ctx) {
  if (ctx.zoneCache.has(tzid)) return ctx.zoneCache.get(tzid);
  const resolved = resolveTzid(tzid);
  if (!resolved) {
    ctx.warn(`Unknown time zone “${tzid}” — those times were imported as your local time.`);
  } else if (resolved.approximate) {
    ctx.warn(`Time zone “${tzid}” was read as a fixed UTC offset; times near daylight-saving changes may be an hour off.`);
  }
  const zone = resolved ? resolved.zone : null;
  ctx.zoneCache.set(tzid, zone);
  return zone;
}

const WINDOWS_ZONES = {
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'us mountain standard time': 'America/Phoenix',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'canada central standard time': 'America/Regina',
  'central standard time (mexico)': 'America/Mexico_City',
  'sa pacific standard time': 'America/Bogota',
  'pacific sa standard time': 'America/Santiago',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'russian standard time': 'Europe/Moscow',
  'turkey standard time': 'Europe/Istanbul',
  'israel standard time': 'Asia/Jerusalem',
  'egypt standard time': 'Africa/Cairo',
  'south africa standard time': 'Africa/Johannesburg',
  'arabian standard time': 'Asia/Dubai',
  'arab standard time': 'Asia/Riyadh',
  'pakistan standard time': 'Asia/Karachi',
  'india standard time': 'Asia/Kolkata',
  'se asia standard time': 'Asia/Bangkok',
  'singapore standard time': 'Asia/Singapore',
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'korea standard time': 'Asia/Seoul',
  'tokyo standard time': 'Asia/Tokyo',
  'w. australia standard time': 'Australia/Perth',
  'cen. australia standard time': 'Australia/Adelaide',
  'e. australia standard time': 'Australia/Brisbane',
  'aus eastern standard time': 'Australia/Sydney',
  'new zealand standard time': 'Pacific/Auckland',
};

// Outlook display names such as "(UTC-05:00) Eastern Time (US & Canada)".
const DISPLAY_ZONES = {
  'eastern time (us & canada)': 'America/New_York',
  'central time (us & canada)': 'America/Chicago',
  'mountain time (us & canada)': 'America/Denver',
  'pacific time (us & canada)': 'America/Los_Angeles',
  'arizona': 'America/Phoenix',
  'alaska': 'America/Anchorage',
  'hawaii': 'Pacific/Honolulu',
  'atlantic time (canada)': 'America/Halifax',
  'coordinated universal time': 'UTC',
  'dublin, edinburgh, lisbon, london': 'Europe/London',
  'amsterdam, berlin, bern, rome, stockholm, vienna': 'Europe/Berlin',
  'brussels, copenhagen, madrid, paris': 'Europe/Paris',
  'osaka, sapporo, tokyo': 'Asia/Tokyo',
  'chennai, kolkata, mumbai, new delhi': 'Asia/Kolkata',
  'canberra, melbourne, sydney': 'Australia/Sydney',
};

// Returns { zone: IANA name | offset minutes, approximate } or null.
function resolveTzid(raw) {
  const id = String(raw).trim().replace(/^["']+|["']+$/g, '').trim();
  if (!id) return null;
  if (isIanaZone(id)) return { zone: id };
  const win = WINDOWS_ZONES[id.toLowerCase()];
  if (win) return { zone: win };

  // Prefixed ids: "/Microsoft/Eastern Standard Time", "/mozilla.org/20050126_1/America/New_York".
  if (id.includes('/')) {
    const parts = id.split('/').filter(Boolean);
    for (let n = Math.min(3, parts.length); n >= 1; n--) {
      const candidate = parts.slice(-n).join('/');
      if (isIanaZone(candidate)) return { zone: candidate };
      const mapped = WINDOWS_ZONES[candidate.toLowerCase()];
      if (mapped) return { zone: mapped };
    }
  }

  const m = id.match(/^\(?(?:UTC|GMT)\s*(?:([+-])\s*(\d{1,2})(?::?(\d{2}))?)?\)?\s*(.*)$/i);
  if (m) {
    const named = DISPLAY_ZONES[m[4].trim().toLowerCase()];
    if (named) return { zone: named };
    const offset = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
    return { zone: offset, approximate: Boolean(m[4].trim()) };
  }
  return null;
}

const ianaCache = new Map();
function isIanaZone(name) {
  if (!ianaCache.has(name)) {
    let ok = false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: name });
      ok = /^[A-Za-z]/.test(name);
    } catch {
      ok = false;
    }
    ianaCache.set(name, ok);
  }
  return ianaCache.get(name);
}

const formatterCache = new Map();
function zoneFormatter(tz) {
  if (!formatterCache.has(tz)) {
    formatterCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatterCache.get(tz);
}

// Wall-clock fields of UTC instant `ms` in `tz` (IANA name or offset minutes).
function zoneParts(ms, tz) {
  if (typeof tz === 'number') {
    const d = new Date(ms + tz * MINUTE);
    return {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
    };
  }
  const out = {};
  for (const { type, value } of zoneFormatter(tz).formatToParts(new Date(ms))) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return { ...out, hour: out.hour % 24 };
}

function localParts(ms) {
  const d = new Date(ms);
  return {
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
  };
}

function zoneOffsetMs(ms, tz) {
  const p = zoneParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in `tz` (IANA name, or offset minutes) → Date (UTC instant).
function zonedToUtc(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const first = zoneOffsetMs(guess, tz);
  let ms = guess - first;
  const second = zoneOffsetMs(ms, tz);
  if (second !== first) ms = guess - second;
  return new Date(ms);
}

// ---------------------------------------------------------------------------
// CSV

const CSV_FIELDS = {
  title: ['subject', 'title', 'name', 'summary', 'event', 'eventname', 'eventtitle'],
  startDate: ['startdate', 'start', 'startdatetime', 'starts', 'begins', 'begin', 'from', 'date'],
  startTime: ['starttime', 'time'],
  endDate: ['enddate', 'end', 'enddatetime', 'ends', 'to', 'until'],
  endTime: ['endtime'],
  allDay: ['alldayevent', 'allday'],
  notes: ['description', 'notes', 'details', 'note', 'body'],
  location: ['location', 'where', 'place', 'venue'],
  showAs: ['showtimeas'],
};

function parseCsv(text, filename) {
  const rows = parseCsvRows(text, detectDelimiter(text)).filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length) throw new Error('This CSV file is empty.');
  const cols = mapCsvColumns(rows[0]);
  if (cols.startDate < 0) {
    throw new Error('This CSV doesn’t have a start date column Pace recognizes. Use headers like “Subject, Start Date, Start Time, End Date, End Time”.');
  }

  const events = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const event = csvRowToEvent(row, cols);
    if (!event) {
      skipped++;
      continue;
    }
    if (seen.has(event.uid)) event.uid = `${event.uid}-${seen.size}`;
    seen.add(event.uid);
    events.push(event);
  }

  const warnings = [];
  if (skipped) warnings.push(`Skipped ${plural(skipped, 'row')} without a readable start date.`);
  if (!events.length) warnings.push('No events were found in this CSV file.');
  return { name: baseName(filename), color: null, events, todos: [], warnings };
}

function csvRowToEvent(row, cols) {
  const cell = (key) => (cols[key] >= 0 ? String(row[cols[key]] ?? '').trim() : '');
  const startDT = parseDateTime(cell('startDate'));
  if (!startDT) return null;
  const startClock = parseClock(cell('startTime')) || startDT.time;
  const allDay = (cols.allDay >= 0 && isTruthy(cell('allDay'))) || !startClock;
  const title = cell('title') || '(No title)';

  let start;
  let end;
  if (allDay) {
    start = startDT.date;
    end = csvAllDayEnd(start, parseDateTime(cell('endDate')), parseClock(cell('endTime')));
  } else {
    const startMs = wallToMs(startDT.date, startClock);
    start = new Date(startMs).toISOString();
    end = new Date(csvTimedEnd(startDT, startMs, parseDateTime(cell('endDate')), parseClock(cell('endTime')))).toISOString();
  }

  const showAs = cell('showAs').toLowerCase();
  return {
    uid: generatedUid(title, start),
    title,
    start,
    end,
    allDay,
    location: cell('location'),
    notes: cleanNotes(cell('notes')),
    url: '',
    busy: !allDay && showAs !== '0' && showAs !== 'free',
    cancelled: false,
  };
}

// Outlook writes all-day ends as 12:00 AM on the following day (exclusive);
// a bare end date is treated as the inclusive last day.
function csvAllDayEnd(start, endDT, endClock) {
  let end = null;
  if (endDT) {
    const clock = endClock || endDT.time;
    const exclusive = clock && clock.hour === 0 && clock.minute === 0;
    end = exclusive ? endDT.date : addDays(endDT.date, 1);
  }
  return end && end > start ? end : addDays(start, 1);
}

function csvTimedEnd(startDT, startMs, endDT, endClock) {
  const clock = endClock || (endDT && endDT.time);
  if (clock) {
    const baseDate = endDT ? endDT.date : startDT.date;
    let endMs = wallToMs(baseDate, clock);
    if (!endDT && endMs < startMs) endMs = wallToMs(addDays(baseDate, 1), clock); // overnight
    if (endMs >= startMs) return endMs;
  }
  return startMs + HOUR;
}

function mapCsvColumns(header) {
  const keys = header.map((h) => h.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const cols = {};
  for (const [field, aliases] of Object.entries(CSV_FIELDS)) {
    cols[field] = -1;
    for (const alias of aliases) {
      const idx = keys.indexOf(alias);
      if (idx >= 0) {
        cols[field] = idx;
        break;
      }
    }
  }
  // A lone "Start Time"/"End Time" column may hold full date-times.
  if (cols.startDate < 0 && cols.startTime >= 0) [cols.startDate, cols.startTime] = [cols.startTime, -1];
  if (cols.endDate < 0 && cols.endTime >= 0 && cols.startTime < 0) [cols.endDate, cols.endTime] = [cols.endTime, -1];
  return cols;
}

function detectDelimiter(text) {
  const header = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
  if (header.includes(',')) return ',';
  if (header.includes(';')) return ';';
  if (header.includes('\t')) return '\t';
  return ',';
}

// RFC 4180: quoted fields may contain delimiters, newlines and "" escapes.
// Expects newlines already normalized to \n.
function parseCsvRows(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[++i];
      else inQuotes = false;
    } else if (c === '"' && !field.trim()) {
      field = '';
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function looksLikeCsv(text) {
  const header = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
  if (!/[,;\t]/.test(header) || /[<>{}]/.test(header)) return false;
  return mapCsvColumns(parseCsvRows(header, detectDelimiter(header))[0] || []).startDate >= 0;
}

// Parses a date with optional time: ISO, M/D/YYYY, D/M/YYYY (when the first
// part > 12), DD.MM.YYYY, or text dates like "Nov 13, 2026".
// Returns { date: 'YYYY-MM-DD', time: clock|null } or null.
function parseDateTime(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  let y;
  let mo;
  let d;
  let rest = '';
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s,]+(.*))?$/i);
  if (m) {
    [y, mo, d, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || ''];
  } else if ((m = s.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?:[T\s,]+(.*))?$/))) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const dayFirst = m[2] === '.' ? b <= 12 : a > 12;
    [mo, d] = dayFirst ? [b, a] : [a, b];
    y = expandYear(m[4]);
    rest = m[5] || '';
  } else {
    return parseTextDate(s);
  }
  if (!validDate(y, mo, d)) return null;
  const date = ymd(y, mo, d);
  if (!rest.trim()) return { date, time: null };
  const time = parseClock(rest);
  if (!time) return null;
  // A zone suffix means an exact instant: shift into local wall-clock time.
  if (time.offset != null) return fromInstant(Date.UTC(y, mo - 1, d, time.hour, time.minute, time.second) - time.offset * MINUTE);
  return { date, time };
}

function parseTextDate(s) {
  if (!/[a-z]{3}/i.test(s)) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  const parsed = fromInstant(ms);
  return /\d:\d/.test(s) ? parsed : { date: parsed.date, time: null };
}

function fromInstant(ms) {
  const p = localParts(ms);
  return { date: ymd(p.year, p.month, p.day), time: { hour: p.hour, minute: p.minute, second: p.second } };
}

// "10:00 AM", "10 pm", "22:15:00", "09:00:00.000Z", "14:00+02:00" → clock or null.
function parseClock(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\.\d+)?\s*([ap])?\.?\s*(?:m\.?)?\s*(z|utc|gmt|[+-]\d{2}:?\d{2})?$/i);
  if (!m || (m[2] == null && !m[4])) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const second = Number(m[3] || 0);
  if (m[4]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[4].toLowerCase() === 'p' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  const clock = { hour, minute, second };
  if (m[5]) clock.offset = parseOffset(m[5]);
  return clock;
}

function parseOffset(text) {
  if (/^(z|utc|gmt)$/i.test(text)) return 0;
  const m = text.match(/^([+-])(\d{2}):?(\d{2})$/);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function wallToMs(date, clock) {
  const [y, m, d] = date.split('-').map(Number);
  if (clock.offset != null) return Date.UTC(y, m - 1, d, clock.hour, clock.minute, clock.second) - clock.offset * MINUTE;
  return new Date(y, m - 1, d, clock.hour, clock.minute, clock.second).getTime();
}

function expandYear(text) {
  const n = Number(text);
  if (text.length === 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

function isTruthy(text) {
  return /^(true|yes|y|1|x|on|checked)$/i.test(String(text).trim());
}

// ---------------------------------------------------------------------------
// Fetch helpers

function normalizeCalendarUrl(url) {
  let s = String(url || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  else if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw codedError('BAD_URL', 'That doesn’t look like a web address. Paste the calendar’s full iCal/ICS link.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw codedError('BAD_URL', 'Calendar links must start with https://, http:// or webcal://.');
  }
  return parsed.href;
}

function buildProxyUrl(proxy, target) {
  const encoded = encodeURIComponent(target);
  return proxy.includes('{url}') ? proxy.split('{url}').join(encoded) : proxy + encoded;
}

function directFetchError() {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline) return codedError('NETWORK', 'You appear to be offline. Reconnect and try again.');
  return codedError('CORS', 'Pace couldn’t load this calendar directly — the calendar server doesn’t allow web apps to read it (CORS), or it couldn’t be reached. Add a CORS proxy in Settings, or download the .ics file and import it instead.');
}

function httpError(status) {
  let hint = '';
  if (status === 401 || status === 403) hint = ' The link may be private or expired — copy a fresh one from your calendar app.';
  else if (status === 404 || status === 410) hint = ' Check that the address is correct and the calendar still exists.';
  else if (status >= 500) hint = ' The calendar server had a problem; try again later.';
  const err = codedError('HTTP', `The calendar server responded with an error (HTTP ${status}).${hint}`);
  err.status = status;
  return err;
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Small utilities

function resolveRange(rangeStart, rangeEnd) {
  const now = Date.now();
  const toMs = (v) => (v == null ? NaN : new Date(v).getTime());
  let startMs = toMs(rangeStart);
  let endMs = toMs(rangeEnd);
  if (Number.isNaN(startMs)) startMs = now - 180 * DAY;
  if (Number.isNaN(endMs)) endMs = now + 365 * DAY;
  return { startMs: Math.min(startMs, endMs), endMs: Math.max(startMs, endMs) };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

function fileExtension(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function baseName(filename) {
  const name = String(filename || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').trim();
  return name || null;
}

function normalizeHexColor(value) {
  const m = String(value || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1].slice(0, 6);
  return `#${hex.toLowerCase()}`;
}

function ymd(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function validDate(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

function daysBetween(a, b) {
  const toUtc = (s) => Date.UTC(...s.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)));
  return Math.max(1, Math.round((toUtc(b) - toUtc(a)) / DAY));
}

function localMidnight(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function localDateString(ms) {
  const p = localParts(ms);
  return ymd(p.year, p.month, p.day);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function generatedUid(title, start) {
  return `gen-${hashString(`${title}|${start}`)}`;
}

// cyrb53: fast, deterministic 53-bit string hash.
function hashString(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
