// cg-live: the CG computer's listener (tools/cg-live) posts what ProPresenter 7 sent it,
// one answer at a time, with its campus key. The answer is parsed here, so the Mac does no
// work beyond passing it on. Kinds, named by the ProPresenter path the answer came from:
// presentation/active, presentation/slide_index, status/slide, status/layers; heartbeat
// ("still here"); and thumb (the JPEG of the slide that's live).
// A slide_index answer is replied to with "thumb <presentation uuid> <slide> <when>": the
// listener then fetches that slide's thumbnail from ProPresenter and posts it back as kind
// thumb, so the Mac never has to read JSON itself.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const text = (s: unknown) => (typeof s === "string" ? s.replace(/\r/g, "").trim() : null);
const MAX_THUMB = 400 * 1024;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const key = req.headers.get("x-cg-key") || "";
  const q = new URL(req.url).searchParams;
  const kind = q.get("kind") || "";
  if (!key) return new Response("no key", { status: 401 });
  const { data: agent } = await sb.from("cg_agents").select("id, campus_id").eq("key", key).maybeSingle();
  if (!agent) return new Response("bad key", { status: 401 });
  const now = new Date().toISOString();

  // The picture of the live slide. Kept only if it's for the newest slide change heard.
  if (kind === "thumb") {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.length < 100 || buf.length > MAX_THUMB) return new Response("bad size", { status: 400 });
    if (!(buf[0] === 0xff && buf[1] === 0xd8)) return new Response("not a jpeg", { status: 400 });
    const at = Number(q.get("at")) || Date.now();
    const reqAt = new Date(at).toISOString();
    const { data: had } = await sb.from("cg_live_thumbs").select("req_at").eq("campus_id", agent.campus_id).maybeSingle();
    if (had && Date.parse(had.req_at) > at) return new Response("stale");
    const ix = Number(q.get("index"));
    const { error } = await sb.from("cg_live_thumbs").upsert({
      campus_id: agent.campus_id, presentation_uuid: q.get("uuid"), slide_index: Number.isFinite(ix) ? ix + 1 : null,
      jpeg: encodeBase64(buf), req_at: reqAt, updated_at: now,
    }, { onConflict: "campus_id" });
    if (error) return new Response(error.message, { status: 500 });
    return new Response("ok");
  }

  let body: any = null;
  try { body = await req.json(); } catch { return new Response("not json", { status: 400 }); }
  const row: Record<string, unknown> = { campus_id: agent.campus_id, seen_at: now, updated_at: now };
  let reply = "ok";
  if (kind === "presentation/active") {
    const p = body?.presentation ?? body;
    row.presentation = text(p?.id?.name) ?? text(p?.name);
    row.presentation_uuid = text(p?.id?.uuid);
    row.slide_count = Array.isArray(p?.groups) ? p.groups.reduce((n: number, g: any) => n + (g?.slides?.length || 0), 0) : null;
  } else if (kind === "status/slide") {
    row.slide_text = text(body?.current?.text);
    row.next_text = text(body?.next?.text);
  } else if (kind === "presentation/slide_index") {
    const ix = body?.presentation_index;
    row.slide_index = typeof ix?.index === "number" ? ix.index + 1 : null;
    if (ix?.presentation_id?.name) row.presentation = text(ix.presentation_id.name);
    const uuid = text(ix?.presentation_id?.uuid);
    if (uuid) row.presentation_uuid = uuid;
    // Ask for that slide's picture (only ever a plain id and a whole number).
    if (uuid && /^[A-Za-z0-9-]{8,64}$/.test(uuid) && Number.isInteger(ix?.index) && ix.index >= 0) reply = `thumb ${uuid} ${ix.index} ${Date.now()}`;
  } else if (kind === "status/layers") {
    row.media_playing = !!(body?.media || body?.video);
    row.cleared = !(body?.slide || body?.media || body?.video || body?.props || body?.messages || body?.announcements);
  } else if (kind === "heartbeat") {
    // just seen_at
  } else {
    row.raw = body;
  }
  const { error } = await sb.from("cg_live").upsert(row, { onConflict: "campus_id" });
  if (error) return new Response(error.message, { status: 500 });
  await sb.from("cg_agents").update({ last_seen: now }).eq("id", agent.id);
  return new Response(reply);
});
