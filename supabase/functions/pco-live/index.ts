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
    await staff(req, sb);
    return reply(await live(sb, String(body.plan_id ?? '')));
  } catch (e) {
    const status = e instanceof Problem ? e.status : e instanceof PcoError ? 400 : 500;
    if (status >= 500) console.error('pco-live error', e);
    return reply({ error: (e as Error).message || 'Something went wrong.' }, status);
  }
});

/** Staff and admins; or the sync's own cron token (for checking it from the server side). */
async function staff(req: Request, sb: any) {
  const cron = req.headers.get('x-pco-cron');
  if (cron) {
    const creds = await credentials(sb);
    if (!creds?.cron_token || !same(cron, creds.cron_token)) throw new Problem(401, 'Not allowed.');
    return;
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new Problem(401, 'Sign in first.');
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) throw new Problem(401, 'Your sign-in has expired. Sign in again.');
  const { data: profile } = await sb.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
  if ((RANK[profile?.role] ?? 0) < RANK.staff) throw new Problem(403, 'Only staff can see Live.');
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
  const moved = !prev || prev.current_id !== lv.current_id || prev.current?.start !== lv.current?.start;
  const fullDue = !prev || moved || now - Date.parse(row.full_at) > FULL_EVERY_MS;
  const full = fullDue ? await readPlan(pco, base) : { items: prev.items, item_times: prev.item_times, plan_times: prev.plan_times };
  // An item time Live named but didn't include: find it among the item times.
  const timeOf = (id: string | null) => (id ? full.item_times.find((t: any) => t?.id === id) ?? null : null);
  const stamp = new Date().toISOString();
  const state = {
    plan_id: planId, ...lv,
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
