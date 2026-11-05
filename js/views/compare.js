// Compare: items side by side, one column each, with what's different picked out.
// Opened from a model (all its items), from Gear › Items or from Gear › Software
// (whatever is on screen). Rows are the details that can differ between the same kind
// of thing: model, status, where in the room, what it's for, its OS and firmware, the
// version of each piece of software, notes. A row that isn't the same everywhere is
// marked, and in it the values that differ from the usual one are highlighted (a blank is
// "not set", so it's never the odd one out).
// Serial, asset # and IP are always different, so they're shown but never marked.

import { esc, icon, $, plural, splitInet } from '../util.js';
import { typeLabel } from './types.js';
import { STATUS } from './devices.js';
import { roomPath } from '../rooms.js';
import { assetTag } from '../lighting.js';
import { versionText, logoHtml, runsSoftware } from '../software.js';

export const COMPARE_MAX = 40;

/** items: devices rows. openItem(id): open one (the compare closes first). */
export function openCompare(ctx, s, items, { title, sub = '', openItem }) {
  const typeOf = (d) => s.ix.type.get(d.type_id);
  const campusRank = new Map(ctx.campuses.map((c, i) => [c.id, i]));
  const roomOf = (d) => (d.room_id ? s.ix.room.get(d.room_id) : null);
  const cols = [...items].sort((a, b) => (campusRank.get(a.campus_id) ?? 99) - (campusRank.get(b.campus_id) ?? 99)
    || (roomOf(a)?.sort_order ?? 999) - (roomOf(b)?.sort_order ?? 999) || (roomOf(a)?.name || '').localeCompare(roomOf(b)?.name || '')
    || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const installs = (d) => s.ix.installs?.get(d.id) || [];
  const titles = new Map();
  for (const d of cols) for (const i of installs(d)) titles.set(i.sw.id, i.sw);
  const allComputers = cols.every((d) => runsSoftware(d, typeOf(d)));

  const rows = [
    { label: 'Model', get: (d) => (typeOf(d) ? typeLabel(typeOf(d)) : null) },
    { label: 'Status', get: (d) => STATUS[d.status] || d.status },
    { label: 'Area', get: (d) => d.area },
    { label: 'Spot', get: (d) => d.location },
    { label: 'Operator position', get: (d) => (d.positions || []).join(', ') },
    { label: 'Used as', get: (d) => d.used_as },
    { label: allComputers ? 'OS' : 'Firmware / OS', get: (d) => d.firmware, mono: true },
    ...[...titles.values()].sort((a, b) => a.name.localeCompare(b.name)).map((sw) => ({
      label: sw.name, logo: logoHtml(sw.name, sw.logo, 'sm'), mono: true,
      get: (d) => { const i = installs(d).find((x) => x.software_id === sw.id); return i ? versionText(i) : null; },
    })),
    { label: 'Notes', get: (d) => d.notes },
    { label: 'Serial', get: (d) => d.serial_number, mono: true, own: true },
    { label: 'Asset #', get: (d) => assetTag(d.asset_no), mono: true, own: true },
    { label: 'IP', get: (d) => (s.ix.ipsByDev.get(d.id) || []).map((ip) => ip._addr || (ip.ip ? splitInet(ip.ip).addr : '')).filter(Boolean).join(', '), mono: true, own: true },
  ].map((r) => {
    const values = cols.map((d) => { const v = r.get(d); return v == null || String(v).trim() === '' ? '' : String(v).trim(); });
    const keys = values.map((v) => v.toLowerCase().replace(/\s+/g, ' ')); // "FOH desk" and "FOH Desk" are the same spot
    const counts = new Map();
    for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
    // The usual value: the most common one that's filled in (a blank is "not set", not a value to
    // match). With a tie between filled-in values nothing is usual, and the whole row is marked instead.
    const ranked = [...counts].filter(([k]) => k !== '').sort((a, b) => b[1] - a[1]);
    const usual = !ranked.length ? null : ranked.length === 1 || ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
    return { ...r, values, keys, differs: !r.own && counts.size > 1, usual, tie: ranked.length > 1 && usual == null };
  }).filter((r) => r.values.some(Boolean));

  let onlyDiff = false;
  const sheet = ctx.openSheet({ label: `Compare ${title}`, className: 'cmp-sheet' });
  sheet.el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.c === 'close') sheet.close();
    else if (t.dataset.c === 'diff') { onlyDiff = !onlyDiff; render(); }
    else if (t.dataset.open) { const id = t.dataset.open; sheet.close(true); openItem?.(id); }
  });
  render();

  function render() {
    const differing = rows.filter((r) => r.differs);
    const shown = onlyDiff ? differing : rows;
    const place = (d) => [ctx.campusById.get(d.campus_id)?.short_name, roomOf(d) ? roomPath(roomOf(d), s.ix.room) : null].filter(Boolean).join(' · ');
    const cell = (r, v, k) => {
      const odd = r.differs && r.usual != null && k !== '' && k !== r.usual;
      return `<td class="${odd ? 'is-odd' : ''} ${v ? '' : 'is-empty'} ${r.mono ? 'mono' : ''}">${v ? esc(v) : '—'}</td>`;
    };
    sheet.render(`
      <header class="sh-head">
        <div class="sh-top"><span class="eyebrow">Compare</span>
          <button class="icon-btn" data-c="close" aria-label="Close">${icon('close')}</button></div>
        <h2>${esc(title)}</h2>
        <p class="sh-sub">${esc([plural(cols.length, 'item'), sub].filter(Boolean).join(' · '))} · ${differing.length
          ? `<b class="cmp-count">${plural(differing.length, 'detail differs', 'details differ')}</b>` : 'Everything compared is the same'}</p>
        <div class="cmp-tools">
          <button type="button" class="switch" role="switch" data-c="diff" aria-checked="${onlyDiff}"><span class="switch-track"><i></i></span>Only what’s different</button>
          <span class="cmp-legend"><i></i>Not like the others</span>
          <span class="cmp-legend is-row"><i></i>All different</span>
        </div>
      </header>
      <div class="sh-body cmp-body">
        ${shown.length ? `<div class="cmp-wrap"><table class="cmp">
          <thead><tr><th class="cmp-corner" scope="col"><span class="vh">Detail</span></th>${cols.map((d) => `<th scope="col">
            <button class="cmp-item" data-open="${d.id}"><b>${esc(d.name)}</b><small>${esc(place(d))}</small></button></th>`).join('')}</tr></thead>
          <tbody>${shown.map((r) => `<tr class="${r.differs ? `differs ${r.tie ? 'no-usual' : ''}` : ''} ${r.own ? 'own' : ''}">
            <th scope="row"><span class="cmp-label">${r.logo || ''}<span>${esc(r.label)}</span>${r.differs ? '<i class="cmp-dot" title="Differs"></i>' : ''}</span></th>
            ${r.values.map((v, i) => cell(r, v, r.keys[i])).join('')}</tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted pad">These match on everything compared.</p>'}
      </div>`);
    $('.cmp-wrap', sheet.el)?.focus?.();
  }
}
