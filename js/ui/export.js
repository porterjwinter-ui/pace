import { addDays, parseWhen } from '../dates.js';
import { expandEvents } from '../events.js';
import { dueDate } from '../scheduler.js';

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
const icsUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDate = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const fold = (line) => line.length <= 74 ? line : line.match(/.{1,74}/g).join('\r\n ');

/** Events (next year), work sessions and due dates as one .ics file. */
export function exportIcs(v) {
  const now = new Date();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pace//Planner//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Pace'];
  const stamp = icsUtc(now);
  const add = (uid, summary, start, end, allDay, desc = '') => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@pace`, `DTSTAMP:${stamp}`);
    if (allDay) lines.push(`DTSTART;VALUE=DATE:${icsDate(start)}`, `DTEND;VALUE=DATE:${icsDate(end)}`);
    else lines.push(`DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(end)}`);
    lines.push(fold(`SUMMARY:${icsText(summary)}`));
    if (desc) lines.push(fold(`DESCRIPTION:${icsText(desc)}`));
    lines.push('END:VEVENT');
  };
  for (const e of expandEvents(v, addDays(now, -30), addDays(now, 365))) add(e.id, e.title, e.start, e.end, e.allDay, e.notes);
  const tasks = new Map(v.tasks.map((t) => [t.id, t]));
  for (const b of v.blocks) {
    const t = tasks.get(b.taskId);
    if (!t || b.status === 'skipped') continue;
    add(b.id, `${b.status === 'done' ? '✓ ' : ''}${t.title}`, parseWhen(b.start), parseWhen(b.end), false, 'Work session planned by Pace');
  }
  for (const t of v.tasks) {
    const d = dueDate(t);
    add(`due-${t.id}`, `Due: ${t.title}`, d, new Date(+d + 15 * 60000), false, t.notes);
  }
  lines.push('END:VCALENDAR');
  download('pace.ics', lines.join('\r\n'), 'text/calendar');
}

export function exportBackup(v, username) {
  const data = { ...v, settings: { ...v.settings, aiKey: v.settings.aiKey ? '(removed)' : '' } };
  download(`pace-backup-${username}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
}
