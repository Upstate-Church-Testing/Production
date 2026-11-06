// Planning Center Live for Events › Live: where a service is right now.
//
// POST { plan_id } with the signed-in person's token (staff and up). Answers with the
// current item and when it went live, the next item, who's driving in Planning Center
// Live, every item's planned and actual times, the plan's times, and `now` (the
// server's clock, so every screen counts from the same second).
//
// Planning Center Live is read at most every 1.5 seconds per plan however many screens
// are watching (pco_live_cache holds the last answer); the items and their times are
// read again when the item moves, or every 20 seconds. Its own function, apart from
// pco (the sync), so polling it doesn't touch the sync.
//
// POST { plan_id, action } drives Planning Center Live (admins only), as the Planning
// Center account Tally is connected with (me_id): take (take control, if that account
// isn't already driving), next, previous (only while it's driving), release (let go).
// Answers with the fresh state, so every screen sees the move on its next ask.

import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { pcoClient, PcoError } from '../pco/pco.ts';
import { readLive, readPlan } from './live.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RANK: Record<string, number> = { pending: 0, volunteer: 1, contractor: 2, staff: 3, admin: 4 };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const LIVE_FRESH_MS = 1500;  // Planning Center Live read at most this often, however many screens watch
const FULL_EVERY_MS = 20000; // the items and their times: this often, or right away when the item moves

class Problem extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: any = {};
  try { body = await req.json(); } catch { /* no body */ }
  try {
    const role = await staff(req, sb);
    const action = String(body.action ?? '');
    if (action) {
      if ((RANK[role] ?? 0) < RANK.admin) throw new Problem(403, 'Only an admin can drive Live from here.');
      return reply(await control(sb, String(body.plan_id ?? ''), action));
    }
    return reply(await live(sb, String(body.plan_id ?? '')));
  } catch (e) {
    const status = e instanceof Problem ? e.status : e instanceof PcoError ? 400 : 500;
    if (status >= 500) console.error('pco-live error', e);
    return reply({ error: (e as Error).message || 'Something went wrong.' }, status);
  }
});

/** Staff and admins (their role); or the sync's own cron token (for checking it from the server side). */
async function staff(req: Request, sb: any): Promise<string> {
  const cron = req.headers.get('x-pco-cron');
  if (cron) {
    const creds = await credentials(sb);
    if (!creds?.cron_token || !same(cron, creds.cron_token)) throw new Problem(401, 'Not allowed.');
    return 'admin';
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new Problem(401, 'Sign in first.');
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) throw new Problem(401, 'Your sign-in has expired. Sign in again.');
  const { data: profile } = await sb.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
  if ((RANK[profile?.role] ?? 0) < RANK.staff) throw new Problem(403, 'Only staff can see Live.');
  return profile.role;
}

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function credentials(sb: any) {
  const { data, error } = await sb.rpc('pco_credentials');
  if (error) throw new Error(`Database: ${error.message}`);
  return data;
}

async function live(sb: any, planId: string) {
  if (!/^\d{1,18}$/.test(planId)) throw new Problem(400, 'Which service?');
  const { data: plan, error } = await sb.from('pco_plans').select('id, service_type_id').eq('id', planId).maybeSingle();
  if (error) throw new Error(`Database: ${error.message}`);
  if (!plan) throw new Problem(404, 'That service isn’t shared in the app.');
  const answer = (state: any) => ({ ...state, now: new Date().toISOString() });
  const { data: row } = await sb.from('pco_live_cache').select('*').eq('plan_id', planId).maybeSingle();
  const now = Date.now();
  if (row && now - Date.parse(row.live_at) < LIVE_FRESH_MS) return answer(row.state);
  // Claim this read so screens asking at the same moment share it (the others get the last answer).
  if (row) {
    const { data: got } = await sb.from('pco_live_cache').update({ live_at: new Date(now).toISOString() })
      .eq('plan_id', planId).lt('live_at', new Date(now - LIVE_FRESH_MS).toISOString()).select('plan_id');
    if (!got?.length) return answer(row.state);
  }
  const creds = await credentials(sb);
  if (!creds?.app_id || !creds?.secret) throw new Problem(400, 'Planning Center isn’t connected.');
  const pco = pcoClient({ appId: creds.app_id, secret: creds.secret });
  const base = `/services/v2/service_types/${plan.service_type_id}/plans/${planId}`;
  const prev = row?.state?.items ? row.state : null;
  const lv = await readLive(pco, base);
  // Who Tally is in Planning Center (the account that made the token): read once, kept.
  let meId: string | null = row?.state?.me_id ?? null;
  if (!meId) { try { meId = String((await pco.get('/services/v2/me')).data?.id ?? '') || null; } catch { meId = null; } }
  const moved = !prev || prev.current_id !== lv.current_id || prev.current?.start !== lv.current?.start;
  const fullDue = !prev || moved || now - Date.parse(row.full_at) > FULL_EVERY_MS;
  const full = fullDue ? await readPlan(pco, base) : { items: prev.items, item_times: prev.item_times, plan_times: prev.plan_times };
  // An item time Live named but didn't include: find it among the item times.
  const timeOf = (id: string | null) => (id ? full.item_times.find((t: any) => t?.id === id) ?? null : null);
  const stamp = new Date().toISOString();
  const state = {
    plan_id: planId, ...lv, me_id: meId,
    current: lv.current ?? timeOf(lv.current_id), next: lv.next ?? timeOf(lv.next_id),
    ...full,
    read_at: stamp, full_read_at: fullDue ? stamp : prev.full_read_at,
  };
  const { error: saveError } = await sb.from('pco_live_cache').upsert({
    plan_id: planId, state, live_at: stamp, full_at: fullDue ? stamp : row.full_at,
  });
  if (saveError) console.error('pco live not cached', saveError.message);
  return answer(state);
}

/** Drive Planning Center Live as Tally's Planning Center account, then read it again for everyone. */
async function control(sb: any, planId: string, action: string) {
  if (!['take', 'release', 'next', 'previous'].includes(action)) throw new Problem(400, 'Unknown action.');
  if (!/^\d{1,18}$/.test(planId)) throw new Problem(400, 'Which service?');
  const { data: plan, error } = await sb.from('pco_plans').select('id, service_type_id').eq('id', planId).maybeSingle();
  if (error) throw new Error(`Database: ${error.message}`);
  if (!plan) throw new Problem(404, 'That service isn’t shared in the app.');
  const creds = await credentials(sb);
  if (!creds?.app_id || !creds?.secret) throw new Problem(400, 'Planning Center isn’t connected.');
  const pco = pcoClient({ appId: creds.app_id, secret: creds.secret });
  const base = `/services/v2/service_types/${plan.service_type_id}/plans/${planId}`;
  const meId = String((await pco.get('/services/v2/me')).data?.id ?? '');
  if (!meId) throw new Problem(400, 'Couldn’t tell which Planning Center account Tally uses.');
  const lv = await readLive(pco, base);
  if (!lv.available || !lv.live_id) throw new Problem(400, 'Planning Center Live isn’t available for this plan.');
  const mine = lv.controller_id === meId;
  // Planning Center's docs put Live's actions under live/{id}; on a plan's own path that can
  // answer "not found", so the bare live/ path is tried too. A "not found" changes nothing.
  const act = async (name: string) => {
    let last: unknown = null;
    for (const path of [`${base}/live/${lv.live_id}/${name}`, `${base}/live/${name}`]) {
      try { await pco.send('POST', path); return; } catch (e) {
        if (e instanceof PcoError && e.status === 404) { last = e; continue; }
        throw e;
      }
    }
    const allowed = lv.can_take_control === false ? ' Planning Center says the account Tally is connected with can’t take control of this plan’s Live.' : '';
    throw new Problem(400, `Planning Center didn’t accept ${name.replace(/_/g, ' ')} from Tally.${allowed}`);
  };
  if (action === 'take') {
    if (!mine) await act('toggle_control');
  } else if (action === 'release') {
    if (mine) await act('toggle_control');
  } else {
    if (!mine) throw new Problem(409, lv.controller ? `${lv.controller} is driving in Planning Center Live. Take control first.` : 'Take control first.');
    await act(action === 'next' ? 'go_to_next_item' : 'go_to_previous_item');
  }
  // Everyone's next ask gets the move: read it all again now.
  const after = await readLive(pco, base);
  const full = await readPlan(pco, base);
  const timeOf = (id: string | null) => (id ? full.item_times.find((t: any) => t?.id === id) ?? null : null);
  const stamp = new Date().toISOString();
  const state = {
    plan_id: planId, ...after, me_id: meId,
    current: after.current ?? timeOf(after.current_id), next: after.next ?? timeOf(after.next_id),
    ...full, read_at: stamp, full_read_at: stamp,
  };
  const { error: saveError } = await sb.from('pco_live_cache').upsert({ plan_id: planId, state, live_at: stamp, full_at: stamp });
  if (saveError) console.error('pco live not cached', saveError.message);
  console.log(JSON.stringify({ pco_live_control: { plan: planId, action, was: lv.current_id, now: after.current_id, driving: after.controller } }));
  return { ...state, now: new Date().toISOString() };
}
