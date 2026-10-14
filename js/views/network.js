// Network: the IP sheet for every campus. Devices grouped by network, with
// audio / video / lighting filters, search, conflict checks and full editing.

import {
  esc, icon, $, $$, debounce, storage, store, ipToInt, intToIp, splitInet, prefixToMask, maskToPrefix,
  parseCidr, inCidr, nextFreeIp, normMac, timeAgo, plural, copyText,
} from '../util.js';
import { typeEditor, typeLabel, sortPorts, portMeta } from './types.js';

const IP_LABELS = ['Management', 'Control', 'Dante Primary', 'Dante Secondary', 'Art-Net / sACN', 'NDI', 'Video', 'House', 'Production'];
const MASKS = ['255.255.255.0', '255.255.0.0', '255.0.0.0', '255.255.255.128', '255.255.254.0', '255.255.252.0'];
const STATUS = { active: 'In use', spare: 'Spare', repair: 'In repair', retired: 'Retired' };
const MODES = { static: 'Static', reserved: 'DHCP reservation', dhcp: 'DHCP' };
const FIELD = {
  name: 'Name', departments: 'Tags', category: 'Category', manufacturer: 'Manufacturer', model: 'Model',
  serial_number: 'Serial', firmware: 'Firmware', location: 'Location', room_id: 'Room', campus_id: 'Campus',
  status: 'Status', notes: 'Notes', ip: 'IP', gateway: 'Gateway', mac: 'MAC', label: 'Label', network_id: 'Network',
  mode: 'Mode', username: 'Username', password: 'Password', hostname: 'Hostname', type_id: 'Type',
  connected_to: 'Connected to', assignment: 'Assignment',
};

export function mount(el, ctx) {
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
        <label class="campus-pick">
          <span class="campus-name" id="campus-name"></span>${icon('down', 'campus-caret')}
          <select id="campus" aria-label="Campus">
            <option value="all">All campuses</option>
            ${ctx.campuses.map((c) => `<option value="${c.id}">${esc(c.short_name)}</option>`).join('')}
          </select>
        </label>
        <button class="btn primary add-desktop" data-act="add">${icon('plus')}<span>Add model</span></button>
      </div>
      <div class="stats" id="stats" aria-live="polite"></div>
      <div class="seg mode-seg" role="tablist" aria-label="Show">
        <button type="button" role="tab" data-mode="devices">Models</button>
        <button type="button" role="tab" data-mode="networks">Networks</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="q" type="search" placeholder="Search name, IP, type, MAC, location" autocomplete="off" enterkeyhint="search" aria-label="Search"></div>
      <div class="chips" id="chips"></div>
    </div>
    <div id="results" class="results" aria-live="polite"></div>
    <button class="fab" data-act="add" aria-label="Add model">${icon('plus')}</button>`;

  const campusSel = $('#campus', el);
  campusSel.value = s.campus;
  campusSel.addEventListener('change', () => { s.campus = campusSel.value; store('ucp.campus', s.campus); draw(); });
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
      s.flag = s.flag === t.dataset.flag ? null : t.dataset.flag; drawMeta(); drawChips(); drawResults();
    } else if (t.dataset.act === 'add') {
      s.mode === 'networks' ? openNetworkSheet(null) : openDeviceSheet(null, true);
    } else if (t.dataset.act === 'clear') {
      s.q = ''; q.value = ''; s.tags.clear(); s.flag = null; store('ucp.tags', []); drawMeta(); drawChips(); drawResults();
    } else if (t.dataset.act === 'add-net') {
      openNetworkSheet(null, t.dataset.campus);
    } else if (t.dataset.act === 'retry') {
      load();
    }
  });

  const unsubscribe = ctx.store.subscribe(debounce(() => load(true), 350));
  load();
  return { unmount: () => unsubscribe() };

  // ------------------------------------------------------------- data ---

  async function load(quiet = false) {
    if (!quiet) $('#results', el).innerHTML = `<div class="loading">${'<div class="sk"></div>'.repeat(6)}</div>`;
    try {
      s.data = await ctx.store.networkData();
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

  function inCampus(row) { return s.campus === 'all' || row.campus_id === s.campus; }
  function campusName(id) { return ctx.campusById.get(id)?.short_name || 'Unknown campus'; }

  /** One entry per IP, plus one for each device that has no IP yet. */
  function entries() {
    const out = [];
    for (const dev of s.data.devices) {
      if (!inCampus(dev)) continue;
      const ips = s.ix.ipsByDev.get(dev.id) || [];
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
    const c = ctx.campusById.get(s.campus);
    $('#campus-name', el).textContent = c ? c.short_name : 'All campuses';
    $$('[data-mode]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === s.mode)));
    $('.fab', el).setAttribute('aria-label', s.mode === 'networks' ? 'Add network' : 'Add model');
    $('.add-desktop span', el).textContent = s.mode === 'networks' ? 'Add network' : 'Add model';
    $('.toolbar', el).hidden = s.mode === 'networks';
    drawMeta(); drawChips(); drawResults();
  }

  function drawMeta() {
    const box = $('#stats', el);
    if (!s.data) { box.innerHTML = s.error ? '' : '<div class="stat"><span class="stat-label">Loading…</span><span class="stat-num">–</span></div>'; return; }
    const all = entries();
    const devs = s.data.devices.filter(inCampus);
    const ips = s.data.ips.filter((i) => inCampus(i) && i._addr);
    const nets = s.data.networks.filter(inCampus);
    const conflicts = all.filter((e) => e.ip && s.ix.conflicts.has(e.ip.id)).length;
    const noip = all.filter((e) => !e.ip?._addr).length;
    const byDep = (slug) => devs.filter((d) => d.departments.includes(slug)).length;
    box.innerHTML = `
      <div class="stat"><span class="stat-label">Models</span><span class="stat-num">${devs.length}</span>
        <span class="stat-sub">${ctx.departments.map((d) => `<span><i class="tag" data-dep="${d.slug}">${esc(d.name[0])}</i>${byDep(d.slug)}</span>`).join('')}</span></div>
      <div class="stat"><span class="stat-label">IP addresses</span><span class="stat-num">${ips.length}</span>
        <span class="stat-sub">on ${plural(nets.length, 'network')}</span></div>
      <button type="button" class="stat ${conflicts ? 'is-bad' : 'is-zero'}" data-flag="conflicts" aria-pressed="${s.flag === 'conflicts'}">
        <span class="stat-label">Conflicts</span><span class="stat-num">${conflicts}</span>
        <span class="stat-sub">${conflicts ? 'Same IP twice · tap to see' : 'No duplicate IPs'}</span></button>
      <button type="button" class="stat ${noip ? '' : 'is-zero'}" data-flag="noip" aria-pressed="${s.flag === 'noip'}">
        <span class="stat-label">Missing IP</span><span class="stat-num">${noip}</span>
        <span class="stat-sub">${noip ? 'Models with no address' : 'Every model has one'}</span></button>`;
  }

  function drawChips() {
    const box = $('#chips', el);
    if (!s.data) { box.innerHTML = ''; return; }
    const all = entries();
    const devs = new Map();
    for (const e of all) devs.set(e.dev.id, e.dev);
    const count = (slug) => [...devs.values()].filter((d) => d.departments.includes(slug)).length;
    box.innerHTML = `
      ${ctx.departments.map((d) => `<button type="button" class="chip dep" data-tag="${d.slug}" data-dep="${d.slug}" aria-pressed="${s.tags.has(d.slug)}"><i class="dot"></i>${esc(d.name)}<small>${count(d.slug)}</small></button>`).join('')}
`;
  }

  function drawResults() {
    const box = $('#results', el);
    if (s.error) {
      box.innerHTML = `<div class="empty"><h3>Couldn’t load the sheet</h3><p>${esc(s.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
      return;
    }
    if (!s.data) return;
    if (s.mode === 'networks') return drawNetworks(box);

    const all = entries();
    const shown = all.filter(matches);
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
    const filtered = s.q || s.tags.size || s.flag;
    box.innerHTML = `
      ${filtered ? `<p class="result-note">Showing ${plural(shown.length, 'row')} of ${all.length}. <button class="btn link" data-act="clear">Clear</button></p>` : ''}
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
    list.sort((a, b) => (a.ip?._int ?? Infinity) - (b.ip?._int ?? Infinity) || a.dev.name.localeCompare(b.dev.name));
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

  // Dims the network part so the host part stands out: 10.50.10.<b>102</b>
  function ipHtml(addr) {
    const i = addr.lastIndexOf('.');
    return `<span class="ipv"><span class="ip-net">${esc(addr.slice(0, i + 1))}</span><span class="ip-host">${esc(addr.slice(i + 1))}</span></span>`;
  }

  function tagDots(tags = []) {
    return `<span class="tags">${tags.map((t) => `<i class="tag" data-dep="${t}" title="${esc(ctx.dep[t]?.name || t)}">${esc((ctx.dep[t]?.name || t)[0])}</i>`).join('')}</span>`;
  }

  function drawNetworks(box) {
    const camps = s.campus === 'all' ? ctx.campuses : [ctx.campusById.get(s.campus)];
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
    }).join('') || `<div class="empty"><h3>No networks yet</h3><p>Pick a campus and add its networks: Production Control, Dante, House…</p><button class="btn primary" data-act="add">${icon('plus')}Add a network</button></div>`;
  }

  // ---------------------------------------------------- device sheet ----

  function openDeviceSheet(id, editing = false, preset = {}) {
    let dev = id ? s.ix.dev.get(id) : null;
    let mode = editing ? 'edit' : 'view';
    let creds = null;       // loaded on demand
    let ports = null;       // this model's port patches, loaded on demand
    let typeApi = null;     // the type editor, while creating a type from here
    let showPw = new Set();
    let draft = null;
    let dirty = false;
    let busy = false;
    let confirmDelete = false;

    const sheet = ctx.openSheet({
      label: dev ? dev.name : 'New model',
      className: 'device-sheet',
      beforeClose: () => {
        if (mode === 'type') { typeApi?.cancel(); return false; }
        if (mode === 'edit' && dirty) { showDiscard(); return false; }
        openDevice = null;
        return true;
      },
    });
    openDevice = {
      id,
      refresh() {
        if (!id) return;
        const fresh = s.ix.dev.get(id);
        if (!fresh) { if (mode === 'view') { sheet.close(true); ctx.toast('That model was deleted'); } return; }
        dev = fresh;
        if (mode === 'view') renderView();
      },
    };

    if (mode === 'edit') startEdit(); else renderView();

    sheet.el.addEventListener('click', onClick);
    sheet.el.addEventListener('input', onInput);
    sheet.el.addEventListener('change', onChange);

    async function onClick(e) {
      const t = e.target.closest('button, [data-copy]');
      if (!t) return;
      if (t.dataset.copy) {
        const ok = await copyText(t.dataset.copy, t);
        ctx.toast(ok ? `Copied ${t.dataset.label || t.dataset.copy}` : 'Selected. Copy it from the menu.');
        return;
      }
      const a = t.dataset.a;
      if (a === 'close') sheet.close();
      else if (a === 'edit') startEdit();
      else if (a === 'creds') { creds = await ctx.store.credentials(dev.id); renderView(); }
      else if (a === 'pw') { showPw.has(t.dataset.i) ? showPw.delete(t.dataset.i) : showPw.add(t.dataset.i); renderView(); }
      else if (a === 'cancel') { if (!id) return sheet.close(); dirty ? showDiscard() : (mode = 'view', renderView()); }
      else if (a === 'keep') $('.discard', sheet.el)?.remove();
      else if (a === 'discard') { dirty = false; if (!id) return sheet.close(true); mode = 'view'; renderView(); }
      else if (a === 'save') save();
      else if (a === 'add-ip') { collect(); draft.ips.push(blankIp()); renderEdit(); focusLast('.ip-card input[id$="-addr"]'); }
      else if (a === 'rm-ip') { collect(); draft.ips.splice(+t.dataset.i, 1); dirty = true; renderEdit(); }
      else if (a === 'add-cred') { collect(); draft.creds.push({ label: '', username: '', password: '' }); renderEdit(); focusLast('.cred-card input'); }
      else if (a === 'rm-cred') { collect(); draft.creds.splice(+t.dataset.i, 1); dirty = true; renderEdit(); }
      else if (a === 'tag') { collect(); const tg = t.dataset.tag; draft.departments = draft.departments.includes(tg) ? draft.departments.filter((x) => x !== tg) : [...draft.departments, tg]; dirty = true; renderEdit(); }
      else if (a === 'next-ip') { collect(); fillNextIp(+t.dataset.i); }
      else if (a === 'add-room') addRoom();
      else if (a === 'open-type') { const tid = dev.type_id; openDevice = null; sheet.close(true); ctx.openType(tid); }
      else if (a === 'delete') { confirmDelete = true; renderView(); }
      else if (a === 'delete-no') { confirmDelete = false; renderView(); }
      else if (a === 'delete-yes') remove();
    }

    function onInput(e) {
      if (mode !== 'edit') return;
      dirty = true;
      if (e.target.matches('[id$="-addr"], [id$="-mask"]')) { collect(); checkIp(+e.target.closest('.ip-card').dataset.i); }
    }

    function onChange(e) {
      if (mode !== 'edit') return;
      dirty = true;
      const id_ = e.target.id;
      if (id_ === 'f-type') { onTypePicked(e.target.value); return; }
      if (id_ === 'f-campus') { collect(); draft.room_id = ''; draft.ips.forEach((ip) => { ip.network_id = ''; }); renderEdit(); }
      else if (id_ === 'f-room') {
        const was = draft.room_id;
        collect();
        if (draft.room_id === '__new' || was === '__new') { renderEdit(); if (draft.room_id === '__new') $('#f-newroom', sheet.el)?.focus(); }
      }
      else if (/^ip-\d+-net$/.test(id_)) {
        collect();
        const i = +id_.split('-')[1];
        const n = s.ix.net.get(draft.ips[i].network_id);
        const c = n && parseCidr(n.subnet);
        if (c && !draft.ips[i].mask) draft.ips[i].mask = prefixToMask(c.prefix);
        if (n?.gateway && !draft.ips[i].gateway) draft.ips[i].gateway = splitInet(n.gateway).addr;
        renderEdit();
      }
    }

    // ---- view

    function renderView() {
      if (!dev) return;
      const ips = s.ix.ipsByDev.get(dev.id) || [];
      const room = s.ix.room.get(dev.room_id)?.name;
      const by = (pid) => ctx.people.get(pid)?.full_name || 'Someone';
      const ty = s.ix.type.get(dev.type_id);
      sheet.render(`
        <header class="sh-head">
          <div class="sh-top">${tagDots(dev.departments)}${dev.status !== 'active' ? `<span class="pill">${STATUS[dev.status]}</span>` : ''}
            <button class="icon-btn" data-a="close" aria-label="Close">${icon('close')}</button></div>
          <h2>${esc(dev.name)}</h2>
          <p class="sh-sub">${esc([ty?.category, typeLabel(ty)].filter(Boolean).join(' · '))}</p>
        </header>
        <div class="sh-body">
          <section class="ip-list">
            ${ips.length ? ips.map((ip) => ipCard(ip)).join('') : `<div class="ipcard empty-ip"><p>No IP recorded yet.</p><button class="btn" data-a="edit">${icon('plus')}Add an IP</button></div>`}
          </section>
          <section class="block">
            <h3>Where</h3>
            <dl class="kv">
              ${kv('Campus', campusName(dev.campus_id))}${kv('Room', room)}${kv('Location', dev.location)}
            </dl>
          </section>
          <section class="block">
            <h3>This model</h3>
            <dl class="kv">
              ${kv('Serial', dev.serial_number, true)}${kv('Firmware', dev.firmware, true)}${kv('Status', STATUS[dev.status])}
            </dl>
            ${dev.notes ? `<p class="notes">${esc(dev.notes)}</p>` : ''}
          </section>
          ${ty?.ports.length ? `<section class="block">
            <h3>Ports</h3>
            <div id="ports"><p class="muted">Loading…</p></div>
          </section>` : ''}
          ${ty ? `<section class="block type-block">
            <h3>Type</h3>
            <button class="type-link" data-a="open-type"><span><b>${esc(ty.name)}</b><small>${esc([ty.manufacturer, ty.category, ty.part_number].filter(Boolean).join(' · '))}</small></span>${icon('chevron')}</button>
            ${ty.description ? `<p class="muted">${esc(ty.description)}</p>` : ''}
            ${ty.specs?.length ? `<dl class="kv compact">${ty.specs.map((sp) => `<div><dt>${esc(sp.label)}</dt><dd>${esc(sp.value)}</dd></div>`).join('')}</dl>` : ''}
          </section>` : ''}
          <section class="block">
            <h3>${icon('key')}Logins</h3>
            ${creds == null
              ? `<button class="btn" data-a="creds">Show logins</button>`
              : creds.length ? `<ul class="creds">${creds.map((c, i) => `<li>
                  <span class="cred-label">${esc(c.label || 'Login')}</span>
                  ${c.username ? `<button class="cred-val mono" data-copy="${esc(c.username)}" data-label="username">${esc(c.username)}${icon('copy')}</button>` : ''}
                  ${c.password ? `<span class="cred-pw"><button class="cred-val mono" data-copy="${esc(c.password)}" data-label="password">${showPw.has(String(i)) ? esc(c.password) : '••••••••'}${icon('copy')}</button><button class="icon-btn" data-a="pw" data-i="${i}" aria-label="${showPw.has(String(i)) ? 'Hide' : 'Show'} password">${icon('eye')}</button></span>` : ''}
                  ${c.notes ? `<span class="cred-notes">${esc(c.notes)}</span>` : ''}
                </li>`).join('')}</ul>`
              : '<p class="muted">No logins saved for this device.</p>'}
          </section>
          <section class="block">
            <h3>${icon('history')}History</h3>
            <div id="hist"><p class="muted">Loading…</p></div>
          </section>
          <p class="stamp">Added by ${esc(by(dev.created_by))} ${esc(timeAgo(dev.created_at))}${dev.updated_at && dev.updated_at !== dev.created_at ? ` · edited by ${esc(by(dev.updated_by))} ${esc(timeAgo(dev.updated_at))}` : ''}</p>
        </div>
        <footer class="sh-foot">
          ${confirmDelete
            ? `<span class="confirm-text">Delete ${esc(dev.name)} and its IPs?</span><button class="btn" data-a="delete-no">Keep it</button><button class="btn danger" data-a="delete-yes">Delete</button>`
            : `<button class="btn ghost danger-text" data-a="delete">${icon('trash')}Delete</button><span class="spacer"></span><button class="btn primary" data-a="edit">${icon('edit')}Edit</button>`}
        </footer>`);
      loadHistory();
      if (ty?.ports.length) loadPorts(ty);
    }

    async function loadPorts(ty) {
      try {
        ports = await ctx.store.devicePorts(dev.id);
      } catch (e) {
        const box = $('#ports', sheet.el); if (box) box.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
        return;
      }
      const box = $('#ports', sheet.el);
      if (!box) return;
      const byPort = new Map(ports.map((p) => [p.type_port_id, p]));
      const used = ty.ports.filter((p) => byPort.has(p.id));
      const empty = ty.ports.length - used.length;
      box.innerHTML = `${used.length ? `<ul class="patch-list">${used.map((p) => {
          const x = byPort.get(p.id);
          return `<li><span class="patch-port"><b>${esc(p.name)}</b><small>${esc(portMeta(p))}</small></span>
            <span class="patch-to">${esc(x.connected_to || '')}${x.assignment ? `<em>${esc(x.assignment)}</em>` : ''}${x.notes ? `<small>${esc(x.notes)}</small>` : ''}</span></li>`;
        }).join('')}</ul>` : ''}
        ${empty ? `<p class="muted">${used.length ? `${plural(empty, 'more port')} with nothing recorded.` : `Nothing recorded on its ${plural(ty.ports.length, 'port')} yet.`} <button class="btn link" data-a="edit">Record what’s plugged in</button></p>` : ''}`;
    }

    function ipCard(ip) {
      const net = s.ix.net.get(ip.network_id);
      const conflict = s.ix.conflicts.get(ip.id);
      const outside = net && ip._int != null && net.subnet && !inCidr(ip._int, net.subnet);
      return `<div class="ipcard ${conflict ? 'is-conflict' : ''}">
        <div class="ipcard-top"><span class="ipcard-label">${esc(ip.label || 'IP')}</span><span class="ipcard-net">${esc(net ? net.name + (net.vlan_id ? ` · VLAN ${net.vlan_id}` : '') : 'No network set')}</span></div>
        ${ip._addr ? `<div class="ipcard-ip">
            <button class="big-ip mono" data-copy="${esc(ip._addr)}" aria-label="Copy ${esc(ip._addr)}">${ipHtml(ip._addr)}${icon('copy')}</button>
            <a class="btn small" href="http://${esc(ip._addr)}" target="_blank" rel="noopener">${icon('open')}Open</a>
          </div>` : '<div class="ipcard-ip none">No address yet</div>'}
        <dl class="kv compact">
          ${kv('Mask', ip._prefix != null ? `${prefixToMask(ip._prefix)} (/${ip._prefix})` : null, true)}
          ${kv('Gateway', ip.gateway ? splitInet(ip.gateway).addr : null, true)}
          ${kv('MAC', ip.mac, true)}${kv('Hostname', ip.hostname, true)}${kv('Mode', MODES[ip.mode])}
        </dl>
        ${conflict ? `<p class="warnline">${icon('warn')}Same IP as ${esc(conflict.map((o) => s.ix.dev.get(o.device_id)?.name || 'another device').join(', '))}</p>` : ''}
        ${outside ? `<p class="warnline soft">${icon('warn')}Outside ${esc(net.name)} (${esc(net.subnet)})</p>` : ''}
      </div>`;
    }

    async function loadHistory() {
      const box = $('#hist', sheet.el);
      try {
        const items = await ctx.store.history(dev.id);
        if (!$('#hist', sheet.el)) return;
        box.innerHTML = items.length
          ? `<ol class="hist">${items.map(histItem).join('')}</ol>`
          : '<p class="muted">No changes recorded yet.</p>';
      } catch (e) {
        box.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    }

    function histItem(a) {
      const who = ctx.people.get(a.actor_id)?.full_name || 'Someone';
      const thing = { devices: '', device_ips: 'IP ', device_credentials: 'login ', networks: 'network ', device_ports: 'port ' }[a.entity] ?? '';
      let what;
      if (a.entity === 'devices') what = a.action === 'created' ? 'added this model' : a.action === 'deleted' ? 'deleted this model' : 'changed';
      else what = `${a.action === 'created' ? 'added' : a.action === 'deleted' ? 'removed' : 'changed'} ${thing}<b>${esc(a.label || '')}</b>`;
      const lines = a.action === 'updated'
        ? Object.entries(a.changes || {}).map(([k, [o, n]]) => k === 'password'
            ? `<li>Password changed</li>`
            : `<li><span>${esc(FIELD[k] || k)}</span> ${fmtVal(k, o)} <i>→</i> ${fmtVal(k, n)}</li>`).join('')
        : '';
      return `<li><p><b>${esc(who)}</b> ${what} <time>${esc(timeAgo(a.at))}</time></p>${lines ? `<ul>${lines}</ul>` : ''}</li>`;
    }

    function fmtVal(k, v) {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '<em>empty</em>';
      if (k === 'room_id') v = s.ix.room.get(v)?.name || 'a removed room';
      else if (k === 'campus_id') v = campusName(v);
      else if (k === 'network_id') v = s.ix.net.get(v)?.name || 'a removed network';
      else if (k === 'type_id') v = s.ix.type.has(v) ? typeLabel(s.ix.type.get(v)) : 'a removed type';
      else if (k === 'departments') v = v.map((t) => ctx.dep[t]?.name || t).join(', ');
      else if (k === 'status') v = STATUS[v] || v;
      else if (k === 'mode') v = MODES[v] || v;
      return `<code>${esc(String(v))}</code>`;
    }

    // ---- edit

    function blankIp() {
      return { id: '', label: '', network_id: '', addr: '', mask: '', gateway: '', mac: '', hostname: '', mode: 'static', notes: '' };
    }

    async function startEdit() {
      mode = 'edit';
      dirty = false;
      if (dev) {
        sheet.render(`<div class="sh-body"><p class="muted pad">Loading…</p></div>`);
        try { [creds, ports] = await Promise.all([ctx.store.credentials(dev.id), ctx.store.devicePorts(dev.id)]); }
        catch (e) { ctx.toast(e.message, 'bad'); mode = 'view'; return renderView(); }
      } else {
        creds = []; ports = [];
      }
      const ips = dev ? s.ix.ipsByDev.get(dev.id) || [] : [];
      const defaultCampus = s.campus !== 'all' ? s.campus : (ctx.me.home_campus_id || ctx.campuses[0]?.id);
      draft = dev
        ? { ...dev, room_id: dev.room_id || '', departments: [...dev.departments],
            ips: ips.map((ip) => ({ id: ip.id, label: ip.label || '', network_id: ip.network_id || '', addr: ip._addr || '',
              mask: ip._prefix != null ? prefixToMask(ip._prefix) : '', gateway: ip.gateway ? splitInet(ip.gateway).addr : '',
              mac: ip.mac || '', hostname: ip.hostname || '', mode: ip.mode, notes: ip.notes || '' })),
            creds: creds.map((c) => ({ ...c })),
            ports: Object.fromEntries(ports.map((p) => [p.type_port_id, { connected_to: p.connected_to || '', assignment: p.assignment || '', notes: p.notes || '' }])) }
        : { id: '', type_id: '', campus_id: defaultCampus, room_id: '', name: '', departments: [], serial_number: '', firmware: '',
            location: '', status: 'active', notes: '', ips: [blankIp()], creds: [], ports: {} };
      if (!dev && preset.type_id) onTypePicked(preset.type_id, true);
      renderEdit();
      $(draft.type_id ? '#f-name' : '#f-type', sheet.el)?.focus();
    }

    function renderEdit(error = '') {
      const campusId = draft.campus_id;
      const rooms = s.data.rooms.filter((r) => r.campus_id === campusId);
      const nets = s.data.networks.filter((n) => n.campus_id === campusId);
      const ty = s.ix.type.get(draft.type_id);
      const typeGroups = new Map();
      for (const t of [...s.ix.type.values()].sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)))) {
        const k = t.category || 'Uncategorized';
        if (!typeGroups.has(k)) typeGroups.set(k, []);
        typeGroups.get(k).push(t);
      }
      const oldPatches = dev && draft.type_id !== dev.type_id && ports?.length;
      const locs = [...new Set(s.data.devices.filter((d) => d.campus_id === campusId).map((d) => d.location).filter(Boolean))].sort();
      const scroll = $('.sh-body', sheet.el)?.scrollTop || 0;
      sheet.render(`
        <header class="sh-head">
          <div class="sh-top"><span class="eyebrow">${dev ? 'Edit model' : 'New model'}</span>
            <button class="icon-btn" data-a="cancel" aria-label="Close">${icon('close')}</button></div>
          <h2>${esc(draft.name || (ty ? ty.name : dev ? dev.name : 'New model'))}</h2>
        </header>
        <form class="sh-body form" id="dev-form" novalidate autocomplete="off">
          <label class="field"><span>Type <b class="req">required</b></span><select id="f-type">
            <option value="" ${draft.type_id ? '' : 'selected'}>Choose a type…</option>
            ${[...typeGroups.keys()].sort().map((k) => `<optgroup label="${esc(k)}">${typeGroups.get(k).map((t) => `<option value="${t.id}" ${t.id === draft.type_id ? 'selected' : ''}>${esc(typeLabel(t))}</option>`).join('')}</optgroup>`).join('')}
            <option value="__new">＋ New type…</option>
          </select>
          ${ty ? `<small class="hint">${esc([ty.category, ty.part_number, ty.ports.length ? plural(ty.ports.length, 'port') : null].filter(Boolean).join(' · ') || 'Specs and ports come from the type.')}</small>` : `<small class="hint">The product this is, like Hoglet 4. Its specs and ports come from the type.</small>`}
          ${oldPatches ? `<small class="hint warn-text">What was recorded on the old type’s ports will be cleared when you save.</small>` : ''}</label>
          <label class="field"><span>Name</span><input id="f-name" value="${esc(draft.name)}" placeholder="${esc(ty ? ty.name : 'FOH Switch, Camera 2, Stage Box…')}"></label>
          <div class="field"><span>Tags <b class="req">at least one</b></span>
            <div class="tag-picker">${ctx.departments.map((d) => `<button type="button" class="chip dep big" data-a="tag" data-tag="${d.slug}" data-dep="${d.slug}" aria-pressed="${draft.departments.includes(d.slug)}"><i class="dot"></i>${esc(d.name)}</button>`).join('')}</div>
          </div>

          <fieldset class="group"><legend>Where</legend>
            <div class="grid2">
              <label class="field"><span>Campus</span><select id="f-campus">${ctx.campuses.map((c) => `<option value="${c.id}" ${c.id === campusId ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select></label>
              <label class="field"><span>Room</span><select id="f-room">
                <option value="">No room</option>
                ${rooms.map((r) => `<option value="${r.id}" ${r.id === draft.room_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
                <option value="__new" ${draft.room_id === '__new' ? 'selected' : ''}>＋ New room…</option>
              </select></label>
            </div>
            ${draft.room_id === '__new' ? `<div class="inline-add"><input id="f-newroom" placeholder="Worship Center, North Auditorium, Kids…" aria-label="New room name"><button type="button" class="btn" data-a="add-room">Add room</button></div>` : ''}
            <label class="field"><span>Location in the room</span><input id="f-location" value="${esc(draft.location)}" list="dl-loc" placeholder="FOH rack, Stage rack, Catwalk…"></label>
          </fieldset>

          <fieldset class="group"><legend>IP addresses</legend>
            <div class="ip-edit">${draft.ips.map((ip, i) => ipEditCard(ip, i, nets)).join('')}</div>
            <button type="button" class="btn" data-a="add-ip">${icon('plus')}${draft.ips.length ? 'Add another IP' : 'Add an IP'}</button>
          </fieldset>

          ${ty?.ports.length ? `<fieldset class="group"><legend>Ports <span class="count">${ty.ports.length}</span></legend>
            <p class="fine">What’s plugged into each port on this one. Leave a port blank if nothing is.</p>
            <div class="patch-edit">${ty.ports.map((p) => {
              const x = draft.ports[p.id] || {};
              return `<div class="patch-row">
                <span class="patch-port"><b>${esc(p.name)}</b><small>${esc(portMeta(p))}</small></span>
                <input id="pp-${p.id}-to" value="${esc(x.connected_to || '')}" placeholder="Plugged into…" aria-label="${esc(p.name)}: plugged into">
                <input id="pp-${p.id}-as" value="${esc(x.assignment || '')}" placeholder="Universe, input, channel…" aria-label="${esc(p.name)}: assignment">
              </div>`;
            }).join('')}</div>
          </fieldset>` : ''}

          <fieldset class="group"><legend>This model</legend>
            <div class="grid2">
              <label class="field"><span>Serial number</span><input id="f-serial_number" class="mono" value="${esc(draft.serial_number)}"></label>
              <label class="field"><span>Firmware / software</span><input id="f-firmware" class="mono" value="${esc(draft.firmware)}"></label>
              <label class="field"><span>Status</span><select id="f-status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === draft.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            </div>
            <label class="field"><span>Notes</span><textarea id="f-notes" rows="3" placeholder="Anything the next person should know">${esc(draft.notes)}</textarea></label>
          </fieldset>

          <fieldset class="group"><legend>Logins</legend>
            <p class="fine">Only staff can see these.</p>
            <div class="cred-edit">${draft.creds.map((c, i) => `<div class="cred-card" data-i="${i}">
              <div class="grid3">
                <label class="field"><span>Label</span><input id="c-${i}-label" value="${esc(c.label)}" placeholder="Web UI"></label>
                <label class="field"><span>Username</span><input id="c-${i}-username" class="mono" value="${esc(c.username)}" autocapitalize="off" spellcheck="false"></label>
                <label class="field"><span>Password</span><input id="c-${i}-password" class="mono" value="${esc(c.password)}" autocapitalize="off" spellcheck="false" autocomplete="off" data-lpignore="true"></label>
              </div>
              <button type="button" class="btn ghost small danger-text" data-a="rm-cred" data-i="${i}">${icon('trash')}Remove login</button>
            </div>`).join('')}</div>
            <button type="button" class="btn" data-a="add-cred">${icon('key')}Add a login</button>
          </fieldset>

          <datalist id="dl-loc">${locs.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
          <datalist id="dl-iplabel">${IP_LABELS.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
          <datalist id="dl-mask">${MASKS.map((v) => `<option value="${v}">`).join('')}</datalist>
        </form>
        <footer class="sh-foot">
          <p class="form-msg ${error ? 'bad' : ''}" role="status">${esc(error)}</p>
          <span class="spacer"></span>
          <button class="btn" data-a="cancel">Cancel</button>
          <button class="btn primary" data-a="save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : dev ? 'Save changes' : 'Add model'}</button>
        </footer>`);
      $('#dev-form', sheet.el).addEventListener('submit', (e) => { e.preventDefault(); save(); });
      const body = $('.sh-body', sheet.el);
      if (body) body.scrollTop = scroll;
      draft.ips.forEach((_, i) => checkIp(i));
    }

    function ipEditCard(ip, i, nets) {
      const net = s.ix.net.get(ip.network_id);
      return `<div class="ip-card" data-i="${i}">
        <div class="grid2">
          <label class="field"><span>Network</span><select id="ip-${i}-net">
            <option value="">No network</option>
            ${nets.map((n) => `<option value="${n.id}" ${n.id === ip.network_id ? 'selected' : ''}>${esc(n.name)}${n.subnet ? ' · ' + esc(n.subnet) : ''}</option>`).join('')}
          </select></label>
          <label class="field"><span>Label</span><input id="ip-${i}-label" value="${esc(ip.label)}" list="dl-iplabel" placeholder="Control, Dante Primary…"></label>
        </div>
        <div class="grid-ip">
          <label class="field"><span>IP address</span><input id="ip-${i}-addr" class="mono" value="${esc(ip.addr)}" inputmode="decimal" placeholder="${net?.subnet ? esc(intToIp(parseCidr(net.subnet).first)) : '10.50.10.102'}" autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>Subnet mask</span><input id="ip-${i}-mask" class="mono" value="${esc(ip.mask)}" list="dl-mask" inputmode="decimal" placeholder="255.255.255.0"></label>
          ${net?.subnet ? `<button type="button" class="btn small next-ip" data-a="next-ip" data-i="${i}" title="Fill in the next unused address on ${esc(net.name)}">${icon('wand')}Next free</button>` : ''}
        </div>
        <p class="ip-check" id="ip-${i}-check" aria-live="polite"></p>
        <div class="grid3">
          <label class="field"><span>Gateway</span><input id="ip-${i}-gateway" class="mono" value="${esc(ip.gateway)}" inputmode="decimal"></label>
          <label class="field"><span>MAC address</span><input id="ip-${i}-mac" class="mono" value="${esc(ip.mac)}" autocapitalize="off" spellcheck="false" placeholder="aa:bb:cc:dd:ee:ff"></label>
          <label class="field"><span>Assigned by</span><select id="ip-${i}-mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${k === ip.mode ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        <button type="button" class="btn ghost small danger-text" data-a="rm-ip" data-i="${i}">${icon('trash')}Remove this IP</button>
      </div>`;
    }

    /** Reads every input back into the draft. */
    function collect() {
      const f = (id) => $(`#${id}`, sheet.el);
      if (!f('f-name')) return;
      for (const k of ['name', 'location', 'serial_number', 'firmware', 'notes', 'status']) draft[k] = f('f-' + k).value;
      const ty = s.ix.type.get(draft.type_id);
      for (const p of ty?.ports || []) {
        if (!f(`pp-${p.id}-to`)) continue;
        draft.ports[p.id] = { ...(draft.ports[p.id] || {}), connected_to: f(`pp-${p.id}-to`).value, assignment: f(`pp-${p.id}-as`).value };
      }
      draft.campus_id = f('f-campus').value;
      draft.room_id = f('f-room').value;
      draft.ips.forEach((ip, i) => {
        if (!f(`ip-${i}-addr`)) return;
        ip.network_id = f(`ip-${i}-net`).value; ip.label = f(`ip-${i}-label`).value; ip.addr = f(`ip-${i}-addr`).value.trim();
        ip.mask = f(`ip-${i}-mask`).value.trim(); ip.gateway = f(`ip-${i}-gateway`).value.trim(); ip.mac = f(`ip-${i}-mac`).value.trim();
        ip.mode = f(`ip-${i}-mode`).value;
      });
      draft.creds.forEach((c, i) => {
        if (!f(`c-${i}-label`)) return;
        c.label = f(`c-${i}-label`).value; c.username = f(`c-${i}-username`).value; c.password = f(`c-${i}-password`).value;
      });
    }

    /** Live check under each IP: conflicts, wrong subnet, typos. */
    function checkIp(i) {
      const box = $(`#ip-${i}-check`, sheet.el);
      const ip = draft.ips[i];
      if (!box || !ip) return;
      const n = ipToInt(ip.addr);
      const msgs = [];
      if (ip.addr && n == null) msgs.push(['bad', 'That isn’t a valid IP address. Use four numbers 0–255, like 10.50.10.102.']);
      if (ip.mask && maskToPrefix(ip.mask) == null) msgs.push(['bad', 'That isn’t a valid subnet mask. Try 255.255.255.0.']);
      if (n != null) {
        const net = s.ix.net.get(ip.network_id);
        if (net?.subnet && !inCidr(n, net.subnet)) msgs.push(['soft', `Outside ${net.name} (${net.subnet}).`]);
        const clashes = s.data.ips.filter((o) => o._int === n && o.campus_id === draft.campus_id && o.device_id !== draft.id
          && (!o.network_id || !ip.network_id || o.network_id === ip.network_id));
        const own = draft.ips.filter((o, j) => j !== i && ipToInt(o.addr) === n).length;
        if (clashes.length) msgs.push(['bad', `Already used by ${clashes.map((o) => s.ix.dev.get(o.device_id)?.name || 'another device').join(', ')}.`]);
        if (own) msgs.push(['bad', 'This device already lists that address.']);
        if (!msgs.length && net?.subnet) msgs.push(['ok', `Free on ${net.name}.`]);
      }
      box.innerHTML = msgs.map(([k, m]) => `<span class="${k}">${k === 'ok' ? icon('check') : icon('warn')}${esc(m)}</span>`).join('');
    }

    function fillNextIp(i) {
      const ip = draft.ips[i];
      const net = s.ix.net.get(ip.network_id);
      if (!net?.subnet) return;
      const used = [...s.data.ips.filter((o) => o.network_id === net.id && o.device_id !== draft.id).map((o) => o._int),
        ...draft.ips.filter((_, j) => j !== i).map((o) => ipToInt(o.addr))].filter((x) => x != null);
      const next = nextFreeIp(net.subnet, used, net.gateway ? ipToInt(splitInet(net.gateway).addr) : null);
      if (!next) return ctx.toast(`${net.name} is full`, 'bad');
      ip.addr = next;
      if (!ip.mask) ip.mask = prefixToMask(parseCidr(net.subnet).prefix);
      if (!ip.gateway && net.gateway) ip.gateway = splitInet(net.gateway).addr;
      dirty = true;
      renderEdit();
    }

    /** Picking a type: the name and tags follow it unless they were changed by hand. */
    function onTypePicked(v, initial = false) {
      if (!initial) collect();
      if (v === '__new') { startNewType(); return; }
      const prev = s.ix.type.get(draft.type_id);
      const next = s.ix.type.get(v);
      draft.type_id = v;
      if (next) {
        if (prev && draft.name.trim() === prev.name) draft.name = '';
        const same = prev && draft.departments.length === prev.departments.length && draft.departments.every((t) => prev.departments.includes(t));
        if (!draft.departments.length || same) draft.departments = [...next.departments];
      }
      if (!initial) { dirty = true; renderEdit(); }
    }

    function startNewType() {
      mode = 'type';
      typeApi = typeEditor({
        ctx, sheet, types: [...s.ix.type.values()], defaults: { departments: [...draft.departments] },
        onDone: async (newId) => {
          typeApi = null;
          await load(true);
          mode = 'edit';
          onTypePicked(newId, true);
          dirty = true;
          renderEdit();
        },
        onCancel: () => { typeApi = null; mode = 'edit'; renderEdit(); },
      });
    }

    async function addRoom() {
      const input = $('#f-newroom', sheet.el);
      const name = input.value.trim();
      if (!name) return input.focus();
      collect();
      try {
        const room = await ctx.store.addRoom(draft.campus_id, name);
        if (!s.data.rooms.some((r) => r.id === room.id)) s.data.rooms.push(room);
        s.ix.room.set(room.id, room);
        draft.room_id = room.id;
        renderEdit();
      } catch (e) { ctx.toast(e.message, 'bad'); }
    }

    async function save() {
      if (busy) return;
      collect();
      const err = (m, sel) => { renderEdit(m); if (sel) $(sel, sheet.el)?.focus(); };
      if (!draft.type_id) return err('Pick a type, or choose “New type…” to add one.', '#f-type');
      if (!draft.departments.length) return err('Tag it audio, video or lighting (at least one).');
      if (draft.room_id === '__new') return err('Finish adding the new room, or pick “No room”.', '#f-newroom');

      const ips = [];
      for (const [i, ip] of draft.ips.entries()) {
        const empty = !ip.addr && !ip.mac && !ip.label && !ip.network_id && !ip.gateway;
        if (empty) continue;
        const where = draft.ips.length > 1 ? ` (IP ${i + 1})` : '';
        let inet = '';
        if (ip.addr) {
          if (ipToInt(ip.addr) == null) return err(`Fix the IP address${where}.`, `#ip-${i}-addr`);
          const net = s.ix.net.get(ip.network_id);
          const prefix = ip.mask ? maskToPrefix(ip.mask) : net?.subnet ? parseCidr(net.subnet).prefix : 24;
          if (prefix == null) return err(`Fix the subnet mask${where}.`, `#ip-${i}-mask`);
          inet = `${ip.addr}/${prefix}`;
        }
        if (ip.gateway && ipToInt(ip.gateway) == null) return err(`Fix the gateway${where}.`, `#ip-${i}-gateway`);
        let mac = '';
        if (ip.mac) { mac = normMac(ip.mac); if (!mac) return err(`Fix the MAC address${where}. It should be 12 hex digits.`, `#ip-${i}-mac`); }
        ips.push({ id: ip.id || '', network_id: ip.network_id || '', label: ip.label, ip: inet, gateway: ip.gateway, mac, hostname: ip.hostname, mode: ip.mode, notes: ip.notes });
      }
      const credentials = draft.creds.filter((c) => c.label || c.username || c.password)
        .map((c) => ({ id: c.id || '', label: c.label, username: c.username, password: c.password, notes: c.notes || '' }));

      const payload = {
        device: {
          id: draft.id || '', type_id: draft.type_id, campus_id: draft.campus_id, room_id: draft.room_id || '', name: draft.name,
          departments: draft.departments, serial_number: draft.serial_number, firmware: draft.firmware, location: draft.location,
          status: draft.status, notes: draft.notes,
        },
        ips,
        credentials,
        ports: (s.ix.type.get(draft.type_id)?.ports || []).map((p) => ({ type_port_id: p.id, connected_to: draft.ports[p.id]?.connected_to || '',
          assignment: draft.ports[p.id]?.assignment || '', notes: draft.ports[p.id]?.notes || '' })),
      };
      busy = true; renderEdit();
      try {
        const newId = await ctx.store.saveDevice(payload);
        busy = false; dirty = false;
        ctx.toast(`Saved ${draft.name.trim() || typeLabel(s.ix.type.get(draft.type_id))}`);
        await load(true);
        id = newId; openDevice.id = newId;
        dev = s.ix.dev.get(newId);
        creds = null; ports = null; mode = 'view';
        if (dev) renderView(); else sheet.close(true);
      } catch (e) {
        busy = false; renderEdit(e.message);
      }
    }

    async function remove() {
      try {
        await ctx.store.deleteDevice(dev.id);
        ctx.toast(`Deleted ${dev.name}`);
        openDevice = null;
        sheet.close(true);
        load(true);
      } catch (e) { ctx.toast(e.message, 'bad'); }
    }

    function showDiscard() {
      if ($('.discard', sheet.el)) return;
      const bar = document.createElement('div');
      bar.className = 'discard';
      bar.innerHTML = `<span>Discard your changes?</span><button class="btn" data-a="keep">Keep editing</button><button class="btn danger" data-a="discard">Discard</button>`;
      $('.sh-foot', sheet.el)?.prepend(bar);
    }

    function focusLast(sel) { const all = $$(sel, sheet.el); all[all.length - 1]?.focus(); }
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

function kv(label, value, mono = false) {
  if (value == null || value === '') return '';
  return `<div><dt>${esc(label)}</dt><dd class="${mono ? 'mono' : ''}">${esc(value)}</dd></div>`;
}
