// Planning Center webhooks: the fast path for rosters.
//
// Planning Center POSTs here (…/functions/v1/pco?hook=1) within a second or two
// of someone being scheduled, taken off, accepting or declining. The delivery is
// checked against the subscription's authenticity secret, then just that plan's
// roster is read again and open apps are told. The 30-second sync stays as the
// safety net for anything a webhook misses.
//
// Subscriptions are made with the church-wide token (admin action `webhooks`),
// and their secrets are kept in pco_webhooks, which only the service role reads.

import { relId, type Pco } from './pco.ts';
import { refreshRoster } from './sync.ts';
import type { ScheduleDb } from './schedule.ts';

/** What the roster needs to hear about: someone on a plan, or (failing that) the plan itself. */
const ROSTER_EVENT = /^services\.v2\.events\.plan_person\./;
const PLAN_EVENT = /^services\.v2\.events\.plan\.updated$/;

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
}

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the body was signed with one of our subscriptions' secrets. */
export async function authentic(sb: any, body: string, signature: string | null) {
  if (!signature) return false;
  const { data, error } = await sb.from('pco_webhooks').select('secret');
  if (error) throw new Error(`Database: ${error.message}`);
  const want = signature.trim().toLowerCase();
  for (const row of data || []) {
    if (row.secret && same(await hmac(row.secret, body), want)) return true;
  }
  return false;
}

/** The plan each delivery is about (plan people only), from the payload or what we already have. */
export async function plansIn(sb: any, body: any) {
  const deliveries = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
  const planIds = new Set<string>();
  const lookUp: string[] = [];
  for (const d of deliveries) {
    const name = String(d?.attributes?.name || '');
    if (!ROSTER_EVENT.test(name) && !PLAN_EVENT.test(name)) continue;
    let doc: any = null;
    try { doc = JSON.parse(d.attributes.payload); } catch { continue; }
    const item = Array.isArray(doc?.data) ? doc.data[0] : doc?.data;
    const plan = PLAN_EVENT.test(name) ? item?.id : relId(item, 'plan');
    if (plan) planIds.add(String(plan));
    else if (item?.id) lookUp.push(String(item.id)); // a removal may not say which plan; we know
  }
  if (lookUp.length) {
    const { data } = await sb.from('pco_plan_people').select('plan_id').in('id', lookUp);
    for (const r of data || []) planIds.add(String(r.plan_id));
  }
  return [...planIds];
}

// One refresh per plan at a time; changes that land meanwhile get one more pass after it.
const running = new Map<string, { again: boolean; done: Promise<void> }>();

/** Reads the plans' rosters again and tells open apps. Plans the app doesn't show are skipped. */
export async function refreshPlans({ pco, db, planIds }: { pco: Pco; db: ScheduleDb; planIds: string[] }) {
  const known = planIds.length ? await db.plans(planIds) : [];
  const tracked = known.filter((p) => p.access !== 'hidden');
  if (!tracked.length) return { refreshed: 0 };
  let shown: Set<string> | null = null;
  let keepAudio: Set<string> | null = null;
  const one = async (plan: { id: string; service_type_id: string }) => {
    const busy = running.get(plan.id);
    if (busy) { busy.again = true; return busy.done; }
    const job = { again: false, done: Promise.resolve() };
    job.done = (async () => {
      try {
        do {
          job.again = false;
          shown ??= new Set(await db.shownTeamIds());
          keepAudio ??= new Set(await db.audioTeamIds());
          const stamp = new Date().toISOString();
          await refreshRoster({ pco, db, plan, shownTeams: shown, keepAudio, stamp });
          await db.pulse(stamp);
        } while (job.again);
      } finally {
        running.delete(plan.id);
      }
    })();
    running.set(plan.id, job);
    return job.done;
  };
  await Promise.all(tracked.map(one));
  return { refreshed: tracked.length };
}

/**
 * Admin: make sure Planning Center sends the roster events to `url`, and keep
 * their secrets. Returns what's subscribed.
 */
export async function ensureWebhooks({ pco, sb, url }: { pco: Pco; sb: any; url: string }) {
  // The Webhooks API lists its collections at its root; use the subscriptions one it names.
  const root = await pco.get('/webhooks/v2');
  const links: Record<string, string> = { ...(root.data?.links || {}), ...((root as any).links || {}) };
  const link = (re: RegExp) => Object.entries(links).find(([k, v]) => re.test(k) && typeof v === 'string')?.[1];
  const href = link(/subscription/i);
  if (!href) throw new Error(`Planning Center’s Webhooks API offers: ${Object.keys(links).join(', ') || 'nothing'}`);
  const path = new URL(href).pathname;
  const type = /webhook_subscriptions$/.test(path) ? 'WebhookSubscription' : 'Subscription';
  // Only ask for events Planning Center actually offers.
  const eventsHref = link(/available_event/i);
  const offered: string[] = eventsHref
    ? (await pco.all(`${new URL(eventsHref).pathname}?per_page=100`)).data.map((e: any) => String(e.attributes?.name || '')).filter(Boolean)
    : [];
  let wanted = offered.filter((n) => ROSTER_EVENT.test(n));
  if (!wanted.length) wanted = offered.filter((n) => PLAN_EVENT.test(n));
  if (!wanted.length) {
    const services = offered.filter((n) => n.startsWith('services.'));
    throw new Error(`No roster events offered. Services events: ${services.join(', ') || 'none'}; links: ${Object.keys(links).join(', ')}`);
  }
  const list = await pco.all(`${path}?per_page=100`);
  const ours = list.data.filter((s: any) => s.attributes?.url === url);
  const made: string[] = [];
  for (const name of wanted) {
    const have = ours.find((s: any) => s.attributes?.name === name);
    if (have) {
      if (have.attributes?.active === false) {
        const doc = await pco.send('PATCH', `${path}/${have.id}`, { data: { type, id: have.id, attributes: { active: true } } });
        if (doc?.data) Object.assign(have, doc.data);
      }
      continue;
    }
    const doc = await pco.send('POST', path, { data: { type, attributes: { name, url, active: true } } });
    if (doc?.data) { ours.push(doc.data); made.push(name); }
  }
  const rows = [];
  for (const s of ours) {
    let secret = s.attributes?.authenticity_secret;
    if (!secret) secret = (await pco.get(`${path}/${s.id}`)).data?.attributes?.authenticity_secret;
    if (secret) rows.push({ id: String(s.id), name: s.attributes?.name, url, secret, active: s.attributes?.active !== false });
  }
  if (rows.length) {
    const { error } = await sb.from('pco_webhooks').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`Database: ${error.message}`);
  }
  return { offered: offered.filter((n) => n.startsWith('services.')), made, subscribed: rows.map((r) => ({ id: r.id, name: r.name, active: r.active })) };
}
