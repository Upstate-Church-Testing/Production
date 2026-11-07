// PCO's model and the Scheduling grid's rows, shared by PCO › Scheduling (views/services.js)
// and Home (the Sunday check), so both count the same people the same way.

import { ALL } from './picker.js';
import { clock, teamKey, teamServices, hiddenPosition } from './pco.js';

/** Training spots ("CG (Training)") aren't rows on the Scheduling grid. */
export const TRAINING = /\btraining\b/i;

/** Everything PCO's pages need, worked out from what this person is allowed to read:
 *  data and status from the store, `wantWeek` the Scheduling week asked for ('sun' or 'mid'). */
export function pcoModel(d, status, ctx, wantWeek) {
  if (!d) return null;
  const c = clock(status?.time_zone);
  const types = d.types.filter((t) => t.access !== 'hidden'); // admins can read hidden ones; they don't show here
  const typeById = new Map(types.map((t) => [t.id, t]));
  const teams = d.teams.filter((t) => t.shown && teamServices(t).some((id) => typeById.has(id)));
  const start = (p) => {
    const first = p.times.find((x) => x.kind === 'service' && x.starts_at);
    return Date.parse(first?.starts_at || p.sort_date);
  };
  // No audio, except on services an admin marked to keep their audio op (the midweeks).
  const keepAudio = (typeId) => !!typeById.get(typeId)?.show_audio;
  const shows = (typeId, position) => keepAudio(typeId) || !hiddenPosition(position);
  const plans = d.plans.filter((p) => typeById.has(p.service_type_id))
    .map((p) => ({ ...p, needed: (p.needed || []).filter((n) => shows(p.service_type_id, n.position)), _day: c.day(p.sort_date), _start: start(p) }))
    .sort((a, b) => a._start - b._start || (typeById.get(a.service_type_id).sequence ?? 99) - (typeById.get(b.service_type_id).sequence ?? 99));
  const planType = new Map(plans.map((p) => [p.id, p.service_type_id]));
  const people = new Map();
  for (const p of d.people) if (shows(planType.get(p.plan_id), p.position)) people.set(p.plan_id, [...(people.get(p.plan_id) || []), p]);
  // Planning Center is copied from some weeks back, so what already happened is here too.
  // Past is before today (a service day counts as coming up until the day is over).
  const today = c.day(Date.now());
  const upcoming = plans.filter((p) => p._day >= today);
  const me = ctx.me.pco_person_id;
  const mine = me ? upcoming.filter((p) => (people.get(p.id) || []).some((x) => x.person_id === me)) : [];
  const type = (p) => typeById.get(p.service_type_id);
  const plansAt = (campusId) => plans.filter((p) => type(p).campus_id === campusId);
  const places = ctx.campuses.filter((cp) => plansAt(cp.id).length);
  // PCO › Scheduling: shared services an admin hasn't taken off it (Settings › Planning Center),
  // Sunday mornings or Wednesdays (the midweeks: kept audio, or named for it). One at a time.
  const midweek = (t) => !!t && (!!t.show_audio || /mid\s*-?\s*week|wednesday/i.test(t.name));
  const weekOf = (t) => (midweek(t) ? 'mid' : 'sun');
  const rosterAll = plans.filter((p) => type(p).on_roster !== false);
  const weeks = new Set(rosterAll.map((p) => weekOf(type(p))));
  const week = weeks.has(wantWeek || 'sun') ? wantWeek || 'sun' : weeks.has('sun') ? 'sun' : 'mid';
  const rosterIn = (w) => rosterAll.filter((p) => weekOf(type(p)) === w);
  const onRoster = rosterIn(week);
  const rosterAt = (campusId) => onRoster.filter((p) => type(p).campus_id === campusId);
  const rosterPlaces = ctx.campuses.filter((cp) => rosterAt(cp.id).length);
  // The services on each, even ones with nothing copied yet (Wednesdays shows every position).
  const rosterTypes = (w) => types.filter((t) => t.on_roster !== false && weekOf(t) === w);
  return { c, today, types, typeById, teams, plans, upcoming, people, me, mine, type, plansAt, places,
    week, weeks, rosterIn, rosterTypes, onRoster, rosterAt, rosterPlaces };
}
/** The Scheduling grid's rows: one per location and position, a cell per day, one pill per person
 *  (their answer for the whole day), and the open spots. `where` is a campus id or ALL. */
export function rosterData(m, week, where, campuses) {
  const scope = m.rosterIn(week).filter((p) => where === ALL || m.type(p).campus_id === where);
  const teamOf = new Map(m.teams.map((t) => [t.id, t]));
  const days = [...new Set(scope.map((p) => p._day))].sort();
  const campusAt = (id) => { const i = campuses.findIndex((c) => c.id === id); return i < 0 ? 999 : i; };
  // Teams with the same name (each service type has its own "Broadcast") are one team here.
  const teamRank = new Map();
  const posRank = new Map();
  for (const t of [...m.teams].sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99))) {
    const k = teamKey(t.name);
    if (!teamRank.has(k)) teamRank.set(k, teamRank.size);
    (t.positions || []).forEach((x, i) => { const pk = `${k}|${teamKey(x.name)}`; if (!posRank.has(pk)) posRank.set(pk, i); });
  }
  const rows = new Map();
  const rowFor = (campusId, team, position) => {
    const tk = teamKey(team.name);
    const pk = teamKey(position || team.name);
    const key = `${campusId}|${tk}|${pk}`;
    let row = rows.get(key);
    if (!row) {
      // Audio (kept on the midweeks) goes after the team's other positions.
      rows.set(key, row = { key, campusId, team: team.name, position: position || team.name, cells: new Map(),
        at: [campusAt(campusId), teamRank.get(tk) ?? 99, hiddenPosition(position) ? 1 : 0, posRank.get(`${tk}|${pk}`) ?? 500] });
    }
    return row;
  };
  // Wednesdays: every position on the midweeks' shown teams gets a row, filled or not
  // (Sundays only lists positions someone is on, or that are open).
  if (week === 'mid') {
    for (const t of m.rosterTypes('mid')) {
      if (!t.campus_id || (where !== ALL && t.campus_id !== where)) continue;
      for (const team of m.teams.filter((x) => teamServices(x).includes(t.id))) {
        for (const x of team.positions || []) if (x.name && !TRAINING.test(x.name)) rowFor(t.campus_id, team, x.name);
      }
    }
  }
  const cellFor = (p, team, position) => {
    const row = rowFor(m.type(p).campus_id || '', team, position);
    let cell = row.cells.get(p._day);
    if (!cell) row.cells.set(p._day, cell = { people: new Map(), openBy: new Map(), openTeam: new Map() });
    return cell;
  };
  for (const p of scope) {
    for (const r of m.people.get(p.id) || []) {
      const team = teamOf.get(r.team_id);
      if (!team || TRAINING.test(r.position || '')) continue;
      const cell = cellFor(p, team, r.position);
      const who = r.person_id || r.name || r.id;
      let pill = cell.people.get(who);
      if (!pill) cell.people.set(who, pill = { person_id: r.person_id, name: r.name, photo: r.photo, entries: [] });
      pill.entries.push({ plan: p, status: r.status || 'U', invite: !!r.invite_pending, ppid: r.id });
    }
    for (const n of p.needed || []) {
      const team = teamOf.get(n.team_id);
      if (!team || TRAINING.test(n.position || '')) continue;
      const cell = cellFor(p, team, n.position);
      cell.openBy.set(p.id, (cell.openBy.get(p.id) || 0) + Math.max(1, n.quantity || 1));
      cell.openTeam.set(p.id, n.team_id);
    }
  }
  const seq = (p) => m.type(p).sequence ?? 99;
  for (const row of rows.values()) {
    for (const cell of row.cells.values()) {
      for (const pill of cell.people.values()) {
        // First service on top, last on the bottom.
        pill.entries.sort((a, b) => a.plan._start - b.plan._start || seq(a.plan) - seq(b.plan));
        pill.status = wholeDay(pill.entries.map((e) => e.status));
        pill.invite = pill.entries.some((e) => e.invite && e.status !== 'D'); // scheduled, invite email not sent yet
      }
      // An open spot on Vintage and Modern is one spot for one person, not two.
      cell.open = Math.max(0, ...cell.openBy.values());
    }
  }
  const list = [...rows.values()].sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2] || a.at[3] - b.at[3] || a.position.localeCompare(b.position));
  // Show the team only where a location has the same position on two teams ("Audio").
  const seen = new Map();
  for (const r of list) { const k = `${r.campusId}|${teamKey(r.position)}`; seen.set(k, (seen.get(k) || 0) + 1); }
  for (const r of list) r.showTeam = seen.get(`${r.campusId}|${teamKey(r.position)}`) > 1;
  return { days, rows: list };
}
/** A person's answer for the whole day: any decline wins, then any request still out. */
export function wholeDay(statuses) {
  if (statuses.includes('D')) return 'D';
  if (statuses.some((x) => x !== 'C')) return 'U';
  return 'C';
}
