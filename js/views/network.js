// Network: the IP sheet for every campus. Devices grouped by network, with
// audio / video / lighting filters, search, conflict checks and full editing.

import {
  esc, icon, $, $$, debounce, storage, store, ipToInt, intToIp, splitInet, prefixToMask, maskToPrefix,
  parseCidr, inCidr, nextFreeIp, normMac, timeAgo, plural, copyText,
} from '../util.js';
import { typeEditor, typeLabel, sortPorts, portMeta } from './types.js';
import { buildIndex, ipHtml, tagDotsHtml, openDeviceSheet as openModelSheet, STATUS, kv } from './devices.js';
import { locationPill, wireLocationPicker } from '../picker.js';

export function mount(el, ctx) {
  let alive = true; // false once the person leaves this section
  const s = {
    campus: storage('ucp.campus', ctx.me.home_campus_id || 'all'),
    mode: storage('ucp.netmode', 'devices'),
    q: '',
    tags: new Set(storage('ucp.tags', [])),
    flag: null,
    data: null,
    ix: null,
    error: null,
  };
  if (s.campus !== 'all' && !ctx.campusById.has(s.campus)) s.campus = 'all';
  let openDevice = null; // { id, refresh } of the device sheet on screen

  el.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Network · IP sheet</div>
      <div class="head-row">
        ${locationPill('n-loc')}
        <button class="btn primary add-desktop" data-act="add">${icon('plus')}<span>Add model</span></button>
      </div>
      <div class="mode-row">
        <div class="seg mode-seg" role="tablist" aria-label="Show">
          <button type="button" role="tab" data-mode="devices">Models</button>
          <button type="button" role="tab" data-mode="networks">Networks</button>
        </div>
        <p class="tally" id="n-tally" aria-live="polite"></p>
      </div>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="q" type="search" placeholder="Search name, IP, type, MAC, location" autocomplete="off" enterkeyhint="search" aria-label="Search"></div>
      <div class="chips" id="chips"></div>
    </div>
    <div id="results" class="results" aria-live="polite"></div>
    <button class="fab" data-act="add" aria-label="Add model">${icon('plus')}</button>`;

  const loc = wireLocationPicker(ctx, $('#n-loc', el), {
    get: () => s.campus,
    set: (v) => { s.campus = v; store('ucp.campus', v); draw(); },
    counts: () => {
      if (!s.data) return null;
      const nets = s.mode === 'networks';
      const counts = { all: nets ? s.data.networks.length : listedDevices().length };
      for (const c of ctx.campuses) {
        counts[c.id] = nets ? s.data.networks.filter((n) => n.campus_id === c.id).length : listedDevices().filter((d) => d.campus_id === c.id).length;
      }
      return { counts, unit: nets ? 'networks' : 'models', one: nets ? 'network' : 'model' };
    },
  });
  $$('[data-mode]', el).forEach((b) => b.addEventListener('click', () => { s.mode = b.dataset.mode; store('ucp.netmode', s.mode); draw(); }));
  const q = $('#q', el);
  q.addEventListener('input', debounce(() => { s.q = q.value.trim().toLowerCase(); drawResults(); drawChips(); }, 120));

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-open], [data-net], [data-copy], [data-tag], [data-flag]');
    if (!t) return;
    if (t.dataset.copy) {
      copyText(t.dataset.copy, t).then((ok) => ctx.toast(ok ? `Copied ${t.dataset.copy}` : 'Selected. Copy it from the menu.'));
    } else if (t.dataset.open) {
      openDeviceSheet(t.dataset.open);
    } else if (t.dataset.net) {
      openNetworkSheet(t.dataset.net === 'new' ? null : t.dataset.net, t.dataset.campus);
    } else if (t.dataset.tag) {
      s.tags.has(t.dataset.tag) ? s.tags.delete(t.dataset.tag) : s.tags.add(t.dataset.tag);
      store('ucp.tags', [...s.tags]); drawChips(); drawResults();
    } else if (t.dataset.flag) {
      s.flag = s.flag === t.dataset.flag ? null : t.dataset.flag; drawChips(); drawResults();
    } else if (t.dataset.act === 'add') {
      s.mode === 'networks' ? openNetworkSheet(null) : openDeviceSheet(null, true);
    } else if (t.dataset.act === 'clear') {
      s.q = ''; q.value = ''; s.tags.clear(); s.flag = null; store('ucp.tags', []); drawChips(); drawResults();
    } else if (t.dataset.act === 'add-net') {
      openNetworkSheet(null, t.dataset.campus);
    } else if (t.dataset.act === 'retry') {
      load();
    }
  });

  const unsubscribe = ctx.store.subscribe(debounce(() => load(true), 350));
  load();
  return { unmount: () => { alive = false; unsubscribe(); } };

  // ------------------------------------------------------------- data ---

  async function load(quiet = false) {
    if (!alive) return;
    if (!quiet) $('#results', el).innerHTML = `<div class="loading">${'<div class="sk"></div>'.repeat(6)}</div>`;
    try {
      s.data = await ctx.store.networkData();
      if (!alive) return;
      s.ix = buildIndex(s.data);
      s.error = null;
    } catch (e) {
      s.error = e.message;
    }
    draw();
    openDevice?.refresh();
    if (ctx.pending && s.data) {
      const p = ctx.pending; ctx.pending = null;
      if (p.open && s.ix.dev.has(p.open)) openDeviceSheet(p.open);
      else if (p.newDevice) openDeviceSheet(null, true, p.newDevice);
      else if (p.flag) { s.flag = p.flag; s.mode = 'devices'; store('ucp.netmode', 'devices'); draw(); }
    }
  }

  function buildIndex(d) {
    const ix = {
      dev: new Map(d.devices.map((x) => [x.id, x])),
      net: new Map(d.networks.map((x) => [x.id, x])),
      room: new Map(d.rooms.map((x) => [x.id, x])),
      type: new Map(d.types.map((x) => [x.id, { ...x, ports: sortPorts(x.ports) }])),
      ipsByDev: new Map(),
      conflicts: new Map(),
    };
    for (const ip of d.ips) {
      const { addr, prefix } = splitInet(ip.ip);
      ip._addr = addr; ip._prefix = prefix; ip._int = ipToInt(addr);
      if (!ix.ipsByDev.has(ip.device_id)) ix.ipsByDev.set(ip.device_id, []);
      ix.ipsByDev.get(ip.device_id).push(ip);
    }
    const byKey = new Map();
    for (const ip of d.ips) {
      if (ip._int == null) continue;
      const k = ip.campus_id + '|' + ip._int;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(ip);
    }
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      for (const a of list) for (const b of list) {
        if (a === b || a.device_id === b.device_id) continue;
        if (a.network_id && b.network_id && a.network_id !== b.network_id) continue;
        if (!ix.conflicts.has(a.id)) ix.conflicts.set(a.id, []);
        ix.conflicts.get(a.id).push(b);
      }
    }
    return ix;
  }

  /** Next free number for "Base N" names at a campus (R3 Beam 1, R3 Beam 2…). */
  function tagDots(tags = []) { return tagDotsHtml(ctx, tags); }
  function openDeviceSheet(id, editing = false, preset = {}) {
    openModelSheet(ctx, { s, load: (quiet) => load(quiet), setOpen: (t) => { openDevice = t; } }, id, editing, preset);
  }

  function inCampus(row) { return s.campus === 'all' || row.campus_id === s.campus; }
  function campusName(id) { return ctx.campusById.get(id)?.short_name || 'Unknown campus'; }

  /** Every model the sheet lists, at any location (fixtures with no IP aren't on it). */
  function listedDevices() {
    return s.data.devices.filter((dev) => (s.ix.ipsByDev.get(dev.id) || []).length || s.ix.type.get(dev.type_id)?.networked !== false);
  }

  /** One entry per IP, plus one for each device that has no IP yet. */
  function entries() {
    const out = [];
    for (const dev of s.data.devices) {
      if (!inCampus(dev)) continue;
      const ips = s.ix.ipsByDev.get(dev.id) || [];
      if (!ips.length && s.ix.type.get(dev.type_id)?.networked === false) continue;
      if (!ips.length) out.push({ dev, ip: null });
      else for (const ip of ips) out.push({ dev, ip });
    }
    return out;
  }

  function matches({ dev, ip }) {
    if (s.tags.size && !dev.departments.some((t) => s.tags.has(t))) return false;
    if (s.flag === 'conflicts' && !(ip && s.ix.conflicts.has(ip.id))) return false;
    if (s.flag === 'noip' && ip?._addr) return false;
    if (!s.q) return true;
    const net = ip?.network_id ? s.ix.net.get(ip.network_id) : null;
    const ty = s.ix.type.get(dev.type_id);
    const hay = [dev.name, ty?.name, ty?.manufacturer, ty?.category, ty?.part_number, dev.location, dev.serial_number, dev.firmware, dev.notes,
      s.ix.room.get(dev.room_id)?.name, ip?._addr, ip?.label, ip?.mac, ip?.hostname, net?.name,
      net?.vlan_id ? 'vlan ' + net.vlan_id : '', s.campus === 'all' ? campusName(dev.campus_id) : '']
      .filter(Boolean).join(' \u0001 ').toLowerCase();
    return s.q.split(/\s+/).every((w) => hay.includes(w));
  }

  // ------------------------------------------------------------ drawing --

  function draw() {
    loc.update();
    $$('[data-mode]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === s.mode)));
    $('.fab', el).setAttribute('aria-label', s.mode === 'networks' ? 'Add network' : 'Add model');
    $('.add-desktop span', el).textContent = s.mode === 'networks' ? 'Add network' : 'Add model';
    $('.toolbar', el).hidden = s.mode === 'networks';
    drawChips(); drawResults();
  }

  /** The count up top: whatever is on screen right now. */
  function drawTally(shown, total, unit) {
    $('#n-tally', el).innerHTML = shown == null ? ''
      : `<b>${shown}</b><span>${shown === 1 ? unit[0] : unit[1]}</span>${total != null && total !== shown ? `<small>of ${total} · <button class="btn link" data-act="clear">Clear</button></small>` : ''}`;
  }

  function drawChips() {
    const box = $('#chips', el);
    if (!s.data) { box.innerHTML = ''; return; }
    const all = entries();
    const devs = new Map();
    for (const e of all) devs.set(e.dev.id, e.dev);
    const count = (slug) => [...devs.values()].filter((d) => d.departments.includes(slug)).length;
    // Problems to chase down, as filters: the same IP twice, and models with no address.
    const conflicts = all.filter((e) => e.ip && s.ix.conflicts.has(e.ip.id)).length;
    const noip = all.filter((e) => !e.ip?._addr).length;
    box.innerHTML = `
      ${ctx.departments.map((d) => `<button type="button" class="chip dep" data-tag="${d.slug}" data-dep="${d.slug}" aria-pressed="${s.tags.has(d.slug)}"><i class="dot"></i>${esc(d.name)}<small>${count(d.slug)}</small></button>`).join('')}
      ${conflicts || s.flag === 'conflicts' ? `<button type="button" class="chip bad" data-flag="conflicts" aria-pressed="${s.flag === 'conflicts'}">${icon('warn')}Same IP twice<small>${conflicts}</small></button>` : ''}
      ${noip || s.flag === 'noip' ? `<button type="button" class="chip" data-flag="noip" aria-pressed="${s.flag === 'noip'}">No IP yet<small>${noip}</small></button>` : ''}`;
  }

  function drawResults() {
    const box = $('#results', el);
    if (s.error) {
      drawTally(null);
      box.innerHTML = `<div class="empty"><h3>Couldn’t load the sheet</h3><p>${esc(s.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
      return;
    }
    if (!s.data) return;
    if (s.mode === 'networks') return drawNetworks(box);

    const all = entries();
    const shown = all.filter(matches);
    const devCount = (list) => new Set(list.map((e) => e.dev.id)).size;
    const filtered = s.q || s.tags.size || s.flag;
    drawTally(devCount(shown), filtered ? devCount(all) : null, ['model', 'models']);
    if (!all.length) {
      const c = ctx.campusById.get(s.campus);
      box.innerHTML = `<div class="empty">
        <h3>Nothing at ${esc(c ? c.short_name : 'any campus')} yet</h3>
        <p>Add its networks first (Control, Dante, House…) so every IP gets checked against the right subnet. Then add the models here, each one picked from a type in Gear.</p>
        <div class="empty-actions"><button class="btn" data-act="add-net" data-campus="${esc(s.campus)}">${icon('network')}Add a network</button><button class="btn primary" data-act="add">${icon('plus')}Add a model</button></div>
      </div>`;
      return;
    }
    if (!shown.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `Nothing matches “${esc(s.q)}”` : 'Nothing matches these filters'}${s.campus !== 'all' ? ` at ${esc(campusName(s.campus))}` : ''}.</p><button class="btn" data-act="clear">Clear search and filters</button></div>`;
      return;
    }

    const byCampus = new Map();
    for (const e of shown) {
      const cid = e.dev.campus_id;
      if (!byCampus.has(cid)) byCampus.set(cid, new Map());
      const key = e.ip?.network_id || 'none';
      const g = byCampus.get(cid);
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(e);
    }
    const campusOrder = ctx.campuses.map((c) => c.id).filter((id) => byCampus.has(id));
    box.innerHTML = `
      ${campusOrder.map((cid) => {
        const groups = byCampus.get(cid);
        const nets = s.data.networks.filter((n) => n.campus_id === cid).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
        const keys = [...nets.map((n) => n.id).filter((id) => groups.has(id)), ...(groups.has('none') ? ['none'] : [])];
        return `<section class="campus-block">
          ${s.campus === 'all' ? `<h2 class="campus-h">${esc(campusName(cid))}</h2>` : ''}
          ${keys.map((k) => groupHtml(k === 'none' ? null : s.ix.net.get(k), groups.get(k), cid)).join('')}
        </section>`;
      }).join('')}`;
  }

  function groupHtml(net, list, campusId) {
    list.sort((a, b) => (a.ip?._int ?? Infinity) - (b.ip?._int ?? Infinity) || a.dev.name.localeCompare(b.dev.name, undefined, { numeric: true }));
    return `<section class="net">
      ${net ? netHead(net) : `<header class="net-head none"><div class="net-title"><h3>Not on a network yet</h3></div><p class="net-sub">IPs with no network picked, and models with no IP recorded.</p></header>`}
      <ul class="rows">${list.map(rowHtml).join('')}</ul>
    </section>`;
  }

  function netUsage(net) {
    const c = parseCidr(net.subnet);
    if (!c) return null;
    const used = new Set(s.data.ips.filter((i) => i.network_id === net.id && i._int != null && inCidr(i._int, c)).map((i) => i._int)).size;
    return { used, size: c.size };
  }

  function netHead(net) {
    const u = netUsage(net);
    const pct = u && u.size ? Math.min(100, (u.used / u.size) * 100) : 0;
    return `<header class="net-head">
      <div class="net-title">
        <h3>${esc(net.name)}</h3>
        ${tagDots(net.departments)}
        ${net.is_isolated ? '<span class="pill">Separate switches</span>' : ''}
        <button class="icon-btn net-edit" data-net="${net.id}" aria-label="Edit ${esc(net.name)}">${icon('edit')}</button>
      </div>
      <p class="net-sub mono">${[net.vlan_id ? `VLAN ${net.vlan_id}` : null, net.subnet, net.gateway ? `gw ${splitInet(net.gateway).addr}` : null].filter(Boolean).map((x) => `<span class="mp">${esc(x)}</span>`).join('') || '<span class="mp">No subnet set</span>'}</p>
      ${u ? `<div class="meter" title="${u.used} of ${u.size} addresses used"><span style="width:${pct.toFixed(1)}%"></span></div><span class="meter-label">${u.used} / ${u.size.toLocaleString()} used</span>` : ''}
    </header>`;
  }

  function rowHtml({ dev, ip }) {
    const conflict = ip && s.ix.conflicts.get(ip.id);
    const room = s.ix.room.get(dev.room_id)?.name;
    const where = [room, dev.location].filter(Boolean).join(' · ');
    const ty = s.ix.type.get(dev.type_id);
    const model = ty ? typeLabel(ty) : '';
    return `<li class="row ${conflict ? 'is-conflict' : ''} ${dev.status !== 'active' ? 'is-' + dev.status : ''}">
      <button class="row-hit" data-open="${dev.id}" aria-label="Open ${esc(dev.name)}"></button>
      ${tagDots(dev.departments)}
      <span class="r-name"><b>${esc(dev.name)}</b>${ip?.label ? `<em>${esc(ip.label)}</em>` : ''}${dev.status !== 'active' ? `<span class="pill">${STATUS[dev.status]}</span>` : ''}</span>
      <span class="r-sub">${ip?.label ? `<span class="r-label">${esc(ip.label)}</span>` : ''}<span class="r-model">${esc(model)}</span><span class="r-where">${esc(where)}</span></span>
      <span class="r-mac mono">${esc(ip?.mac || '')}</span>
      ${ip?._addr
        ? `<button class="r-ip mono" data-copy="${esc(ip._addr)}" aria-label="Copy ${esc(ip._addr)}">${conflict ? icon('warn') : ''}${ipHtml(ip._addr)}${ip.mode !== 'static' ? `<small>${ip.mode === 'dhcp' ? 'DHCP' : 'RSV'}</small>` : ''}</button>`
        : '<span class="r-ip none">No IP</span>'}
      ${conflict ? `<span class="r-conflict">${icon('warn')}Same IP as ${esc(conflict.map((o) => s.ix.dev.get(o.device_id)?.name || 'another device').join(', '))}</span>` : ''}
    </li>`;
  }

  function drawNetworks(box) {
    const camps = s.campus === 'all' ? ctx.campuses : [ctx.campusById.get(s.campus)];
    drawTally(s.data.networks.filter(inCampus).length, null, ['network', 'networks']);
    box.innerHTML = camps.map((c) => {
      const nets = s.data.networks.filter((n) => n.campus_id === c.id).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
      if (s.campus === 'all' && !nets.length) return '';
      return `<section class="campus-block">
        ${s.campus === 'all' ? `<h2 class="campus-h">${esc(c.short_name)}</h2>` : ''}
        ${nets.length ? `<div class="net-cards">${nets.map((n) => {
          const u = netUsage(n);
          const devCount = new Set(s.data.ips.filter((i) => i.network_id === n.id).map((i) => i.device_id)).size;
          return `<button class="net-card" data-net="${n.id}">
            <span class="net-title"><b>${esc(n.name)}</b>${tagDots(n.departments)}</span>
            ${n.purpose ? `<span class="net-purpose">${esc(n.purpose)}</span>` : ''}
            <span class="net-sub mono">${[n.vlan_id ? `VLAN ${n.vlan_id}` : null, n.subnet, n.gateway ? `gw ${splitInet(n.gateway).addr}` : null].filter(Boolean).map((x) => `<span class="mp">${esc(x)}</span>`).join('') || '<span class="mp">No subnet set</span>'}</span>
            ${u ? `<span class="meter"><span style="width:${Math.min(100, (u.used / Math.max(1, u.size)) * 100).toFixed(1)}%"></span></span>` : ''}
            <span class="net-foot">${plural(devCount, 'device')}${u ? ` · ${u.used} of ${u.size.toLocaleString()} addresses` : ''}${n.is_isolated ? ' · separate switches' : ''}</span>
          </button>`;
        }).join('')}</div>`
        : `<div class="empty small"><p>No networks at ${esc(c.short_name)} yet.</p><button class="btn" data-act="add-net" data-campus="${c.id}">${icon('plus')}Add a network</button></div>`}
      </section>`;
    }).join('') || `<div class="empty"><h3>No networks yet</h3><p>Pick a location and add its networks: Production Control, Dante, House…</p><button class="btn primary" data-act="add">${icon('plus')}Add a network</button></div>`;
  }

  // --------------------------------------------------- network sheet ----

  function openNetworkSheet(netId, campusHint) {
    const net = netId ? s.ix.net.get(netId) : null;
    const campusId = net?.campus_id || (campusHint && campusHint !== 'all' ? campusHint : s.campus !== 'all' ? s.campus : ctx.me.home_campus_id || ctx.campuses[0]?.id);
    const d = net ? { ...net, departments: [...net.departments], gateway: net.gateway ? splitInet(net.gateway).addr : '' }
      : { campus_id: campusId, name: '', purpose: '', vlan_id: '', subnet: '', gateway: '', departments: [], is_isolated: false, notes: '' };
    let confirmDelete = false;
    let dirty = false;
    const sheet = ctx.openSheet({
      label: net ? net.name : 'New network',
      beforeClose: () => { if (!dirty) return true; collect(); render('', true); return false; },
    });
    const render = (msg = '', offerDiscard = false) => {
      const u = net && netUsage(net);
      const next = net?.subnet ? nextFreeIp(net.subnet, s.data.ips.filter((i) => i.network_id === net.id).map((i) => i._int).filter((x) => x != null), net.gateway ? ipToInt(splitInet(net.gateway).addr) : null) : null;
      sheet.render(`
        <header class="sh-head"><div class="sh-top"><span class="eyebrow">${net ? 'Network' : 'New network'} · ${esc(campusName(d.campus_id))}</span>
          <button class="icon-btn" data-a="close" aria-label="Close">${icon('close')}</button></div>
          <h2>${esc(d.name || 'New network')}</h2>
          ${u ? `<p class="sh-sub">${u.used} of ${u.size.toLocaleString()} addresses used${next ? ` · next free <span class="mono">${next}</span>` : ''}</p>` : ''}
        </header>
        <form class="sh-body form" id="net-form" novalidate autocomplete="off">
          ${!net ? `<label class="field"><span>Campus</span><select id="n-campus">${ctx.campuses.map((c) => `<option value="${c.id}" ${c.id === d.campus_id ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select></label>` : ''}
          <label class="field"><span>Name <b class="req">required</b></span><input id="n-name" value="${esc(d.name)}" placeholder="Production Control, Dante Primary, House…"></label>
          <label class="field"><span>What’s on it</span><input id="n-purpose" value="${esc(d.purpose || '')}" placeholder="Switchers, cameras, projectors"></label>
          <div class="grid3">
            <label class="field"><span>Subnet</span><input id="n-subnet" class="mono" value="${esc(d.subnet || '')}" placeholder="10.50.10.0/24" inputmode="decimal"></label>
            <label class="field"><span>Gateway</span><input id="n-gateway" class="mono" value="${esc(d.gateway || '')}" placeholder="10.50.10.1" inputmode="decimal"></label>
            <label class="field"><span>VLAN ID</span><input id="n-vlan" class="mono" value="${esc(d.vlan_id ?? '')}" inputmode="numeric" placeholder="203"></label>
          </div>
          <div class="field"><span>Tags</span><div class="tag-picker">${ctx.departments.map((t) => `<button type="button" class="chip dep big" data-a="tag" data-tag="${t.slug}" data-dep="${t.slug}" aria-pressed="${d.departments.includes(t.slug)}"><i class="dot"></i>${esc(t.name)}</button>`).join('')}</div></div>
          <label class="check"><input type="checkbox" id="n-iso" ${d.is_isolated ? 'checked' : ''}><span>Separate switches, not connected to the church network (Dante, Art-Net…)</span></label>
          <label class="field"><span>Notes</span><textarea id="n-notes" rows="3">${esc(d.notes || '')}</textarea></label>
        </form>
        <footer class="sh-foot">
          ${offerDiscard ? `<div class="discard"><span>Discard your changes?</span><button class="btn" data-a="keep">Keep editing</button><button class="btn danger" data-a="discard">Discard</button></div>` : ''}
          <p class="form-msg bad" role="status">${esc(offerDiscard ? '' : msg)}</p>
          ${confirmDelete
            ? `<span class="confirm-text">Delete ${esc(d.name)}? Its devices keep their IPs.</span><button class="btn" data-a="del-no">Keep it</button><button class="btn danger" data-a="del-yes">Delete</button>`
            : `${net ? `<button class="btn ghost danger-text" data-a="del">${icon('trash')}Delete</button>` : ''}<span class="spacer"></span><button class="btn primary" data-a="save">${net ? 'Save changes' : 'Add network'}</button>`}
        </footer>`);
      $('#net-form', sheet.el).addEventListener('submit', (e) => { e.preventDefault(); saveNet(); });
    };
    const collect = () => {
      const v = (id) => $(`#${id}`, sheet.el)?.value ?? '';
      if (!$('#n-name', sheet.el)) return;
      if (!net) d.campus_id = v('n-campus');
      d.name = v('n-name'); d.purpose = v('n-purpose'); d.subnet = v('n-subnet').trim(); d.gateway = v('n-gateway').trim();
      d.vlan_id = v('n-vlan').trim(); d.notes = v('n-notes'); d.is_isolated = $('#n-iso', sheet.el).checked;
    };
    async function saveNet() {
      collect();
      if (!d.name.trim()) return render('Give the network a name.');
      let subnet = null;
      if (d.subnet) {
        const withPrefix = d.subnet.includes('/') ? d.subnet : `${d.subnet}/24`;
        const c = parseCidr(withPrefix);
        if (!c) return render('Write the subnet like 10.50.10.0/24.');
        subnet = `${intToIp(c.base)}/${c.prefix}`;
      }
      if (d.gateway && ipToInt(d.gateway) == null) return render('Fix the gateway address.');
      if (d.gateway && subnet && !inCidr(ipToInt(d.gateway), subnet)) return render(`The gateway isn’t inside ${subnet}.`);
      const vlan = d.vlan_id === '' ? null : Number(d.vlan_id);
      if (vlan != null && !(Number.isInteger(vlan) && vlan >= 1 && vlan <= 4094)) return render('VLAN IDs run from 1 to 4094.');
      try {
        await ctx.store.saveNetwork({ ...d, name: d.name.trim(), subnet, gateway: d.gateway || null, vlan_id: vlan });
        dirty = false;
        ctx.toast(`Saved ${d.name.trim()}`);
        sheet.close(true);
        load(true);
      } catch (e) {
        render(/duplicate|unique/i.test(e.message) ? 'That campus already has a network with that name.' : e.message);
      }
    }
    sheet.el.addEventListener('input', () => { dirty = true; });
    sheet.el.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const a = t.dataset.a;
      if (a === 'close') sheet.close();
      else if (a === 'save') saveNet();
      else if (a === 'tag') { collect(); d.departments = d.departments.includes(t.dataset.tag) ? d.departments.filter((x) => x !== t.dataset.tag) : [...d.departments, t.dataset.tag]; dirty = true; render(); }
      else if (a === 'keep') { collect(); render(); }
      else if (a === 'discard') { dirty = false; sheet.close(true); }
      else if (a === 'del') { collect(); confirmDelete = true; render(); }
      else if (a === 'del-no') { collect(); confirmDelete = false; render(); }
      else if (a === 'del-yes') {
        try { await ctx.store.deleteNetwork(net.id); ctx.toast(`Deleted ${net.name}`); dirty = false; sheet.close(true); load(true); }
        catch (err) { render(err.message); }
      }
    });
    render();
    $('#n-name', sheet.el)?.focus();
  }
}
