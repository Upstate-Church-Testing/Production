// CG uploads' rows, shared by CG uploads (views/cg.js) and Home so both count the same: one per
// campus for its main CG, plus one for each other CG computer Gear has at a campus (Simpsonville's
// CG2 in A Control). A CG computer is a Computer at location CG / CG1 / CG2…, or with "(CG)",
// "(CG1)", "(CG2)"… in its name. CG and CG1 are the campus's main one ('' station); CG2 and up
// each get a row of their own ('CG2'), with the main one then shown as CG1.

/** '' = a campus's main CG, 'CG2'… = another one, null = not at a CG. */
export function cgStation(d) {
  const m = /^cg\s*(\d)?$/i.exec(String(d?.location || '').trim()) || /\(cg\s*(\d)?\)/i.exec(d?.name || '');
  if (!m) return null;
  const n = Number(m[1] || 1);
  return n >= 2 ? `CG${n}` : '';
}

/** The row key: campus id and station. */
export const cgKey = (campusId, station = '') => `${campusId}|${station || ''}`;

/** Every row, campuses in the order given (alphabetical), each campus's extra CGs after its main
 *  one. `computers`: Gear items that are computers ({ campus_id, location, name }). */
export function cgRows(campuses, computers = []) {
  const extra = new Map();
  for (const d of computers) {
    const st = cgStation(d);
    if (!st) continue;
    if (!extra.has(d.campus_id)) extra.set(d.campus_id, new Set());
    extra.get(d.campus_id).add(st);
  }
  const rows = [];
  for (const cp of campuses) {
    const more = [...(extra.get(cp.id) || [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    rows.push({ key: cgKey(cp.id), campus: cp, station: '', tag: more.length ? 'CG1' : '' });
    for (const st of more) rows.push({ key: cgKey(cp.id, st), campus: cp, station: st, tag: st });
  }
  return rows;
}
