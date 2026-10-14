// Resi web players: reading what someone pasted, asking Resi what's on,
// and building the player link. Resi's player API is public and allows
// requests from any site, so this runs in the browser with no server.

const API = 'https://webevents.resi.io/api/v1';
const PLAYLIST_API = 'https://media-metadata.resi.io/api/v1/playlists/player/';
const PLAYER = 'https://control.resi.io/webplayer/video.html';

// data-type values the Resi player understands. No type means a web channel
// (an event profile), which is what a campus's main embed usually is.
export const EMBED_TYPES = {
  webchannel: 'Web channel',
  event: 'Single event',
  schedule: 'Schedule',
  library: 'Library video',
  playlist: 'Playlist',
};
const PATHS = { webchannel: 'eventprofiles/latest/', event: 'events/', schedule: 'schedules/', library: 'library/' };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Reads a Resi player out of whatever was pasted: the player link
 * (…/webplayer/video.html?id=…), the embed code (data-embed-id="…"), or the ID.
 * Returns { embed_id, embed_type } or null.
 */
export function parsePlayer(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const typeOf = (v) => (v && EMBED_TYPES[v.toLowerCase()] ? v.toLowerCase() : 'webchannel');
  // Embed code
  const attr = /data-embed-id\s*=\s*["']?([0-9a-f-]{36})/i.exec(s);
  if (attr && UUID.test(attr[1])) {
    const t = /data-type\s*=\s*["']?([a-z]+)/i.exec(s);
    return { embed_id: attr[1].toLowerCase(), embed_type: typeOf(t?.[1]) };
  }
  // Player link
  const href = /https?:\/\/\S+/i.exec(s)?.[0].replace(/["'<>].*$/, '');
  if (href) {
    try {
      const u = new URL(href.replace(/&amp;/g, '&'));
      const id = u.searchParams.get('id') || u.searchParams.get('embedId') || '';
      if (UUID.test(id)) return { embed_id: UUID.exec(id)[0].toLowerCase(), embed_type: typeOf(u.searchParams.get('type')) };
    } catch { /* not a full link; fall through */ }
  }
  // Just the ID, or an ID somewhere in the text
  const any = UUID.exec(s);
  return any ? { embed_id: any[0].toLowerCase(), embed_type: 'webchannel' } : null;
}

/** The Resi player page for a stream; this is what goes in the iframe. */
export function playerUrl({ embed_id, embed_type }, { autoplay = true, muted = true } = {}) {
  const q = new URLSearchParams({ id: embed_id, autoplay: String(autoplay), mute: String(muted) });
  if (embed_type && embed_type !== 'webchannel') q.set('type', embed_type);
  return `${PLAYER}?${q}`;
}

/** A plain link to the player, for opening in a new tab or showing in Settings. */
export function linkFor({ embed_id, embed_type }) {
  return `${PLAYER}?id=${embed_id}${embed_type && embed_type !== 'webchannel' ? `&type=${embed_type}` : ''}`;
}

export const shortId = (id) => (id ? `${id.slice(0, 8)}…` : '');

/**
 * What a player is showing right now.
 *   state: live | simlive | replay | ondemand | on | offline | missing | error
 *   title, description, thumb, startedAt (Date), duration (seconds), checkedAt
 * `on` means Resi has an event up but we couldn't tell if it's live or a replay.
 */
export async function playerStatus({ embed_id, embed_type = 'webchannel' }, { signal } = {}) {
  const checkedAt = new Date();
  const url = embed_type === 'playlist' ? PLAYLIST_API + embed_id : `${API}/${PATHS[embed_type] || PATHS.webchannel}${embed_id}`;
  let data;
  try {
    const r = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
    if (r.status === 404 || r.status === 400) return { state: 'missing', checkedAt };
    if (!r.ok) return { state: 'error', message: `Resi answered ${r.status}`, checkedAt };
    data = await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { state: 'error', message: 'Couldn’t reach Resi', checkedAt };
  }

  if (embed_type === 'playlist') {
    const item = data?.items?.[0];
    if (!item) return { state: 'offline', checkedAt };
    return { state: 'ondemand', title: data.title || item.title || '', thumb: thumbOf(item), checkedAt };
  }
  if (embed_type === 'library') {
    return { state: 'ondemand', title: data.title || data.name || '', description: data.description || '', thumb: thumbOf(data), checkedAt };
  }

  const cloud = data.cloud || data.cdnManifestUrls?.[0] || {};
  const offlineImage = data.offlineImageEnabled && data.offlineImageUrl ? data.offlineImageUrl : null;
  const isOffline = !cloud.dashUrl && !cloud.hlsUrl
    || /\/offline\//.test(cloud.dashUrl || cloud.hlsUrl || '')
    || (data.name === 'Offline Content' && !data.airingId);
  if (isOffline) return { state: 'offline', thumb: offlineImage, checkedAt };

  const base = { title: data.name || '', description: data.description || '', thumb: thumbOf(data) || offlineImage, eventId: data.uuid || null, checkedAt };
  const m = cloud.dashUrl ? await readManifest(cloud.dashUrl, signal) : null;
  if (!m) return { ...base, state: data.simLive ? 'simlive' : 'on' };
  if (m.dynamic) return { ...base, state: data.simLive ? 'simlive' : 'live', startedAt: m.start };
  return { ...base, state: 'replay', duration: m.duration };
}

function thumbOf(x) {
  return x?.thumbnails?.[0]?.representations?.[0]?.publicUrl || null;
}

// A DASH manifest says type="dynamic" while it's live and "static" once it's a recording.
async function readManifest(url, signal) {
  try {
    const r = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
    if (!r.ok) return null;
    const head = (await r.text()).slice(0, 4000);
    const root = /<MPD\b[^>]*>/i.exec(head)?.[0];
    if (!root) return null;
    const attr = (n) => new RegExp(`\\b${n}="([^"]*)"`, 'i').exec(root)?.[1];
    const start = attr('availabilityStartTime');
    return {
      dynamic: (attr('type') || '').toLowerCase() === 'dynamic',
      start: start && !Number.isNaN(Date.parse(start)) ? new Date(start) : null,
      duration: isoSeconds(attr('mediaPresentationDuration')),
    };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
}

// PT1H12M3.5S -> 4323.5
function isoSeconds(v) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(v || '');
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

/** "42 min", "1 hr 12 min" */
export function spanText(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const mins = Math.max(0, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export const ON_AIR = new Set(['live', 'simlive', 'replay', 'ondemand', 'on']);
export const STATE_LABEL = {
  live: 'Live', simlive: 'Simulated live', replay: 'Replay', ondemand: 'On demand', on: 'On',
  offline: 'Offline', missing: 'Not found', error: 'Can’t check', loading: 'Checking…',
};
