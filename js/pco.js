// Planning Center helpers shared by the Services tab and its settings.

export const PCO_TOKENS_URL = 'https://api.planningcenteronline.com/oauth/applications';

export const STATUS_LABEL = { C: 'Confirmed', U: 'Requested', D: 'Declined' };

export const ACCESS = [
  ['hidden', 'Off', 'Nobody sees it here'],
  ['staff', 'Staff', 'Staff and admins'],
  ['everyone', 'Everyone', 'Volunteers too'],
];

export const teamKey = (name) => String(name || '').trim().toLowerCase();

/** The services a team is on (a Planning Center team can be shared by several). */
export const teamServices = (t) => (t.service_type_ids?.length ? t.service_type_ids : [t.service_type_id]);

/** Date and time formatting in the church's time zone, whatever the device's. */
export function clock(timeZone = 'America/New_York') {
  const safe = (opts) => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }); } catch { return new Intl.DateTimeFormat('en-US', opts); }
  };
  const dayKey = (() => { try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { return new Intl.DateTimeFormat('en-CA'); } })();
  const weekday = safe({ weekday: 'long' });
  const short = safe({ month: 'short', day: 'numeric' });
  const time = safe({ hour: 'numeric', minute: '2-digit' });
  const day = (d) => dayKey.format(new Date(d)); // 2026-10-18
  const t = (d) => time.format(new Date(d)).replace(':00', '').replace(/ /g, ' ');

  return {
    day,
    weekday: (d) => weekday.format(new Date(d)),
    date: (d) => short.format(new Date(d)),
    time: t,
    /** "9:30 & 11:30 AM", "10 AM & 6 PM", "8, 9:30 & 11 AM" */
    times(list) {
      const parts = list.map((d) => t(d)).filter(Boolean);
      if (!parts.length) return '';
      const suffix = parts.map((p) => p.slice(-2));
      const same = suffix.every((x) => x === suffix[0]);
      const bare = same ? parts.map((p) => p.slice(0, -3)) : parts;
      const joined = bare.length === 1 ? bare[0] : `${bare.slice(0, -1).join(', ')} & ${bare[bare.length - 1]}`;
      return same ? `${joined} ${suffix[0]}` : joined;
    },
    /** "Today", "Tomorrow", "In 5 days" */
    relative(d) {
      const a = Date.parse(day(Date.now()) + 'T00:00:00Z');
      const b = Date.parse(day(d) + 'T00:00:00Z');
      const n = Math.round((b - a) / 864e5);
      if (n === 0) return 'Today';
      if (n === 1) return 'Tomorrow';
      if (n === -1) return 'Yesterday';
      return n > 0 ? `In ${n} days` : `${-n} days ago`;
    },
  };
}

/** Planning Center's own initials pictures are skipped; we draw initials ourselves. */
export const realPhoto = (url) => (url && /^https:\/\//.test(url) && !/\/initials\//.test(url) ? url : null);
