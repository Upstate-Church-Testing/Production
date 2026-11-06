// Planning Center Live for one plan: which item is up and since when, what's next,
// who's driving, and every item's planned and actual times. The app's Events › Live
// view asks for this every couple of seconds; pco-live/index.ts keeps the last answer in
// pco_live_cache so every screen watching shares one read of Planning Center.

import { PcoError, relId, relIds, type Pco } from '../pco/pco.ts';

const text = (v: unknown) => (v == null ? '' : String(v)).trim();
const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export type LiveTime = {
  id: string; item_id: string | null; plan_time_id: string | null;
  start: string | null; end: string | null; length: number | null; exclude: boolean;
};

/** One ItemTime: when an item went live (and ended) for one service time. */
export function liveTime(x: any): LiveTime | null {
  if (!x) return null;
  const a = x.attributes || {};
  return {
    id: String(x.id), item_id: relId(x, 'item'), plan_time_id: relId(x, 'plan_time'),
    start: a.live_start_at || null, end: a.live_end_at || null, length: num(a.length), exclude: !!a.exclude,
  };
}

/** What changes when someone hits Next: one request. */
export async function readLive(pco: Pco, base: string) {
  let doc;
  try {
    doc = await pco.get(`${base}/live?include=current_item_time,next_item_time,controller`);
  } catch (e) {
    if (e instanceof PcoError && (e.status === 403 || e.status === 404)) {
      return { available: false, current: null, next: null, controller: null, current_id: null, next_id: null, note: e.message };
    }
    throw e;
  }
  const live = Array.isArray(doc.data) ? doc.data[0] : doc.data;
  const inc = doc.included || [];
  const find = (type: string, id: string | null) => (id ? inc.find((x: any) => x.type === type && String(x.id) === String(id)) : null);
  const currentId = relId(live, 'current_item_time');
  const nextId = relId(live, 'next_item_time');
  const who = find('Person', relId(live, 'controller'));
  const wa = who?.attributes || {};
  return {
    available: true,
    current_id: currentId,
    next_id: nextId,
    current: liveTime(find('ItemTime', currentId)),
    next: liveTime(find('ItemTime', nextId)),
    controller: who ? text(wa.full_name) || [text(wa.first_name), text(wa.last_name)].filter(Boolean).join(' ') || null : null,
    note: null as string | null,
  };
}

/** The order of service with every item's times, and the plan's times: two requests. */
export async function readPlan(pco: Pco, base: string) {
  const [items, times] = await Promise.all([
    pco.all(`${base}/items?per_page=100&include=item_times,item_notes`, 4),
    pco.all(`${base}/plan_times?per_page=100`, 2),
  ]);
  const notes = new Map(items.included.filter((x: any) => x.type === 'ItemNote').map((x: any) => [String(x.id), x]));
  return {
    items: items.data.map((it: any) => {
      const a = it.attributes || {};
      return {
        id: String(it.id),
        sequence: num(a.sequence),
        title: text(a.title),
        kind: text(a.item_type) || 'item',
        position: text(a.service_position) || 'during',
        length: num(a.length),
        description: text(a.description) || null,
        key_name: text(a.key_name) || null,
        notes: relIds(it, 'item_notes').map((id) => notes.get(String(id))).filter(Boolean)
          .map((n: any) => ({ category: text(n.attributes?.category_name) || 'Note', content: text(n.attributes?.content) }))
          .filter((n: any) => n.content),
      };
    }).sort((a: any, b: any) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9)),
    item_times: items.included.filter((x: any) => x.type === 'ItemTime').map(liveTime),
    plan_times: times.data.map((t: any) => {
      const a = t.attributes || {};
      return {
        id: String(t.id), name: text(a.name) || null, kind: a.time_type || 'other',
        starts_at: a.starts_at || null, ends_at: a.ends_at || null,
        live_starts_at: a.live_starts_at || null, live_ends_at: a.live_ends_at || null,
      };
    }).sort((a: any, b: any) => String(a.starts_at).localeCompare(String(b.starts_at))),
  };
}
