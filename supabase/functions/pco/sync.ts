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

const DAY = 864e5;
const HOUR = 36e5;

export type Db = {
  campuses(): Promise<{ id: string; short_name: string; code: string | null }[]>;
  serviceTypes(): Promise<{ id: string; access: string; access_set: boolean; campus_id: string | null; campus_set: boolean; teams_synced_at: string | null }[]>;
  teams(): Promise<{ id: string; service_type_id: string; service_type_ids?: string[]; name: string; shown: boolean }[]>;
  plans(): Promise<{ id: string; service_type_id: string; synced_at: string | null; needed: any }[]>;
  saveServiceTypes(rows: any[]): Promise<void>;
  removeServiceTypesExcept(ids: string[]): Promise<void>;
  saveTeams(rows: any[]): Promise<void>;
  removeTeamsExcept(typeIds: string[], keepIds: string[]): Promise<void>;
  removePlansForTypes(typeIds: string[]): Promise<void>;
  savePlans(rows: any[]): Promise<void>;
  removePlansExcept(typeId: string, keepIds: string[]): Promise<void>;
  savePeople(planId: string, rows: any[]): Promise<void>;
  updatePlan(id: string, patch: any): Promise<void>;
  profilesToMatch(checkedBefore: string, limit: number): Promise<{ id: string; email: string }[]>;
  setProfileMatch(id: string, personId: string | null, at: string): Promise<void>;
};

export type SyncResult = {
  types: number; shared: number; teamsFetched: number; plans: number; rosters: number; people: number;
  matched: number; skipped: string[]; partial: boolean; peopleNote: string | null; requests: number;
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

// fullTeams: re-read every service's teams (daily, and when first connected).
// allRosters: re-read every roster now, not just the next two weeks' (when someone asks).
export async function runSync({ pco, db, weeksAhead = 6, fullTeams = false, allRosters = false, now = new Date(), deadline = Infinity }:
  { pco: Pco; db: Db; weeksAhead?: number; fullTeams?: boolean; allRosters?: boolean; now?: Date; deadline?: number }): Promise<SyncResult> {
  const out: SyncResult = { types: 0, shared: 0, teamsFetched: 0, plans: 0, rosters: 0, people: 0, matched: 0, skipped: [], partial: false, peopleNote: null, requests: 0 };
  const stamp = now.toISOString();
  const nowMs = now.getTime();
  const late = () => Date.now() > deadline;
  // A service the token can't see shouldn't stop the rest.
  const skippable = (e: unknown) => e instanceof PcoError && (e.status === 403 || e.status === 404);

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

  const knownTypes = new Map((await db.serviceTypes()).map((r) => [r.id, r]));
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
  const teamsStale = (r: typeof types[number]) => fullTeams || !r.teams_synced_at || nowMs - Date.parse(r.teams_synced_at) > 6 * HOUR;
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
      fetchedById.set(row.id, row);
      fetchedTeams.push(row);
    }
    r.teams_synced_at = stamp;
    teamTypes.push(r.id);
    out.teamsFetched++;
  });

  // Every team we know of after this pass.
  const refetched = new Set(teamTypes);
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

  // 3. Upcoming plans for shared services.
  const shared = types.filter((r) => r.access !== 'hidden');
  out.shared = shared.length;
  const hidden = types.filter((r) => r.access === 'hidden').map((r) => r.id);
  if (hidden.length) await db.removePlansForTypes(hidden);

  const shownTeams = new Set(teams.filter((t) => t.shown).map((t) => t.id));
  const horizon = nowMs + weeksAhead * 7 * DAY;
  const knownPlans = new Map((await db.plans()).map((p) => [p.id, p]));
  const rosterJobs: { plan: any; typeId: string; when: number }[] = [];

  await pool(shared, 4, async (r) => {
    if (late()) { out.partial = true; return; }
    let doc;
    try {
      doc = await pco.all(`/services/v2/service_types/${r.id}/plans?filter=future&order=sort_date&per_page=${Math.min(100, weeksAhead * 4 + 4)}&include=plan_times`, 1);
    } catch (e) {
      if (skippable(e)) { out.skipped.push(r.name); return; }
      throw e;
    }
    const timesById = new Map(doc.included.filter((x) => x.type === 'PlanTime').map((x) => [x.id, x]));
    const rows: any[] = [];
    for (const p of doc.data) {
      const when = Date.parse(p.attributes?.sort_date);
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
      };
      rows.push(row);
      // Rosters inside two weeks change most; further out, every couple of hours is plenty.
      const fresh = prev?.synced_at && prev.service_type_id === r.id && nowMs - Date.parse(prev.synced_at) < 2 * HOUR;
      if (allRosters || !prev || when - nowMs < 14 * DAY || !fresh) rosterJobs.push({ plan: row, typeId: r.id, when });
    }
    if (rows.length) await db.savePlans(rows);
    await db.removePlansExcept(r.id, rows.map((x) => x.id));
    out.plans += rows.length;
  });

  // 4. Who's on the shown teams, soonest services first.
  rosterJobs.sort((a, b) => a.when - b.when);
  await pool(rosterJobs, 4, async ({ plan, typeId }) => {
    if (late()) { out.partial = true; return; }
    const base = `/services/v2/service_types/${typeId}/plans/${plan.id}`;
    let members, needed;
    try {
      [members, needed] = await Promise.all([
        pco.all(`${base}/team_members?per_page=100&include=team,person`),
        pco.all(`${base}/needed_positions?per_page=100`),
      ]);
    } catch (e) {
      if (skippable(e)) return;
      throw e;
    }
    const people = members.data
      .map((pp) => ({
        id: String(pp.id), plan_id: plan.id, team_id: relId(pp, 'team'), person_id: relId(pp, 'person'),
        name: text(pp.attributes?.name), position: text(pp.attributes?.team_position_name) || null,
        status: text(pp.attributes?.status).slice(0, 1).toUpperCase() || null,
        photo: pp.attributes?.photo_thumbnail || null, synced_at: stamp,
      }))
      .filter((p) => p.team_id && shownTeams.has(p.team_id));
    const open = needed.data
      .map((n) => ({ team_id: relId(n, 'team'), position: text(n.attributes?.team_position_name) || null, quantity: Number(n.attributes?.quantity) || 1 }))
      .filter((n) => n.team_id && shownTeams.has(n.team_id));
    await db.savePeople(plan.id, people);
    await db.updatePlan(plan.id, { needed: open, synced_at: stamp });
    out.rosters++;
    out.people += people.length;
  });

  // 5. Match app accounts to Planning Center people by email, a few at a time.
  if (!late()) {
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

  out.requests = pco.requests;
  return out;
}
