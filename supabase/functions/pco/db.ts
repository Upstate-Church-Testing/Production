// The sync's reads and writes, done with the service role (it can see and
// write the Planning Center tables; the app can only read what RLS allows).

import type { Db } from './sync.ts';

const CHUNK = 500;
const list = (ids: string[]) => `(${ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',')})`;

export function dbAdapter(sb: any): Db {
  const ok = ({ data, error }: { data: any; error: any }) => {
    if (error) throw new Error(`Database: ${error.message}`);
    return data;
  };
  async function upsert(table: string, rows: any[]) {
    // One row per id: Postgres won't update the same row twice in one statement.
    const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
    for (let i = 0; i < unique.length; i += CHUNK) ok(await sb.from(table).upsert(unique.slice(i, i + CHUNK), { onConflict: 'id' }));
  }
  async function selectAll(table: string, cols: string) {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const page = ok(await sb.from(table).select(cols).range(from, from + 999));
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  return {
    campuses: () => selectAll('campuses', 'id, short_name, code'),
    serviceTypes: () => selectAll('pco_service_types', 'id, access, access_set, campus_id, campus_set, teams_synced_at'),
    teams: () => selectAll('pco_teams', 'id, service_type_id, service_type_ids, name, shown, positions'),
    plans: () => selectAll('pco_plans', 'id, service_type_id, synced_at, needed, pco_updated_at'),

    saveServiceTypes: (rows) => upsert('pco_service_types', rows),
    async removeServiceTypesExcept(ids) {
      if (!ids.length) return; // never wipe everything because a list came back empty
      ok(await sb.from('pco_service_types').delete().not('id', 'in', list(ids)));
    },
    saveTeams: (rows) => upsert('pco_teams', rows),
    async removeTeamsExcept(typeIds, keepIds) {
      let q = sb.from('pco_teams').delete().in('service_type_id', typeIds);
      if (keepIds.length) q = q.not('id', 'in', list(keepIds));
      ok(await q);
    },
    async removePlansForTypes(typeIds) {
      if (typeIds.length) ok(await sb.from('pco_plans').delete().in('service_type_id', typeIds));
    },
    savePlans: (rows) => upsert('pco_plans', rows),
    async removePlansExcept(typeId, keepIds) {
      let q = sb.from('pco_plans').delete().eq('service_type_id', typeId);
      if (keepIds.length) q = q.not('id', 'in', list(keepIds));
      ok(await q);
    },
    async savePeople(planId, rows) {
      if (rows.length) await upsert('pco_plan_people', rows);
      let q = sb.from('pco_plan_people').delete().eq('plan_id', planId);
      if (rows.length) q = q.not('id', 'in', list(rows.map((r) => r.id)));
      ok(await q);
    },
    async saveItems(planId, rows) {
      if (rows.length) await upsert('pco_plan_items', rows);
      let q = sb.from('pco_plan_items').delete().eq('plan_id', planId);
      if (rows.length) q = q.not('id', 'in', list(rows.map((r) => r.id)));
      ok(await q);
    },
    async updatePlan(id, patch) {
      ok(await sb.from('pco_plans').update(patch).eq('id', id));
    },
    async profilesToMatch(checkedBefore, limit) {
      return ok(await sb.from('profiles').select('id, email')
        .is('pco_person_id', null).neq('role', 'pending')
        .or(`pco_checked_at.is.null,pco_checked_at.lt.${checkedBefore}`)
        .limit(limit));
    },
    async setProfileMatch(id, personId, at) {
      ok(await sb.from('profiles').update({ pco_person_id: personId, pco_checked_at: at }).eq('id', id));
    },
    teamPeopleSyncedAt: () => selectAll('pco_teams', 'id, people_synced_at'),
    async saveTeamPeople(teamId, rows, at) {
      const unique = [...new Map(rows.map((r) => [r.person_id, r])).values()];
      const ids = unique.map((r) => r.person_id);
      for (let i = 0; i < unique.length; i += CHUNK) {
        ok(await sb.from('pco_team_people').upsert(unique.slice(i, i + CHUNK).map((r) => ({ team_id: teamId, person_id: r.person_id, positions: r.positions, synced_at: at })), { onConflict: 'team_id,person_id' }));
      }
      let q = sb.from('pco_team_people').delete().eq('team_id', teamId);
      if (ids.length) q = q.not('person_id', 'in', list(ids));
      ok(await q);
      ok(await sb.from('pco_teams').update({ people_synced_at: at }).eq('id', teamId));
    },
    async pulse(at) {
      ok(await sb.from('pco_live').upsert({ id: true, changed_at: at }, { onConflict: 'id' }));
    },
    async saveVolunteers(rows) {
      // Only the name, photo and when they were last seen: lanyards, tags and notes are the staff's.
      const unique = [...new Map(rows.map((r) => [r.pco_person_id, r])).values()];
      for (let i = 0; i < unique.length; i += CHUNK) {
        ok(await sb.from('volunteers').upsert(unique.slice(i, i + CHUNK), { onConflict: 'pco_person_id' }));
      }
    },
  };
}
