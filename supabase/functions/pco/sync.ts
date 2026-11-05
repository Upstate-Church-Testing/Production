// Copies what the app shows out of Planning Center: service types (and the
// folders they sit in), their teams, upcoming plans, and who's on the shown
// teams. Who can see what is decided in the database, not here.

import { PcoError, relId, relIds, type Pco } from './pco.ts';

// Teams whose rosters show unless an admin says otherwise.
export const PRODUCTION_TEAM =
  /broadcast|\bfoh\b|front of house|production|\btech\b|technical|audio|sound|video|lighting|\blights?\b|media|camera|stream|graphics|propresenter|\ba\/?v\b/i;
// Campus folders look like "09 UC Simpsonville" or "10 UG Union".
const CAMPUS_FOLDER = /^\s*\d+\s+U[A-Z]\b/i;
// Services in a campus folder that aren't the weekly ones.
const SPECIAL = /christmas|easter|event|retreat|camp|archive|vbs|conference|getting to know/i;
// Positions left out everywhere: the app is for FOH (CG, lighting) and broadcast, not audio.
// "Audio" is left out; "CG / Lighting" or "Audio / CG" stay. A service an admin marks
// show_audio (the student midweeks) keeps its audio op: see audioTeams below.
export const hiddenPosition = (name: string | null | undefined) =>
  !!name && String(name).split(/[\/&,+]/).every((part) => /^\s*(audio|sound)\b/i.test(part));

/** Scheduled, but the invite email hasn't been sent yet (Planning Center's ✉️ "prepared" state). */
export const invitePending = (a: any) => !!a && !a.notification_sent_at && (a.prepare_notification === true || !!a.notification_prepared_at);

const DAY = 864e5;
const HOUR = 36e5;

export type Db = {
  campuses(): Promise<{ id: string; short_name: string; code: string | null }[]>;
  serviceTypes(): Promise<{ id: string; name?: string; access: string; access_set: boolean; campus_id: string | null; campus_set: boolean; teams_synced_at: string | null; synced_at?: string | null; show_audio?: boolean }[]>;
  teams(): Promise<{ id: string; service_type_id: string; service_type_ids?: string[]; name: string; shown: boolean; positions?: { id: string; name: string }[] }[]>;
  plans(): Promise<{ id: string; service_type_id: string; sort_date?: string | null; synced_at: string | null; needed: any; pco_updated_at?: string | null }[]>;
  saveServiceTypes(rows: any[]): Promise<void>;
  removeServiceTypesExcept(ids: string[]): Promise<void>;
  saveTeams(rows: any[]): Promise<void>;
  removeTeamsExcept(typeIds: string[], keepIds: string[]): Promise<void>;
  removePlansForTypes(typeIds: string[]): Promise<void>;
  savePlans(rows: any[]): Promise<void>;
  /** Removes a service's plans dated from..before (yyyy-mm-dd) that aren't in keepIds. */
  removePlansExcept(typeId: string, keepIds: string[], from: string, before: string): Promise<void>;
  savePeople(planId: string, rows: any[]): Promise<void>;
  saveItems(planId: string, rows: any[]): Promise<void>;
  updatePlan(id: string, patch: any): Promise<void>;
  profilesToMatch(checkedBefore: string, limit: number): Promise<{ id: string; email: string }[]>;
  teamPeopleSyncedAt(): Promise<{ id: string; people_synced_at: string | null }[]>;
  /** Replaces a team's members; true when who's on it (or what they can do) changed. */
  saveTeamPeople(teamId: string, rows: { person_id: string; positions: string[] }[], at: string): Promise<boolean>;
  saveVolunteers(rows: { pco_person_id: string; name: string; photo: string | null; last_seen_at: string }[]): Promise<void>;
  setProfileMatch(id: string, personId: string | null, at: string): Promise<void>;
  /** Tells open apps that rosters or plans changed (they reload right away). */
  pulse(at: string): Promise<void>;
};

export type SyncResult = {
  types: number; shared: number; teamsFetched: number; plans: number; rosters: number; people: number; items: number;
  matched: number; skipped: string[]; partial: boolean; peopleNote: string | null; requests: number; teamPeople: number;
  changed: number; pastWaiting: number;
};

const key = (s: string) => s.trim().toLowerCase();
const text = (v: unknown) => (v == null ? '' : String(v)).trim();
const bySequence = (a: any, b: any) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9) || a.name.localeCompare(b.name);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/** Shown teams on services that keep their audio op (pco_service_types.show_audio). */
export function audioTeams(teams: { id: string; service_type_id: string; service_type_ids?: string[] | null; shown: boolean }[], audioTypes: Set<string>) {
  return new Set(teams.filter((t) => t.shown && (t.service_type_ids?.length ? t.service_type_ids : [t.service_type_id]).some((id) => audioTypes.has(String(id)))).map((t) => t.id));
}

/** A plan's people (shown teams, no audio unless the team keeps it) and open spots, as stored. */
export function rosterRows(members: any[], needed: any[], planId: string, shownTeams: Set<string>, stamp: string, keepAudio: Set<string> = new Set()) {
  const allowed = (teamId: string | null, position: string | null) => !!teamId && shownTeams.has(teamId) && (!hiddenPosition(position) || keepAudio.has(teamId));
  const people = members
    .map((pp) => ({
      id: String(pp.id), plan_id: planId, team_id: relId(pp, 'team'), person_id: relId(pp, 'person'),
      name: text(pp.attributes?.name), position: text(pp.attributes?.team_position_name) || null,
      status: text(pp.attributes?.status).slice(0, 1).toUpperCase() || null,
      photo: pp.attributes?.photo_thumbnail || null, synced_at: stamp,
      invite_pending: invitePending(pp.attributes),
    }))
    .filter((p) => allowed(p.team_id, p.position));
  const open = needed
    .map((n) => ({ team_id: relId(n, 'team'), position: text(n.attributes?.team_position_name) || null, quantity: Number(n.attributes?.quantity) || 1 }))
    .filter((n) => allowed(n.team_id, n.position));
  return { people, open };
}

/** Reads one plan's roster again right away (after someone is scheduled or removed from the app). */
export async function refreshRoster({ pco, db, plan, shownTeams, keepAudio, stamp }:
  { pco: Pco; db: Pick<Db, 'savePeople' | 'updatePlan'>; plan: { id: string; service_type_id: string }; shownTeams: Set<string>; keepAudio?: Set<string>; stamp: string }) {
  const base = `/services/v2/service_types/${plan.service_type_id}/plans/${plan.id}`;
  const [members, needed, doc] = await Promise.all([
    pco.all(`${base}/team_members?per_page=100`),
    pco.all(`${base}/needed_positions?per_page=100`),
    pco.get(base),
  ]);
  const { people, open } = rosterRows(members.data, needed.data, plan.id, shownTeams, stamp, keepAudio);
  await db.savePeople(plan.id, people);
  await db.updatePlan(plan.id, { needed: open, synced_at: stamp, pco_updated_at: doc.data?.attributes?.updated_at ?? null });
  return { people, open };
}

/** Which of our locations a Planning Center service belongs to, from its folders and name. */
export function autoCampus(path: string[], name: string, campuses: { id: string; short_name: string; code: string | null }[]) {
  for (const t of [...path, name]) {
    const low = t.toLowerCase();
    let hits = campuses.filter((c) => c.short_name && low.includes(c.short_name.toLowerCase()));
    if (!hits.length) {
      hits = campuses.filter((c) => c.code && c.code.length >= 2 && new RegExp(`(^|[^A-Za-z])${escapeRe(c.code)}([^A-Za-z]|$)`).test(t));
    }
    if (hits.length) return hits.sort((a, b) => b.short_name.length - a.short_name.length)[0].id;
  }
  return null;
}

/** A campus's regular weekly service: shared with everyone until an admin decides otherwise. */
export const isWeekly = (path: string[], name: string) => path.length === 1 && CAMPUS_FOLDER.test(path[0]) && !SPECIAL.test(name);

// Past services' rosters read again per scheduled run (they rarely change; this keeps
// the daily re-read from crowding out upcoming services and webhooks).
const PAST_PER_RUN = 3;
// How often a scheduled run re-reads services, folders, and shared services' teams, positions and
// members (the rest only look for changed plans). Planning Center has no cheap way to tell that a
// team changed: no webhook, and a team's updated_at doesn't move when its positions do.
const TYPES_EVERY = 3 * 60_000;
const TEAMS_FRESH = TYPES_EVERY - 20_000; // a bit under, so each full pass re-reads them

// range: the days copied, yyyy-mm-dd in the church's time zone (from pco_range in the
//        database: some weeks back through the end of a month some months out).
// fullTeams: re-read every service's teams (daily, and when first connected).
// allRosters: re-read every roster now, not just the ones due (when someone asks).
export async function runSync({ pco, db, range, weeksAhead = 6, fullTeams = false, allRosters = false, now = new Date(), deadline = Infinity }:
  { pco: Pco; db: Db; range?: { start: string; end: string } | null; weeksAhead?: number; fullTeams?: boolean; allRosters?: boolean; now?: Date; deadline?: number }): Promise<SyncResult> {
  const out: SyncResult = { types: 0, shared: 0, teamsFetched: 0, plans: 0, rosters: 0, people: 0, items: 0, matched: 0, skipped: [], partial: false, peopleNote: null, requests: 0, teamPeople: 0, changed: 0, pastWaiting: 0 };
  const stamp = now.toISOString();
  const nowMs = now.getTime();
  const late = () => Date.now() > deadline;
  // A service the token can't see shouldn't stop the rest.
  const skippable = (e: unknown) => e instanceof PcoError && (e.status === 403 || e.status === 404);

  // Most scheduled runs (every 10 seconds) only look for changed plans, using the services and
  // teams copied in the last few minutes as they are. Every TYPES_EVERY, or when asked, it's a full pass.
  const knownTypeRows = await db.serviceTypes();
  // Services whose teams gained, lost or renamed a position (or a shown team): their upcoming
  // rosters are read again, since plans keep showing the old position name until then.
  const reshaped = new Set<string>();
  const light = !fullTeams && !allRosters && knownTypeRows.length > 0
    && knownTypeRows.every((r) => r.synced_at && nowMs - Date.parse(r.synced_at) < TYPES_EVERY);
  const { types, teams } = light
    ? { types: knownTypeRows.map((r) => ({ id: r.id, name: r.name || 'Service', access: r.access })), teams: await db.teams() }
    : await readTypesAndTeams();
  out.types = types.length;

  async function readTypesAndTeams() {
  const campuses = await db.campuses();

  // 1. Service types, and the folders they're filed in.
  const [folderList, typeList] = await Promise.all([
    pco.all('/services/v2/folders?per_page=100'),
    pco.all('/services/v2/service_types?per_page=100'),
  ]);
  const folders = new Map(folderList.data.map((f) => [f.id, f]));
  const parentOf = new Map<string, string | null>();
  if (typeList.data.some((t) => t.relationships && 'parent' in t.relationships)) {
    for (const t of typeList.data) parentOf.set(t.id, relId(t, 'parent'));
  } else {
    // Older responses leave out the folder link; ask each folder what's in it.
    for (const f of folderList.data) {
      const inside = await pco.all(`/services/v2/folders/${f.id}/service_types?per_page=100`);
      for (const t of inside.data) parentOf.set(t.id, f.id);
    }
  }
  const folderPath = (id: string | null | undefined) => {
    const names: string[] = [];
    const seen = new Set<string>();
    let f = id ? folders.get(id) : null;
    while (f && !seen.has(f.id) && names.length < 8) {
      seen.add(f.id);
      names.unshift(text(f.attributes?.name));
      const up = relId(f, 'parent');
      f = up ? folders.get(up) : null;
    }
    return names.filter(Boolean);
  };

  const live = typeList.data.filter((t) => !t.attributes?.archived_at && !t.attributes?.deleted_at);
  let paths = live.map((t) => folderPath(parentOf.get(t.id)));
  // Some accounts file everything under one top folder; it says nothing, so drop it.
  const firsts = new Set(paths.map((p) => p[0]));
  if (live.length > 4 && firsts.size === 1 && paths.every((p) => p.length > 1)) paths = paths.map((p) => p.slice(1));

  const knownTypes = new Map(knownTypeRows.map((r) => [r.id, r]));
  const types = live.map((t, i) => {
    const name = text(t.attributes?.name) || 'Untitled service';
    const path = paths[i];
    const prev = knownTypes.get(t.id);
    return {
      id: String(t.id), name, path,
      sequence: Number.isFinite(t.attributes?.sequence) ? t.attributes.sequence : null,
      campus_id: prev?.campus_set ? prev.campus_id : autoCampus(path, name, campuses),
      campus_set: prev?.campus_set ?? false,
      access: prev?.access ?? 'hidden',
      access_set: prev?.access_set ?? false,
      teams_synced_at: prev?.teams_synced_at ?? null,
      synced_at: stamp,
      weekly: isWeekly(path, name),
    };
  });
  out.types = types.length;

  // 2. Teams, for services that are shared (or might be) and haven't been checked lately.
  const knownTeams = await db.teams();
  const knownTeamById = new Map(knownTeams.map((t) => [t.id, t]));
  const shownByName = new Map<string, boolean>();
  for (const t of knownTeams) shownByName.set(key(t.name), (shownByName.get(key(t.name)) ?? false) || t.shown);
  // Shared services' teams: every full pass. Others (only read to decide sharing): every six hours.
  const teamsStale = (r: typeof types[number]) => fullTeams || allRosters || !r.teams_synced_at
    || nowMs - Date.parse(r.teams_synced_at) > (r.access !== 'hidden' ? TEAMS_FRESH : 6 * HOUR);
  const shape = (list: any[] | undefined) => (list || []).map((p) => `${p.id}:${p.name}`).sort().join('|');
  const wantTeams = types.filter((r) => (fullTeams || r.access !== 'hidden' || (!r.access_set && r.weekly)) && teamsStale(r));

  const fetchedTeams: any[] = [];
  const fetchedById = new Map<string, any>(); // a team can sit in more than one service
  const teamTypes: string[] = [];
  await pool(wantTeams, 4, async (r) => {
    if (late()) { out.partial = true; return; }
    let doc;
    try {
      doc = await pco.all(`/services/v2/service_types/${r.id}/teams?per_page=100&include=team_positions`);
    } catch (e) {
      if (skippable(e)) { out.skipped.push(r.name); return; }
      throw e;
    }
    const positions = new Map(doc.included.filter((x) => x.type === 'TeamPosition').map((p) => [p.id, p]));
    for (const t of doc.data) {
      if (t.attributes?.archived_at || t.attributes?.deleted_at) continue;
      const also = fetchedById.get(String(t.id));
      if (also) {
        if (!also.service_type_ids.includes(r.id)) also.service_type_ids.push(r.id);
        continue;
      }
      const name = text(t.attributes?.name) || 'Team';
      const prev = knownTeamById.get(t.id);
      const row = {
        id: String(t.id), service_type_id: r.id, name,
        service_type_ids: [...new Set([r.id, ...relIds(t, 'service_types').map(String)])],
        sequence: Number.isFinite(t.attributes?.sequence) ? t.attributes.sequence : null,
        positions: relIds(t, 'team_positions').map((id) => positions.get(id)).filter(Boolean)
          .map((p: any) => ({ id: String(p.id), name: text(p.attributes?.name), sequence: p.attributes?.sequence ?? null }))
          .sort(bySequence),
        shown: prev ? prev.shown : shownByName.has(key(name)) ? shownByName.get(key(name))! : PRODUCTION_TEAM.test(name),
        synced_at: stamp,
      };
      if (row.shown && (!prev || shape(prev.positions) !== shape(row.positions))) for (const id of row.service_type_ids) reshaped.add(id);
      fetchedById.set(row.id, row);
      fetchedTeams.push(row);
    }
    r.teams_synced_at = stamp;
    teamTypes.push(r.id);
    out.teamsFetched++;
  });

  // Every team we know of after this pass.
  const refetched = new Set(teamTypes);
  for (const t of knownTeams) if (t.shown && refetched.has(t.service_type_id) && !fetchedById.has(t.id)) reshaped.add(t.service_type_id); // a shown team is gone
  const teams = [...knownTeams.filter((t) => !refetched.has(t.service_type_id) && !fetchedById.has(t.id)), ...fetchedTeams];
  const teamsOf = new Map<string, typeof teams>();
  for (const t of teams) {
    for (const id of t.service_type_ids?.length ? t.service_type_ids : [t.service_type_id]) teamsOf.set(id, [...(teamsOf.get(id) || []), t]);
  }

  // Until an admin picks, a campus's weekly service is shared when it has a production team.
  for (const r of types) {
    if (r.access_set) continue;
    if (!r.teams_synced_at) continue; // haven't seen its teams yet
    r.access = r.weekly && (teamsOf.get(r.id) || []).some((t) => t.shown) ? 'everyone' : 'hidden';
  }

  await db.saveServiceTypes(types.map(({ weekly, ...row }) => row));
  if (types.length) await db.removeServiceTypesExcept(types.map((r) => r.id));
  if (fetchedTeams.length) await db.saveTeams(fetchedTeams);
  if (teamTypes.length) await db.removeTeamsExcept(teamTypes, fetchedTeams.map((t) => t.id));
  return { types, teams };
  }

  // 3. Plans in the range for shared services.
  if (reshaped.size) out.changed++; // positions changed: open apps redraw
  const shared = types.filter((r) => r.access !== 'hidden');
  out.shared = shared.length;
  const hidden = types.filter((r) => r.access === 'hidden').map((r) => r.id);
  const knownPlans = new Map((await db.plans()).map((p) => [p.id, p]));
  if (hidden.length) {
    const hiddenSet = new Set(hidden);
    if ([...knownPlans.values()].some((k) => hiddenSet.has(k.service_type_id))) out.changed++;
    await db.removePlansForTypes(hidden);
  }

  const shownTeams = new Set(teams.filter((t) => t.shown).map((t) => t.id));
  const keepAudio = audioTeams(teams as any[], new Set(knownTypeRows.filter((r) => r.show_audio).map((r) => String(r.id))));
  // Without a range from the database, fall back to what it used to be: today through weeksAhead.
  const today = stamp.slice(0, 10);
  const from = range?.start || today;
  const to = range?.end || new Date(nowMs + weeksAhead * 7 * DAY).toISOString().slice(0, 10);
  const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
  const horizon = Date.parse(`${nextDay(to)}T12:00:00Z`); // generous by half a day either way; the filter does the real work
  const rosterJobs: { plan: any; typeId: string; when: number; remote: string | null; changed: boolean; past: boolean }[] = [];
  const sameTime = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && Date.parse(a) === Date.parse(b);

  await pool(shared, 8, async (r) => {
    if (late()) { out.partial = true; return; }
    let doc;
    try {
      doc = await pco.all(`/services/v2/service_types/${r.id}/plans?filter=after,before&after=${from}&before=${nextDay(to)}&order=sort_date&per_page=100&include=plan_times`, 5);
    } catch (e) {
      if (skippable(e)) { out.skipped.push(r.name); return; }
      throw e;
    }
    const timesById = new Map(doc.included.filter((x) => x.type === 'PlanTime').map((x) => [x.id, x]));
    const rows: any[] = [];
    const changedRows: any[] = [];
    let outside = 0; // plans from well before the range mean the date filter wasn't applied
    for (const p of doc.data) {
      const when = Date.parse(p.attributes?.sort_date);
      if (Number.isFinite(when) && when < Date.parse(`${from}T12:00:00Z`) - 2 * DAY) { outside++; continue; }
      if (!Number.isFinite(when) || when > horizon) continue;
      const prev = knownPlans.get(String(p.id));
      const times = relIds(p, 'plan_times').map((id) => timesById.get(id)).filter(Boolean)
        .map((x: any) => ({ name: text(x.attributes?.name) || null, kind: x.attributes?.time_type || 'other', starts_at: x.attributes?.starts_at || null, ends_at: x.attributes?.ends_at || null }))
        .sort((a: any, b: any) => String(a.starts_at).localeCompare(String(b.starts_at)));
      const row = {
        id: String(p.id), service_type_id: r.id,
        title: text(p.attributes?.title) || null, series_title: text(p.attributes?.series_title) || null,
        dates: text(p.attributes?.dates) || null, sort_date: p.attributes.sort_date, times,
        url: p.attributes?.planning_center_url || p.links?.html || `https://services.planningcenteronline.com/plans/${p.id}`,
        needed: prev?.needed ?? [], synced_at: prev?.synced_at ?? stamp,
        pco_updated_at: prev?.pco_updated_at ?? null, // moves forward once its roster is read
      };
      rows.push(row);
      // Planning Center bumps a plan's updated_at whenever anyone on it is scheduled,
      // removed, accepts or declines, so only changed plans are read again. Now and then
      // every plan is read anyway, in case a change slipped by.
      const remote: string | null = p.attributes?.updated_at || null;
      const moved = !prev || prev.service_type_id !== r.id;
      const changed = moved || !remote || !sameTime(prev?.pco_updated_at, remote);
      const age = prev?.synced_at ? nowMs - Date.parse(prev.synced_at) : Infinity;
      // Over (a service from yesterday or before): once a day. Coming up: hourly for the next two weeks, else every six hours.
      const past = when < nowMs - 12 * HOUR;
      const stale = age > (past ? DAY : when - nowMs < 14 * DAY ? HOUR : 6 * HOUR) || (!past && reshaped.has(r.id));
      if (changed) changedRows.push(row);
      if (allRosters || changed || stale) rosterJobs.push({ plan: row, typeId: r.id, when, remote, changed, past });
    }
    if (changedRows.length) { await db.savePlans(changedRows); out.changed += changedRows.length; }
    if (outside) { out.skipped.push(`${r.name} (dates not filtered; nothing removed)`); out.plans += rows.length; return; }
    // Only services well inside the range that Planning Center no longer has are removed (a day's
    // margin at each end for time zones); older ones stay, for looking back at who served when.
    const keep = new Set(rows.map((x) => x.id));
    const inside = (d: string | null | undefined) => !!d && d.slice(0, 10) >= nextDay(from) && d.slice(0, 10) < to;
    if ([...knownPlans.values()].some((k) => k.service_type_id === r.id && !keep.has(k.id) && inside(k.sort_date))) out.changed++;
    await db.removePlansExcept(r.id, rows.map((x) => x.id), nextDay(from), to);
    out.plans += rows.length;
  });

  // 4. Everyone on the shown teams of shared services, for the People list
  //    (volunteers who aren't on a roster right now too), and which positions each can fill.
  //    Every full pass (about every three minutes); two requests a team. Before the rosters,
  //    so a Refresh that runs out of time on rosters still brings the teams up to date.
  if (!light && !late()) {
    const sharedIds = new Set(shared.map((r) => r.id));
    const lastPeople = new Map((await db.teamPeopleSyncedAt()).map((t) => [t.id, t.people_synced_at]));
    const due = teams.filter((t) => t.shown
      && (t.service_type_ids?.length ? t.service_type_ids : [t.service_type_id]).some((id) => sharedIds.has(id))
      && (fullTeams || allRosters || !lastPeople.get(t.id) || nowMs - Date.parse(lastPeople.get(t.id)!) > TEAMS_FRESH));
    await pool(due, 4, async (t) => {
      if (late()) { out.partial = true; return; }
      let doc, assigned;
      try {
        [doc, assigned] = await Promise.all([
          pco.all(`/services/v2/teams/${t.id}/people?per_page=100`),
          pco.all(`/services/v2/teams/${t.id}/person_team_position_assignments?per_page=100&include=team_position`),
        ]);
      } catch (e) {
        if (skippable(e)) return;
        throw e;
      }
      const people = doc.data
        .filter((p) => !p.attributes?.status || p.attributes.status === 'active')
        .map((p) => ({
          pco_person_id: String(p.id),
          name: text(p.attributes?.full_name) || [text(p.attributes?.first_name), text(p.attributes?.last_name)].filter(Boolean).join(' '),
          photo: p.attributes?.photo_thumbnail_url || null,
          last_seen_at: stamp,
        }))
        .filter((p) => p.name);
      // Which positions each of them can fill (so audio-only people can be left out of the app).
      const posName = new Map<string, string>((t.positions || []).map((p: any) => [String(p.id), p.name]));
      for (const x of assigned.included) if (x.type === 'TeamPosition') posName.set(String(x.id), text(x.attributes?.name));
      const positionsOf = new Map<string, Set<string>>();
      for (const x of assigned.data) {
        const pid = relId(x, 'person');
        const pos = posName.get(String(relId(x, 'team_position')));
        if (!pid || !pos) continue;
        if (!positionsOf.has(pid)) positionsOf.set(pid, new Set());
        positionsOf.get(pid)!.add(pos);
      }
      await db.saveVolunteers(people);
      if (await db.saveTeamPeople(t.id, people.map((p) => ({ person_id: p.pco_person_id, positions: [...(positionsOf.get(p.pco_person_id) || [])].sort() })), stamp)) out.changed++;
      out.teamPeople += people.length;
    });
  }

  // 5. Who's on the shown teams, and the flow of the service: upcoming services first, soonest
  //    first; then past ones, latest first, a few per scheduled run.
  // (The rest wait for later runs; that isn't "partial", which would hold up the daily team read.)
  const upcoming = rosterJobs.filter((j) => !j.past).sort((a, b) => a.when - b.when);
  const behind = rosterJobs.filter((j) => j.past).sort((a, b) => b.when - a.when);
  if (!allRosters && behind.length > PAST_PER_RUN) { out.pastWaiting = behind.length - PAST_PER_RUN; behind.length = PAST_PER_RUN; }
  await pool([...upcoming, ...behind], 4, async ({ plan, typeId, remote, changed }) => {
    if (late()) { out.partial = true; return; }
    const base = `/services/v2/service_types/${typeId}/plans/${plan.id}`;
    let members, needed, items;
    try {
      [members, needed, items] = await Promise.all([
        pco.all(`${base}/team_members?per_page=100`),
        pco.all(`${base}/needed_positions?per_page=100`),
        pco.all(`${base}/items?per_page=100&include=item_notes`),
      ]);
    } catch (e) {
      if (skippable(e)) return;
      throw e;
    }
    const { people, open } = rosterRows(members.data, needed.data, plan.id, shownTeams, stamp, keepAudio);
    const notesById = new Map(items.included.filter((x) => x.type === 'ItemNote').map((x) => [x.id, x]));
    const flow = items.data.map((it) => ({
      id: String(it.id), plan_id: plan.id,
      sequence: Number.isFinite(it.attributes?.sequence) ? it.attributes.sequence : null,
      title: text(it.attributes?.title),
      kind: text(it.attributes?.item_type) || 'item',
      position: text(it.attributes?.service_position) || 'during',
      length: Number.isFinite(it.attributes?.length) ? it.attributes.length : null,
      description: text(it.attributes?.description) || null,
      key_name: text(it.attributes?.key_name) || null,
      arrangement: text(it.attributes?.custom_arrangement_sequence_short) || null,
      notes: relIds(it, 'item_notes').map((id) => notesById.get(id)).filter(Boolean)
        .map((n: any) => ({ category: text(n.attributes?.category_name) || 'Note', content: text(n.attributes?.content) }))
        .filter((n: any) => n.content),
      synced_at: stamp,
    }));
    await db.savePeople(plan.id, people);
    await db.saveItems(plan.id, flow);
    await db.updatePlan(plan.id, { needed: open, synced_at: stamp, pco_updated_at: remote });
    const spots = (list: any[]) => list.map((n) => `${n.team_id}|${n.position}|${n.quantity}`).sort().join();
    if (changed || spots(open) !== spots(plan.needed || [])) out.changed++;
    out.rosters++;
    out.people += people.length;
    out.items += flow.length;
  });

  // 6. Match app accounts to Planning Center people by email, a few at a time; full passes only.
  if (!light && !late()) {
    const todo = await db.profilesToMatch(new Date(nowMs - DAY).toISOString(), 25);
    for (const p of todo) {
      if (late()) { out.partial = true; break; }
      try {
        const email = p.email.trim().toLowerCase();
        const doc = await pco.all(`/people/v2/people?where[search_name_or_email]=${encodeURIComponent(email)}&include=emails&per_page=10`, 1);
        const addr = new Map(doc.included.filter((x) => x.type === 'Email').map((x) => [x.id, text(x.attributes?.address).toLowerCase()]));
        const hits = doc.data.filter((person) => relIds(person, 'emails').some((id) => addr.get(id) === email));
        await db.setProfileMatch(p.id, hits.length === 1 ? String(hits[0].id) : null, stamp);
        if (hits.length === 1) out.matched++;
      } catch (e) {
        if (e instanceof PcoError && [400, 401, 403, 404].includes(e.status)) {
          out.peopleNote = 'The account that made the token can’t search People, so app accounts aren’t matched to Planning Center people.';
          break;
        }
        throw e;
      }
    }
  }

  if (out.changed) await db.pulse(stamp);
  out.requests = pco.requests;
  return out;
}
