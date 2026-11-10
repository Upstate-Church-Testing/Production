// Live data: Supabase (Postgres + logins + live updates).
// Every screen talks to this through the same methods as the preview store.

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

export async function createSupabaseStore(url, key) {
  const { createClient } = await import(SUPABASE_JS);
  const sb = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });

  const ok = ({ data, error }) => {
    if (error) throw friendly(error);
    return data;
  };

  // PostgREST returns at most 1000 rows per request; page through.
  async function all(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const data = ok(await build().range(from, from + 999));
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  return {
    mode: 'live',

    async session() {
      return ok(await sb.auth.getSession()).session;
    },
    onAuth(cb) {
      const { data } = sb.auth.onAuthStateChange((event, session) => cb(event, session));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      ok(await sb.auth.signInWithPassword({ email, password }));
    },
    async signUp(full_name, email, password) {
      const data = ok(await sb.auth.signUp({
        email, password,
        options: { data: { full_name }, emailRedirectTo: location.origin + location.pathname },
      }));
      return { needsConfirm: !data.session };
    },
    async sendReset(email) {
      ok(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
    },
    async setPassword(password) {
      ok(await sb.auth.updateUser({ password }));
    },
    async signOut() {
      await sb.auth.signOut();
    },

    async me() {
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return null;
      return ok(await sb.from('profiles').select('*').eq('id', user.id).maybeSingle());
    },
    async updateMe(id, patch) {
      ok(await sb.from('profiles').update(patch).eq('id', id));
    },

    async reference() {
      const [campuses, departments] = await Promise.all([
        all(() => sb.from('campuses').select('*').eq('is_active', true).order('sort_order').order('name')),
        all(() => sb.from('departments').select('*').order('sort_order')),
      ]);
      return { campuses, departments };
    },

    async networkData() {
      const [rooms, networks, devices, ips, types, positions, software, installs] = await Promise.all([
        all(() => sb.from('rooms').select('*').order('sort_order').order('name')),
        all(() => sb.from('networks').select('*').order('sort_order').order('name')),
        all(() => sb.from('devices').select('*').order('name')),
        all(() => sb.from('device_ips').select('*').order('sort_order')),
        all(() => sb.from('device_types').select('*, ports:device_type_ports(*)').order('name')),
        // Rigging positions; an app open before they existed still loads the rest.
        all(() => sb.from('rig_positions').select('*').order('sort_order').order('name')).catch(() => []),
        // Software on each computer (Gear › Software); likewise optional.
        all(() => sb.from('software').select('*').order('name')).catch(() => []),
        all(() => sb.from('software_installs').select('*')).catch(() => []),
      ]);
      return { rooms, networks, devices, ips, types, positions, software, installs };
    },

    // ---- Software: titles (ProPresenter…) and the version on each computer.
    /** Insert or update a title ({ id?, name, maker, logo, notes }); returns its id. */
    async saveSoftware(row) {
      const { id, ...fields } = row;
      if (id) { ok(await sb.from('software').update(fields).eq('id', id)); return id; }
      return ok(await sb.from('software').insert(fields).select('id').single()).id;
    },
    /** Takes a title away, and its versions with it. */
    async deleteSoftware(id) {
      ok(await sb.from('software').delete().eq('id', id));
    },
    /** A title on one computer ({ id?, software_id, device_id, version, build, seen_on, notes }); returns its id. */
    async saveInstall(row) {
      const { id, ...fields } = row;
      if (id) { ok(await sb.from('software_installs').update(fields).eq('id', id)); return id; }
      return ok(await sb.from('software_installs').insert(fields).select('id').single()).id;
    },
    async deleteInstall(id) {
      ok(await sb.from('software_installs').delete().eq('id', id));
    },

    // ---- Rigging: a room's battens and trusses, and what hangs on each.
    /** Insert or update a position ({ id?, campus_id, room_id, name, sort_order, notes }); returns its id. */
    async savePosition(row) {
      const { id, ...fields } = row;
      if (id) { ok(await sb.from('rig_positions').update(fields).eq('id', id)); return id; }
      return ok(await sb.from('rig_positions').insert(fields).select('id').single()).id;
    },
    /** Takes the position away; whatever hung on it is left not on a position. */
    async deletePosition(id) {
      ok(await sb.from('rig_positions').delete().eq('id', id));
    },
    /** Hangs items on a position (or takes them down with null). */
    async setDevicePosition(ids, positionId) {
      if (!ids.length) return;
      ok(await sb.from('devices').update({ position_id: positionId || null }).in('id', ids));
    },

    /** payload: { device, ips, credentials, ports, numbers } — numbers holds only what changed. */
    async saveDevice(payload) {
      return ok(await sb.rpc('save_device_full', { payload }));
    },
    /** Many items' lighting numbers at once: [{ id, fixture_id?, patch_universe?, patch_address?, … }]. */
    /** How an item is doing: active, spare, check, broken, repair, retired. */
    async setDeviceStatus(id, status) {
      ok(await sb.from('devices').update({ status }).eq('id', id));
    },
    async setDeviceNumbers(rows) {
      return ok(await sb.rpc('set_device_numbers', { rows }));
    },
    async deleteDevice(id) {
      ok(await sb.from('devices').delete().eq('id', id));
    },
    async devicePorts(deviceId) {
      return ok(await sb.from('device_ports').select('*').eq('device_id', deviceId));
    },
    async saveType(payload) {
      const id = ok(await sb.rpc('save_device_type', { payload }));
      const extra = {};
      if ('networked' in payload.type) extra.networked = !!payload.type.networked;
      if ('dmx_modes' in payload.type) extra.dmx_modes = payload.type.dmx_modes || [];
      if ('dmx_footprint' in payload.type) extra.dmx_footprint = payload.type.dmx_footprint || null;
      if ('unknown' in payload.type) extra.unknown = !!payload.type.unknown;
      if (Object.keys(extra).length) ok(await sb.from('device_types').update(extra).eq('id', id));
      return id;
    },
    async addDevices(payload) {
      return ok(await sb.rpc('add_devices', { payload }));
    },
    async deleteType(id) {
      ok(await sb.from('device_types').delete().eq('id', id));
    },

    /** Public link to a type's photo; thumb=true for the small list version. */
    photoUrl(path, thumb = false) {
      if (!path) return null;
      const p = thumb ? thumbPath(path) : path;
      return `${url}/storage/v1/object/public/gear-photos/${p.split('/').map(encodeURIComponent).join('/')}`;
    },
    async setTypePhoto(typeId, { full, thumb }, oldPath = null) {
      const bucket = sb.storage.from('gear-photos');
      const path = `types/${typeId}/${Date.now().toString(36)}.jpg`;
      const opts = { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false };
      ok(await bucket.upload(path, full, opts));
      ok(await bucket.upload(thumbPath(path), thumb, opts));
      ok(await sb.from('device_types').update({ photo_path: path }).eq('id', typeId));
      if (oldPath) bucket.remove([oldPath, thumbPath(oldPath)]).catch(() => {});
      return path;
    },
    async removeTypePhoto(typeId, oldPath = null) {
      ok(await sb.from('device_types').update({ photo_path: null }).eq('id', typeId));
      if (oldPath) sb.storage.from('gear-photos').remove([oldPath, thumbPath(oldPath)]).catch(() => {});
    },
    async credentials(deviceId) {
      return ok(await sb.from('device_credentials').select('*').eq('device_id', deviceId).order('sort_order'));
    },
    async history(deviceId) {
      return ok(await sb.from('activity').select('*').eq('device_id', deviceId).order('at', { ascending: false }).limit(40));
    },

    async saveNetwork(n) {
      const row = {
        campus_id: n.campus_id, name: n.name, purpose: n.purpose || null, vlan_id: n.vlan_id ?? null,
        subnet: n.subnet || null, gateway: n.gateway || null, departments: n.departments || [],
        is_isolated: !!n.is_isolated, notes: n.notes || null,
      };
      if (n.id) return ok(await sb.from('networks').update(row).eq('id', n.id).select('id').single()).id;
      return ok(await sb.from('networks').insert(row).select('id').single()).id;
    },
    async deleteNetwork(id) {
      ok(await sb.from('networks').delete().eq('id', id));
    },
    async addRoom(campus_id, name, group_id = null) {
      return ok(await sb.from('rooms').insert({ campus_id, name, group_id: group_id || null }).select('*').single());
    },

    async streams() {
      return all(() => sb.from('streams').select('*').order('sort_order').order('created_at'));
    },
    async saveStream(st) {
      const row = { campus_id: st.campus_id, name: (st.name || '').trim() || 'Online', embed_id: st.embed_id, embed_type: st.embed_type || 'webchannel' };
      if (st.id) return ok(await sb.from('streams').update(row).eq('id', st.id).select('id').single()).id;
      return ok(await sb.from('streams').insert(row).select('id').single()).id;
    },
    async deleteStream(id) {
      ok(await sb.from('streams').delete().eq('id', id));
    },

    // ---- Planning Center: one church-wide connection, synced on the server.
    async pcoStatus() {
      return ok(await sb.rpc('pco_status'));
    },
    async pcoData() {
      const [types, teams, plans, people] = await Promise.all([
        all(() => sb.from('pco_service_types').select('*').order('sequence', { nullsFirst: false }).order('name')),
        all(() => sb.from('pco_teams').select('*').order('sequence', { nullsFirst: false }).order('name')),
        all(() => sb.from('pco_plans').select('*').order('sort_date')),
        all(() => sb.from('pco_plan_people').select('id, plan_id, team_id, person_id, name, position, status, photo, invite_pending').order('id')),
      ]);
      return { types, teams, plans, people };
    },
    /** The flow of one service (its Planning Center items), in order. */
    async pcoItems(planId) {
      return ok(await sb.from('pco_plan_items').select('*').eq('plan_id', planId).order('sequence'));
    },
    /** Planning Center Live for one plan (Events › Live): current item, next, who's driving, item times. */
    /** With an action (admins): take, release, next, previous: drive Planning Center Live. */
    async pcoLive(planId, action = null) {
      const { data, error } = await sb.functions.invoke('pco-live', { body: action ? { plan_id: planId, action } : { plan_id: planId } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* not JSON */ }
        throw friendly(new Error(msg));
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    /** CG uploads for one Sunday (2026-11-08): each campus's status (and each extra CG's, by
     *  station: 'CG2'), and who set it when. */
    async cgUploads(sunday) {
      return ok(await sb.from('cg_uploads').select('campus_id, station, status, updated_at, updated_by_name, who:profiles!cg_uploads_updated_by_fkey(full_name)').eq('sunday', sunday));
    },
    async cgSetUpload(sunday, campusId, status, station = '') {
      ok(await sb.from('cg_uploads').upsert({ sunday, campus_id: campusId, station: station || '', status }, { onConflict: 'sunday,campus_id,station' }));
    },
    /** Lighting › House lights: the rooms on the sheet, Planning Center's services (which
     *  ones each room has), and every level set. */
    async houseLights() {
      const [rooms, types, levels] = await Promise.all([
        sb.from('rooms').select('id, name, campus_id').eq('house_lights', true),
        sb.from('pco_service_types').select('id, name, campus_id, access, on_roster, is_event'),
        sb.from('house_light_levels').select('room_id, service, segment, level, updated_at, updated_by_name, who:profiles!house_light_levels_updated_by_fkey(full_name)'),
      ]);
      return { rooms: ok(rooms) || [], types: ok(types) || [], levels: ok(levels) || [] };
    },
    /** A level (0-100), or null to take it off. */
    /** Resi › Studio: the encoders and the events scheduled on them (typed in from Resi Studio). */
    async resiStudio() {
      const [encoders, schedules] = await Promise.all([
        sb.from('resi_encoders').select('id, name, campus_id, installed, notes, updated_at, updated_by_name'),
        sb.from('resi_schedules').select('*, who:profiles!resi_schedules_updated_by_fkey(full_name)'),
      ]);
      return { encoders: ok(encoders) || [], schedules: ok(schedules) || [] };
    },
    /** Planning Center for Resi › Studio: every service type (with its location) and the plans
     *  from `fromIso` on, with their times (services, rehearsals). */
    async resiPco(fromIso) {
      const [types, plans] = await Promise.all([
        all(() => sb.from('pco_service_types').select('id, name, campus_id, access, is_event').order('name')),
        all(() => sb.from('pco_plans').select('id, service_type_id, title, sort_date, times, url').gte('sort_date', fromIso).order('sort_date')),
      ]);
      return { types, plans };
    },
    /** Add (no id) or change an encoder; returns its id. */
    async resiEncoderSave(row) {
      const { id, ...fields } = row;
      if (id) { ok(await sb.from('resi_encoders').update(fields).eq('id', id)); return id; }
      return ok(await sb.from('resi_encoders').insert(fields).select('id').single()).id;
    },
    async resiEncoderRemove(id) { ok(await sb.from('resi_encoders').delete().eq('id', id)); },
    /** Add (no id) or change a scheduled event; returns its id. */
    async resiScheduleSave(row) {
      const { id, ...fields } = row;
      if (id) { ok(await sb.from('resi_schedules').update(fields).eq('id', id)); return id; }
      return ok(await sb.from('resi_schedules').insert(fields).select('id').single()).id;
    },
    async resiScheduleRemove(id) { ok(await sb.from('resi_schedules').delete().eq('id', id)); },
    async houseLightSet(roomId, service, segment, level) {
      if (level == null) ok(await sb.from('house_light_levels').delete().match({ room_id: roomId, service, segment }));
      else ok(await sb.from('house_light_levels').upsert({ room_id: roomId, service, segment, level }, { onConflict: 'room_id,service,segment' }));
    },
    /** Gear's computers (campus, name, location): which CGs there are (js/cg-rows.js). */
    async cgComputers() {
      return all(() => sb.from('devices').select('campus_id, name, location, device_types!inner(category)').eq('device_types.category', 'Computer'));
    },
    /** Events › Live: what each person in an event is on (VOX 4), and the gear it is, when logged. */
    async eventGear(planId) {
      return ok(await sb.from('event_item_gear').select('item_id, label, device_ids').eq('plan_id', planId));
    },
    async pcoSetEvent(typeId, on) {
      ok(await sb.rpc('pco_set_event', { p_type: typeId, p_on: !!on }));
    },
    /** connect { app_id, secret } · disconnect · sync */
    async pco(action, payload = {}) {
      const { data, error } = await sb.functions.invoke('pco', { body: { action, ...payload } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* not JSON */ }
        throw friendly(new Error(msg));
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    async pcoSetAccess(typeId, access) {
      ok(await sb.rpc('pco_set_access', { p_type: typeId, p_access: access }));
    },
    /** Whether a shared service is on Services › Roster. */
    async pcoSetRoster(typeId, on) {
      ok(await sb.rpc('pco_set_roster', { p_type: typeId, p_on: !!on }));
    },
    async pcoShowTeam(name, shown) {
      ok(await sb.rpc('pco_show_team', { p_name: name, p_shown: shown }));
    },
    async pcoSetWeeks(weeks) {
      ok(await sb.rpc('pco_set_weeks', { p_weeks: weeks }));
    },
    async pcoSetCampus(typeId, campusId) {
      ok(await sb.rpc('pco_set_campus', { p_type: typeId, p_campus: campusId || null }));
    },

    // ---- Volunteers: everyone on the production teams (staff only). Not logins.
    async volunteers() {
      const [people, members] = await Promise.all([
        all(() => sb.from('volunteers').select('*').order('name')),
        all(() => sb.from('pco_team_people').select('team_id, person_id, positions')),
      ]);
      return { people, members };
    },
    /** Add someone by hand, or change name, home location, tags or notes. Returns the id. */
    async saveVolunteer(v) {
      const row = {};
      for (const k of ['name', 'home_campus_id', 'notes', 'tags', 'lanyard']) if (k in v) row[k] = v[k];
      if ('name' in row) row.name = String(row.name || '').trim();
      if ('notes' in row) row.notes = String(row.notes || '').trim() || null;
      if ('home_campus_id' in row) row.home_campus_id = row.home_campus_id || null;
      if ('lanyard' in row) row.lanyard = row.lanyard || null;
      if (v.id) return ok(await sb.from('volunteers').update(row).eq('id', v.id).select('id').single()).id;
      return ok(await sb.from('volunteers').insert(row).select('id').single()).id;
    },
    async setLanyard(id, lanyard) {
      return ok(await sb.from('volunteers').update({ lanyard: lanyard || null }).eq('id', id).select('*').single());
    },
    async deleteVolunteer(id) {
      ok(await sb.from('volunteers').delete().eq('id', id));
    },

    async profiles() {
      return all(() => sb.from('profiles').select('*').order('full_name'));
    },
    async updateProfile(id, patch) {
      ok(await sb.from('profiles').update(patch).eq('id', id));
    },

    // ---- Meetings (staff): notes, and questions & answers.
    async meetings() {
      const [meetings, notes, questions, answers] = await Promise.all([
        all(() => sb.from('meetings').select('*').order('starts_at', { ascending: false })),
        all(() => sb.from('meeting_notes').select('*').order('created_at')),
        all(() => sb.from('meeting_questions').select('*').order('asked_at')),
        all(() => sb.from('meeting_answers').select('*').order('answered_at')),
      ]);
      return { meetings, notes, questions, answers };
    },
    /** Insert or update one meeting-related row; returns its id. */
    async saveMeetingRow(table, row) {
      if (!['meetings', 'meeting_notes', 'meeting_questions', 'meeting_answers'].includes(table)) throw new Error('Not a meeting table.');
      const { id, ...fields } = row;
      if (id) { ok(await sb.from(table).update(fields).eq('id', id)); return id; }
      return ok(await sb.from(table).insert(fields).select('id').single()).id;
    },
    async deleteMeetingRow(table, id) {
      if (!['meetings', 'meeting_notes', 'meeting_questions', 'meeting_answers'].includes(table)) throw new Error('Not a meeting table.');
      ok(await sb.from(table).delete().eq('id', id));
    },

    // ---- Gear extras (staff): camera builds, and haze fluid, stock and tank checks.
    async gearExtras() {
      const [builds, fluids, stock, checks, systems, systemItems] = await Promise.all([
        all(() => sb.from('camera_builds').select('*').order('number')),
        all(() => sb.from('haze_fluids').select('*').order('name')),
        all(() => sb.from('haze_stock').select('*')),
        all(() => sb.from('haze_checks').select('*').order('checked_at', { ascending: false })),
        all(() => sb.from('systems').select('*').order('name')),
        all(() => sb.from('system_items').select('*')),
      ]);
      return { builds, fluids, stock, checks, systems, systemItems };
    },
    /** Insert or update one row of those; returns its id. */
    async saveGearRow(table, row) {
      if (!GEAR_TABLES.includes(table)) throw new Error('Not a gear table.');
      const { id, ...fields } = row;
      if (id) { ok(await sb.from(table).update(fields).eq('id', id)); return id; }
      return ok(await sb.from(table).insert(fields).select('id').single()).id;
    },
    async deleteGearRow(table, id) {
      if (!GEAR_TABLES.includes(table)) throw new Error('Not a gear table.');
      ok(await sb.from(table).delete().eq('id', id));
    },
    /** A placeholder model ("Projector", model unknown) becomes a real one, or back. */
    async setTypeUnknown(typeId, unknown) {
      ok(await sb.from('device_types').update({ unknown: !!unknown }).eq('id', typeId));
    },
    /** A hazer model's fluid and tank size. */
    async setHazerModel(typeId, { haze_fluid_id = null, tank_liters = null }) {
      ok(await sb.from('device_types').update({ haze_fluid_id, tank_liters }).eq('id', typeId));
    },

    // ---- Cables (staff): kinds of cable, and how many of each length and label.
    async cables() {
      const [types, cables, rooms] = await Promise.all([
        all(() => sb.from('cable_types').select('*').order('signal')),
        all(() => sb.from('cables').select('*').order('length_ft')),
        all(() => sb.from('rooms').select('*').order('sort_order').order('name')),
      ]);
      return { types, cables, rooms };
    },
    async saveCableRow(table, row) {
      if (!CABLE_TABLES.includes(table)) throw new Error('Not a cable table.');
      const { id, ...fields } = row;
      if (id) { ok(await sb.from(table).update(fields).eq('id', id)); return id; }
      return ok(await sb.from(table).insert(fields).select('id').single()).id;
    },
    async deleteCableRow(table, id) {
      if (!CABLE_TABLES.includes(table)) throw new Error('Not a cable table.');
      ok(await sb.from(table).delete().eq('id', id));
    },

    /** Calls cb(table) whenever someone changes shared data. */
    subscribe(cb) {
      const ch = sb.channel('changes');
      for (const table of ['devices', 'device_ips', 'networks', 'rooms', 'rig_positions', 'profiles', 'device_types', 'device_type_ports', 'streams', 'volunteers', 'software', 'software_installs']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb(table));
      }
      for (const table of ['meetings', 'meeting_notes', 'meeting_questions', 'meeting_answers']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb('meetings'));
      }
      for (const table of GEAR_TABLES) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb(table));
      }
      for (const table of CABLE_TABLES) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb('cables'));
      }
      // Planning Center rosters: the sync touches one row whenever anything changed.
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'pco_live' }, () => cb('pco'));
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'cg_uploads' }, () => cb('cg'));
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'house_light_levels' }, () => cb('house'));
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'resi_encoders' }, () => cb('resi_studio'));
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'resi_schedules' }, () => cb('resi_studio'));
      ch.subscribe();
      return () => sb.removeChannel(ch);
    },
  };
}

const thumbPath = (p) => p.replace(/\.jpg$/i, '-t.jpg');
const GEAR_TABLES = ['camera_builds', 'haze_fluids', 'haze_stock', 'haze_checks', 'systems', 'system_items'];
const CABLE_TABLES = ['cable_types', 'cables'];

// Turns database and auth errors into sentences people can act on.
function friendly(error) {
  const msg = error?.message || String(error);
  const map = [
    [/Invalid login credentials/i, 'That email and password don’t match an account.'],
    [/Email not confirmed/i, 'Check your email for the confirmation link first, then sign in.'],
    [/User already registered/i, 'There’s already an account with that email. Sign in instead.'],
    [/Password should be at least/i, 'Use a password with at least 8 characters.'],
    [/rate limit/i, 'Too many emails were sent just now. Wait a few minutes and try again.'],
    [/invalid input syntax for type inet/i, 'One of the IP addresses isn’t valid.'],
    [/invalid input syntax for type macaddr/i, 'The MAC address isn’t valid.'],
    [/device_types_name_idx/i, 'There’s already a model with that name from that brand.'],
    [/device_type_ports_type_id_name_key/i, 'Two ports on this model have the same name.'],
    [/devices_type_id_fkey/i, 'This model still has items at some locations. Delete or change those first.'],
    // The database says "type" and "unit"; the app says "model" and "item".
    [/That (unit|device) was deleted by someone else/i, 'That item was deleted by someone else.'],
    [/That type was deleted by someone else/i, 'That model was deleted by someone else.'],
    [/isn't on this unit's type/i, 'That port isn’t on this item’s model.'],
    [/Tag it audio, video or lighting/i, 'Pick at least one department: Audio, Video, Lighting or Network.'],
    [/is at a different campus/i, (m) => m.replace('campus', 'location')],
    [/devices_asset_no_key|devices_type_asset_key/i, 'Another item already has that asset number. Every item has its own.'],
    [/devices_patch_pair/i, 'A patch needs both a universe and an address, like 1.333.'],
    [/devices_asset_no_(check|max)/i, 'Asset numbers go from UCP-000001 to UCP-999999.'],
    [/devices_(patch_universe|patch_address|fixture_id|dmx_channels)_check/i, 'One of the numbers is out of range.'],
    [/volunteers_name_check/i, 'Give them a name.'],
    [/streams_campus_id_embed_id_key/i, 'That player is already on this campus.'],
    [/cable_types_signal_end_a_end_b_key/i, 'That kind of cable is already listed.'],
    [/cables_(length_ft|quantity)_check/i, 'Check the length and the count.'],
    [/rig_positions_room_id_name_key/i, 'There’s already a position with that name in this room.'],
    [/rig_positions_name_check/i, 'Give the position a name (up to 60 characters).'],
    [/system_items_system_id_device_id_key/i, 'That item is already in this system.'],
    [/camera_builds_campus_id_number_key/i, 'That camera number is already set up at this location.'],
    [/haze_stock_campus_id_fluid_id_key/i, 'That fluid is already listed at this location.'],
    [/haze_(stock|checks|fluids)_\w+_check|camera_builds_\w+_check/i, 'One of the numbers is out of range.'],
    [/invalid input syntax for type uuid/i, 'That doesn’t look like a Resi player ID.'],
    [/Payload too large|exceeded the maximum allowed size/i, 'That photo is too big. Try a smaller one.'],
    [/row-level security|permission denied/i, 'Your account doesn’t have access to change this.'],
    [/Failed to fetch|NetworkError/i, 'Can’t reach the server. Check your connection and try again.'],
  ];
  for (const [re, text] of map) if (re.test(msg)) return new Error(typeof text === 'function' ? text(msg) : text);
  return new Error(msg);
}
