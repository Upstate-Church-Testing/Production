// Resi › Studio: when a scheduled event runs, worked out from the same fields as Resi
// Studio's event form. Dates are local calendar days ("2026-11-15"); times are minutes from
// midnight in the event's own timezone (shown as typed, with the zone named when it isn't
// Eastern). Weeks start on Sunday. Nothing here talks to Resi.
//
// An event: { start_date, start_time "08:10", duration_min, prebuffer_min, repeats,
//   repeat_every, repeat_unit hour|day|week|month, repeat_days [0..6], repeat_month date|weekday,
//   ends never|on|after, ends_on, ends_after, paused, service_time }

export const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const NTH = ['first', 'second', 'third', 'fourth', 'fifth'];
export const ZONES = [
  ['America/New_York', 'Eastern', 'ET'], ['America/Chicago', 'Central', 'CT'], ['America/Denver', 'Mountain', 'MT'],
  ['America/Phoenix', 'Arizona', 'MST'], ['America/Los_Angeles', 'Pacific', 'PT'], ['UTC', 'UTC', 'UTC'],
];
export const HOME_ZONE = 'America/New_York';

// ------------------------------------------------------------------ dates ---
/** "2026-11-15" -> a local Date at midnight. */
export function day(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
/** A Date -> "2026-11-15". */
export function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function addDays(s, n) { const d = day(s); d.setDate(d.getDate() + n); return iso(d); }
export function today() { return iso(new Date()); }
/** Whole days from a to b (b later: positive). */
export function daysBetween(a, b) { return Math.round((day(b) - day(a)) / 864e5); }
export const weekday = (s) => day(s).getDay();

// ------------------------------------------------------------------ times ---
/** "08:10" or "08:10:00" -> 490. */
export function mins(t) { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; }
/** "08:10:00" -> "08:10" (what a time input wants). */
export const hhmm = (t) => (t ? String(t).slice(0, 5) : '');
/** 490 -> "8:10 AM". Past midnight wraps (-30 -> "11:30 PM"). */
export function clock(m) {
  if (m == null) return '';
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(x / 60); const mm = x % 60;
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
/** Short, for tight spots: "8:10" (with "p" after noon when asked). */
export function clockShort(m, ampm = false) {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(x / 60);
  return `${h % 12 || 12}:${String(x % 60).padStart(2, '0')}${ampm ? (h < 12 ? 'a' : 'p') : ''}`;
}
/** 70 -> "1:10" (hours:minutes, how Resi's form and the team say it). */
export function dur(m) { if (m == null) return ''; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; }
/** 70 -> "1 hour 10 minutes". */
export function durWords(m) {
  if (m == null) return '';
  const h = Math.floor(m / 60); const r = m % 60;
  return [h ? `${h} hour${h === 1 ? '' : 's'}` : '', r ? `${r} minute${r === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || '0 minutes';
}
export const zoneShort = (z) => ZONES.find(([id]) => id === z)?.[2] || z || '';

/** Minutes a zone is ahead of UTC on a date (at noon there). */
function zoneOffset(zone, date) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = /GMT([+-])(\d{1,2})(?::(\d\d))?/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
  } catch { return 0; }
}
/** How many minutes to add to a time in `zone` to get Eastern time on that date (Central: +60). */
export function zoneShift(zone, date) {
  if (!zone || zone === HOME_ZONE) return 0;
  return zoneOffset(HOME_ZONE, date) - zoneOffset(zone, date);
}

// ------------------------------------------------------------- occurrences ---
/** Every start (minutes from midnight) the event has on this date, ignoring how it ends. */
function startsOn(ev, date) {
  const start = mins(ev.start_time);
  if (start == null) return [];
  const anchor = ev.start_date ? String(ev.start_date).slice(0, 10) : null;
  if (anchor && date < anchor) return [];
  if (!ev.repeats) return anchor === date ? [start] : [];
  const every = Math.max(1, Number(ev.repeat_every) || 1);
  const unit = ev.repeat_unit || 'week';
  if (unit === 'hour') {
    const step = every * 60;
    const out = [];
    if (!anchor) { for (let t = start % step; t < 1440; t += step) out.push(t); return out; }
    const from = daysBetween(anchor, date) * 1440; // this day's midnight, counted from the first day's
    let k = Math.max(0, Math.ceil((from - start) / step));
    for (let t = start + k * step - from; t < 1440; k += 1, t = start + k * step - from) out.push(t);
    return out;
  }
  if (unit === 'day') return !anchor || daysBetween(anchor, date) % every === 0 ? [start] : [];
  if (unit === 'week') {
    const days = (ev.repeat_days || []).length ? ev.repeat_days.map(Number) : anchor ? [weekday(anchor)] : [];
    if (!days.includes(weekday(date))) return [];
    if (!anchor || every === 1) return [start];
    const weeks = Math.floor(daysBetween(addDays(anchor, -weekday(anchor)), addDays(date, -weekday(date))) / 7);
    return weeks % every === 0 ? [start] : [];
  }
  if (unit === 'month') {
    if (!anchor) return [];
    const a = day(anchor); const d = day(date);
    const months = (d.getFullYear() - a.getFullYear()) * 12 + d.getMonth() - a.getMonth();
    if (months % every !== 0) return [];
    if ((ev.repeat_month || 'date') === 'date') return d.getDate() === a.getDate() ? [start] : [];
    return d.getDay() === a.getDay() && Math.ceil(d.getDate() / 7) === Math.ceil(a.getDate() / 7) ? [start] : [];
  }
  return [];
}

/** How many times it has started before this date (for "ends after N times"). */
function countBefore(ev, date) {
  const anchor = ev.start_date ? String(ev.start_date).slice(0, 10) : null;
  if (!anchor) return 0;
  let n = 0;
  for (let d = anchor; d < date; d = addDays(d, 1)) {
    n += startsOn(ev, d).length;
    if (n > 100000) break;
  }
  return n;
}

/** The runs on this date: [{ start, on (encoder on), end, service, n (which time this is), last }].
 *  Paused events still come back (marked paused by the caller): Studio keeps them, they just
 *  don't run. */
export function runsOn(ev, date) {
  let starts = startsOn(ev, date);
  if (!starts.length) return [];
  if (ev.repeats && ev.ends === 'on' && ev.ends_on && date > String(ev.ends_on).slice(0, 10)) return [];
  let before = 0;
  if (ev.repeats && ev.ends === 'after' && ev.ends_after) {
    before = countBefore(ev, date);
    starts = starts.filter((_, i) => before + i < ev.ends_after);
    if (!starts.length) return [];
  }
  const pre = Number(ev.prebuffer_min) || 0;
  const len = Number(ev.duration_min) || 0;
  const svc = mins(ev.service_time);
  return starts.map((start, i) => ({
    start, on: start - pre, end: start + len, service: svc, n: before + i + 1,
    last: ev.repeats && ev.ends === 'after' && ev.ends_after ? before + i + 1 === Number(ev.ends_after) : !ev.repeats,
  }));
}

/** The next date (from `from`, going `dir` 1 or -1, not counting `from` itself) any of these
 *  events runs on, within `limit` days; null if none. */
export function nextDate(events, from, dir = 1, limit = 400) {
  for (let i = 1; i <= limit; i += 1) {
    const d = addDays(from, i * dir);
    if (events.some((ev) => runsOn(ev, d).length)) return d;
  }
  return null;
}

/** The first date on or after `from` an event runs, or null. */
export function firstRun(ev, from, limit = 400) {
  for (let i = 0; i <= limit; i += 1) { const d = addDays(from, i); if (runsOn(ev, d).length) return d; }
  return null;
}

/** Is it over: a one-time event whose date has passed, or a repeating one that has ended. */
export function isOver(ev, onDate = today()) {
  if (!ev.repeats) return !!ev.start_date && String(ev.start_date).slice(0, 10) < onDate;
  if (ev.ends === 'on' && ev.ends_on) return String(ev.ends_on).slice(0, 10) < onDate;
  if (ev.ends === 'after' && ev.ends_after) return !firstRun(ev, onDate, 800);
  return false;
}

// ---------------------------------------------------------------- in words ---
/** "Weekly on Sunday", "Every 2 weeks on Sun, Wed", "Monthly on the third Sunday", "Once". */
export function repeatText(ev) {
  if (!ev.repeats) return 'Once';
  const every = Math.max(1, Number(ev.repeat_every) || 1);
  const unit = ev.repeat_unit || 'week';
  const anchor = ev.start_date ? String(ev.start_date).slice(0, 10) : null;
  if (unit === 'hour') return every === 1 ? 'Every hour' : `Every ${every} hours`;
  if (unit === 'day') return every === 1 ? 'Daily' : `Every ${every} days`;
  if (unit === 'week') {
    const days = (ev.repeat_days || []).length ? [...ev.repeat_days].map(Number).sort() : anchor ? [weekday(anchor)] : [];
    const on = days.length === 1 ? DAY[days[0]] : days.map((x) => DAY3[x]).join(', ');
    return `${every === 1 ? 'Weekly' : `Every ${every} weeks`}${on ? ` on ${on}` : ''}`;
  }
  if (unit === 'month') {
    const lead = every === 1 ? 'Monthly' : `Every ${every} months`;
    if (!anchor) return lead;
    const a = day(anchor);
    return (ev.repeat_month || 'date') === 'date' ? `${lead} on day ${a.getDate()}` : `${lead} on the ${NTH[Math.ceil(a.getDate() / 7) - 1]} ${DAY[a.getDay()]}`;
  }
  return 'Repeats';
}

/** How it ends: "No end", "Until Dec 31, 2026", "12 times". */
export function endText(ev) {
  if (!ev.repeats) return ev.start_date ? dateText(ev.start_date, true) : 'No date';
  if (ev.ends === 'on' && ev.ends_on) return `Until ${dateText(ev.ends_on, true)}`;
  if (ev.ends === 'after' && ev.ends_after) return `${ev.ends_after} time${Number(ev.ends_after) === 1 ? '' : 's'}`;
  return 'No end';
}

/** "Sun, Nov 15" (with the year when asked, or when it isn't this year). */
export function dateText(s, withYear = false) {
  const d = day(s);
  const y = withYear || d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(y ? { year: 'numeric' } : {}) });
}

/** The monthly choices for a start date: ["On day 15", "On the third Sunday"]. */
export function monthChoices(anchor) {
  if (!anchor) return ['On the same date', 'On the same weekday'];
  const a = day(anchor);
  return [`On day ${a.getDate()}`, `On the ${NTH[Math.ceil(a.getDate() / 7) - 1]} ${DAY[a.getDay()]}`];
}
