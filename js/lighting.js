// Lighting numbers, shared by the item panel, the patch sheet and Statistics.
//
//   Fixture ID  the console's number for a fixture (grandMA3 Fixture ID, Eos channel)
//   Patch       "1.333" = universe 1, address 333. Stored as two numbers so a
//               universe can be searched and counted across locations.
//   Stage #     1…N per model in one room
//   Asset #     1…N per model across every location, permanent
//
// A patch belongs to the console in its room, so a "rig" is one location + room.

export const MAX_UNIVERSE = 100;
export const SLOTS = 512;

// Things in the lighting section that aren't patched on a console.
const NOT_PATCHED = /console|wing|computer|switch|node|gateway|wall station|access point|router|monitor|display|cable|driver|processor/i;

/** True for lighting items that take a DMX patch (fixtures, hazers, dimmers…). */
export function takesPatch(dev, type) {
  if (!dev?.departments?.includes('lighting')) return false;
  if (type?.dmx_modes?.length) return true;
  return !NOT_PATCHED.test(type?.category || '');
}

/** "1.333", "1/333", "1:333", "1-333" or "1 333"; a lone number up to 512 is universe 1. */
export function parsePatch(text) {
  const t = String(text ?? '').trim().replace(/^u(niverse)?\s*/i, '');
  if (!t) return { empty: true };
  let m = /^(\d{1,5})\s*[.\/:\-\s]\s*(\d{1,3})$/.exec(t);
  if (!m && /^\d{1,3}$/.test(t)) m = [t, '1', t];
  if (!m && /^\d{4}$/.test(t)) return { error: `Put a dot between the universe and the address, like ${t[0]}.${t.slice(1)}.` };
  if (!m) return { error: 'Type it as universe.address, like 1.333.' };
  const universe = Number(m[1]);
  const address = Number(m[2]);
  if (universe < 1 || universe > MAX_UNIVERSE) return { error: `Universes go from 1 to ${MAX_UNIVERSE}.` };
  if (address < 1 || address > SLOTS) return { error: 'Addresses go from 1 to 512.' };
  return { universe, address };
}

/** 1, 1 → "1.001": the way grandMA3 writes it, so 1.1 and 1.10 can't be mixed up. */
export const fmtPatch = (u, a) => (u == null || a == null ? '' : `${u}.${String(a).padStart(3, '0')}`);
export const patchOf = (d) => fmtPatch(d.patch_universe, d.patch_address);

/** How many DMX channels this item takes: its own setting, the model's mode, or the model's only mode. */
export function footprint(dev, type) {
  if (dev?.dmx_channels) return dev.dmx_channels;
  if (type?.dmx_footprint) return type.dmx_footprint;
  if (type?.dmx_modes?.length === 1) return type.dmx_modes[0];
  return null;
}

/** "1.001–1.014" for a patched item; the start alone when the footprint isn't known. */
export function rangeText(d, ch) {
  if (d.patch_universe == null) return '';
  if (!ch || ch === 1) return fmtPatch(d.patch_universe, d.patch_address);
  return `${fmtPatch(d.patch_universe, d.patch_address)}–${String(d.patch_address + ch - 1).padStart(3, '0')}`;
}

export const rigKey = (d) => `${d.campus_id}|${d.room_id || ''}`;

/** "6, 9 13/18" → [6, 9, 13, 18] (sorted, no repeats, 1–512). */
export function parseModes(text) {
  const out = String(text ?? '').split(/[^\d]+/).filter(Boolean).map(Number).filter((n) => n >= 1 && n <= SLOTS);
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Problems in one rig (the items of one location + room):
 *   overlap  two patches cross over each other's addresses
 *   shared   two fixtures on exactly the same addresses (often on purpose, so they move together)
 *   fid      two fixtures have the same fixture ID
 *   stage    two of the same model have the same stage #
 * Returns Map(itemId → [{ kind, other }]).
 */
export function rigProblems(items, typeOf) {
  const out = new Map();
  const add = (a, kind, other) => { if (!out.has(a.id)) out.set(a.id, []); out.get(a.id).push({ kind, other }); };

  const byUni = new Map();
  for (const d of items) {
    if (d.patch_universe == null) continue;
    const ch = footprint(d, typeOf(d)) || 1;
    if (!byUni.has(d.patch_universe)) byUni.set(d.patch_universe, []);
    byUni.get(d.patch_universe).push({ d, start: d.patch_address, end: d.patch_address + ch - 1 });
  }
  for (const list of byUni.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].start <= list[i].end; j++) {
        const kind = list[j].start === list[i].start && list[j].end === list[i].end ? 'shared' : 'overlap';
        add(list[i].d, kind, list[j].d);
        add(list[j].d, kind, list[i].d);
      }
    }
  }

  const dupes = (key, kind) => {
    const seen = new Map();
    for (const d of items) {
      const k = key(d);
      if (k == null) continue;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(d);
    }
    for (const list of seen.values()) if (list.length > 1) for (const a of list) for (const b of list) if (a !== b) add(a, kind, b);
  };
  dupes((d) => d.fixture_id ?? null, 'fid');
  dupes((d) => (d.stage_no == null ? null : `${d.type_id}|${d.stage_no}`), 'stage');
  return out;
}

/** Channels in use on one universe (each address counted once). */
export function usedChannels(items, typeOf) {
  const used = new Uint8Array(SLOTS + 1);
  for (const d of items) {
    const ch = footprint(d, typeOf(d)) || 1;
    for (let a = d.patch_address; a < d.patch_address + ch && a <= SLOTS; a++) used[a] = 1;
  }
  return used.reduce((n, x) => n + x, 0);
}

/** First address on a universe where `ch` channels fit, skipping what's taken. */
export function nextFreeAddress(items, typeOf, universe, ch = 1) {
  const used = new Uint8Array(SLOTS + 2);
  for (const d of items) {
    if (d.patch_universe !== universe) continue;
    const n = footprint(d, typeOf(d)) || 1;
    for (let a = d.patch_address; a < d.patch_address + n && a <= SLOTS; a++) used[a] = 1;
  }
  for (let a = 1; a + ch - 1 <= SLOTS; a++) {
    let free = true;
    for (let k = a; k < a + ch; k++) if (used[k]) { free = false; a = k; break; }
    if (free) return a;
  }
  return null;
}

/** Problem lines for one item, for the item panel and the editor. */
export function problemText(list, nameOf) {
  const by = (kind) => list.filter((p) => p.kind === kind).map((p) => nameOf(p.other));
  const lines = [];
  const o = by('overlap'); if (o.length) lines.push(`Patch overlaps ${o.join(', ')}`);
  const sh = by('shared'); if (sh.length) lines.push(`On the same addresses as ${sh.join(', ')}, so they move together`);
  const f = by('fid'); if (f.length) lines.push(`Same fixture ID as ${f.join(', ')}`);
  const s = by('stage'); if (s.length) lines.push(`Same stage # as ${s.join(', ')}`);
  return lines;
}

/** Number at the end of a name, for ordering "Jolt 2" before "Jolt 10". */
export const nameNumber = (name) => { const m = /(\d+)\s*$/.exec(name || ''); return m ? Number(m[1]) : Infinity; };

/** Problems worth a red flag (sharing addresses on purpose isn't one). */
export const isProblem = (p) => p.kind !== 'shared';

/** "2.041" typed in a search box → { universe, address }, else null. */
export function patchPoint(q) {
  const m = /^(\d{1,3})[.\/:](\d{1,3})$/.exec(String(q || '').trim());
  if (!m) return null;
  const universe = Number(m[1]), address = Number(m[2]);
  return universe >= 1 && address >= 1 && address <= SLOTS ? { universe, address } : null;
}

/** Does this item's patch cover that address? */
export function covers(d, type, pt) {
  if (!pt || d.patch_universe !== pt.universe) return false;
  const ch = footprint(d, type) || 1;
  return pt.address >= d.patch_address && pt.address < d.patch_address + ch;
}
