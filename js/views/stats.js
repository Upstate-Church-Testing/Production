// Statistics: the numbers behind Gear and Network for one location or all of them.
// Tap a bar to see those items in Gear; tap a problem to see it on the Network sheet.

import { esc, icon, $, debounce, plural } from '../util.js';
import { buildIndex } from './devices.js';
import { brandKey } from './types.js';
import { ALL, dropdownHtml, locationDropdown } from '../picker.js';

const TOP = 8; // longer lists fold the rest into "Everything else"

export function mount(el, ctx) {
  let alive = true;
  const s = {
    campus: ctx.campus, // shared with Gear and Network; All on every launch
    data: null,
    ix: null,
    error: null,
  };
  if (s.campus !== 'all' && !ctx.campusById.has(s.campus)) s.campus = 'all';

  el.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Statistics</div>
    </div>
    <div class="toolbar filter-bar stats-filters"><div class="filters">${dropdownHtml('st-loc', 'Location', 'caps')}</div></div>
    <div class="results stats-page" id="st-body"><div class="loading">${'<div class="sk"></div>'.repeat(4)}</div></div>`;

  const loc = locationDropdown(ctx, $('#st-loc', el), {
    unit: ['item', 'items'],
    get: () => s.campus,
    set: (v) => { s.campus = ctx.campus = v; draw(); },
    counts: () => {
      if (!s.data) return null;
      const counts = { [ALL]: s.data.devices.length };
      for (const c of ctx.campuses) counts[c.id] = s.data.devices.filter((d) => d.campus_id === c.id).length;
      return counts;
    },
  });

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (!t) return;
    const [kind, value] = [t.dataset.go, t.dataset.value];
    if (kind === 'location') { s.campus = ctx.campus = value; loc.update(); draw(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (kind === 'flag') { ctx.openNetworkFlag(value); return; }
    // A section, category or brand: show those items in Gear.
    ctx.openGear({ dep: kind === 'team' ? value : ALL, cat: kind === 'category' ? value : ALL, brand: kind === 'brand' ? value : ALL });
  });

  const unsubscribe = ctx.store.subscribe(debounce(() => load(), 400));
  load();
  return { unmount() { alive = false; unsubscribe(); } };

  async function load() {
    try {
      s.data = await ctx.store.networkData();
      s.ix = buildIndex(s.data);
      s.error = null;
    } catch (e) { s.error = e.message; }
    if (alive) draw();
  }

  function draw() {
    loc.update();
    const box = $('#st-body', el);
    if (s.error) { box.innerHTML = `<div class="empty"><h3>Couldn’t load the numbers</h3><p>${esc(s.error)}</p></div>`; return; }
    if (!s.data) return;

    const here = (row) => s.campus === 'all' || row.campus_id === s.campus;
    const devices = s.data.devices.filter(here);
    const typeIds = new Set(devices.map((d) => d.type_id));
    const types = s.campus === 'all' ? s.data.types : s.data.types.filter((t) => typeIds.has(t.id));
    const typeOf = (d) => s.ix.type.get(d.type_id);
    const brands = new Set(types.map((t) => brandKey(t.manufacturer)).filter(Boolean));
    const categories = new Set(types.map((t) => t.category).filter(Boolean));
    const noPhoto = types.filter((t) => !t.photo_path).length;
    const rooms = new Set(devices.map((d) => d.room_id).filter(Boolean)).size;
    const locations = new Set(devices.map((d) => d.campus_id)).size;

    const ips = s.data.ips.filter((i) => here(i) && i._addr);
    const networks = s.data.networks.filter(here);
    const onSheet = devices.filter((d) => (s.ix.ipsByDev.get(d.id) || []).length || typeOf(d)?.networked !== false);
    const noIp = onSheet.filter((d) => !(s.ix.ipsByDev.get(d.id) || []).some((i) => i._addr)).length;
    const conflictIps = ips.filter((i) => s.ix.conflicts.has(i.id)).length;
    const offNet = devices.filter((d) => typeOf(d)?.networked === false).length;

    const tile = (label, value, sub, extra = '') => `<div class="stat ${value ? '' : 'is-zero'} ${extra}"><span class="stat-label">${label}</span><span class="stat-num">${value.toLocaleString()}</span><span class="stat-sub">${sub}</span></div>`;
    const alarm = (label, value, sub, flag, ok) => value
      ? `<button type="button" class="stat is-bad" data-go="flag" data-value="${flag}"><span class="stat-label">${icon('warn')}${label}</span><span class="stat-num">${value}</span><span class="stat-sub">${sub}</span></button>`
      : `<div class="stat is-zero"><span class="stat-label">${label}</span><span class="stat-num">0</span><span class="stat-sub">${ok}</span></div>`;

    // Breakdowns of the items here.
    const count = (keyOf) => {
      const m = new Map();
      for (const d of devices) { const k = keyOf(d); if (k != null) m.set(k, (m.get(k) || 0) + 1); }
      return m;
    };
    const brandName = new Map();
    for (const t of s.data.types) if (t.manufacturer && !brandName.has(brandKey(t.manufacturer))) brandName.set(brandKey(t.manufacturer), t.manufacturer.trim());
    const byTeam = ctx.departments.map((dep) => ({ key: dep.slug, label: dep.name, n: devices.filter((d) => d.departments.includes(dep.slug)).length, dep: dep.slug }));
    const byLocation = ctx.campuses.map((c) => ({ key: c.id, label: c.short_name, n: devices.filter((d) => d.campus_id === c.id).length })).filter((x) => x.n);
    const byCategory = [...count((d) => typeOf(d)?.category || 'Uncategorized')].map(([k, n]) => ({ key: k, label: k, n }));
    const byBrand = [...count((d) => brandKey(typeOf(d)?.manufacturer) || '__none')].map(([k, n]) => ({ key: k, label: k === '__none' ? 'No brand' : brandName.get(k) || k, n }));

    box.innerHTML = `
      <section class="st-group">
        <h2 class="st-h">Gear</h2>
        <div class="stats">
          ${tile('Models', types.length, plural(categories.size, 'category', 'categories'))}
          ${tile('Items', devices.length, s.campus === 'all' ? `at ${plural(locations, 'location')}` : `in ${plural(rooms, 'room')}`)}
          ${tile('Brands', brands.size, 'on these models')}
          ${tile('Need a photo', noPhoto, noPhoto ? 'Models without a picture' : 'Every model has one')}
          ${tile('Off the network', offNet, 'Gear with no IP')}
          ${tile('Ports listed', types.reduce((n, t) => n + (t.ports?.length || 0), 0), 'Across these models')}
        </div>
      </section>
      <section class="st-group">
        <h2 class="st-h">Network</h2>
        <div class="stats">
          ${tile('IP addresses', ips.length, `on ${plural(networks.length, 'network')}`)}
          ${tile('Networks', networks.length, s.campus === 'all' ? `at ${plural(new Set(networks.map((n) => n.campus_id)).size, 'location')}` : 'Subnets and VLANs')}
          ${alarm('Same IP twice', conflictIps, 'Tap to see them', 'conflicts', 'No duplicate IPs')}
          ${alarm('No IP yet', noIp, 'Tap to see them', 'noip', 'Every item has one')}
        </div>
      </section>
      <section class="st-group st-bars">
        ${bars('Items by section', byTeam, 'team', { colored: true, keepZero: true })}
        ${s.campus === 'all' ? bars('Items by location', byLocation, 'location') : ''}
        ${bars('Items by category', byCategory, 'category')}
        ${bars('Items by brand', byBrand, 'brand')}
      </section>`;
  }

  /** A ranked bar list. Every value is printed, so nothing hides behind a hover. */
  function bars(title, rows, kind, { colored = false, keepZero = false } = {}) {
    let list = rows.filter((r) => keepZero || r.n > 0);
    if (!colored) list.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    if (list.length > TOP + 1) {
      const rest = list.slice(TOP);
      list = [...list.slice(0, TOP), { key: null, other: true, label: 'Everything else', n: rest.reduce((n, r) => n + r.n, 0) }];
    }
    const max = Math.max(1, ...list.map((r) => r.n));
    return `<div class="bar-card">
      <h3>${esc(title)}</h3>
      ${list.length ? `<ul class="bar-list">${list.map((r) => {
        const pct = (r.n / max) * 100;
        const inner = `<span class="bar-label">${colored ? `<i class="tag" data-dep="${r.dep}">${esc(r.label[0])}</i>` : ''}${esc(r.label)}</span>
          <span class="bar-track"><span class="bar-fill ${r.other ? 'is-other' : ''}" ${colored ? `data-dep="${r.dep}"` : ''} style="width:${r.n ? Math.max(2, pct).toFixed(1) : 0}%"></span></span>
          <span class="bar-value">${r.n.toLocaleString()}</span>`;
        return `<li>${r.key != null && r.n ? `<button type="button" class="bar-row" data-go="${kind}" data-value="${esc(r.key)}" aria-label="${esc(`${r.label}: ${r.n}. ${kind === 'location' ? 'Show this location' : 'Show these items in Gear'}`)}">${inner}</button>` : `<div class="bar-row">${inner}</div>`}</li>`;
      }).join('')}</ul>` : '<p class="muted">No items here yet.</p>'}
    </div>`;
  }
}
