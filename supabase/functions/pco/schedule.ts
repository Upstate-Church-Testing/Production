// Scheduling from the app (staff), through the church-wide connection.
//
//   candidates  who on the team could fill an open spot, with what Planning Center
//               knows about that day: blockouts, declines, anything else they're on
//   schedule    put someone on one or more of that day's services. They're added the
//               way Planning Center's own scheduling adds people: unconfirmed, with the
//               invite email prepared but NOT sent (the ✉️ in Planning Center). The API
//               can't send it; whoever scheduled them sends it from the plan.
//   unschedule  take someone back off, only while their invite hasn't gone out

import { PcoError, relId, type Pco } from './pco.ts';
import { hiddenPosition, refreshRoster, type Db } from './sync.ts';

export type Spot = { plan_id: string; team_id: string };
export type PlanRow = { id: string; service_type_id: string; sort_date: string; times: any[]; url: string | null };
export type TeamRow = { id: string; service_type_id: string; name: string; shown: boolean; positions: { id: string; name: string }[] };

export type ScheduleDb = Pick<Db, 'savePeople' | 'updatePlan' | 'pulse'> & {
  plans(ids: string[]): Promise<(PlanRow & { access: string })[]>;
  teams(ids: string[]): Promise<TeamRow[]>;
  shownTeamIds(): Promise<string[]>;
  members(teamIds: string[]): Promise<{ team_id: string; person_id: string; positions: string[] }[]>;
  volunteers(personIds: string[]): Promise<{ pco_person_id: string; name: string; photo: string | null; lanyard: string | null }[]>;
  planPerson(id: string): Promise<{ id: string; plan_id: string; team_id: string; person_id: string | null; name: string; position: string | null; invite_pending: boolean } | null>;
  log(row: { by: string | null; action: 'schedule' | 'remove'; plan_id: string; plan_person_id: string | null; person_id: string | null; person_name: string | null; team_id: string | null; position: string | null }): Promise<void>;
};

export class Refused extends Error {}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const ID = /^\d{1,15}$/;

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** yyyy-mm-dd of an instant in the church's time zone, and n days later. */
export function localDay(iso: string, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** Checks what the app asked for against what's shared and shown, and finds each pick's position. */
async function resolve(db: ScheduleDb, picks: Spot[], position: string) {
  if (!Array.isArray(picks) || !picks.length || picks.length > 8) throw new Refused('Pick at least one service.');
  if (!position || typeof position !== 'string' || position.length > 120) throw new Refused('Which position?');
  if (hiddenPosition(position)) throw new Refused('Audio isn’t scheduled from here.');
  for (const p of picks) if (!ID.test(String(p?.plan_id)) || !ID.test(String(p?.team_id))) throw new Refused('That service isn’t in the app.');
  const plans = new Map((await db.plans(picks.map((p) => String(p.plan_id)))).map((p) => [p.id, p]));
  const teams = new Map((await db.teams(picks.map((p) => String(p.team_id)))).map((t) => [t.id, t]));
  return picks.map((p) => {
    const plan = plans.get(String(p.plan_id));
    const team = teams.get(String(p.team_id));
    if (!plan || plan.access === 'hidden') throw new Refused('That service isn’t shared in the app.');
    if (!team || !team.shown) throw new Refused('That team isn’t shown in the app.');
    const pos = (team.positions || []).find((x) => norm(x.name) === norm(position));
    if (!pos) throw new Refused(`${team.name} has no ${position} position.`);
    return { plan, team, pos };
  });
}

/** The time a set of plans covers (calls and rehearsals included), for checking blockouts. */
function window(plans: PlanRow[]) {
  let from = Infinity;
  let to = -Infinity;
  for (const p of plans) {
    const times = (p.times || []).filter((t: any) => t?.starts_at);
    if (!times.length) { const s = Date.parse(p.sort_date); from = Math.min(from, s); to = Math.max(to, s + 2 * 36e5); continue; }
    for (const t of times) {
      const s = Date.parse(t.starts_at);
      const e = t.ends_at ? Date.parse(t.ends_at) : s + 90 * 60e3;
      from = Math.min(from, s);
      to = Math.max(to, Math.max(e, s + 30 * 60e3));
    }
  }
  return { from, to };
}

export async function candidates({ pco, db, picks, position, tz }: { pco: Pco; db: ScheduleDb; picks: Spot[]; position: string; tz: string }) {
  const resolved = await resolve(db, picks, position);
  const plans = resolved.map((r) => r.plan);
  const span = window(plans);
  const days = [...new Set(plans.map((p) => localDay(p.sort_date, tz)))].sort();
  const pickedPlans = new Set(plans.map((p) => p.id));

  // Everyone on the team(s), and who Planning Center says can fill this position (with their preference).
  const teamIds = [...new Set(resolved.map((r) => r.team.id))];
  const people = new Map<string, any>();
  const add = (id: string) => {
    if (!people.has(id)) people.set(id, { person_id: id, name: null, photo: null, lanyard: null, positions: new Set<string>(), audioOnly: false, qualified: false, preference: null, blockouts: [], schedules: [], unchecked: false });
    return people.get(id);
  };
  for (const m of await db.members(teamIds)) {
    const x = add(m.person_id);
    for (const p of m.positions || []) if (!hiddenPosition(p)) x.positions.add(p);
    x.audioOnly = (m.positions || []).length > 0 && (m.positions || []).every((p) => hiddenPosition(p)) && !x.positions.size;
  }
  const seenPos = new Set<string>();
  for (const r of resolved) {
    const k = `${r.team.service_type_id}/${r.pos.id}`;
    if (seenPos.has(k)) continue;
    seenPos.add(k);
    try {
      const a = await pco.all(`/services/v2/service_types/${r.team.service_type_id}/team_positions/${r.pos.id}/person_team_position_assignments?per_page=100&include=person`);
      const named = new Map(a.included.filter((i) => i.type === 'Person').map((i) => [String(i.id), i]));
      for (const row of a.data) {
        const pid = relId(row, 'person');
        if (!pid) continue;
        const x = add(String(pid));
        x.qualified = true;
        x.positions.add(r.pos.name);
        x.preference = row.attributes?.schedule_preference || x.preference;
        const who = named.get(String(pid));
        if (who && !x.name) { x.name = who.attributes?.full_name || who.attributes?.name || null; x.photo = who.attributes?.photo_thumbnail_url || null; }
      }
    } catch (e) {
      if (!(e instanceof PcoError && (e.status === 403 || e.status === 404))) throw e;
    }
  }
  for (const v of await db.volunteers([...people.keys()])) {
    const x = people.get(v.pco_person_id);
    if (!x) continue;
    x.name = v.name || x.name;
    x.photo = x.photo || v.photo;
    x.lanyard = v.lanyard;
  }

  // Someone who only runs audio isn't a choice here (unless Planning Center says they can do this position).
  for (const [id, x] of people) if (x.audioOnly && !x.qualified) people.delete(id);

  // What Planning Center knows about each of them that day.
  const after = addDays(days[0], -1);
  const before = addDays(days[days.length - 1], 2);
  await pool([...people.values()], 6, async (x) => {
    // If Planning Center won't say, the app says it couldn't check rather than showing them as free.
    const none = () => { x.unchecked = true; return { data: [] as any[], included: [] as any[] }; };
    const [blocks, sched] = await Promise.all([
      pco.all(`/services/v2/people/${x.person_id}/blockout_dates?filter=after,before&after=${after}&before=${before}&per_page=50`, 2).catch(none),
      pco.all(`/services/v2/people/${x.person_id}/schedules?filter=after,before,with_declined&after=${after}&before=${before}&per_page=50`, 2).catch(none),
    ]);
    for (const b of blocks.data) {
      const a = b.attributes || {};
      const s = Date.parse(a.starts_at_utc || a.starts_at);
      const e = Date.parse(a.ends_at_utc || a.ends_at);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      const sameDay = days.some((d) => localDay(new Date(s).toISOString(), tz) <= d && localDay(new Date(e).toISOString(), tz) >= d);
      if (!sameDay) continue;
      x.blockouts.push({ starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString(), reason: a.reason || null, blocks: s < span.to && e > span.from });
    }
    for (const sc of sched.data) {
      const a = sc.attributes || {};
      if (!a.sort_date || !days.includes(localDay(a.sort_date, tz))) continue;
      const planId = relId(sc, 'plan');
      x.schedules.push({
        plan_id: planId, plan_person_id: relId(sc, 'plan_person'), service: a.service_type_name || null, team: a.team_name || null,
        position: a.team_position_name || null, status: String(a.status || 'U').slice(0, 1).toUpperCase(), decline_reason: a.decline_reason || null,
        sort_date: a.sort_date, this_spot: !!planId && pickedPlans.has(String(planId)),
      });
    }
  });

  const list = [...people.values()]
    .filter((x) => x.name)
    .map(({ audioOnly, ...x }) => ({ ...x, positions: [...x.positions].sort() }))
    .sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.name.localeCompare(b.name));
  return { position: resolved[0].pos.name, days, people: list };
}

export async function schedule({ pco, db, picks, position, person_id, by, stamp }:
  { pco: Pco; db: ScheduleDb; picks: Spot[]; position: string; person_id: string; by: string | null; stamp: string }) {
  if (!ID.test(String(person_id))) throw new Refused('Pick someone to schedule.');
  const resolved = await resolve(db, picks, position);
  const shown = new Set(await db.shownTeamIds());
  const done: { plan_id: string; plan_person_id: string; name: string | null }[] = [];
  let failure: Error | null = null;
  for (const { plan, team, pos } of resolved) {
    try {
      const doc = await pco.send('POST', `/services/v2/service_types/${plan.service_type_id}/plans/${plan.id}/team_members`, {
        data: {
          type: 'PlanPerson',
          attributes: { status: 'U', team_position_name: pos.name, prepare_notification: true },
          relationships: { person: { data: { type: 'Person', id: String(person_id) } }, team: { data: { type: 'Team', id: team.id } } },
        },
      });
      const made = doc?.data;
      done.push({ plan_id: plan.id, plan_person_id: String(made?.id ?? ''), name: made?.attributes?.name ?? null });
      await db.log({ by, action: 'schedule', plan_id: plan.id, plan_person_id: made?.id ? String(made.id) : null, person_id: String(person_id), person_name: made?.attributes?.name ?? null, team_id: team.id, position: pos.name });
    } catch (e) {
      failure = e as Error;
      break;
    }
  }
  // Show the change right away instead of waiting for the next sync.
  for (const { plan } of resolved.filter((r) => done.some((d) => d.plan_id === r.plan.id))) {
    try { await refreshRoster({ pco, db, plan, shownTeams: shown, stamp }); } catch { /* the sync catches up */ }
  }
  if (done.length) await db.pulse(stamp);
  if (failure) {
    const msg = failure instanceof PcoError && failure.status === 403
      ? 'The Planning Center account that made the token can’t schedule this team.'
      : failure.message;
    throw new Refused(done.length ? `Scheduled for ${done.length} of ${resolved.length} services, then: ${msg}` : msg);
  }
  return { scheduled: done };
}

export async function unschedule({ pco, db, plan_person_id, by, stamp }:
  { pco: Pco; db: ScheduleDb; plan_person_id: string; by: string | null; stamp: string }) {
  if (!ID.test(String(plan_person_id))) throw new Refused('Who should come off?');
  const row = await db.planPerson(String(plan_person_id));
  if (!row) throw new Refused('They’re not on that service anymore.');
  const [plan] = await db.plans([row.plan_id]);
  if (!plan) throw new Refused('That service isn’t in the app.');
  const path = `/services/v2/service_types/${plan.service_type_id}/plans/${plan.id}/team_members/${row.id}`;
  // Only before the invite goes out: once it has, they should hear it from a person in Planning Center.
  const live = await pco.get(path);
  if (live.data?.attributes?.notification_sent_at) {
    throw new Refused('Their invite already went out. Take them off in Planning Center so they’re told.');
  }
  await pco.send('DELETE', path);
  await db.log({ by, action: 'remove', plan_id: plan.id, plan_person_id: row.id, person_id: row.person_id, person_name: row.name, team_id: row.team_id, position: row.position });
  try { await refreshRoster({ pco, db, plan, shownTeams: new Set(await db.shownTeamIds()), stamp }); } catch { /* the sync catches up */ }
  await db.pulse(stamp);
  return { removed: row.id };
}
