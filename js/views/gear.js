// Gear: models (device types: specs, ports, photo) and every item at every location.
// In the app a "model" is a device_types row and an "item" is a devices row.
// Models are grouped by category; Items is one A–Z list of every unit.

import { esc, icon, $, $$, debounce, storage, store, splitInet, plural, timeAgo, copyText } from '../util.js';
import { typeEditor, typeLabel, sortPorts, DIRECTIONS, brandKey, typeThumb } from './types.js';
import { buildIndex, ipHtml, tagDotsHtml, openDeviceSheet, STATUS } from './devices.js';
import { preparePhoto } from '../photo.js';
import { ALL, dropdownHtml, wireDropdown, locationDropdown } from '../picker.js';

const NO_BRAND = '__none';

export function mount(el, ctx) {
  let alive = true; // false once the person leaves this section
  const s = {
    q: '',
    dep: ctx.gearFilters.dep,     // Section: audio, video, lighting, network
    cat: ctx.gearFilters.cat,
    brand: ctx.gearFilters.brand,
    mode: storage('ucp.gearmode', 'types'),
    gridRooms: storage('ucp.gridrooms', false), // grid: one column per room instead of per location
    campus: ctx.campus,           // shared with Network and Statistics; All on every launch
    data: null,
    ix: null,
    error: null,
  };
  if (s.campus !== 'all' && !ctx.campusById.has(s.campus)) s.campus = 'all';
  // Statistics can open Gear on one section, category or brand.
  if (ctx.pending?.filters) {
    Object.assign(s, ctx.pending.filters);
    s.mode = 'models';
    store('ucp.gearmode', 'models');
    ctx.pending = null;
  }
  const remember = () => { ctx.gearFilters = { dep: s.dep, cat: s.cat, brand: s.brand }; };
  remember();
  let openType = null; // { id, refresh } of the type panel on screen
  let openDev = null;  // { id, refresh } of the model panel on screen

  el.innerHTML = `
    <div class="page-head">
      <div class="mode-row">
        <div class="seg mode-seg" role="tablist" aria-label="Show">
          <button type="button" role="tab" data-gmode="types">Models</button>
          <button type="button" role="tab" data-gmode="models">Items</button>
          <button type="button" role="tab" data-gmode="grid">Grid</button>
        </div>
        <p class="tally" id="g-tally" aria-live="polite"></p>
        <button class="btn primary add-desktop" data-act="add">${icon('plus')}<span>Add model</span></button>
      </div>
    </div>
    <div class="toolbar filter-bar">
      <div class="search">${icon('search')}<input id="g-q" type="search" autocomplete="off" enterkeyhint="search" aria-label="Search gear"></div>
      <div class="filters">
        ${dropdownHtml('g-loc', 'Location', 'caps')}
        ${dropdownHtml('g-dep', 'Section')}
        ${dropdownHtml('g-cat', 'Category')}
        ${dropdownHtml('g-brand', 'Brand')}
      </div>
    </div>
    <div id="g-results" class="results" aria-live="polite"></div>
    <button class="fab" data-act="add" aria-label="Add model">${icon('plus')}</button>`;

  // Filters, in order: location, section, category, brand. Each narrows the next.
  const unit = () => (s.mode === 'models' ? ['item', 'items'] : ['model', 'models']);
  const loc = locationDropdown(ctx, $('#g-loc', el), {
    unit,
    get: () => s.campus,
    set: (v) => { s.campus = ctx.campus = v; draw(); },
    counts: () => {
      if (!s.data) return {};
      const models = s.mode === 'models';
      const counts = { [ALL]: models ? s.data.devices.length : s.data.types.length };
      for (const c of ctx.campuses) {
        const here = s.data.devices.filter((d) => d.campus_id === c.id);
        counts[c.id] = models ? here.length : new Set(here.map((d) => d.type_id)).size;
      }
      return counts;
    },
  });
  const depDd = wireDropdown($('#g-dep', el), {
    label: 'Section',
    unit,
    get: () => s.dep,
    set: (v) => { s.dep = v; remember(); draw(); },
    options: () => {
      const pool = s.data ? poolHere() : [];
      return [{ value: ALL, label: 'All', count: pool.length },
        ...ctx.departments.map((d) => ({ value: d.slug, label: d.name, dep: d.slug, count: pool.filter((x) => x.departments.includes(d.slug)).length }))];
    },
  });
  const catDd = wireDropdown($('#g-cat', el), {
    label: 'Category',
    unit,
    get: () => s.cat,
    set: (v) => { s.cat = v; remember(); draw(); },
    options: () => {
      const pool = s.data ? poolHere().filter((x) => inDep(x.departments)) : [];
      const m = new Map();
      for (const x of pool) { const k = catOf(typeFor(x)); m.set(k, (m.get(k) || 0) + 1); }
      const keys = [...m.keys()].sort((a, b) => (a === 'Uncategorized') - (b === 'Uncategorized') || a.localeCompare(b));
      return [{ value: ALL, label: 'All', count: pool.length }, ...keys.map((k) => ({ value: k, label: k, count: m.get(k) }))];
    },
  });
  const brandDd = wireDropdown($('#g-brand', el), {
    label: 'Brand',
    unit,
    get: () => s.brand,
    set: (v) => { s.brand = v; remember(); draw(); },
    options: () => {
      const pool = s.data ? poolHere().filter((x) => inDep(x.departments) && inCat(typeFor(x))) : [];
      const names = s.data ? brandNames() : new Map();
      const m = new Map();
      for (const x of pool) { const k = brandOf(typeFor(x)); m.set(k, (m.get(k) || 0) + 1); }
      const keys = [...m.keys()].sort((a, b) => (a === NO_BRAND) - (b === NO_BRAND) || (names.get(a) || a).localeCompare(names.get(b) || b));
      return [{ value: ALL, label: 'All', count: pool.length }, ...keys.map((k) => ({ value: k, label: k === NO_BRAND ? 'No brand' : names.get(k), count: m.get(k) }))];
    },
  });
  const q = $('#g-q', el);
  q.addEventListener('input', debounce(() => { s.q = q.value.trim().toLowerCase(); draw(); }, 120));
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-type], [data-gmode], [data-model], [data-copy]');
    if (!t) return;
    if (t.dataset.copy) { copyText(t.dataset.copy, t).then((ok) => ctx.toast(ok ? `Copied ${t.dataset.copy}` : 'Selected. Copy it from the menu.')); }
    else if (t.dataset.model) openModel(t.dataset.model);
    else if (t.dataset.gmode) { s.mode = t.dataset.gmode; store('ucp.gearmode', s.mode); draw(); }
    else if (t.dataset.type) openTypeSheet(t.dataset.type);
    else if (t.dataset.act === 'add') s.mode === 'models' ? openModel(null, true) : newType();
    else if (t.dataset.act === 'all-campuses') { s.campus = ctx.campus = ALL; loc.update(); draw(); }
    else if (t.dataset.act === 'clear') clearFilters();
    else if (t.dataset.act === 'retry') load();
    else if (t.dataset.act === 'grid-rooms') { s.gridRooms = !s.gridRooms; store('ucp.gridrooms', s.gridRooms); drawResults(); }
  });
  el.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('tr[data-type]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTypeSheet(row.dataset.type); }
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
    s.q = ''; q.value = ''; s.dep = ALL; s.cat = ALL; s.brand = ALL;
    remember();
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
  function inDep(tags) { return s.dep === ALL || tags.includes(s.dep); }
  function inCat(t) { return s.cat === ALL || catOf(t) === s.cat; }
  function inBrand(t) { return s.brand === ALL || brandOf(t) === s.brand; }
  function typeOf(d) { return s.ix.type.get(d.type_id); }
  /** What the filters choose from: models or types at this location. */
  function poolHere() { return s.mode === 'models' ? s.data.devices.filter(inCampus) : typesHere(); }
  function typeFor(x) { return s.mode === 'models' ? typeOf(x) || {} : x; }

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
    if (!inDep(t.departments) || !inCat(t) || !inBrand(t)) return false;
    if (!s.q) return true;
    return words([t.name, t.manufacturer, t.category, t.part_number, t.description, ...t.departments.map((x) => ctx.dep[x]?.name || x),
      ...(t.ports || []).map((p) => `${p.name} ${p.signal || ''}`),
      ...new Set(unitsHere(t.id).flatMap((u) => campusWords(u.campus_id)))]); // "net-x simpsonville" finds it
  }

  function modelMatches(d) {
    if (!inCampus(d)) return false;
    const t = typeOf(d);
    if (!inDep(d.departments) || !inCat(t) || !inBrand(t)) return false;
    if (!s.q) return true;
    const ips = (s.ix.ipsByDev.get(d.id) || []).map((i) => i._addr);
    return words([d.name, d.location, d.serial_number, d.firmware, d.notes, s.ix.room.get(d.room_id)?.name, ...campusWords(d.campus_id),
      t?.name, t?.manufacturer, t?.category, t?.part_number, ...d.departments.map((x) => ctx.dep[x]?.name || x), ...ips]);
  }

  // ------------------------------------------------------------ drawing --

  function draw() {
    $$('[data-gmode]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.gmode === s.mode)));
    const addLabel = s.mode === 'models' ? 'Add items' : 'Add model';
    $('.add-desktop span', el).textContent = addLabel;
    $('.fab', el).setAttribute('aria-label', addLabel);
    q.placeholder = s.mode === 'models' ? 'Search name, model, brand, location, IP' : 'Search model, brand, port, location';
    el.classList.toggle('is-grid', s.mode === 'grid');
    if (s.error) {
      drawTally(null);
      $('#g-results', el).innerHTML = `<div class="empty"><h3>Couldn’t load gear</h3><p>${esc(s.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
      return;
    }
    if (!s.data) return;
    drawFilters();
    drawResults();
  }

  /** The count up top: whatever is on screen right now. */
  function drawTally(shown, total) {
    const unit = s.mode === 'models' ? ['item', 'items'] : ['model', 'models'];
    $('#g-tally', el).innerHTML = shown == null ? ''
      : `<b>${shown}</b><span>${shown === 1 ? unit[0] : unit[1]}</span>${filtering() && total !== shown ? `<small>of ${total} · <button class="btn link" data-act="clear">Clear</button></small>` : ''}`;
  }

  /** Keeps each filter's choice valid for the ones before it, then refreshes the pills. */
  function drawFilters() {
    const valid = (dd, v) => dd === null || v === ALL || (s.data && optionValues(dd).includes(v));
    if (!valid(depDd, s.dep)) s.dep = ALL;
    if (!valid(catDd, s.cat)) s.cat = ALL;
    if (!valid(brandDd, s.brand)) s.brand = ALL;
    loc.update(); depDd.update(); catDd.update(); brandDd.update();
  }
  function optionValues(dd) {
    if (dd === depDd) return ctx.departments.map((d) => d.slug);
    const pool = poolHere().filter((x) => inDep(x.departments));
    if (dd === catDd) return pool.map((x) => catOf(typeFor(x)));
    return pool.filter((x) => inCat(typeFor(x))).map((x) => brandOf(typeFor(x)));
  }

  function filtering() { return !!(s.q || s.dep !== ALL || s.cat !== ALL || s.brand !== ALL); }

  function drawResults() {
    const box = $('#g-results', el);
    if (!s.data) return;
    if (s.mode === 'models') return drawModels(box);
    if (s.mode === 'grid') return drawGrid(box);

    const types = s.data.types;
    if (!types.length) {
      box.innerHTML = `<div class="empty">
        <h3>No models yet</h3>
        <p>A model is one product, like a Hoglet 4 or an HDMI-to-SDI converter. Add its photo, specs and ports once, then add the items you have at each location.</p>
        <div class="empty-actions"><button class="btn primary" data-act="add">${icon('plus')}Add the first model</button></div>
      </div>`;
      drawTally(0, 0);
      return;
    }
    const here = typesHere();
    const shown = here.filter(typeMatches);
    drawTally(shown.length, here.length);
    const hidden = types.length - here.length;
    const elsewhere = hidden ? `<p class="result-note">${plural(hidden, 'more model isn’t', 'more models aren’t')} at ${esc(campusName(s.campus))}. <button class="btn link" data-act="all-campuses">Show all locations</button></p>` : '';
    if (!shown.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `No model matches “${esc(s.q)}”` : 'No model matches these filters'}${s.campus !== 'all' ? ` at ${esc(campusName(s.campus))}` : ''}.</p><button class="btn" data-act="clear">Clear search and filters</button></div>${elsewhere}`;
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
    const sub = [t.category, t.ports?.length ? plural(t.ports.length, 'port') : null, t.networked === false ? 'No IP' : null].filter(Boolean).join(' · ');
    return `<li class="gear-row">
      <button class="row-hit" data-type="${t.id}" aria-label="Open ${esc(typeLabel(t))}"></button>
      ${typeThumb(ctx, t)}
      <span class="g-text">
        <span class="g-brand"><span>${t.manufacturer ? esc(t.manufacturer) : '<i>No brand</i>'}</span>${tagDots(t.departments)}</span>
        <b class="g-name">${esc(t.name)}</b>
        ${sub ? `<span class="g-sub">${esc(sub)}</span>` : ''}
      </span>
      <span class="g-count"><b>${units.length}</b><small>${units.length === 1 ? 'item' : 'items'}</small></span>
    </li>`;
  }

  // Grid: models down the side, locations across the top, item counts in the cells,
  // like the old lighting sheet. Tap a row to open that model.
  function drawGrid(box) {
    const types = typesHere().filter(typeMatches);
    const typeIds = new Set(types.map((t) => t.id));
    const items = s.data.devices.filter((d) => inCampus(d) && typeIds.has(d.type_id));
    const roomName = (id) => s.ix.room.get(id)?.name || 'No room';
    const byRoom = s.campus !== ALL || s.gridRooms;

    // Columns: one per location, or one per room (grouped under its location).
    let cols = [];
    const places = s.campus === ALL ? ctx.campuses : [ctx.campusById.get(s.campus)];
    for (const c of places) {
      if (!byRoom) { cols.push({ campus: c, room: undefined, label: c.short_name }); continue; }
      const here = items.filter((d) => d.campus_id === c.id);
      const roomIds = [...new Set(here.map((d) => d.room_id || null))];
      const ordered = s.data.rooms.filter((r) => r.campus_id === c.id && roomIds.includes(r.id))
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name)).map((r) => r.id);
      if (roomIds.includes(null)) ordered.push(null);
      if (!ordered.length) cols.push({ campus: c, room: undefined, label: s.campus === ALL ? '—' : 'Nothing here yet', empty: true });
      else for (const rid of ordered) cols.push({ campus: c, room: rid, label: roomName(rid) });
    }
    cols.forEach((col, i) => { col.first = i === 0 || cols[i - 1].campus.id !== col.campus.id; }); // where a new location starts
    const inCol = (d, col) => d.campus_id === col.campus.id && (col.room === undefined || (d.room_id || null) === col.room);

    // Counts.
    const count = new Map(); // `${typeId}|${colIndex}` -> n
    let max = 0;
    for (const d of items) {
      cols.forEach((col, i) => {
        if (!inCol(d, col)) return;
        const k = `${d.type_id}|${i}`;
        const n = (count.get(k) || 0) + 1;
        count.set(k, n);
        if (n > max) max = n;
      });
    }
    drawGridTally(items.length, types.length);

    if (!types.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>No model matches these filters${s.campus !== ALL ? ` at ${esc(campusName(s.campus))}` : ''}.</p><button class="btn" data-act="clear">Clear search and filters</button></div>`;
      return;
    }

    // Rows: grouped by category (unless one is picked), then brand, then name.
    const sorted = [...types].sort((a, b) => catOf(a).localeCompare(catOf(b)) || (a.manufacturer || '\uffff').localeCompare(b.manufacturer || '\uffff')
      || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const heat = (n) => (n ? `style="--heat:${Math.round(14 + 46 * (n / Math.max(1, max)))}%"` : '');
    const colTotals = cols.map(() => 0);
    let lastCat = null;
    const body = sorted.map((t) => {
      const cells = cols.map((col, i) => {
        const n = count.get(`${t.id}|${i}`) || 0;
        colTotals[i] += n;
        return `<td class="${n ? 'has' : ''} ${col.first ? 'first' : ''}" ${heat(n)}>${n || ''}</td>`;
      }).join('');
      const total = cols.reduce((sum, _, i) => sum + (count.get(`${t.id}|${i}`) || 0), 0);
      const group = s.cat === ALL && catOf(t) !== lastCat ? `<tr class="grid-group"><th colspan="${cols.length + 2}"><span>${esc(catOf(t))}</span></th></tr>` : '';
      lastCat = catOf(t);
      return `${group}<tr data-type="${t.id}" tabindex="0" aria-label="Open ${esc(typeLabel(t))}">
        <th class="grid-model" scope="row"><div class="gm">${typeThumb(ctx, t, 'sm')}<span class="gm-text"><small>${esc(t.manufacturer || 'No brand')}</small><b>${esc(t.name)}</b></span></div></th>
        ${cells}<td class="grid-sum ${total ? '' : 'zero'}">${total || ''}</td></tr>`;
    }).join('');

    // Header: locations, with their rooms underneath when split by room.
    const spans = [];
    for (const col of cols) {
      const last = spans[spans.length - 1];
      if (last && last.campus.id === col.campus.id) last.n += 1; else spans.push({ campus: col.campus, n: 1 });
    }
    const twoRows = byRoom && s.campus === ALL;
    const head = twoRows
      ? `<tr><th class="grid-corner" rowspan="2">Model</th>${spans.map((sp) => `<th class="grid-loc first ${sp.n > 1 ? 'wide' : ''}" colspan="${sp.n}"><span>${esc(sp.campus.short_name)}</span></th>`).join('')}<th class="grid-sum" rowspan="2">Total</th></tr>
         <tr class="grid-rooms">${cols.map((col) => `<th class="${col.first ? 'first' : ''} ${col.empty ? 'is-blank' : ''}">${esc(col.label)}</th>`).join('')}</tr>`
      : `<tr><th class="grid-corner">Model</th>${cols.map((col, i) => `<th class="grid-loc ${col.first ? 'first' : ''} ${colTotals[i] ? '' : 'is-blank'}">${esc(col.label)}</th>`).join('')}<th class="grid-sum">Total</th></tr>`;

    box.innerHTML = `
      <div class="grid-tools">
        ${s.campus === ALL ? `<button type="button" class="switch" role="switch" data-act="grid-rooms" aria-checked="${!!s.gridRooms}"><span class="switch-track"><i></i></span>Split by room</button>` : `<span class="muted">Rooms at ${esc(campusName(s.campus))}</span>`}
        <span class="grid-hint">Tap a model to see its items</span>
      </div>
      <div class="grid-wrap">
        <table class="grid ${twoRows ? 'two-rows' : ''} ${byRoom ? 'split' : ''}">
          <thead>${head}</thead>
          <tbody>${body}</tbody>
          <tfoot><tr><th class="grid-model">Total</th>${colTotals.map((n, i) => `<td class="${cols[i].first ? 'first' : ''}">${n || ''}</td>`).join('')}<td class="grid-sum">${items.length}</td></tr></tfoot>
        </table>
      </div>`;
  }

  function drawGridTally(itemCount, modelCount) {
    $('#g-tally', el).innerHTML = `<b>${itemCount}</b><span>${itemCount === 1 ? 'item' : 'items'}</span><small>in ${plural(modelCount, 'model')}${filtering() ? ` · <button class="btn link" data-act="clear">Clear</button>` : ''}</small>`;
  }

  // Items: every unit, A–Z, one after another.
  function drawModels(box) {
    const all = s.data.devices.filter(inCampus);
    if (!all.length) {
      box.innerHTML = `<div class="empty"><h3>No items ${s.campus === 'all' ? 'yet' : `at ${esc(campusName(s.campus))} yet`}</h3>
        <p>Pick a model and how many you have. Ten R3 Beams go in as one batch, and you fill in serials and IPs on each one later.</p>
        <div class="empty-actions"><button class="btn primary" data-act="add">${icon('plus')}Add items</button></div></div>`;
      drawTally(0, 0);
      return;
    }
    const models = all.filter(modelMatches);
    drawTally(models.length, all.length);
    if (!models.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `No item matches “${esc(s.q)}”` : 'No item matches these filters'}${s.campus !== 'all' ? ` at ${esc(campusName(s.campus))}` : ''}.</p><button class="btn" data-act="clear">Clear search and filters</button></div>`;
      return;
    }
    const order = ctx.campuses.map((c) => c.id);
    models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      || order.indexOf(a.campus_id) - order.indexOf(b.campus_id));
    box.innerHTML = `<section class="net"><ul class="gear-list">${models.map(modelRow).join('')}</ul></section>`;
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
    const sheet = ctx.openSheet({ label: 'New model', beforeClose: () => { api.cancel(); return false; } });
    const api = typeEditor({
      ctx, sheet, types: s.data?.types || [], defaults: { departments: s.dep !== ALL ? [s.dep] : [] },
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
        if (!fresh) { if (!editing) { sheet.close(true); ctx.toast('That model was deleted'); } return; }
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
          <div class="sh-top">${tagDots(t.departments)}<span class="eyebrow">Model</span>
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
              : '<p class="muted">No ports listed. Add them with Edit so each item can record what’s plugged in.</p>'}
          </section>
          <section class="block">
            <h3>Items <span class="count">${units.length}</span></h3>
            ${units.length ? campusOrder.map((c) => `<div class="unit-group">
                <p class="unit-campus">${esc(c.short_name)}</p>
                <ul class="unit-list">${byCampus.get(c.id).map((u) => `<li><button class="unit" data-unit="${u.id}">
                  <span><b>${esc(u.name)}</b><small>${esc([room(u), u.location].filter(Boolean).join(' · '))}</small></span>
                  <span class="mono">${esc(firstIp(u))}</span>${icon('chevron')}
                </button></li>`).join('')}</ul>
              </div>`).join('')
              : '<p class="muted">None yet. Add one for each location that has this gear.</p>'}
            <button class="btn" data-g="add-unit">${icon('plus')}Add items of this model</button>
          </section>
          ${t.manual_url ? `<a class="btn" href="${esc(t.manual_url)}" target="_blank" rel="noopener">${icon('open')}Open manual</a>` : ''}
          ${t.notes ? `<p class="notes">${esc(t.notes)}</p>` : ''}
          <p class="stamp">Added by ${esc(by(t.created_by))} ${esc(timeAgo(t.created_at))}${t.updated_at !== t.created_at ? ` · edited by ${esc(by(t.updated_by))} ${esc(timeAgo(t.updated_at))}` : ''}</p>
        </div>
        <footer class="sh-foot">
          ${confirmDelete
            ? `<span class="confirm-text">Delete the ${esc(t.name)} model?</span><button class="btn" data-g="del-no">Keep it</button><button class="btn danger" data-g="del-yes">Delete</button>`
            : `${units.length ? '' : `<button class="btn ghost danger-text" data-g="del">${icon('trash')}Delete</button>`}<span class="spacer"></span><button class="btn primary" data-g="edit">${icon('edit')}Edit model</button>`}
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
