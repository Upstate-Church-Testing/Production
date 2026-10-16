// A model's detail panel and editor, shared by Network and Gear.
// The host section passes its state (data + index) and a way to reload it.

// Network: the IP sheet for every campus. Devices grouped by network, with
// audio / video / lighting filters, search, conflict checks and full editing.

import {
  esc, icon, $, $$, debounce, storage, store, ipToInt, intToIp, splitInet, prefixToMask, maskToPrefix,
  parseCidr, inCidr, nextFreeIp, normMac, timeAgo, plural, copyText,
} from '../util.js';
import { typeEditor, typeLabel, sortPorts, portMeta, typeThumb } from './types.js';
import {
  takesPatch, parsePatch, fmtPatch, patchOf, footprint, rigKey, rigProblems, problemText, nextFreeAddress, isProblem, MAX_UNIVERSE,
} from '../lighting.js';

export const IP_LABELS = ['Management', 'Control', 'Dante Primary', 'Dante Secondary', 'Art-Net / sACN', 'NDI', 'Video', 'House', 'Production'];
export const MASKS = ['255.255.255.0', '255.255.0.0', '255.0.0.0', '255.255.255.128', '255.255.254.0', '255.255.252.0'];
export const STATUS = { active: 'In use', spare: 'Spare', repair: 'In repair', retired: 'Retired' };
export const MODES = { static: 'Static', reserved: 'DHCP reservation', dhcp: 'DHCP' };
export const FIELD = {
  name: 'Name', departments: 'Sections', category: 'Category', manufacturer: 'Brand', model: 'Model',
  serial_number: 'Serial', firmware: 'Firmware', location: 'Spot', room_id: 'Room', campus_id: 'Location',
  status: 'Status', notes: 'Notes', ip: 'IP', gateway: 'Gateway', mac: 'MAC', label: 'Label', network_id: 'Network',
  mode: 'Mode', username: 'Username', password: 'Password', hostname: 'Hostname', type_id: 'Model',
  connected_to: 'Connected to', assignment: 'Assignment',
  asset_no: 'Asset #', stage_no: 'Stage #', fixture_id: 'Fixture ID', patch_universe: 'Universe', patch_address: 'Address',
  dmx_channels: 'DMX channels', patch: 'Patch',
};
const NUMBER_FIELDS = ['fixture_id', 'stage_no', 'asset_no', 'dmx_channels'];

export function buildIndex(d) {
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

export function nextNumberIn(data, base, campusId) {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`, 'i');
  let max = 0;
  for (const d of data.devices) {
    if (d.campus_id !== campusId) continue;
    const m = re.exec(d.name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// Dims the network part so the host part stands out: 10.50.10.<b>102</b>
export function ipHtml(addr) {
  const i = addr.lastIndexOf('.');
  return `<span class="ipv"><span class="ip-net">${esc(addr.slice(0, i + 1))}</span><span class="ip-host">${esc(addr.slice(i + 1))}</span></span>`;
}

export function tagDotsHtml(ctx, tags = []) {
  return `<span class="tags">${tags.map((t) => `<i class="tag" data-dep="${t}" title="${esc(ctx.dep[t]?.name || t)}">${esc((ctx.dep[t]?.name || t)[0])}</i>`).join('')}</span>`;
}

export function openDeviceSheet(ctx, host, id, editing = false, preset = {}) {
  const s = host.s;           // the section's state: data, ix, campus
  const load = host.load;     // reloads the section's data
  const campusName = (cid) => ctx.campusById.get(cid)?.short_name || 'Unknown location';
  const tagDots = (tags) => tagDotsHtml(ctx, tags);
  const nextNumber = (base, campusId) => nextNumberIn(s.data, base, campusId);
  let tracker = null;
  let dev = id ? s.ix.dev.get(id) : null;
  let mode = editing ? 'edit' : 'view';
  let creds = null;       // loaded on demand
  let ports = null;       // this item's port patches, loaded on demand
  let typeApi = null;     // the type editor, while creating a type from here
  let showPw = new Set();
  let draft = null;
  let dirty = false;
  let busy = false;
  let confirmDelete = false;

  const sheet = ctx.openSheet({
    label: dev ? dev.name : 'New item',
    className: 'device-sheet',
    beforeClose: () => {
      if (mode === 'type') { typeApi?.cancel(); return false; }
      if (mode === 'edit' && dirty) { showDiscard(); return false; }
      host.setOpen(null);
      return true;
    },
  });
  tracker = {
    id,
    refresh() {
      if (!id) return;
      const fresh = s.ix.dev.get(id);
      if (!fresh) { if (mode === 'view') { sheet.close(true); ctx.toast('That item was deleted'); } return; }
      dev = fresh;
      if (mode === 'view') renderView();
    },
  };
  host.setOpen(tracker);

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
    else if (a === 'edit') startEdit(t.dataset.f);
    else if (a === 'mode') { collect(); draft.dmx_channels = String(t.dataset.n) === String(draft.dmx_channels) ? '' : String(t.dataset.n); dirty = true; renderEdit(); }
    else if (a === 'next-patch') { collect(); fillNextPatch(); }
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
    else if (a === 'qty-' || a === 'qty+') { collect(); draft.qty = clampQty(draft.qty + (a === 'qty+' ? 1 : -1)); renderEdit(); }
    else if (a === 'open-type') { const tid = dev.type_id; host.setOpen(null); sheet.close(true); ctx.openType(tid); }
    else if (a === 'delete') { confirmDelete = true; renderView(); }
    else if (a === 'delete-no') { confirmDelete = false; renderView(); }
    else if (a === 'delete-yes') remove();
  }

  function onInput(e) {
    if (mode !== 'edit') return;
    dirty = true;
    if (e.target.matches('[id$="-addr"], [id$="-mask"]')) { collect(); checkIp(+e.target.closest('.ip-card').dataset.i); }
    if (e.target.matches('#f-patch, #f-dmx_channels, #f-fixture_id')) { collect(); checkNumbers(); }
  }

  function onChange(e) {
    if (mode !== 'edit') return;
    dirty = true;
    const id_ = e.target.id;
    if (id_ === 'f-type') { onTypePicked(e.target.value); return; }
    if (id_ === 'f-qty' || id_ === 'f-numbered' || id_ === 'f-start') { collect(); renderEdit(); return; }
    if (id_ === 'f-campus') { collect(); draft.room_id = ''; draft.ips.forEach((ip) => { ip.network_id = ''; }); followMove(); renderEdit(); }
    else if (id_ === 'f-room') {
      collect();
      followMove();
      renderEdit();
      if (draft.room_id === '__new') $('#f-newroom', sheet.el)?.focus();
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
    const patchable = takesPatch(dev, ty);
    sheet.render(`
      <header class="sh-head">
        <div class="sh-top">${tagDots(dev.departments)}${dev.status !== 'active' ? `<span class="pill">${STATUS[dev.status]}</span>` : ''}
          <button class="icon-btn" data-a="close" aria-label="Close">${icon('close')}</button></div>
        ${ty?.manufacturer ? `<p class="sh-brand">${esc(ty.manufacturer)}</p>` : ''}
        <h2>${esc(dev.name)}</h2>
        <p class="sh-sub">${esc([ty?.name, ty?.category].filter(Boolean).join(' · '))}</p>
      </header>
      <div class="sh-body">
        ${ty?.photo_path ? `<div class="photo-hero is-compact"><img src="${esc(ctx.store.photoUrl(ty.photo_path))}" alt="${esc(typeLabel(ty))}"></div>` : ''}
        ${patchable ? numbersStrip(ty) : ''}
        <section class="ip-list">
          ${ips.length ? ips.map((ip) => ipCard(ip)).join('') : `<div class="ipcard empty-ip"><p>No IP recorded yet.</p><button class="btn" data-a="edit">${icon('plus')}Add an IP</button></div>`}
        </section>
        <section class="block">
          <h3>Where</h3>
          <dl class="kv">
            ${kv('Location', campusName(dev.campus_id))}${kv('Room', room)}${kv('Spot', dev.location)}
          </dl>
        </section>
        <section class="block">
          <h3>This item</h3>
          <dl class="kv">
            ${kv('Model #', ty?.part_number, true)}
            <div><dt>Serial</dt><dd class="${dev.serial_number ? 'mono' : 'muted'}">${dev.serial_number ? esc(dev.serial_number) : `<button class="btn link" data-a="edit" data-f="f-serial_number">Add serial</button>`}</dd></div>
            ${patchable ? '' : kv('Asset #', dev.asset_no)}
            ${kv('Firmware', dev.firmware, true)}${kv('Status', STATUS[dev.status])}
          </dl>
          ${dev.notes ? `<p class="notes">${esc(dev.notes)}</p>` : ''}
        </section>
        ${ty?.ports.length ? `<section class="block">
          <h3>Ports</h3>
          <div id="ports"><p class="muted">Loading…</p></div>
        </section>` : ''}
        ${ty ? `<section class="block type-block">
          <h3>Model</h3>
          <button class="type-link" data-a="open-type">${typeThumb(ctx, ty)}<span><b>${esc(ty.name)}</b><small>${esc([ty.manufacturer, ty.category, ty.part_number].filter(Boolean).join(' · '))}</small></span>${icon('chevron')}</button>
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

  /** Fixture ID, patch, stage # and asset #: big tiles a tech can read at a glance. Tap one to edit it. */
  function numbersStrip(ty) {
    const ch = footprint(dev, ty);
    const rig = s.data.devices.filter((d) => rigKey(d) === rigKey(dev));
    const here = rig.filter((d) => d.type_id === dev.type_id).length;
    const probs = rigProblems(rig, (d) => s.ix.type.get(d.type_id)).get(dev.id) || [];
    const roomName = dev.room_id ? 'this room' : 'this location';
    const end = dev.patch_universe != null && ch > 1 ? fmtPatch(dev.patch_universe, dev.patch_address + ch - 1) : '';
    const tile = (label, value, sub, f, mono = false) => `<button class="num ${value == null || value === '' ? 'is-blank' : ''}" data-a="edit" data-f="${f}">
      <small>${esc(label)}</small><b class="${mono ? 'mono' : ''}">${value == null || value === '' ? 'Add' : esc(value)}</b><em>${esc(sub)}</em></button>`;
    return `<section class="num-strip" aria-label="Lighting numbers">
        ${tile('Fixture ID', dev.fixture_id, 'On the console', 'f-fixture_id')}
        ${tile('Patch', patchOf(dev), ch ? `${ch} ch${end ? ` · to ${end}` : ''}` : 'Channels not set', 'f-patch', true)}
        ${tile('Stage #', dev.stage_no, `of ${here} in ${roomName}`, 'f-stage_no')}
        ${tile('Asset #', dev.asset_no, 'All locations', 'f-asset_no')}
      </section>
      ${problemText(probs.filter(isProblem), (o) => o.name).map((t) => `<p class="warnline">${icon('warn')}${esc(t)}</p>`).join('')}
      ${problemText(probs.filter((p) => !isProblem(p)), (o) => o.name).map((t) => `<p class="warnline soft">${icon('link')}${esc(t)}</p>`).join('')}`;
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
    if (a.entity === 'devices') what = a.action === 'created' ? 'added this item' : a.action === 'deleted' ? 'deleted this item' : 'changed';
    else what = `${a.action === 'created' ? 'added' : a.action === 'deleted' ? 'removed' : 'changed'} ${thing}<b>${esc(a.label || '')}</b>`;
    const changes = { ...(a.changes || {}) };
    if (changes.patch_universe && changes.patch_address) { // one "Patch 1.001 → 2.001" line instead of two
      const [ou, nu] = changes.patch_universe;
      const [oa, na] = changes.patch_address;
      delete changes.patch_universe; delete changes.patch_address;
      changes.patch = [fmtPatch(ou, oa) || null, fmtPatch(nu, na) || null];
    }
    const lines = a.action === 'updated'
      ? Object.entries(changes).map(([k, [o, n]]) => k === 'password'
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
    else if (k === 'type_id') v = s.ix.type.has(v) ? typeLabel(s.ix.type.get(v)) : 'a removed model';
    else if (k === 'departments') v = v.map((t) => ctx.dep[t]?.name || t).join(', ');
    else if (k === 'status') v = STATUS[v] || v;
    else if (k === 'mode') v = MODES[v] || v;
    return `<code>${esc(String(v))}</code>`;
  }

  // ---- edit

  function blankIp() {
    return { id: '', label: '', network_id: '', addr: '', mask: '', gateway: '', mac: '', hostname: '', mode: 'static', notes: '' };
  }

  async function startEdit(focusId) {
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
          ports: Object.fromEntries(ports.map((p) => [p.type_port_id, { connected_to: p.connected_to || '', assignment: p.assignment || '', notes: p.notes || '' }])),
          ...numbersDraft(dev) }
      : { id: '', type_id: '', campus_id: defaultCampus, room_id: '', name: '', departments: [], serial_number: '', firmware: '',
          location: '', status: 'active', notes: '', ips: [blankIp()], creds: [], ports: {}, qty: clampQty(preset.qty || 1), numbering: true, start: '',
          ...numbersDraft(null) };
    if (!dev && preset.type_id) onTypePicked(preset.type_id, true);
    renderEdit();
    const target = focusId && $('#' + focusId, sheet.el);
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus(); }
    else $(draft.type_id ? '#f-name' : '#f-type', sheet.el)?.focus();
  }

  /** The numbers as the editor shows them (text, so blank means blank). */
  function numbersDraft(d) {
    const str = (v) => (v == null ? '' : String(v));
    return { fixture_id: str(d?.fixture_id), patch: d ? patchOf(d) : '', dmx_channels: str(d?.dmx_channels),
      stage_no: str(d?.stage_no), asset_no: str(d?.asset_no) };
  }

  /** Moving to another room: the patch and fixture ID belonged to the old console. Moving back restores them. */
  function followMove() {
    if (!dev) return;
    const home = draft.campus_id === dev.campus_id && (draft.room_id || '') === (dev.room_id || '');
    const was = numbersDraft(dev);
    if (home) Object.assign(draft, { fixture_id: was.fixture_id, patch: was.patch, stage_no: was.stage_no });
    else Object.assign(draft, { fixture_id: '', patch: '', stage_no: '' });
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
    const bulk = !dev && draft.qty > 1;
    const names = bulk ? bulkNames() : [];
    const locs = [...new Set(s.data.devices.filter((d) => d.campus_id === campusId).map((d) => d.location).filter(Boolean))].sort();
    const scroll = $('.sh-body', sheet.el)?.scrollTop || 0;
    sheet.render(`
      <header class="sh-head">
        <div class="sh-top"><span class="eyebrow">${dev ? 'Edit item' : 'New item'}</span>
          <button class="icon-btn" data-a="cancel" aria-label="Close">${icon('close')}</button></div>
        <h2>${esc(draft.name || (ty ? ty.name : dev ? dev.name : 'New item'))}</h2>
      </header>
      <form class="sh-body form" id="dev-form" novalidate autocomplete="off">
        <label class="field"><span>Model <b class="req">required</b></span><select id="f-type">
          <option value="" ${draft.type_id ? '' : 'selected'}>Choose a model…</option>
          ${[...typeGroups.keys()].sort().map((k) => `<optgroup label="${esc(k)}">${typeGroups.get(k).map((t) => `<option value="${t.id}" ${t.id === draft.type_id ? 'selected' : ''}>${esc(typeLabel(t))}</option>`).join('')}</optgroup>`).join('')}
          <option value="__new">＋ New model…</option>
        </select>
        ${ty ? `<small class="hint">${esc([ty.category, ty.part_number, ty.ports.length ? plural(ty.ports.length, 'port') : null].filter(Boolean).join(' · ') || 'Specs and ports come from the model.')}</small>` : `<small class="hint">The product this is, like Hoglet 4. Its specs and ports come from the model.</small>`}
        ${oldPatches ? `<small class="hint warn-text">What was recorded on the old model’s ports will be cleared when you save.</small>` : ''}</label>
        ${!dev ? `<div class="qty-row">
          <div class="field"><span>How many</span>
            <div class="stepper">
              <button type="button" class="icon-btn" data-a="qty-" aria-label="One fewer" ${draft.qty <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
              <input id="f-qty" class="mono" inputmode="numeric" value="${draft.qty}" aria-label="How many to add">
              <button type="button" class="icon-btn" data-a="qty+" aria-label="One more">${icon('plus')}</button>
            </div>
          </div>
          ${bulk ? `<label class="check"><input type="checkbox" id="f-numbered" ${draft.numbering ? 'checked' : ''}><span>Number the names</span></label>` : ''}
        </div>` : ''}
        <label class="field"><span>${bulk ? 'Name for all of them' : 'Name'}</span><input id="f-name" value="${esc(draft.name)}" placeholder="${esc(bulk && ty ? bulkBase() : ty ? ty.name : 'FOH Switch, Camera 2, Stage Box…')}"></label>
        ${bulk && draft.numbering ? `<div class="grid2">
          <label class="field"><span>Start numbering at</span><input id="f-start" class="mono" inputmode="numeric" value="${esc(draft.start)}" placeholder="${nextNumber(bulkBase(), draft.campus_id)}"></label>
          <p class="bulk-preview">${esc(names[0])}<i>→</i>${esc(names[names.length - 1])}</p>
        </div>` : ''}
        ${bulk ? `<p class="fine">Serial numbers, IPs and what's plugged into each port get filled in on each one after they're added.</p>` : ''}
        <div class="field"><span>Sections <b class="req">at least one</b></span>
          <div class="tag-picker">${ctx.departments.map((d) => `<button type="button" class="chip dep big" data-a="tag" data-tag="${d.slug}" data-dep="${d.slug}" aria-pressed="${draft.departments.includes(d.slug)}"><i class="dot"></i>${esc(d.name)}</button>`).join('')}</div>
        </div>

        <fieldset class="group"><legend>Where</legend>
          <div class="grid2">
            <label class="field"><span>Location</span><select id="f-campus">${ctx.campuses.map((c) => `<option value="${c.id}" ${c.id === campusId ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select></label>
            <label class="field"><span>Room</span><select id="f-room">
              <option value="">No room</option>
              ${rooms.map((r) => `<option value="${r.id}" ${r.id === draft.room_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
              <option value="__new" ${draft.room_id === '__new' ? 'selected' : ''}>＋ New room…</option>
            </select></label>
          </div>
          ${draft.room_id === '__new' ? `<div class="inline-add"><input id="f-newroom" placeholder="Worship Center, North Auditorium, Kids…" aria-label="New room name"><button type="button" class="btn" data-a="add-room">Add room</button></div>` : ''}
          <label class="field"><span>Spot in the room</span><input id="f-location" value="${esc(draft.location)}" list="dl-loc" placeholder="FOH rack, Stage rack, Catwalk…"></label>
        </fieldset>

        ${bulk || !takesPatch({ departments: draft.departments }, ty) ? '' : numbersFieldset(ty)}

        ${bulk ? '' : `<fieldset class="group"><legend>IP addresses</legend>
          <div class="ip-edit">${draft.ips.map((ip, i) => ipEditCard(ip, i, nets)).join('')}</div>
          <button type="button" class="btn" data-a="add-ip">${icon('plus')}${draft.ips.length ? 'Add another IP' : 'Add an IP'}</button>
        </fieldset>`}

        ${ty?.ports.length && !bulk ? `<fieldset class="group"><legend>Ports <span class="count">${ty.ports.length}</span></legend>
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

        ${bulk || takesPatch({ departments: draft.departments }, ty) ? '' : numbersFieldset(ty)}

        ${bulk ? '' : `<fieldset class="group"><legend>This item</legend>
          <div class="grid2">
            <label class="field"><span>Serial number</span><input id="f-serial_number" class="mono" value="${esc(draft.serial_number)}" autocapitalize="characters" spellcheck="false" placeholder="From the label on the unit"></label>
            <div class="field"><span>Model number</span><p class="ro-box mono">${ty?.part_number ? esc(ty.part_number) : '<i>Not set on the model</i>'}</p><small class="hint">Comes from the model, the same for every one.</small></div>
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
        </fieldset>`}

        <datalist id="dl-loc">${locs.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
        <datalist id="dl-iplabel">${IP_LABELS.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
        <datalist id="dl-mask">${MASKS.map((v) => `<option value="${v}">`).join('')}</datalist>
      </form>
      <footer class="sh-foot">
        <p class="form-msg ${error ? 'bad' : ''}" role="status">${esc(error)}</p>
        <span class="spacer"></span>
        <button class="btn" data-a="cancel">Cancel</button>
        <button class="btn primary" data-a="save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : dev ? 'Save changes' : bulk ? `Add ${draft.qty} items` : 'Add item'}</button>
      </footer>`);
    $('#dev-form', sheet.el).addEventListener('submit', (e) => { e.preventDefault(); save(); });
    const body = $('.sh-body', sheet.el);
    if (body) body.scrollTop = scroll;
    draft.ips.forEach((_, i) => checkIp(i));
    checkNumbers();
  }

  function numbersFieldset(ty) {
    const probe = { departments: draft.departments };
    const patchable = takesPatch(probe, ty);
    const moved = dev && (draft.campus_id !== dev.campus_id || (draft.room_id || '') !== (dev.room_id || ''));
    const retyped = dev && draft.type_id !== dev.type_id;
    const modes = ty?.dmx_modes || [];
    const modelCh = footprint({}, ty);
    const auto = (what) => (dev && !moved && !retyped ? '' : what);
    return `<fieldset class="group"><legend>Numbers</legend>
      ${patchable ? `<div class="grid2">
          <label class="field"><span>Fixture ID</span><input id="f-fixture_id" class="mono" inputmode="numeric" value="${esc(draft.fixture_id)}" placeholder="401" autocomplete="off">
            <small class="hint">Its number on the console</small></label>
          <div class="field"><label for="f-patch">Patch</label>
            <div class="with-btn"><input id="f-patch" class="mono" inputmode="decimal" value="${esc(draft.patch)}" placeholder="1.333" autocapitalize="off" spellcheck="false" autocomplete="off">
              <button type="button" class="btn small" data-a="next-patch" title="Fill in the next free address that fits">${icon('wand')}Next free</button></div>
            <p class="ip-check" id="patch-check" aria-live="polite"></p></div>
        </div>
        <div class="field"><label for="f-dmx_channels">DMX channels</label>
          <div class="mode-pick">
            <input id="f-dmx_channels" class="mono short" inputmode="numeric" value="${esc(draft.dmx_channels)}" placeholder="${modelCh || ''}" autocomplete="off">
            ${modes.length > 1 ? `<span class="mode-chips">${modes.map((n) => `<button type="button" class="chip small ${!draft.dmx_channels && n === modelCh ? 'is-default' : ''}" data-a="mode" data-n="${n}" aria-pressed="${String(n) === String(draft.dmx_channels)}">${n}</button>`).join('')}</span>` : ''}
          </div>
          <small class="hint">${modelCh ? `Uses the model’s ${modelCh}-channel mode unless you set this one differently.` : modes.length ? 'Pick the mode this one is set to.' : 'How many channels this one takes in its DMX mode.'}</small></div>` : ''}
      <div class="grid2">
        ${patchable ? `<label class="field"><span>Stage #</span><input id="f-stage_no" class="mono" inputmode="numeric" value="${esc(draft.stage_no)}" placeholder="${auto('Next in the room')}" autocomplete="off">
          <small class="hint">1 to however many of this model are in this room</small></label>` : ''}
        <label class="field"><span>Asset #</span><input id="f-asset_no" class="mono" inputmode="numeric" value="${esc(draft.asset_no)}" placeholder="${auto('Next for the model')}" autocomplete="off">
          <small class="hint">This model across every location. It stays with the unit.</small></label>
      </div>
      ${moved && (dev.fixture_id != null || dev.patch_universe != null) ? `<p class="fine warn-text">Its patch and fixture ID belonged to the old room’s console, so they’re cleared. Add new ones if it’s patched here.</p>` : ''}
      ${moved ? `<p class="fine">It gets the next stage # in its new room.</p>` : ''}
    </fieldset>`;
  }

  /** Live check under the patch: what it covers and whether it collides with anything in this room. */
  function checkNumbers() {
    const box = $('#patch-check', sheet.el);
    if (!box) return;
    const ty = s.ix.type.get(draft.type_id);
    const p = parsePatch(draft.patch);
    const ch = Number(draft.dmx_channels) || footprint({}, ty);
    const msgs = [];
    if (p.error) msgs.push(['bad', p.error]);
    else if (!p.empty) {
      const end = p.address + (ch || 1) - 1;
      if (end > 512) msgs.push(['bad', `With ${ch} channels it runs past 512. Start at ${fmtPatch(p.universe, 513 - ch)} or lower.`]);
      const me_ = { id: draft.id || '__new', type_id: draft.type_id, campus_id: draft.campus_id, room_id: draft.room_id || null,
        patch_universe: p.universe, patch_address: p.address, dmx_channels: ch || null, fixture_id: Number(draft.fixture_id) || null, stage_no: null };
      const rig = [...s.data.devices.filter((d) => d.id !== draft.id && rigKey(d) === rigKey(me_)), me_];
      const probs = (rigProblems(rig, (d) => s.ix.type.get(d.type_id)).get(me_.id) || []).filter((x) => x.kind !== 'stage');
      for (const line of problemText(probs.filter(isProblem), (o) => o.name)) msgs.push(['bad', line + '.']);
      for (const line of problemText(probs.filter((x) => !isProblem(x)), (o) => o.name)) msgs.push(['soft', line + '.']);
      if (!msgs.some(([k]) => k === 'bad')) msgs.push(['ok', `Universe ${p.universe}, ${ch > 1 ? `addresses ${p.address}–${end}` : `address ${p.address}`}${ch ? '' : '. Set its channels to check for overlaps'}.`]);
    } else if (draft.fixture_id) {
      const rig = s.data.devices.filter((d) => d.id !== draft.id && d.campus_id === draft.campus_id && (d.room_id || '') === (draft.room_id || ''));
      const same = rig.filter((d) => String(d.fixture_id) === String(draft.fixture_id));
      if (same.length) msgs.push(['bad', `Fixture ID ${draft.fixture_id} is already ${same.map((d) => d.name).join(', ')}.`]);
    }
    box.innerHTML = msgs.map(([k, m]) => `<span class="${k}">${k === 'ok' ? icon('check') : icon('warn')}${esc(m)}</span>`).join('');
  }

  function fillNextPatch() {
    const ty = s.ix.type.get(draft.type_id);
    const ch = Number(draft.dmx_channels) || footprint({}, ty) || 1;
    const rig = s.data.devices.filter((d) => d.id !== draft.id && d.campus_id === draft.campus_id && (d.room_id || '') === (draft.room_id || ''));
    const typeOf = (d) => s.ix.type.get(d.type_id);
    const cur = parsePatch(draft.patch);
    const start = cur.universe || Math.max(1, ...rig.filter((d) => d.type_id === draft.type_id && d.patch_universe).map((d) => d.patch_universe));
    for (let u = start; u <= MAX_UNIVERSE; u++) {
      const a = nextFreeAddress(rig, typeOf, u, ch);
      if (a) { draft.patch = fmtPatch(u, a); dirty = true; renderEdit(); return; }
    }
    ctx.toast('No room left on any universe', 'bad');
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
    for (const k of ['name', 'location', 'serial_number', 'firmware', 'notes', 'status']) if (f('f-' + k)) draft[k] = f('f-' + k).value;
    for (const k of NUMBER_FIELDS) if (f('f-' + k)) draft[k] = f('f-' + k).value.trim();
    if (f('f-patch')) draft.patch = f('f-patch').value.trim();
    if (f('f-qty')) draft.qty = clampQty(parseInt(f('f-qty').value, 10));
    if (f('f-numbered')) draft.numbering = f('f-numbered').checked;
    if (f('f-start')) draft.start = f('f-start').value.replace(/\D/g, '');
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

  /** Names already used for this type here: "R2X Wash 1…6" makes the next batch R2X Wash 7, 8… */
  function seriesBase() {
    const counts = new Map();
    for (const d of s.data.devices) {
      if (d.type_id !== draft.type_id || d.campus_id !== draft.campus_id) continue;
      const m = /^(.*\S)\s+\d+$/.exec(d.name.trim());
      if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    let best = null;
    for (const [k, n] of counts) if (!best || n > counts.get(best)) best = k;
    return best;
  }
  function bulkBase() {
    return (draft.name || '').trim() || seriesBase() || s.ix.type.get(draft.type_id)?.name || 'Item';
  }
  function bulkNames() {
    const base = bulkBase();
    const start = draft.start !== '' ? Number(draft.start) : nextNumber(base, draft.campus_id);
    return Array.from({ length: draft.qty }, (_, i) => (draft.numbering ? `${base} ${start + i}` : base));
  }

  /** Picking a type: the name and tags follow it unless they were changed by hand. */
  function onTypePicked(v, initial = false) {
    if (!initial) collect();
    if (v === '__new') { startNewType(); return; }
    const prev = s.ix.type.get(draft.type_id);
    const next = s.ix.type.get(v);
    draft.type_id = v;
    if (dev) Object.assign(draft, v === dev.type_id ? { asset_no: String(dev.asset_no ?? ''), stage_no: String(dev.stage_no ?? '') } : { asset_no: '', stage_no: '' });
    if (next) {
      if (prev && draft.name.trim() === prev.name) draft.name = '';
      const same = prev && draft.departments.length === prev.departments.length && draft.departments.every((t) => prev.departments.includes(t));
      if (!draft.departments.length || same) draft.departments = [...next.departments];
      const blankOnly = draft.ips.every((ip) => !ip.addr && !ip.mac && !ip.label && !ip.network_id && !ip.gateway);
      if (!dev && next.networked === false && blankOnly) draft.ips = [];
      if (!dev && next.networked !== false && !draft.ips.length) draft.ips = [blankIp()];
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
    if (!draft.type_id) return err('Pick a model, or choose “New model…” to add one.', '#f-type');
    if (!draft.departments.length) return err('Pick at least one section: Audio, Video, Lighting or Network.');
    if (draft.room_id === '__new') return err('Finish adding the new room, or pick “No room”.', '#f-newroom');
    if (!dev && draft.qty > 1) return saveMany(err);

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
    const numbers = {};
    {
      const ty = s.ix.type.get(draft.type_id);
      const whole = (k, label, max = 99999999) => {
        const v = draft[k];
        if (v === '' || v == null) return null;
        if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) throw [`${label} should be a whole number${max < 99999999 ? ` from 1 to ${max}` : ''}.`, `#f-${k}`];
        return Number(v);
      };
      try {
        const want = { fixture_id: whole('fixture_id', 'Fixture ID'), dmx_channels: whole('dmx_channels', 'DMX channels', 512),
          stage_no: whole('stage_no', 'Stage #'), asset_no: whole('asset_no', 'Asset #') };
        const p = parsePatch(draft.patch);
        if (p.error) throw [p.error, '#f-patch'];
        want.patch_universe = p.empty ? null : p.universe;
        want.patch_address = p.empty ? null : p.address;
        const ch = want.dmx_channels || footprint({}, ty) || 1;
        if (want.patch_address && want.patch_address + ch - 1 > 512) throw [`With ${ch} channels, a patch at ${fmtPatch(want.patch_universe, want.patch_address)} runs past 512. Start at ${fmtPatch(want.patch_universe, 513 - ch)} or lower.`, '#f-patch'];
        for (const [k, v] of Object.entries(want)) {
          if ((k === 'stage_no' || k === 'asset_no') && v == null) continue; // blank: the next number, filled in for you
          if (!dev ? v != null : v !== (dev[k] ?? null)) numbers[k] = v;
        }
        if ('patch_universe' in numbers || 'patch_address' in numbers) Object.assign(numbers, { patch_universe: want.patch_universe, patch_address: want.patch_address });
      } catch (x) {
        if (Array.isArray(x)) return err(x[0], x[1]);
        throw x;
      }
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
      numbers,
    };
    busy = true; renderEdit();
    try {
      const newId = await ctx.store.saveDevice(payload);
      busy = false; dirty = false;
      ctx.toast(`Saved ${draft.name.trim() || typeLabel(s.ix.type.get(draft.type_id))}`);
      await load(true);
      id = newId; tracker.id = newId;
      dev = s.ix.dev.get(newId);
      creds = null; ports = null; mode = 'view';
      if (dev) renderView(); else sheet.close(true);
    } catch (e) {
      busy = false; renderEdit(e.message);
    }
  }

  async function saveMany(err) {
    const ty = s.ix.type.get(draft.type_id);
    const names = bulkNames();
    busy = true; renderEdit();
    try {
      const n = await ctx.store.addDevices({
        device: { type_id: draft.type_id, campus_id: draft.campus_id, room_id: draft.room_id || '', location: draft.location,
          departments: draft.departments, status: 'active', notes: '' },
        names,
      });
      busy = false; dirty = false;
      ctx.toast(ty?.networked === false && !location.hash.startsWith('#gear') ? `Added ${n} ${ty.name}. They're listed under Gear.` : `Added ${n} ${ty?.name || 'items'}`);
      host.setOpen(null);
      sheet.close(true);
      load(true);
    } catch (e) {
      busy = false; err(e.message);
    }
  }

  async function remove() {
    try {
      await ctx.store.deleteDevice(dev.id);
      ctx.toast(`Deleted ${dev.name}`);
      host.setOpen(null);
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

export const clampQty = (n) => Math.max(1, Math.min(200, Number.isFinite(n) ? n : 1));

export function kv(label, value, mono = false) {
  if (value == null || value === '') return '';
  return `<div><dt>${esc(label)}</dt><dd class="${mono ? 'mono' : ''}">${esc(value)}</dd></div>`;
}
