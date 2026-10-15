// Gear: device types (specs, ports, photo) and every model at every campus.
// Types are grouped by category; Models is one A–Z list of every unit.

import { esc, icon, $, $$, debounce, storage, store, splitInet, plural, timeAgo, copyText } from '../util.js';
import { typeEditor, typeLabel, sortPorts, DIRECTIONS, brandKey, typeThumb } from './types.js';
import { buildIndex, ipHtml, tagDotsHtml, openDeviceSheet, STATUS } from './devices.js';
import { preparePhoto } from '../photo.js';

const NO_BRAND = '__none';

export function mount(el, ctx) {
  let alive = true; // false once the person leaves this section
  const s = {
    q: '',
    tags: new Set(storage('ucp.geartags', [])),
    cat: storage('ucp.gearcat', null),
    brand: storage('ucp.gearbrand', null),
    mode: storage('ucp.gearmode', 'types'),
    campus: storage('ucp.campus', ctx.me.home_campus_id || 'all'), // shared with Network
    data: null,
    ix: null,
    error: null,
  };
  if (s.campus !== 'all' && !ctx.campusById.has(s.campus)) s.campus = 'all';
  let openType = null; // { id, refresh } of the type panel on screen
  let openDev = null;  // { id, refresh } of the model panel on screen

  el.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Gear</div>
      <div class="head-row">
        <label class="campus-pick">
          <span class="campus-name" id="g-campus-name"></span>${icon('down', 'campus-caret')}
          <select id="g-campus" aria-label="Campus">
            <option value="all">All campuses</option>
            ${ctx.campuses.map((c) => `<option value="${c.id}">${esc(c.short_name)}</option>`).join('')}
          </select>
        </label>
        <button class="btn primary add-desktop" data-act="add">${icon('plus')}<span>Add type</span></button>
      </div>
      <div class="stats" id="g-stats"></div>
      <div class="seg mode-seg" role="tablist" aria-label="Show">
        <button type="button" role="tab" data-gmode="types">Types</button>
        <button type="button" role="tab" data-gmode="models">Models</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="g-q" type="search" autocomplete="off" enterkeyhint="search" aria-label="Search gear"></div>
      <div class="chips" id="g-chips"></div>
      <div class="chips scroll-chips" id="g-cats" aria-label="Categories"></div>
      <div class="chips scroll-chips" id="g-brands" aria-label="Brands"></div>
    </div>
    <div id="g-results" class="results" aria-live="polite"></div>
    <button class="fab" data-act="add" aria-label="Add type">${icon('plus')}</button>`;

  const campusSel = $('#g-campus', el);
  campusSel.value = s.campus;
  campusSel.addEventListener('change', () => { s.campus = campusSel.value; store('ucp.campus', s.campus); draw(); });
  const q = $('#g-q', el);
  q.addEventListener('input', debounce(() => { s.q = q.value.trim().toLowerCase(); draw(); }, 120));
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-type], [data-tag], [data-cat], [data-brand], [data-gmode], [data-model], [data-copy]');
    if (!t) return;
    if (t.dataset.copy) { copyText(t.dataset.copy, t).then((ok) => ctx.toast(ok ? `Copied ${t.dataset.copy}` : 'Selected. Copy it from the menu.')); }
    else if (t.dataset.model) openModel(t.dataset.model);
    else if (t.dataset.gmode) { s.mode = t.dataset.gmode; store('ucp.gearmode', s.mode); draw(); }
    else if (t.dataset.type) openTypeSheet(t.dataset.type);
    else if (t.dataset.cat !== undefined) { s.cat = t.dataset.cat === '' || t.dataset.cat === s.cat ? null : t.dataset.cat; store('ucp.gearcat', s.cat); draw(); }
    else if (t.dataset.brand !== undefined) { s.brand = t.dataset.brand === '' || t.dataset.brand === s.brand ? null : t.dataset.brand; store('ucp.gearbrand', s.brand); draw(); }
    else if (t.dataset.tag) { s.tags.has(t.dataset.tag) ? s.tags.delete(t.dataset.tag) : s.tags.add(t.dataset.tag); store('ucp.geartags', [...s.tags]); draw(); }
    else if (t.dataset.act === 'add') s.mode === 'models' ? openModel(null, true) : newType();
    else if (t.dataset.act === 'all-campuses') { s.campus = 'all'; campusSel.value = 'all'; store('ucp.campus', 'all'); draw(); }
    else if (t.dataset.act === 'clear') clearFilters();
    else if (t.dataset.act === 'retry') load();
  });

  const unsubscribe = ctx.store.subscribe(debounce(() => load(true), 350));
  load();
  return { unmount: () => { alive = false; unsubscribe(); } };

  // ------------------------------------------------------------- data ---

  async function load(quiet = false) {
    if (!alive) return;
    if (!quiet) $('#g-results', el).innerHTML = `<div class="loading">${'<div class="sk"></div>'.repeat(5)}</div>`;
    try {
      s.data = await ctx.store.networkData();
      if (!alive) return;
      s.data.types.forEach((t) => { t.ports = sortPorts(t.ports); });
      s.ix = buildIndex(s.data);
      s.error = null;
    } catch (e) { s.error = e.message; }
    draw();
    openType?.refresh();
    openDev?.refresh();
    if (ctx.pending?.type) { const id = ctx.pending.type; ctx.pending = null; openTypeSheet(id); }
  }

  function clearFilters() {
    s.q = ''; q.value = ''; s.tags.clear(); s.cat = null; s.brand = null;
    store('ucp.geartags', []); store('ucp.gearcat', null); store('ucp.gearbrand', null);
    draw();
  }

  function openModel(id, editing = false, preset = {}) {
    openDeviceSheet(ctx, { s, load: (quiet) => load(quiet), setOpen: (t) => { openDev = t; } }, id, editing, preset);
  }

  function inCampus(d) { return s.campus === 'all' || d.campus_id === s.campus; }
  function campusName(id) { return ctx.campusById.get(id)?.short_name || 'Unknown campus'; }
  function campusWords(id) { const c = ctx.campusById.get(id); return c ? [c.short_name, c.name, c.code] : []; }
  function unitsOf(typeId) { return s.data.devices.filter((d) => d.type_id === typeId); }
  function unitsHere(typeId) { return s.data.devices.filter((d) => d.type_id === typeId && inCampus(d)); }
  function catOf(t) { return t?.category || 'Uncategorized'; }
  function brandOf(t) { return brandKey(t?.manufacturer) || NO_BRAND; }
  function tagDots(tags = []) { return tagDotsHtml(ctx, tags); }
  function inTags(tags) { return !s.tags.size || tags.some((x) => s.tags.has(x)); }
  function typeOf(d) { return s.ix.type.get(d.type_id); }

  /** Types in play: with a campus picked, only types that have models there. */
  function typesHere() {
    return s.campus === 'all' ? s.data.types : s.data.types.filter((t) => unitsHere(t.id).length);
  }

  /** How each brand is written most often ("ETC", not "etc"). */
  function brandNames() {
    const seen = new Map();
    for (const t of s.data.types) {
      if (!t.manufacturer) continue;
      const k = brandKey(t.manufacturer);
      const m = seen.get(k) || new Map();
      m.set(t.manufacturer.trim(), (m.get(t.manufacturer.trim()) || 0) + 1);
      seen.set(k, m);
    }
    return new Map([...seen].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  }

  function words(hay) {
    const text = hay.filter(Boolean).join(' ').toLowerCase();
    return s.q.split(/\s+/).every((w) => text.includes(w));
  }

  function typeMatches(t) {
    if (!inTags(t.departments)) return false;
    if (s.cat && catOf(t) !== s.cat) return false;
    if (s.brand && brandOf(t) !== s.brand) return false;
    if (!s.q) return true;
    return words([t.name, t.manufacturer, t.category, t.part_number, t.description, ...t.departments.map((x) => ctx.dep[x]?.name || x),
      ...(t.ports || []).map((p) => `${p.name} ${p.signal || ''}`),
      ...new Set(unitsHere(t.id).flatMap((u) => campusWords(u.campus_id)))]); // "net-x simpsonville" finds it
  }

  function modelMatches(d) {
    if (!inCampus(d)) return false;
    const t = typeOf(d);
    if (!inTags(d.departments)) return false;
    if (s.cat && catOf(t) !== s.cat) return false;
    if (s.brand && brandOf(t) !== s.brand) return false;
    if (!s.q) return true;
    const ips = (s.ix.ipsByDev.get(d.id) || []).map((i) => i._addr);
    return words([d.name, d.location, d.serial_number, d.firmware, d.notes, s.ix.room.get(d.room_id)?.name, ...campusWords(d.campus_id),
      t?.name, t?.manufacturer, t?.category, t?.part_number, ...d.departments.map((x) => ctx.dep[x]?.name || x), ...ips]);
  }

  // ------------------------------------------------------------ drawing --

  function draw() {
    const c = ctx.campusById.get(s.campus);
    $('#g-campus-name', el).textContent = c ? c.short_name : 'All campuses';
    $$('[data-gmode]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.gmode === s.mode)));
    const addLabel = s.mode === 'models' ? 'Add models' : 'Add type';
    $('.add-desktop span', el).textContent = addLabel;
    $('.fab', el).setAttribute('aria-label', addLabel);
    q.placeholder = s.mode === 'models' ? 'Search name, brand, campus, room, IP' : 'Search type, brand, port, campus';
    if (s.error) {
      $('#g-results', el).innerHTML = `<div class="empty"><h3>Couldn’t load gear</h3><p>${esc(s.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
      return;
    }
    if (!s.data) return;
    drawStats();
    drawFilters();
    drawResults();
  }

  function drawStats() {
    const types = typesHere();
    const models = s.data.devices.filter(inCampus);
    const rooms = new Set(models.map((d) => d.room_id).filter(Boolean)).size;
    const campuses = new Set(models.map((d) => d.campus_id)).size;
    const brands = new Set(types.map((t) => brandKey(t.manufacturer)).filter(Boolean)).size;
    const noPhoto = types.filter((t) => !t.photo_path).length;
    $('#g-stats', el).innerHTML = `
      <div class="stat"><span class="stat-label">Types</span><span class="stat-num">${types.length}</span><span class="stat-sub">${plural(new Set(types.map((t) => t.category).filter(Boolean)).size, 'category', 'categories')}</span></div>
      <div class="stat"><span class="stat-label">Models</span><span class="stat-num">${models.length}</span><span class="stat-sub">${s.campus === 'all' ? `across ${plural(campuses, 'campus', 'campuses')}` : `in ${plural(rooms, 'room')}`}</span></div>
      <div class="stat"><span class="stat-label">Brands</span><span class="stat-num">${brands}</span><span class="stat-sub">on these types</span></div>
      <div class="stat ${noPhoto ? '' : 'is-zero'}"><span class="stat-label">Need a photo</span><span class="stat-num">${noPhoto}</span><span class="stat-sub">${noPhoto ? 'Types without a picture' : 'Every type has one'}</span></div>`;
  }

  function drawFilters() {
    const models = s.mode === 'models';
    const pool = models ? s.data.devices.filter(inCampus) : typesHere();
    const typeFor = (x) => (models ? typeOf(x) || {} : x);
    $('#g-chips', el).innerHTML = pool.length ? ctx.departments.map((d) => `<button type="button" class="chip dep" data-tag="${d.slug}" data-dep="${d.slug}" aria-pressed="${s.tags.has(d.slug)}"><i class="dot"></i>${esc(d.name)}<small>${pool.filter((x) => x.departments.includes(d.slug)).length}</small></button>`).join('') : '';

    // Category chips: the categories within the chosen tags, so Lighting → Fixture or Console.
    const cats = new Map();
    for (const x of pool) {
      if (!inTags(x.departments)) continue;
      const k = catOf(typeFor(x));
      cats.set(k, (cats.get(k) || 0) + 1);
    }
    if (s.cat && !cats.has(s.cat)) s.cat = null;
    const catKeys = [...cats.keys()].sort((a, b) => (a === 'Uncategorized') - (b === 'Uncategorized') || a.localeCompare(b));
    $('#g-cats', el).innerHTML = cats.size > 1
      ? `<span class="chip-label">Category</span><button type="button" class="chip" data-cat="" aria-pressed="${!s.cat}">All</button>${catKeys.map((k) => `<button type="button" class="chip" data-cat="${esc(k)}" aria-pressed="${s.cat === k}">${esc(k)}<small>${cats.get(k)}</small></button>`).join('')}`
      : '';

    // Brand chips: the brands within the chosen tags and category.
    const names = brandNames();
    const brands = new Map();
    for (const x of pool) {
      const t = typeFor(x);
      if (!inTags(x.departments) || (s.cat && catOf(t) !== s.cat)) continue;
      const k = brandOf(t);
      brands.set(k, (brands.get(k) || 0) + 1);
    }
    if (s.brand && !brands.has(s.brand)) s.brand = null;
    const brandKeys = [...brands.keys()].sort((a, b) => (a === NO_BRAND) - (b === NO_BRAND) || (names.get(a) || a).localeCompare(names.get(b) || b));
    $('#g-brands', el).innerHTML = brands.size > 1
      ? `<span class="chip-label">Brand</span><button type="button" class="chip" data-brand="" aria-pressed="${!s.brand}">All</button>${brandKeys.map((k) => `<button type="button" class="chip brand-chip" data-brand="${esc(k)}" aria-pressed="${s.brand === k}">${esc(k === NO_BRAND ? 'No brand' : names.get(k))}<small>${brands.get(k)}</small></button>`).join('')}`
      : '';
  }

  function filtering() { return !!(s.q || s.tags.size || s.cat || s.brand); }

  function drawResults() {
    const box = $('#g-results', el);
    if (!s.data) return;
    if (s.mode === 'models') return drawModels(box);

    const types = s.data.types;
    if (!types.length) {
      box.innerHTML = `<div class="empty">
        <h3>No types yet</h3>
        <p>A type is one product, like a Hoglet 4 or an HDMI-to-SDI converter. Add its photo, specs and ports once, then add its models at each campus.</p>
        <div class="empty-actions"><button class="btn primary" data-act="add">${icon('plus')}Add the first type</button></div>
      </div>`;
      return;
    }
    const here = typesHere();
    const shown = here.filter(typeMatches);
    const hidden = types.length - here.length;
    const elsewhere = hidden ? `<p class="result-note">${plural(hidden, 'more type isn’t', 'more types aren’t')} at ${esc(campusName(s.campus))}. <button class="btn link" data-act="all-campuses">Show all campuses</button></p>` : '';
    if (!shown.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `No type matches “${esc(s.q)}”` : 'No type matches these filters'}${s.campus !== 'all' ? ` at ${esc(campusName(s.campus))}` : ''}.</p><button class="btn" data-act="clear">Clear search and filters</button></div>${elsewhere}`;
      return;
    }
    const groups = new Map();
    for (const t of shown) {
      const k = catOf(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === 'Uncategorized') - (b === 'Uncategorized') || a.localeCompare(b));
    const byBrandThenName = (a, b) => (a.manufacturer || '￿').localeCompare(b.manufacturer || '￿') || a.name.localeCompare(b.name, undefined, { numeric: true });
    box.innerHTML = keys.map((k) => `<section class="net">
      <header class="net-head"><div class="net-title"><h3>${esc(k)}</h3><span class="count">${groups.get(k).length}</span></div></header>
      <ul class="gear-list">${groups.get(k).sort(byBrandThenName).map(typeRow).join('')}</ul>
    </section>`).join('') + elsewhere;
  }

  function typeRow(t) {
    const units = unitsHere(t.id);
    const campuses = new Set(units.map((u) => u.campus_id)).size;
    const sub = [t.category, t.ports?.length ? plural(t.ports.length, 'port') : null, t.networked === false ? 'No IP' : null].filter(Boolean).join(' · ');
    return `<li class="gear-row">
      <button class="row-hit" data-type="${t.id}" aria-label="Open ${esc(typeLabel(t))}"></button>
      ${typeThumb(ctx, t)}
      <span class="g-text">
        <span class="g-brand"><span>${t.manufacturer ? esc(t.manufacturer) : '<i>No brand</i>'}</span>${tagDots(t.departments)}</span>
        <b class="g-name">${esc(t.name)}</b>
        ${sub ? `<span class="g-sub">${esc(sub)}</span>` : ''}
      </span>
      <span class="g-count"><b>${units.length}</b><small>${units.length === 1 ? 'model' : 'models'}${s.campus === 'all' && campuses > 1 ? ` · ${plural(campuses, 'campus', 'campuses')}` : ''}</small></span>
    </li>`;
  }

  // Models: every unit, A–Z, one after another.
  function drawModels(box) {
    const all = s.data.devices.filter(inCampus);
    if (!all.length) {
      box.innerHTML = `<div class="empty"><h3>No models ${s.campus === 'all' ? 'yet' : `at ${esc(campusName(s.campus))} yet`}</h3>
        <p>Pick a type and how many you have. Ten R3 Beams go in as one batch, and you fill in serials and IPs on each one later.</p>
        <div class="empty-actions"><button class="btn primary" data-act="add">${icon('plus')}Add models</button></div></div>`;
      return;
    }
    const models = all.filter(modelMatches);
    if (!models.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `No model matches “${esc(s.q)}”` : 'No model matches these filters'}${s.campus !== 'all' ? ` at ${esc(campusName(s.campus))}` : ''}.</p><button class="btn" data-act="clear">Clear search and filters</button></div>`;
      return;
    }
    const order = ctx.campuses.map((c) => c.id);
    models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      || order.indexOf(a.campus_id) - order.indexOf(b.campus_id));
    box.innerHTML = `${filtering() ? `<p class="result-note">${plural(models.length, 'model')} of ${all.length}. <button class="btn link" data-act="clear">Clear</button></p>` : ''}
      <section class="net"><ul class="gear-list">${models.map(modelRow).join('')}</ul></section>`;
  }

  function modelRow(d) {
    const t = typeOf(d);
    const ip = (s.ix.ipsByDev.get(d.id) || []).find((i) => i._addr);
    const where = [s.campus === 'all' ? campusName(d.campus_id) : null, s.ix.room.get(d.room_id)?.name, d.location].filter(Boolean).join(' · ');
    const sub = [t?.name, where].filter(Boolean).join(' · ');
    return `<li class="gear-row model-row ${d.status !== 'active' ? `is-${d.status}` : ''}">
      <button class="row-hit" data-model="${d.id}" aria-label="Open ${esc(d.name)}"></button>
      ${typeThumb(ctx, t)}
      <span class="g-text">
        <span class="g-brand"><span>${t?.manufacturer ? esc(t.manufacturer) : '<i>No brand</i>'}</span>${tagDots(d.departments)}</span>
        <b class="g-name">${esc(d.name)}${d.status !== 'active' ? ` <span class="pill">${STATUS[d.status]}</span>` : ''}</b>
        ${sub ? `<span class="g-sub">${esc(sub)}</span>` : ''}
      </span>
      ${ip ? `<button class="r-ip mono" data-copy="${esc(ip._addr)}" aria-label="Copy ${esc(ip._addr)}">${ipHtml(ip._addr)}</button>` : '<span></span>'}
    </li>`;
  }

  // ------------------------------------------------------- type sheet ----

  function newType() {
    const sheet = ctx.openSheet({ label: 'New type', beforeClose: () => { api.cancel(); return false; } });
    const api = typeEditor({
      ctx, sheet, types: s.data?.types || [], defaults: { departments: [...s.tags].slice(0, 1) },
      onDone: async (id) => { sheet.close(true); await load(true); openTypeSheet(id); },
      onCancel: () => sheet.close(true),
    });
  }

  function openTypeSheet(id) {
    let t = s.data?.types.find((x) => x.id === id);
    if (!t) return;
    let editing = null;
    let confirmDelete = false;
    let photoBusy = false;
    let photoConfirm = false;
    const sheet = ctx.openSheet({
      label: typeLabel(t),
      beforeClose: () => { if (editing) { editing.cancel(); return false; } openType = null; return true; },
    });
    openType = {
      id,
      refresh() {
        const fresh = s.data.types.find((x) => x.id === id);
        if (!fresh) { if (!editing) { sheet.close(true); ctx.toast('That type was deleted'); } return; }
        t = fresh;
        if (!editing && !photoBusy) render();
      },
    };

    function photoBlock() {
      const url = t.photo_path ? ctx.store.photoUrl(t.photo_path) : null;
      if (photoBusy) return `<div class="photo-hero is-busy"><span class="photo-msg">Saving photo…</span></div>`;
      if (!url) {
        return `<label class="photo-hero is-empty" for="t-photo-in">${icon('camera')}<b>Add a photo</b><small>A product shot on white looks best. You can also take one.</small></label>`;
      }
      return `<div class="photo-hero"><img src="${esc(url)}" alt="${esc(typeLabel(t))}">
        <div class="photo-actions">
          <label class="btn small" for="t-photo-in">${icon('camera')}Change</label>
          ${photoConfirm ? `<button class="btn small danger" data-g="photo-del-yes">Remove photo</button>` : `<button class="btn small icon-only" data-g="photo-del" aria-label="Remove photo">${icon('trash')}</button>`}
        </div></div>`;
    }

    function render() {
      const units = unitsOf(t.id);
      const byCampus = new Map();
      for (const u of units) { if (!byCampus.has(u.campus_id)) byCampus.set(u.campus_id, []); byCampus.get(u.campus_id).push(u); }
      for (const list of byCampus.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); // R3 Beam 2 before R3 Beam 10
      const campusOrder = ctx.campuses.filter((c) => byCampus.has(c.id));
      const firstIp = (u) => { const ip = s.data.ips.find((i) => i.device_id === u.id && i.ip); return ip ? splitInet(ip.ip).addr : ''; };
      const room = (u) => s.data.rooms.find((r) => r.id === u.room_id)?.name;
      const by = (pid) => ctx.people.get(pid)?.full_name || 'Someone';
      sheet.render(`
        <header class="sh-head">
          <div class="sh-top">${tagDots(t.departments)}<span class="eyebrow">Type</span>
            <button class="icon-btn" data-g="close" aria-label="Close">${icon('close')}</button></div>
          <p class="sh-brand">${esc(t.manufacturer || 'No brand')}</p>
          <h2>${esc(t.name)}</h2>
          <p class="sh-sub">${esc([t.category, t.part_number].filter(Boolean).join(' · ') || 'No category yet')}</p>
        </header>
        <div class="sh-body">
          ${photoBlock()}
          <input type="file" accept="image/*" id="t-photo-in" class="vh" tabindex="-1">
          ${t.description ? `<p class="lede">${esc(t.description)}</p>` : ''}
          ${t.specs?.length ? `<section class="block"><h3>Specs</h3><dl class="kv">${t.specs.map((sp) => `<div><dt>${esc(sp.label)}</dt><dd>${esc(sp.value)}</dd></div>`).join('')}</dl></section>` : ''}
          <section class="block">
            <h3>Ports <span class="count">${t.ports.length}</span></h3>
            ${t.ports.length ? `<ul class="port-list">${t.ports.map((p) => `<li><b>${esc(p.name)}</b><span>${esc([p.signal, p.connector].filter(Boolean).join(' · '))}</span>${p.direction !== 'io' ? `<i class="dir dir-${p.direction}">${esc(DIRECTIONS[p.direction])}</i>` : ''}</li>`).join('')}</ul>`
              : '<p class="muted">No ports listed. Add them with Edit so each model can record what’s plugged in.</p>'}
          </section>
          <section class="block">
            <h3>Models <span class="count">${units.length}</span></h3>
            ${units.length ? campusOrder.map((c) => `<div class="unit-group">
                <p class="unit-campus">${esc(c.short_name)}</p>
                <ul class="unit-list">${byCampus.get(c.id).map((u) => `<li><button class="unit" data-unit="${u.id}">
                  <span><b>${esc(u.name)}</b><small>${esc([room(u), u.location].filter(Boolean).join(' · '))}</small></span>
                  <span class="mono">${esc(firstIp(u))}</span>${icon('chevron')}
                </button></li>`).join('')}</ul>
              </div>`).join('')
              : '<p class="muted">None yet. Add one for each campus that has this gear.</p>'}
            <button class="btn" data-g="add-unit">${icon('plus')}Add models of this type</button>
          </section>
          ${t.manual_url ? `<a class="btn" href="${esc(t.manual_url)}" target="_blank" rel="noopener">${icon('open')}Open manual</a>` : ''}
          ${t.notes ? `<p class="notes">${esc(t.notes)}</p>` : ''}
          <p class="stamp">Added by ${esc(by(t.created_by))} ${esc(timeAgo(t.created_at))}${t.updated_at !== t.created_at ? ` · edited by ${esc(by(t.updated_by))} ${esc(timeAgo(t.updated_at))}` : ''}</p>
        </div>
        <footer class="sh-foot">
          ${confirmDelete
            ? `<span class="confirm-text">Delete the ${esc(t.name)} type?</span><button class="btn" data-g="del-no">Keep it</button><button class="btn danger" data-g="del-yes">Delete</button>`
            : `${units.length ? '' : `<button class="btn ghost danger-text" data-g="del">${icon('trash')}Delete</button>`}<span class="spacer"></span><button class="btn primary" data-g="edit">${icon('edit')}Edit type</button>`}
        </footer>`);
      $('#t-photo-in', sheet.el).addEventListener('change', (e) => setPhoto(e.target.files?.[0]));
    }

    async function setPhoto(file) {
      if (!file) return;
      photoBusy = true; photoConfirm = false; render();
      try {
        const blobs = await preparePhoto(file);
        await ctx.store.setTypePhoto(t.id, blobs, t.photo_path);
        photoBusy = false;
        await load(true);
        ctx.toast('Photo saved');
      } catch (err) {
        photoBusy = false; render();
        ctx.toast(err.message, 'bad');
      }
    }

    sheet.el.addEventListener('click', async (e) => {
      if (editing) return;
      const b = e.target.closest('[data-g], [data-unit]');
      if (!b) return;
      if (b.dataset.unit) { sheet.close(true); openType = null; openModel(b.dataset.unit); return; }
      const a = b.dataset.g;
      if (a === 'close') sheet.close();
      else if (a === 'photo-del') { photoConfirm = true; render(); }
      else if (a === 'photo-del-yes') {
        try { await ctx.store.removeTypePhoto(t.id, t.photo_path); photoConfirm = false; await load(true); ctx.toast('Photo removed'); }
        catch (err) { ctx.toast(err.message, 'bad'); }
      }
      else if (a === 'edit') {
        editing = typeEditor({
          ctx, sheet, type: t, types: s.data.types,
          onDone: async () => { editing = null; await load(true); render(); },
          onCancel: () => { editing = null; render(); },
        });
      } else if (a === 'add-unit') { sheet.close(true); openType = null; openModel(null, true, { type_id: t.id }); }
      else if (a === 'del') { confirmDelete = true; render(); }
      else if (a === 'del-no') { confirmDelete = false; render(); }
      else if (a === 'del-yes') {
        try { await ctx.store.deleteType(t.id); ctx.toast(`Deleted ${t.name}`); openType = null; sheet.close(true); load(true); }
        catch (err) { confirmDelete = false; render(); ctx.toast(err.message, 'bad'); }
      }
    });
    render();
  }
}
