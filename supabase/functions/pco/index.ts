// Planning Center for the whole team, through one church-wide connection.
//
// Nobody signs in to Planning Center from the app. An admin pastes a
// personal access token once; it's checked here, kept in Vault, and used to
// copy services, teams and rosters into the database. The database decides
// who sees what (by app role and by which services an admin shares).
//
// POST { action } with the signed-in person's token, or the cron token:
//   connect     admin  { app_id, secret }  check it with Planning Center, keep it, start syncing
//   disconnect  admin                       forget the token and the copied rosters
//   sync        staff, or the 15-minute schedule

import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { pcoClient, PcoError } from './pco.ts';
import { runSync } from './sync.ts';
import { dbAdapter } from './db.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RANK: Record<string, number> = { pending: 0, volunteer: 1, contractor: 2, staff: 3, admin: 4 };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SYNC_BUDGET_MS = 110_000; // stop starting new requests after this; the next run picks up the rest
const DAY = 864e5;

class Problem extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Who = { kind: 'cron' | 'user'; role: string; id: string | null };

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: any = {};
  try { body = await req.json(); } catch { /* no body */ }
  try {
    const who = await caller(req, sb);
    switch (body.action) {
      case 'connect': need(who, 'admin'); return reply(await connect(sb, who, body));
      case 'disconnect': need(who, 'admin'); return reply(await disconnect(sb));
      case 'sync': need(who, 'staff'); return reply(await startSync(sb, who));
      default: throw new Problem(400, 'Unknown action.');
    }
  } catch (e) {
    const status = e instanceof Problem ? e.status : e instanceof PcoError ? 400 : 500;
    if (status >= 500) console.error('pco error', e);
    return reply({ error: (e as Error).message || 'Something went wrong.' }, status);
  }
});

async function caller(req: Request, sb: any): Promise<Who> {
  const cron = req.headers.get('x-pco-cron');
  if (cron) {
    const creds = await credentials(sb);
    if (!creds?.cron_token || !same(cron, creds.cron_token)) throw new Problem(401, 'Not allowed.');
    return { kind: 'cron', role: 'admin', id: null };
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new Problem(401, 'Sign in first.');
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) throw new Problem(401, 'Your sign-in has expired. Sign in again.');
  const { data: profile } = await sb.from('profiles').select('id, role').eq('id', data.user.id).maybeSingle();
  if (!profile) throw new Problem(403, 'Your account isn’t set up yet.');
  return { kind: 'user', role: profile.role, id: profile.id };
}

function need(who: Who, role: 'staff' | 'admin') {
  if ((RANK[who.role] ?? 0) < RANK[role]) throw new Problem(403, role === 'admin' ? 'Only an admin can do that.' : 'Only staff can do that.');
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

// ------------------------------------------------------------------ connect --

async function connect(sb: any, who: Who, body: any) {
  const appId = String(body.app_id ?? '').trim();
  const secret = String(body.secret ?? '').trim();
  if (!appId || !secret) throw new Problem(400, 'Paste both the Application ID and the Secret.');
  if (appId.length > 200 || secret.length > 200 || /\s/.test(appId + secret)) {
    throw new Problem(400, 'That doesn’t look like a Planning Center token. Copy the Application ID and Secret again.');
  }

  const pco = pcoClient({ appId, secret });
  const org = await pco.get('/services/v2'); // a wrong token stops here with a clear message
  let me: any = null;
  try { me = (await pco.get('/services/v2/me')).data; } catch { /* fine without it */ }
  let tz: string | null = null;
  try { tz = (await pco.get('/people/v2')).data?.attributes?.time_zone ?? null; } catch { /* no People access */ }
  const a = me?.attributes || {};
  const connectedAs = a.full_name || [a.first_name, a.last_name].filter(Boolean).join(' ') || null;
  const orgName = org.data?.attributes?.name || null;

  const { error } = await sb.rpc('pco_save_connection', {
    p: { app_id: appId, secret, org_name: orgName, time_zone: tz || org.data?.attributes?.time_zone || null, connected_as: connectedAs, connected_by: who.id },
  });
  if (error) throw new Error(`Database: ${error.message}`);

  const sync = await startSync(sb, who, { fullTeams: true, allRosters: true });
  return { connected: true, org_name: orgName, connected_as: connectedAs, syncing: sync.started };
}

async function disconnect(sb: any) {
  const run = async (q: any) => { const { error } = await q; if (error) throw new Error(`Database: ${error.message}`); };
  await run(sb.rpc('pco_forget_secret'));
  await run(sb.from('pco_connection').delete().eq('id', true));
  await run(sb.from('pco_plans').delete().not('id', 'is', null)); // rosters go with them
  await run(sb.from('profiles').update({ pco_person_id: null, pco_checked_at: null }).or('pco_person_id.not.is.null,pco_checked_at.not.is.null'));
  return { connected: false };
}

// --------------------------------------------------------------------- sync --

async function startSync(sb: any, who: Who, force?: { fullTeams: boolean; allRosters: boolean }) {
  const creds = await credentials(sb);
  if (!creds?.app_id || !creds?.secret) throw new Problem(400, 'Planning Center isn’t connected.');

  // One sync at a time. A sync that died more than 4 minutes ago doesn't count.
  const stale = new Date(Date.now() - 4 * 60_000).toISOString();
  const { data: got, error } = await sb.from('pco_connection')
    .update({ sync_started_at: new Date().toISOString() })
    .eq('id', true)
    .or(`sync_started_at.is.null,sync_started_at.lt.${stale}`)
    .select('id');
  if (error) throw new Error(`Database: ${error.message}`);
  if (!got?.length) return { started: false, already: true };

  const dailyDue = !creds.last_full_sync_at || Date.now() - Date.parse(creds.last_full_sync_at) > DAY;
  const opts = force ?? { fullTeams: dailyDue, allRosters: who.kind === 'user' };
  const job = runAndRecord(sb, creds, opts);
  // Answer now; the sync carries on in the background.
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(job); else await job;
  return { started: true };
}

async function runAndRecord(sb: any, creds: any, opts: { fullTeams: boolean; allRosters: boolean }) {
  const started = Date.now();
  let result: any = null;
  let error: string | null = null;
  try {
    const pco = pcoClient({ appId: creds.app_id, secret: creds.secret });
    result = await runSync({ pco, db: dbAdapter(sb), weeksAhead: creds.weeks_ahead || 6, ...opts, deadline: started + SYNC_BUDGET_MS });
  } catch (e) {
    error = (e as Error).message || String(e);
    console.error('pco sync failed', e);
  }
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { sync_started_at: null, last_sync_error: error };
  if (!error) {
    patch.last_sync_at = now;
    patch.people_note = result.peopleNote;
    if (opts.fullTeams && !result.partial) patch.last_full_sync_at = now;
  }
  const { error: saveError } = await sb.from('pco_connection').update(patch).eq('id', true);
  if (saveError) console.error('pco sync status not saved', saveError.message);
  console.log(JSON.stringify({ pco_sync: { ...opts, ms: Date.now() - started, error, ...result } }));
}
