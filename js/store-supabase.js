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
      const [rooms, networks, devices, ips, types] = await Promise.all([
        all(() => sb.from('rooms').select('*').order('sort_order').order('name')),
        all(() => sb.from('networks').select('*').order('sort_order').order('name')),
        all(() => sb.from('devices').select('*').order('name')),
        all(() => sb.from('device_ips').select('*').order('sort_order')),
        all(() => sb.from('device_types').select('*, ports:device_type_ports(*)').order('name')),
      ]);
      return { rooms, networks, devices, ips, types };
    },

    async saveDevice(payload) {
      return ok(await sb.rpc('save_device', { payload }));
    },
    async deleteDevice(id) {
      ok(await sb.from('devices').delete().eq('id', id));
    },
    async devicePorts(deviceId) {
      return ok(await sb.from('device_ports').select('*').eq('device_id', deviceId));
    },
    async saveType(payload) {
      const id = ok(await sb.rpc('save_device_type', { payload }));
      if ('networked' in payload.type) ok(await sb.from('device_types').update({ networked: !!payload.type.networked }).eq('id', id));
      return id;
    },
    async addDevices(payload) {
      return ok(await sb.rpc('add_devices', { payload }));
    },
    async deleteType(id) {
      ok(await sb.from('device_types').delete().eq('id', id));
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
    async addRoom(campus_id, name) {
      return ok(await sb.from('rooms').insert({ campus_id, name }).select('*').single());
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

    async profiles() {
      return all(() => sb.from('profiles').select('*').order('full_name'));
    },
    async updateProfile(id, patch) {
      ok(await sb.from('profiles').update(patch).eq('id', id));
    },

    /** Calls cb(table) whenever someone changes shared data. */
    subscribe(cb) {
      const ch = sb.channel('changes');
      for (const table of ['devices', 'device_ips', 'networks', 'rooms', 'profiles', 'device_types', 'device_type_ports', 'streams']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb(table));
      }
      ch.subscribe();
      return () => sb.removeChannel(ch);
    },
  };
}

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
    [/device_types_name_idx/i, 'There’s already a type with that name from that maker.'],
    [/device_type_ports_type_id_name_key/i, 'Two ports on this type have the same name.'],
    [/devices_type_id_fkey/i, 'This type still has models at campuses. Delete or change those first.'],
    [/streams_campus_id_embed_id_key/i, 'That player is already on this campus.'],
    [/invalid input syntax for type uuid/i, 'That doesn’t look like a Resi player ID.'],
    [/row-level security|permission denied/i, 'Your account doesn’t have access to change this.'],
    [/Failed to fetch|NetworkError/i, 'Can’t reach the server. Check your connection and try again.'],
  ];
  for (const [re, text] of map) if (re.test(msg)) return new Error(text);
  return new Error(msg);
}
