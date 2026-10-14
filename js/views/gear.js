// Gear: device types (specs, ports) and every model at every campus.
// Types view lists the catalog; Models view stacks each type's models.

import { esc, icon, $, $$, debounce, storage, store, splitInet, plural, timeAgo, copyText } from '../util.js';
import { typeEditor, typeLabel, sortPorts, DIRECTIONS } from './types.js';
import { buildIndex, ipHtml, tagDotsHtml, openDeviceSheet, STATUS } from './devices.js';

const expanded = new Set(); // stacks opened in the Models view (kept while the app is open)

export function mount(el, ctx) {
  let alive = true; // false once the person leaves this section
  const s = {
    q: '',
    tags: new Set(storage('ucp.geartags', [])),
    cat: storage('ucp.gearcat', null),
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
      <div class="chips cat-chips" id="g-cats"></div>
    </div>
    <div id="g-results" class="results" aria-live="polite"></div>
    <button class="fab" data-act="add" aria-label="Add type">${icon('plus')}</button>`;

  const campusSel = $('#g-campus', el);
  campusSel.value = s.campus;
  campusSel.addEventListener('change', () => { s.campus = campusSel.value; store('ucp.campus', s.campus); draw(); });
  const q = $('#g-q', el);
  q.addEventListener('input', debounce(() => { s.q = q.value.trim().toLowerCase(); draw(); }, 120));
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-type], [data-tag], [data-cat], [data-gmode], [data-stack], [data-model], [data-copy], [data-addof]');
    if (!t) return;
    if (t.dataset.copy) { copyText(t.dataset.copy, t).then((ok) => ctx.toast(ok ? `Copied ${t.dataset.copy}` : 'Selected. Copy it from the menu.')); }
    else if (t.dataset.model) openModel(t.dataset.model);
    else if (t.dataset.addof) openModel(null, true, { type_id: t.dataset.addof });
    else if (t.dataset.stack) { expanded.has(t.dataset.stack) ? expanded.delete(t.dataset.stack) : expanded.add(t.dataset.stack); drawResults(); }
    else if (t.dataset.gmode) { s.mode = t.dataset.gmode; store('ucp.gearmode', s.mode); draw(); }
    else if (t.dataset.type) openTypeSheet(t.dataset.type);
    else if (t.dataset.cat !== undefined) { s.cat = t.dataset.cat === '' || t.dataset.cat === s.cat ? null : t.dataset.cat; store('ucp.gearcat', s.cat); draw(); }
    else if (t.dataset.tag) { s.tags.has(t.dataset.tag) ? s.tags.delete(t.dataset.tag) : s.tags.add(t.dataset.tag); store('ucp.geartags', [...s.tags]); draw(); }
    else if (t.dataset.act === 'add') s.mode === 'models' ? openModel(null, true) : newType();
    else if (t.dataset.act === 'all-campuses') { s.campus = 'all'; campusSel.value = 'all'; store('ucp.campus', 'all'); draw(); }
    else if (t.dataset.act === 'clear') { s.q = ''; q.value = ''; s.tags.clear(); s.cat = null; store('ucp.geartags', []); store('ucp.gearcat', null); draw(); }
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

  function openModel(id, editing = false, preset = {}) {
    openDeviceSheet(ctx, { s, load: (quiet) => load(quiet), setOpen: (t) => { openDev = t; } }, id, editing, preset);
  }

  function inCampus(d) { return s.campus === 'all' || d.campus_id === s.campus; }
  function campusName(id) { return ctx.campusById.get(id)?.short_name || 'Unknown campus'; }
  function campusWords(id) { const c = ctx.campusById.get(id); return c ? [c.short_name, c.name, c.code] : []; }
  function unitsOf(typeId) { return s.data.devices.filter((d) => d.type_id === typeId); }
  function unitsHere(typeId) { return s.data.devices.filter((d) => d.type_id === typeId && inCampus(d)); }
  function catOf(t) { return t.category || 'Uncategorized'; }
  function tagDots(tags = []) { return tagDotsHtml(ctx, tags); }
  function inTags(tags) { return !s.tags.size || tags.some((x) => s.tags.has(x)); }

  /** Types in play: with a campus picked, only types that have models there. */
  function typesHere() {
    return s.campus === 'all' ? s.data.types : s.data.types.filter((t) => unitsHere(t.id).length);
  }

  function typeMatches(t) {
    if (!inTags(t.departments)) return false;
    if (s.cat && catOf(t) !== s.cat) return false;
    if (!s.q) return true;
    const hay = [t.name, t.manufacturer, t.category, t.part_number, t.description, ...t.departments.map((x) => ctx.dep[x]?.name || x),
      ...(t.ports || []).map((p) => `${p.name} ${p.signal || ''}`),
      ...new Set(unitsHere(t.id).flatMap((u) => campusWords(u.campus_id)))] // "net-x simpsonville" finds it
      .filter(Boolean).join(' ').toLowerCase();
    return s.q.split(/\s+/).every((w) => hay.includes(w));
  }

  function modelMatches(d) {
    if (!inCampus(d)) return false;
    const t = s.ix.type.get(d.type_id);
    if (!inTags(d.departments)) return false;
    if (s.cat && catOf(t || {}) !== s.cat) return false;
    if (!s.q) return true;
    const ips = (s.ix.ipsByDev.get(d.id) || []).map((i) => i._addr);
    const hay = [d.name, d.location, d.serial_number, d.firmware, d.notes, s.ix.room.get(d.room_id)?.name, ...campusWords(d.campus_id),
      t?.name, t?.manufacturer, t?.category, t?.part_number, ...d.departments.map((x) => ctx.dep[x]?.name || x), ...ips]
      .filter(Boolean).join(' ').toLowerCase();
    return s.q.split(/\s+/).every((w) => hay.includes(w));
  }

  // ------------------------------------------------------------ drawing --

  function draw() {
    const c = ctx.campusById.get(s.campus);
    $('#g-campus-name', el).textContent = c ? c.short_name : 'All campuses';
    $$('[data-gmode]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.gmode === s.mode)));
    const addLabel = s.mode === 'models' ? 'Add models' : 'Add type';
    $('.add-desktop span', el).textContent = addLabel;
    $('.fab', el).setAttribute('aria-label', addLabel);
    q.placeholder = s.mode === 'models' ? 'Search name, type, campus, room, IP' : 'Search type, maker, port, campus';
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
    const ports = types.reduce((n, t) => n + (t.ports?.length || 0), 0);
    const unused = s.data.types.filter((t) => !unitsOf(t.id).length).length;
    const offNet = models.filter((d) => s.ix.type.get(d.type_id)?.networked === false).length;
    $('#g-stats', el).innerHTML = `
      <div class="stat"><span class="stat-label">Types</span><span class="stat-num">${types.length}</span><span class="stat-sub">${plural(new Set(types.map((t) => t.category).filter(Boolean)).size, 'category', 'categories')}</span></div>
      <div class="stat"><span class="stat-label">Models</span><span class="stat-num">${models.length}</span><span class="stat-sub">${s.campus === 'all' ? `across ${plural(campuses, 'campus', 'campuses')}` : `in ${plural(rooms, 'room')}`}</span></div>
      <div class="stat"><span class="stat-label">Ports mapped</span><span class="stat-num">${ports}</span><span class="stat-sub">on these types</span></div>
      ${s.campus === 'all'
        ? `<div class="stat ${unused ? '' : 'is-zero'}"><span class="stat-label">Unused types</span><span class="stat-num">${unused}</span><span class="stat-sub">No models yet</span></div>`
        : `<div class="stat ${offNet ? '' : 'is-zero'}"><span class="stat-label">Off the network</span><span class="stat-num">${offNet}</span><span class="stat-sub">Fixtures and other no-IP gear</span></div>`}`;
  }

  function drawFilters() {
    const pool = s.mode === 'models' ? s.data.devices.filter(inCampus) : typesHere();
    const tagsOf = (x) => x.departments;
    $('#g-chips', el).innerHTML = pool.length ? ctx.departments.map((d) => `<button type="button" class="chip dep" data-tag="${d.slug}" data-dep="${d.slug}" aria-pressed="${s.tags.has(d.slug)}"><i class="dot"></i>${esc(d.name)}<small>${pool.filter((x) => tagsOf(x).includes(d.slug)).length}</small></button>`).join('') : '';
    // Category chips: the categories within the chosen tags, so Lighting → Fixture or Console.
    const cats = new Map();
    for (const x of pool) {
      if (!inTags(tagsOf(x))) continue;
      const k = catOf(s.mode === 'models' ? s.ix.type.get(x.type_id) || {} : x);
      cats.set(k, (cats.get(k) || 0) + 1);
    }
    if (s.cat && !cats.has(s.cat)) s.cat = null;
    const keys = [...cats.keys()].sort((a, b) => (a === 'Uncategorized') - (b === 'Uncategorized') || a.localeCompare(b));
    $('#g-cats', el).innerHTML = cats.size > 1 ? `<button type="button" class="chip" data-cat="" aria-pressed="${!s.cat}">All categories</button>${keys.map((k) => `<button type="button" class="chip" data-cat="${esc(k)}" aria-pressed="${s.cat === k}">${esc(k)}<small>${cats.get(k)}</small></button>`).join('')}` : '';
  }

  function drawResults() {
    const box = $('#g-results', el);
    if (!s.data) return;
    if (s.mode === 'models') return drawModels(box);

    const types = s.data.types;
    if (!types.length) {
      box.innerHTML = `<div class="empty">
        <h3>No types yet</h3>
        <p>A type is one product, like a Hoglet 4 or an HDMI-to-SDI converter. Add its specs and ports once, then add its models at each campus.</p>
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
    box.innerHTML = keys.map((k) => `<section class="net">
      <header class="net-head"><div class="net-title"><h3>${esc(k)}</h3><span class="count">${groups.get(k).length}</span></div></header>
      <ul class="rows">${groups.get(k).sort((a, b) => typeLabel(a).localeCompare(typeLabel(b))).map(typeRow).join('')}</ul>
    </section>`).join('') + elsewhere;
  }

  function typeRow(t) {
    const units = unitsHere(t.id);
    const campuses = new Set(units.map((u) => u.campus_id)).size;
    return `<li class="row type-row">
      <button class="row-hit" data-type="${t.id}" aria-label="Open ${esc(typeLabel(t))}"></button>
      ${tagDots(t.departments)}
      <span class="r-name"><b>${esc(t.name)}</b></span>
      <span class="r-sub"><span class="r-model">${esc([t.manufacturer, t.part_number].filter(Boolean).join(' · '))}</span><span class="r-where">${[t.ports?.length ? plural(t.ports.length, 'port') : null, t.networked === false ? 'no IP' : null].filter(Boolean).join(' · ')}</span></span>
      <span class="r-count"><b>${units.length}</b><small>${units.length === 1 ? 'model' : 'models'}${s.campus === 'all' && campuses ? ` · ${plural(campuses, 'campus', 'campuses')}` : ''}</small></span>
    </li>`;
  }

  // Models view: one stack per type; tap a stack to open it. Searching opens them.
  function drawModels(box) {
    const models = s.data.devices.filter(modelMatches);
    const all = s.data.devices.filter(inCampus);
    if (!all.length) {
      box.innerHTML = `<div class="empty"><h3>No models ${s.campus === 'all' ? 'yet' : `at ${esc(campusName(s.campus))} yet`}</h3>
        <p>Pick a type and how many you have. Ten R3 Beams go in as one batch, and you fill in serials and IPs on each one later.</p>
        <div class="empty-actions"><button class="btn primary" data-act="add">${icon('plus')}Add models</button></div></div>`;
      return;
    }
    if (!models.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `No model matches “${esc(s.q)}”` : 'No model matches these filters'}${s.campus !== 'all' ? ` at ${esc(campusName(s.campus))}` : ''}.</p><button class="btn" data-act="clear">Clear search and filters</button></div>`;
      return;
    }
    const byType = new Map();
    for (const d of models) {
      if (!byType.has(d.type_id)) byType.set(d.type_id, []);
      byType.get(d.type_id).push(d);
    }
    const order = ctx.campuses.map((c) => c.id);
    const stacks = [...byType.entries()]
      .map(([tid, list]) => ({ t: s.ix.type.get(tid) || { id: tid, name: 'Unknown type', departments: [] }, list }))
      .sort((a, b) => catOf(a.t).localeCompare(catOf(b.t)) || typeLabel(a.t).localeCompare(typeLabel(b.t)));
    box.innerHTML = `${s.q || s.tags.size || s.cat ? `<p class="result-note">${plural(models.length, 'model')} in ${plural(stacks.length, 'stack')}. <button class="btn link" data-act="clear">Clear</button></p>` : ''}
      ${stacks.map(({ t, list }) => {
        list.sort((a, b) => order.indexOf(a.campus_id) - order.indexOf(b.campus_id) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        const fixed = !!s.q || list.length === 1 || stacks.length === 1; // always open: nothing to fold
        const open = fixed || expanded.has(t.id);
        const campuses = new Set(list.map((d) => d.campus_id)).size;
        const head = `${tagDots(t.departments)}
              <span class="stack-title"><b>${esc(t.name)}</b><small>${esc([t.manufacturer, t.category !== t.name ? t.category : null].filter(Boolean).join(' · '))}</small></span>
              <span class="r-count"><b>${list.length}</b><small>${list.length === 1 ? 'model' : 'models'}${s.campus === 'all' ? ` · ${plural(campuses, 'campus', 'campuses')}` : ''}</small></span>`;
        return `<section class="stack ${list.length > 2 ? 'is-many' : list.length > 1 ? 'is-two' : ''} ${open ? 'is-open' : ''}" data-stack-id="${t.id}">
          <div class="stack-card">
            ${fixed ? `<div class="stack-head">${head}</div>`
              : `<button class="stack-head" data-stack="${t.id}" aria-expanded="${open}" aria-label="${open ? 'Fold' : 'Show'} ${plural(list.length, `${t.name} model`)}">${head}${icon('down', 'stack-caret')}</button>`}
            ${open ? `<ul class="rows">${list.map(modelRow).join('')}</ul>
              <div class="stack-foot">
                <button class="btn link" data-type="${t.id}">Type details</button>
                <button class="btn link" data-addof="${t.id}">${icon('plus')}Add more</button>
              </div>`
              : `<p class="stack-peek">${list.slice(0, 3).map((d) => esc(d.name)).join('<i>·</i>')}${list.length > 3 ? `<i>·</i>+${list.length - 3} more` : ''}</p>`}
          </div>
        </section>`;
      }).join('')}`;
  }

  function modelRow(d) {
    const ip = (s.ix.ipsByDev.get(d.id) || []).find((i) => i._addr);
    const where = [s.campus === 'all' ? campusName(d.campus_id) : null, s.ix.room.get(d.room_id)?.name, d.location].filter(Boolean).join(' · ');
    return `<li class="row model-row">
      <button class="row-hit" data-model="${d.id}" aria-label="Open ${esc(d.name)}"></button>
      ${tagDots(d.departments)}
      <span class="r-name"><b>${esc(d.name)}</b>${d.status !== 'active' ? `<span class="pill">${STATUS[d.status]}</span>` : ''}</span>
      <span class="r-sub"><span class="r-model">${esc(where)}</span><span class="r-where">${d.serial_number ? esc(`SN ${d.serial_number}`) : ''}</span></span>
      ${ip ? `<button class="r-ip mono" data-copy="${esc(ip._addr)}" aria-label="Copy ${esc(ip._addr)}">${ipHtml(ip._addr)}</button>` : '<span class="r-ip none"></span>'}
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
        if (!editing) render();
      },
    };

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
          <h2>${esc(t.name)}</h2>
          <p class="sh-sub">${esc([t.manufacturer, t.category, t.part_number].filter(Boolean).join(' · ') || 'No maker or category yet')}</p>
        </header>
        <div class="sh-body">
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
    }

    sheet.el.addEventListener('click', async (e) => {
      if (editing) return;
      const b = e.target.closest('[data-g], [data-unit]');
      if (!b) return;
      if (b.dataset.unit) { sheet.close(true); openType = null; openModel(b.dataset.unit); return; }
      const a = b.dataset.g;
      if (a === 'close') sheet.close();
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
