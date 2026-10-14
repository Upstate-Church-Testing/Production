// Gear: every device type, with its specs, ports and the models at each campus.

import { esc, icon, $, $$, debounce, storage, store, splitInet, plural, timeAgo } from '../util.js';
import { typeEditor, typeLabel, sortPorts, DIRECTIONS } from './types.js';

export function mount(el, ctx) {
  let alive = true; // false once the person leaves this section
  const s = { q: '', tags: new Set(storage('ucp.geartags', [])), cat: storage('ucp.gearcat', null), data: null, error: null };
  let openType = null; // { id, refresh }

  el.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Gear · device types</div>
      <div class="head-row">
        <h1 class="h1">Types</h1>
        <button class="btn primary add-desktop" data-act="add">${icon('plus')}<span>Add type</span></button>
      </div>
      <div class="stats" id="g-stats"></div>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="g-q" type="search" placeholder="Search type, maker, category, port" autocomplete="off" enterkeyhint="search" aria-label="Search types"></div>
      <div class="chips" id="g-chips"></div>
      <div class="chips cat-chips" id="g-cats"></div>
    </div>
    <div id="g-results" class="results" aria-live="polite"></div>
    <button class="fab" data-act="add" aria-label="Add type">${icon('plus')}</button>`;

  const q = $('#g-q', el);
  q.addEventListener('input', debounce(() => { s.q = q.value.trim().toLowerCase(); draw(); }, 120));
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-type], [data-tag], [data-cat]');
    if (!t) return;
    if (t.dataset.type) openTypeSheet(t.dataset.type);
    else if (t.dataset.cat !== undefined) { s.cat = t.dataset.cat === '' || t.dataset.cat === s.cat ? null : t.dataset.cat; store('ucp.gearcat', s.cat); draw(); }
    else if (t.dataset.tag) { s.tags.has(t.dataset.tag) ? s.tags.delete(t.dataset.tag) : s.tags.add(t.dataset.tag); store('ucp.geartags', [...s.tags]); draw(); }
    else if (t.dataset.act === 'add') newType();
    else if (t.dataset.act === 'clear') { s.q = ''; q.value = ''; s.tags.clear(); s.cat = null; store('ucp.geartags', []); store('ucp.gearcat', null); draw(); }
    else if (t.dataset.act === 'retry') load();
  });

  const unsubscribe = ctx.store.subscribe(debounce(() => load(true), 350));
  load();
  return { unmount: () => { alive = false; unsubscribe(); } };

  async function load(quiet = false) {
    if (!alive) return;
    if (!quiet) $('#g-results', el).innerHTML = `<div class="loading">${'<div class="sk"></div>'.repeat(5)}</div>`;
    try {
      s.data = await ctx.store.networkData();
      if (!alive) return;
      s.data.types.forEach((t) => { t.ports = sortPorts(t.ports); });
      s.error = null;
    } catch (e) { s.error = e.message; }
    draw();
    openType?.refresh();
    if (ctx.pending?.type) { const id = ctx.pending.type; ctx.pending = null; openTypeSheet(id); }
  }

  function unitsOf(typeId) { return s.data.devices.filter((d) => d.type_id === typeId); }

  function catOf(t) { return t.category || 'Uncategorized'; }
  function inTags(t) { return !s.tags.size || t.departments.some((x) => s.tags.has(x)); }
  function matches(t) {
    if (!inTags(t)) return false;
    if (s.cat && catOf(t) !== s.cat) return false;
    if (!s.q) return true;
    const hay = [t.name, t.manufacturer, t.category, t.part_number, t.description, ...t.departments.map((x) => ctx.dep[x]?.name || x),
      ...(t.ports || []).map((p) => `${p.name} ${p.signal || ''}`)]
      .filter(Boolean).join(' ').toLowerCase();
    return s.q.split(/\s+/).every((w) => hay.includes(w));
  }

  function draw() {
    const box = $('#g-results', el);
    if (s.error) {
      box.innerHTML = `<div class="empty"><h3>Couldn’t load gear</h3><p>${esc(s.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
      return;
    }
    if (!s.data) return;
    const types = s.data.types;
    const covered = new Set(s.data.devices.map((d) => d.campus_id)).size;
    const portCount = types.reduce((n, t) => n + (t.ports?.length || 0), 0);
    $('#g-stats', el).innerHTML = `
      <div class="stat"><span class="stat-label">Types</span><span class="stat-num">${types.length}</span><span class="stat-sub">${plural(new Set(types.map((t) => t.category).filter(Boolean)).size, 'category', 'categories')}</span></div>
      <div class="stat"><span class="stat-label">Models</span><span class="stat-num">${s.data.devices.length}</span><span class="stat-sub">across ${plural(covered, 'campus', 'campuses')}</span></div>
      <div class="stat"><span class="stat-label">Ports mapped</span><span class="stat-num">${portCount}</span><span class="stat-sub">on all types</span></div>
      <div class="stat ${types.filter((t) => !unitsOf(t.id).length).length ? '' : 'is-zero'}"><span class="stat-label">Unused types</span><span class="stat-num">${types.filter((t) => !unitsOf(t.id).length).length}</span><span class="stat-sub">No models yet</span></div>`;
    $('#g-chips', el).innerHTML = types.length ? ctx.departments.map((d) => `<button type="button" class="chip dep" data-tag="${d.slug}" data-dep="${d.slug}" aria-pressed="${s.tags.has(d.slug)}"><i class="dot"></i>${esc(d.name)}<small>${types.filter((t) => t.departments.includes(d.slug)).length}</small></button>`).join('') : '';

    // Category chips: the categories within the chosen tags, so Lighting → Fixture or Console.
    const cats = new Map();
    for (const t of types.filter(inTags)) cats.set(catOf(t), (cats.get(catOf(t)) || 0) + 1);
    if (s.cat && !cats.has(s.cat)) s.cat = null;
    const catKeys = [...cats.keys()].sort((a, b) => (a === 'Uncategorized') - (b === 'Uncategorized') || a.localeCompare(b));
    $('#g-cats', el).innerHTML = cats.size > 1 ? `<button type="button" class="chip" data-cat="" aria-pressed="${!s.cat}">All categories</button>${catKeys.map((k) => `<button type="button" class="chip" data-cat="${esc(k)}" aria-pressed="${s.cat === k}">${esc(k)}<small>${cats.get(k)}</small></button>`).join('')}` : '';

    if (!types.length) {
      box.innerHTML = `<div class="empty">
        <h3>No types yet</h3>
        <p>A type is one product, like a Hoglet 4 or an HDMI-to-SDI converter. Add its specs and ports once, then add a model of it at each campus where you have one.</p>
        <div class="empty-actions"><button class="btn primary" data-act="add">${icon('plus')}Add the first type</button></div>
      </div>`;
      return;
    }
    const shown = types.filter(matches);
    if (!shown.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `No type matches “${esc(s.q)}”.` : 'No type matches these filters.'}</p><button class="btn" data-act="clear">Clear search and filters</button></div>`;
      return;
    }
    const groups = new Map();
    for (const t of shown) {
      const k = t.category || 'Uncategorized';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === 'Uncategorized') - (b === 'Uncategorized') || a.localeCompare(b));
    box.innerHTML = keys.map((k) => `<section class="net">
      <header class="net-head"><div class="net-title"><h3>${esc(k)}</h3><span class="count">${groups.get(k).length}</span></div></header>
      <ul class="rows">${groups.get(k).sort((a, b) => typeLabel(a).localeCompare(typeLabel(b))).map(typeRow).join('')}</ul>
    </section>`).join('');
  }

  function typeRow(t) {
    const units = unitsOf(t.id);
    const campuses = new Set(units.map((u) => u.campus_id)).size;
    return `<li class="row type-row">
      <button class="row-hit" data-type="${t.id}" aria-label="Open ${esc(typeLabel(t))}"></button>
      ${tagDots(t.departments)}
      <span class="r-name"><b>${esc(t.name)}</b></span>
      <span class="r-sub"><span class="r-model">${esc([t.manufacturer, t.part_number].filter(Boolean).join(' · '))}</span><span class="r-where">${[t.ports?.length ? plural(t.ports.length, 'port') : null, t.networked === false ? 'no IP' : null].filter(Boolean).join(' · ')}</span></span>
      <span class="r-count"><b>${units.length}</b><small>${units.length === 1 ? 'model' : 'models'}${campuses ? ` · ${plural(campuses, 'campus', 'campuses')}` : ''}</small></span>
    </li>`;
  }

  function tagDots(tags = []) {
    return `<span class="tags">${tags.map((t) => `<i class="tag" data-dep="${t}" title="${esc(ctx.dep[t]?.name || t)}">${esc((ctx.dep[t]?.name || t)[0])}</i>`).join('')}</span>`;
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
      if (b.dataset.unit) { sheet.close(true); openType = null; ctx.openDevice(b.dataset.unit); return; }
      const a = b.dataset.g;
      if (a === 'close') sheet.close();
      else if (a === 'edit') {
        editing = typeEditor({
          ctx, sheet, type: t, types: s.data.types,
          onDone: async () => { editing = null; await load(true); render(); },
          onCancel: () => { editing = null; render(); },
        });
      } else if (a === 'add-unit') { sheet.close(true); openType = null; ctx.newDevice({ type_id: t.id }); }
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
