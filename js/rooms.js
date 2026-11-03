// Rooms and room groups. A room can sit inside another room at the same location
// (rooms.group_id), like the offices and Production Storage inside "E-Wing
// Offices". Most rooms have no group. Filters go by room name, so "Storage"
// works across locations; a group is one entry that opens to its rooms.

export const ALL = 'all';
export const NO_ROOM = '__none';
export const GROUP = 'grp:';             // filter value prefix for a whole group
const key = (name) => String(name || '').trim().toLowerCase();

/** The group a room is part of, or the room itself when other rooms sit inside it. */
export function groupOf(r, byId, groupIds) {
  if (!r) return null;
  if (r.group_id) return byId.get(r.group_id) || null;
  return groupIds.has(r.id) ? r : null;
}
const groupIdsOf = (rooms) => new Set(rooms.filter((r) => r.group_id).map((r) => r.group_id));

/** Does something in room `r` (or no room) match the picked filter value? */
export function roomMatches(value, r, byId) {
  if (value === ALL || value == null) return true;
  if (!r) return value === NO_ROOM;
  if (value.startsWith(GROUP)) {
    const g = r.group_id ? byId.get(r.group_id) : r;
    return !!g && GROUP + key(g.name) === value;
  }
  return key(r.name) === value;
}

/** "E-Wing Offices › Luken's Office", or just the room's name. */
export function roomPath(r, byId) {
  if (!r) return '';
  const g = r.group_id ? byId.get(r.group_id) : null;
  return g ? `${g.name.trim()} › ${r.name.trim()}` : r.name.trim();
}

/** Words a search can find a room by: its name and its group's. */
export function roomWords(r, byId) {
  if (!r) return [];
  const g = r.group_id ? byId.get(r.group_id) : null;
  return [r.name, g?.name].filter(Boolean);
}

/** The filter's current choice in words: "Luken's Office", "E-Wing Offices", "no room". */
export function roomFilterLabel(value, rooms) {
  if (value === ALL) return '';
  if (value === NO_ROOM) return 'no room';
  const k = value.startsWith(GROUP) ? value.slice(GROUP.length) : value;
  const r = rooms.find((x) => key(x.name) === k);
  return r ? r.name.trim() : k;
}

/**
 * Room filter options, with groups holding their rooms as `children`.
 *   rooms      every room
 *   items      what's being counted (each with room_id)
 *   countOf    (list) => number shown beside an option
 *   emptyAt    a campus id: list its rooms even with nothing in them
 *   byCount    order by count (all locations) instead of the rooms' own order
 */
export function roomOptions({ rooms, items, countOf, emptyAt = null, byCount = false, allCount, allLabel = 'All rooms' }) {
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const groupIds = groupIdsOf(rooms);
  const top = new Map();
  const entry = (map, value, label, sort) => {
    let e = map.get(value);
    if (!e) map.set(value, (e = { value, label, sort, list: [], kids: new Map() }));
    return e;
  };
  const place = (r) => {
    if (!r) return [entry(top, NO_ROOM, 'No room', Infinity), null];
    const g = groupOf(r, byId, groupIds);
    if (!g) return [entry(top, key(r.name), r.name.trim(), r.sort_order ?? 999), null];
    const t = entry(top, GROUP + key(g.name), g.name.trim(), g.sort_order ?? 999);
    t.group = true;
    const kid = r === g ? entry(t.kids, key(g.name), 'Not in a room', Infinity) : entry(t.kids, key(r.name), r.name.trim(), r.sort_order ?? 999);
    return [t, kid];
  };
  for (const x of items) {
    const [t, kid] = place(x.room_id ? byId.get(x.room_id) : null);
    t.list.push(x);
    kid?.list.push(x);
  }
  if (emptyAt) {
    for (const r of rooms.filter((x) => x.campus_id === emptyAt)) {
      if (groupIds.has(r.id)) { const t = entry(top, GROUP + key(r.name), r.name.trim(), r.sort_order ?? 999); t.group = true; }
      else place(r);
    }
  }
  const order = (a, b) => (a.sort === Infinity) - (b.sort === Infinity)
    || (byCount ? countOf(b.list) - countOf(a.list) : a.sort - b.sort) || a.label.localeCompare(b.label);
  const out = (e) => ({ value: e.value, label: e.label, count: countOf(e.list),
    ...(e.group ? { children: [...e.kids.values()].sort(order).map(out) } : {}) });
  return [{ value: ALL, label: allLabel, count: allCount }, ...[...top.values()].sort(order).map(out)];
}

/** Every value an options list offers, children included (to check a choice is still there). */
export function optionValues(list) {
  return list.flatMap((o) => [o.value, ...(o.children || []).map((c) => c.value)]);
}

/** <option>s for a room picker at one location: groups as <optgroup>s with their rooms inside. */
export function roomSelectHtml(rooms, campusId, selected, esc) {
  const here = rooms.filter((r) => r.campus_id === campusId);
  const byId = new Map(here.map((r) => [r.id, r]));
  const groupIds = groupIdsOf(here);
  const sort = (a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999) || a.name.localeCompare(b.name);
  const opt = (r, label = r.name) => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${esc(label)}</option>`;
  return here.filter((r) => !r.group_id || !byId.has(r.group_id)).sort(sort).map((r) => (groupIds.has(r.id)
    ? `<optgroup label="${esc(r.name)}">${opt(r, `${r.name}, not in a room`)}${here.filter((x) => x.group_id === r.id).sort(sort).map((x) => opt(x)).join('')}</optgroup>`
    : opt(r))).join('');
}

/** Rooms that can hold other rooms at a location (any room that isn't inside one). */
export function groupChoices(rooms, campusId) {
  return rooms.filter((r) => r.campus_id === campusId && !r.group_id)
    .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999) || a.name.localeCompare(b.name));
}
