// A model's detail panel and editor, shared by Network and Gear.
// The host section passes its state (data + index) and a way to reload it.

// Network: the IP sheet for every campus. Devices grouped by network, with
// audio / video / lighting filters, search, conflict checks and full editing.

import {
  esc, icon, $, $$, debounce, storage, store, ipToInt, intToIp, splitInet, prefixToMask, maskToPrefix,
  parseCidr, inCidr, nextFreeIp, normMac, timeAgo, plural, copyText,
} from '../util.js';
import { typeEditor, typeLabel, sortPorts, portMeta, typeThumb, CATEGORIES } from './types.js';
import { wireDropdown } from '../picker.js';
import { roomSelectHtml, groupChoices, roomPath } from '../rooms.js';
import { osOf, runsSoftware, installsByDevice, logoHtml, familyLogo, asOf, today, versionText } from '../software.js';
import {
  takesPatch, parsePatch, fmtPatch, patchOf, footprint, rigKey, rigProblems, problemText, nextFreeAddress, isProblem, MAX_UNIVERSE,
  assetTag, parseAsset, itemLabel, isFixtureType, ASSET_MAX,
} from '../lighting.js';

export const IP_LABELS = ['Management', 'Control', 'Dante Primary', 'Dante Secondary', 'Art-Net / sACN', 'NDI', 'Video', 'House', 'Production'];
export const MASKS = ['255.255.255.0', '255.255.0.0', '255.0.0.0', '255.255.255.128', '255.255.254.0', '255.255.252.0'];
// How an item is doing. A colored pill on every item; tap it to change.
export const STATUS = { active: 'In use', spare: 'Ready', update: 'Needs update', check: 'Needs a check', broken: 'Broken', repair: 'In repair', retired: 'Retired' };
export const STATUS_HINT = {
  active: 'On a rig and working', spare: 'Works fine, not in use right now', update: 'Works, but needs an upgrade or a software update', check: 'Something seems off. Look at it soon',
  broken: 'Doesn’t work', repair: 'Out being fixed', retired: 'Gone for good',
};
/** The little colored pill. */
export const statusPill = (st) => `<span class="st st-${esc(st)}"><i></i>${esc(STATUS[st] || st)}</span>`;
export const MODES = { static: 'Static', reserved: 'DHCP reservation', dhcp: 'DHCP' };
/** Projectors: which side of the screen they're on. A fact about the install, so it's on the item. */
export const PROJECTION = { front: 'Front projection', rear: 'Rear projection' };
export const isProjectorType = (t) => /projector/i.test(String(t?.category || ''));
export const FIELD = {
  name: 'Name', departments: 'Departments', category: 'Category', manufacturer: 'Brand', model: 'Model',
  serial_number: 'Serial', firmware: 'Firmware / OS', location: 'Spot', room_id: 'Room', campus_id: 'Location',
  status: 'Status', notes: 'Notes', ip: 'IP', gateway: 'Gateway', mac: 'MAC', label: 'Label', network_id: 'Network',
  mode: 'Mode', username: 'Username', password: 'Password', hostname: 'Hostname', type_id: 'Model',
  connected_to: 'Connected to', assignment: 'Assignment',
  asset_no: 'Asset #', stage_no: 'Stage #', fixture_id: 'Fixture ID', patch_universe: 'Universe', patch_address: 'Address',
  dmx_channels: 'DMX channels', patch: 'Patch ID', projection: 'Projection', position_id: 'Hung on',
  positions: 'Operator position', used_as: 'Used as', area: 'Area',
  version: 'Version', build: 'Build', seen_on: 'As of',
};
// What an item is for. Operator position: the jobs it serves (CG, Director, Audio…),
// one or more. Used as: what this one is, within its kind (a Display used as a Stage
// display). Both on the item, so filters stack.
// Where it is, apart from that: Location (campus) › Room › Area (Front of house,
// Stage, Backstage…) › Spot (FOH rack…). An operator position is a job, not a place.
const SUGGEST_POSITIONS = ['Audio', 'CG', 'Director', 'Lighting'];
export const SUGGEST_AREAS = ['Front of house', 'Stage', 'Backstage', 'House'];
/** Areas in their usual order: front of house, stage, backstage, house, then the rest A–Z. */
export const areaRank = (a) => { const i = SUGGEST_AREAS.findIndex((x) => posKey(x) === posKey(a)); return i < 0 ? SUGGEST_AREAS.length : i; };
export const byArea = (a, b) => areaRank(a) - areaRank(b) || String(a).localeCompare(String(b));
const SUGGEST_USES = { Display: ['Stage display', 'Confidence monitor', 'Computer monitor', 'LED wall'] };
export const posKey = (p) => String(p || '').trim().toLowerCase();
/** Every position in use, most-used first, each written the way it's written most. */
export function knownPositions(s) {
  const seen = new Map();
  for (const d of s.data.devices) for (const p of d.positions || []) {
    const k = posKey(p);
    const e = seen.get(k) || { n: 0, forms: new Map() };
    e.n += 1; e.forms.set(p.trim(), (e.forms.get(p.trim()) || 0) + 1);
    seen.set(k, e);
  }
  const list = [...seen.values()].sort((a, b) => b.n - a.n).map((e) => [...e.forms].sort((a, b) => b[1] - a[1])[0][0]);
  for (const p of SUGGEST_POSITIONS) if (!seen.has(posKey(p))) list.push(p);
  return list;
}
/** What items of this category are used as (plus the usual ones for displays). */
export function knownUses(s, category) {
  const seen = new Map();
  for (const d of s.data.devices) {
    if (!d.used_as || (s.ix.type.get(d.type_id)?.category || '') !== (category || '')) continue;
    const k = posKey(d.used_as);
    if (!seen.has(k)) seen.set(k, { label: d.used_as.trim(), n: 0 });
    seen.get(k).n += 1;
  }
  const list = [...seen.values()].sort((a, b) => b.n - a.n).map((e) => e.label);
  for (const u of SUGGEST_USES[category] || []) if (!seen.has(posKey(u))) list.push(u);
  return list;
}
/** Every area in use (each written the way it's written most), plus the usual ones, in the usual order. */
export function knownAreas(s) {
  const seen = new Map();
  for (const d of s.data.devices) {
    if (!d.area?.trim()) continue;
    const k = posKey(d.area);
    const e = seen.get(k) || new Map();
    e.set(d.area.trim(), (e.get(d.area.trim()) || 0) + 1);
    seen.set(k, e);
  }
  const list = [...seen.values()].map((forms) => [...forms].sort((a, b) => b[1] - a[1])[0][0]);
  for (const a of SUGGEST_AREAS) if (!seen.has(posKey(a))) list.push(a);
  return list.sort(byArea);
}
/** "cg" → "CG" when CG is already in use somewhere, so the same position isn't spelled two ways. */
const canonical = (list, v) => list.find((x) => posKey(x) === posKey(v)) || v.trim();
/** Positions (battens, trusses) in a room, front to back. */
export const positionsIn = (s, roomId) => (roomId ? (s.data.positions || []).filter((p) => p.room_id === roomId)
  .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, undefined, { numeric: true })) : []);
const NUMBER_FIELDS = ['fixture_id', 'asset_no', 'dmx_channels'];

export function buildIndex(d) {
  const ix = {
    dev: new Map(d.devices.map((x) => [x.id, x])),
    net: new Map(d.networks.map((x) => [x.id, x])),
    room: new Map(d.rooms.map((x) => [x.id, x])),
    pos: new Map((d.positions || []).map((x) => [x.id, x])),
    type: new Map(d.types.map((x) => [x.id, { ...x, ports: sortPorts(x.ports) }])),
    installs: installsByDevice(d), // device id -> its software, each with its title (sw)
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
  let unknownPick = false; // choosing what kind of thing an item is, model unknown
  let unknownCat = 'Projector';
  let showPw = new Set();
  let draft = null;
  let dirty = false;
  let busy = false;
  let confirmDelete = false;
  let swForm = null; // the Software form open on this item: { id (null when adding), software_id, version… }

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
      if (mode === 'view') { swRead(); renderView(); } // keep what's typed in the Software form
    },
  };
  host.setOpen(tracker);

  if (mode === 'edit') startEdit(); else renderView();

  sheet.el.addEventListener('click', onClick);
  sheet.el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || mode !== 'edit') return;
    if (e.target.id === 'f-newpos') { e.preventDefault(); addPosition(); }
    else if (e.target.id === 'f-newuse') { e.preventDefault(); const v = e.target.value.trim(); if (v) setUse(v); }
  });
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
    else if (a === 'proj') { collect(); draft.projection = draft.projection === t.dataset.v ? null : t.dataset.v; dirty = true; renderEdit(); }
    else if (a === 'posn') {
      collect();
      const k = posKey(t.dataset.v);
      draft.positions = draft.positions.some((x) => posKey(x) === k) ? draft.positions.filter((x) => posKey(x) !== k) : [...draft.positions, t.dataset.v];
      dirty = true; renderEdit();
    }
    else if (a === 'add-posn') addPosition();
    else if (a === 'use') setUse(t.dataset.v);
    else if (a === 'area') setArea(t.dataset.v);
    else if (a === 'add-area') { const v = $('#f-newarea', sheet.el)?.value.trim(); if (v) { setArea(v); } else $('#f-newarea', sheet.el)?.focus(); }
    else if (a === 'add-use') { const v = $('#f-newuse', sheet.el)?.value.trim(); if (v) { setUse(v); } else $('#f-newuse', sheet.el)?.focus(); }
    else if (a === 'tag') { collect(); const tg = t.dataset.tag; draft.departments = draft.departments.includes(tg) ? draft.departments.filter((x) => x !== tg) : [...draft.departments, tg]; dirty = true; renderEdit(); }
    else if (a === 'next-ip') { collect(); fillNextIp(+t.dataset.i); }
    else if (a === 'add-room') addRoom();
    else if (a === 'use-unknown') useUnknown();
    else if (a === 'unknown-cancel') { collect(); unknownPick = false; renderEdit(); }
    else if (a === 'qty-' || a === 'qty+') { collect(); draft.qty = clampQty(draft.qty + (a === 'qty+' ? 1 : -1)); renderEdit(); }
    else if (a === 'open-type') { const tid = dev.type_id; host.setOpen(null); sheet.close(true); ctx.openType(tid); }
    else if (a === 'sw-add') swStart(null);
    else if (a === 'sw-edit') swStart(t.dataset.id);
    else if (a === 'sw-pick') { swRead(); swForm.software_id = t.dataset.id; swForm.error = ''; renderView(); $(t.dataset.id === 'new' ? '#sw-name' : '#sw-version', sheet.el)?.focus(); }
    else if (a === 'sw-cancel') { swForm = null; renderView(); }
    else if (a === 'sw-save') swSave();
    else if (a === 'sw-rm') { swRead(); swForm.confirm = true; renderView(); }
    else if (a === 'sw-rm-yes') swRemove();
    else if (a === 'delete') { confirmDelete = true; renderView(); }
    else if (a === 'delete-no') { confirmDelete = false; renderView(); }
    else if (a === 'delete-yes') remove();
  }

  function onInput(e) {
    if (mode !== 'edit') return;
    dirty = true;
    if (e.target.matches('[id$="-addr"], [id$="-mask"]')) { collect(); checkIp(+e.target.closest('.ip-card').dataset.i); }
    if (e.target.matches('#f-patch, #f-dmx_channels, #f-fixture_id')) { collect(); checkNumbers(); }
    if (e.target.matches('#f-location') && !draft.area) fillAreaFromSpot(e.target.value);
  }

  /** A spot that's already somewhere in this room brings its area along ("FOH rack" → Front of house). */
  function fillAreaFromSpot(spot) {
    const k = posKey(spot);
    if (!k) return;
    const room = $('#f-room', sheet.el)?.value || '';
    const twin = s.data.devices.find((d) => d.id !== draft.id && d.area && posKey(d.location) === k && (d.room_id || '') === room && d.campus_id === $('#f-campus', sheet.el)?.value);
    if (!twin) return;
    draft.area = canonical(knownAreas(s), twin.area);
    $$('[data-a="area"]', sheet.el).forEach((b) => b.setAttribute('aria-pressed', String(posKey(b.dataset.v) === posKey(draft.area))));
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
    const room = roomPath(s.ix.room.get(dev.room_id), s.ix.room);
    const by = (pid, name) => ctx.people.get(pid)?.full_name || name || 'Someone';
    const ty = s.ix.type.get(dev.type_id);
    const patchable = takesPatch(dev, ty);
    const computer = runsSoftware(dev, ty);
    const installed = s.ix.installs.get(dev.id) || [];
    sheet.render(`
      <header class="sh-head">
        <div class="sh-top">${tagDots(dev.departments)}
          <button type="button" class="st st-${esc(dev.status)} st-btn" id="d-status" aria-haspopup="listbox"><i></i><span class="dd-value"></span>${icon('down')}</button>
          <button class="icon-btn" data-a="close" aria-label="Close">${icon('close')}</button></div>
        ${ty?.manufacturer ? `<p class="sh-brand">${esc(ty.manufacturer)}</p>` : ''}
        <h2>${esc(isFixtureType(ty) ? ty.name : dev.name)}</h2>
        <p class="sh-sub">${esc((isFixtureType(ty) ? [ty.category, assetTag(dev.asset_no)] : [ty?.name, ty?.category]).filter(Boolean).join(' · '))}</p>
      </header>
      <div class="sh-body">
        ${ty?.photo_path ? `<div class="photo-hero is-compact"><img src="${esc(ctx.store.photoUrl(ty.photo_path))}" alt="${esc(typeLabel(ty))}"></div>` : ''}
        ${ty?.unknown ? `<p class="warnline soft unknown-line">${icon('warn')}<span>We don’t know the model yet. Find out what it is, then tap Edit and pick the real model.</span></p>` : ''}
        ${patchable ? numbersStrip(ty) : ''}
        <section class="ip-list">
          ${ips.length ? ips.map((ip) => ipCard(ip)).join('') : `<div class="ipcard empty-ip"><p>No IP recorded yet.</p><button class="btn" data-a="edit">${icon('plus')}Add an IP</button></div>`}
        </section>
        <section class="block">
          <h3>Where</h3>
          <dl class="kv">
            ${kv('Location', campusName(dev.campus_id))}${kv('Room', room)}${dev.area ? kv('Area', dev.area) : ''}${kv('Spot', dev.location)}
            ${isProjectorType(ty) ? kv('Projection', PROJECTION[dev.projection] || 'Not set yet') : ''}
            ${dev.position_id && s.ix.pos.get(dev.position_id) ? kv('Hung on', s.ix.pos.get(dev.position_id).name)
              : patchable && positionsIn(s, dev.room_id).length ? kv('Hung on', 'Not on a position') : ''}
            ${dev.positions?.length ? kv('Operator position', dev.positions.join(', ')) : ''}
            ${dev.used_as ? kv('Used as', dev.used_as) : ''}
          </dl>
        </section>
        <section class="block">
          <h3>This item</h3>
          <dl class="kv">
            ${kv('Model #', ty?.part_number, true)}
            <div><dt>Serial</dt><dd class="${dev.serial_number ? 'mono' : 'muted'}">${dev.serial_number ? esc(dev.serial_number) : `<button class="btn link" data-a="edit" data-f="f-serial_number">Add serial</button>`}</dd></div>
            ${patchable ? '' : kv('Asset #', assetTag(dev.asset_no), true)}
            ${computer && osOf(dev) ? '' : kv(computer ? 'Firmware / OS' : 'Firmware', dev.firmware, true)}
          </dl>
          ${dev.notes ? `<p class="notes">${esc(dev.notes)}</p>` : ''}
        </section>
        ${computer || installed.length ? softwareBlock(installed) : ''}
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
        <p class="stamp">Added by ${esc(by(dev.created_by, dev.created_by_name))} ${esc(timeAgo(dev.created_at))}${dev.updated_at && dev.updated_at !== dev.created_at ? ` · edited by ${esc(by(dev.updated_by, dev.updated_by_name))} ${esc(timeAgo(dev.updated_at))}` : ''}</p>
      </div>
      <footer class="sh-foot">
        ${confirmDelete
          ? `<span class="confirm-text">Delete ${esc(dev.name)} and its IPs?</span><button class="btn" data-a="delete-no">Keep it</button><button class="btn danger" data-a="delete-yes">Delete</button>`
          : `<button class="btn ghost danger-text" data-a="delete">${icon('trash')}Delete</button><span class="spacer"></span><button class="btn primary" data-a="edit">${icon('edit')}Edit</button>`}
      </footer>`);
    loadHistory();
    if (ty?.ports.length) loadPorts(ty);
    wireStatus();
  }

  /** Software: the OS (from Firmware / OS) and each title with its version. Tap one to change
   *  it, or add one; it saves right away, like the status. */
  function softwareBlock(list) {
    const os = osOf(dev);
    const editing = swForm && !swForm.id ? null : swForm;
    const rowHtml = (i) => (editing?.id === i.id ? swFormHtml(i) : `<li><button class="sw-item" data-a="sw-edit" data-id="${i.id}">
        ${logoHtml(i.sw.name, i.sw.logo, 'sm')}
        <span class="sw-item-text"><b>${esc(i.sw.name)}</b><small>${esc([i.sw.maker, i.seen_on ? `as of ${asOf(i.seen_on)}` : null].filter(Boolean).join(' · '))}</small>${i.notes ? `<small class="sw-item-note">${esc(i.notes)}</small>` : ''}</span>
        <span class="sw-item-ver mono">${esc(i.version)}${i.build ? `<small>${esc(i.build)}</small>` : ''}</span>${icon('edit')}
      </button></li>`);
    return `<section class="block sw-block">
      <h3>Software</h3>
      <ul class="sw-items">
        <li><button class="sw-item" data-a="edit" data-f="f-firmware">
          ${os ? logoHtml(os.family, familyLogo(os.family), 'sm') : '<span class="sw-logo sm is-initials" aria-hidden="true">OS</span>'}
          <span class="sw-item-text"><b>${esc(os ? os.family : 'Operating system')}</b><small>${os ? 'Operating system · from Firmware / OS' : 'Not written down yet'}</small></span>
          <span class="sw-item-ver mono">${os ? esc(os.label) : '<em>Add</em>'}</span>${icon('edit')}
        </button></li>
        ${list.map(rowHtml).join('')}
        ${swForm && !swForm.id ? swFormHtml(null) : ''}
      </ul>
      ${swForm ? '' : `<button class="btn" data-a="sw-add">${icon('plus')}Add software</button>`}
    </section>`;
  }

  /** The little form for one title on this item: which software (when adding), version, build, as of, notes. */
  function swFormHtml(cur) {
    const f = swForm;
    const have = new Set((s.ix.installs.get(dev.id) || []).map((i) => i.software_id));
    const titles = (s.data.software || []).filter((x) => !have.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
    return `<li class="sw-form">
      ${cur ? `<p class="sw-form-title">${logoHtml(cur.sw.name, cur.sw.logo, 'sm')}<b>${esc(cur.sw.name)}</b></p>` : `
        <div class="chips">${titles.map((x) => `<button type="button" class="chip sw-pick" data-a="sw-pick" data-id="${x.id}" aria-pressed="${f.software_id === x.id}">${logoHtml(x.name, x.logo, 'xs')}${esc(x.name)}</button>`).join('')}
          <button type="button" class="chip" data-a="sw-pick" data-id="new" aria-pressed="${f.software_id === 'new'}">${icon('plus')}New software</button></div>
        ${f.software_id === 'new' ? `<div class="form-row two">
          <label class="field"><span>Name</span><input id="sw-name" value="${esc(f.name)}" placeholder="vMix" autocomplete="off"></label>
          <label class="field"><span>Maker</span><input id="sw-maker" value="${esc(f.maker)}" placeholder="StudioCoast" autocomplete="off"></label></div>` : ''}`}
      <div class="form-row three">
        <label class="field"><span>Version</span><input id="sw-version" class="mono" value="${esc(f.version)}" placeholder="21.4" autocomplete="off"></label>
        <label class="field"><span>Build <small>optional</small></span><input id="sw-build" class="mono" value="${esc(f.build)}" autocomplete="off"></label>
        <label class="field"><span>As of</span><input id="sw-seen_on" type="date" value="${esc(f.seen_on)}"></label>
      </div>
      <label class="field"><span>Notes <small>optional</small></span><input id="sw-notes" value="${esc(f.notes)}" placeholder="Testing this week" autocomplete="off"></label>
      ${f.error ? `<p class="form-msg bad">${esc(f.error)}</p>` : ''}
      <div class="sw-form-actions">
        ${cur ? (f.confirm ? `<button type="button" class="btn danger small" data-a="sw-rm-yes">Remove ${esc(cur.sw.name)}</button>` : `<button type="button" class="btn ghost danger-text small" data-a="sw-rm">${icon('trash')}Remove</button>`) : ''}
        <span class="spacer"></span>
        <button type="button" class="btn small" data-a="sw-cancel">Cancel</button>
        <button type="button" class="btn primary small" data-a="sw-save" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Saving…' : 'Save'}</button>
      </div>
    </li>`;
  }

  function swRead() {
    if (!swForm) return;
    for (const k of ['name', 'maker', 'version', 'build', 'seen_on', 'notes']) { const x = $(`#sw-${k}`, sheet.el); if (x) swForm[k] = x.value.trim(); }
  }

  function swStart(id) {
    const cur = id ? (s.ix.installs.get(dev.id) || []).find((i) => i.id === id) : null;
    swForm = cur
      ? { id: cur.id, software_id: cur.software_id, version: cur.version, build: cur.build || '', seen_on: cur.seen_on || today(), notes: cur.notes || '' }
      : { id: null, software_id: null, name: '', maker: '', version: '', build: '', seen_on: today(), notes: '' };
    renderView();
    $('#sw-version', sheet.el)?.focus();
  }

  async function swSave() {
    swRead();
    const f = swForm;
    f.error = !f.software_id ? 'Pick the software.' : f.software_id === 'new' && !f.name ? 'Give the new software a name.' : !f.version ? 'Which version?' : '';
    if (f.error) return renderView();
    f.busy = true; renderView();
    try {
      let swId = f.software_id;
      if (swId === 'new') swId = await ctx.store.saveSoftware({ name: f.name, maker: f.maker || null, logo: null, notes: null });
      await ctx.store.saveInstall({ id: f.id || undefined, software_id: swId, device_id: dev.id, version: f.version, build: f.build || null, seen_on: f.seen_on || null, notes: f.notes || null });
      const name = (s.data.software || []).find((x) => x.id === swId)?.name || f.name;
      swForm = null;
      ctx.toast(`${dev.name}: ${name} ${f.version}`);
      await host.load(true);
      renderView();
    } catch (e) {
      f.busy = false; f.error = e.message; renderView();
    }
  }

  async function swRemove() {
    const f = swForm;
    try {
      await ctx.store.deleteInstall(f.id);
      swForm = null;
      ctx.toast('Removed');
      await host.load(true);
      renderView();
    } catch (e) { f.error = e.message; renderView(); }
  }

  /** The status pill: pick one and it saves right away. */
  function wireStatus() {
    const btn = $('#d-status', sheet.el);
    if (!btn) return;
    wireDropdown(btn, {
      label: 'Status',
      options: () => Object.keys(STATUS).map((k) => ({ value: k, label: STATUS[k], hint: STATUS_HINT[k], dot: k })),
      get: () => dev.status,
      set: async (v) => {
        const was = dev.status;
        dev.status = v;
        btn.className = `st st-${v} st-btn`;
        try {
          await ctx.store.setDeviceStatus(dev.id, v);
          ctx.toast(`${dev.name}: ${STATUS[v]}`);
          host.load(true);
        } catch (e) {
          dev.status = was;
          btn.className = `st st-${was} st-btn`;
          $('.dd-value', btn).textContent = STATUS[was];
          ctx.toast(e.message, 'bad');
        }
      },
    });
  }

  /** Fixture ID, patch ID and asset #: big tiles a tech can read at a glance. Tap one to edit it. */
  function numbersStrip(ty) {
    const ch = footprint(dev, ty);
    const rig = s.data.devices.filter((d) => rigKey(d) === rigKey(dev));
    const probs = rigProblems(rig, (d) => s.ix.type.get(d.type_id)).get(dev.id) || [];
    const end = dev.patch_universe != null && ch > 1 ? fmtPatch(dev.patch_universe, dev.patch_address + ch - 1) : '';
    const tile = (label, value, sub, f, mono = false) => `<button class="num ${value == null || value === '' ? 'is-blank' : ''}" data-a="edit" data-f="${f}">
      <small>${esc(label)}</small><b class="${mono ? 'mono' : ''}">${value == null || value === '' ? 'Add' : esc(value)}</b><em>${esc(sub)}</em></button>`;
    return `<section class="num-strip" aria-label="Lighting numbers">
        ${tile('Fixture ID', dev.fixture_id, 'On the console', 'f-fixture_id')}
        ${tile('Patch ID', patchOf(dev), ch ? `${ch} ch${end ? ` · to ${end}` : ''}` : 'Channels not set', 'f-patch', true)}
        ${tile('Asset #', assetTag(dev.asset_no), 'Its own, everywhere', 'f-asset_no', true)}
      </section>
      ${problemText(probs.filter(isProblem), itemLabel).map((t) => `<p class="warnline">${icon('warn')}${esc(t)}</p>`).join('')}
      ${problemText(probs.filter((p) => !isProblem(p)), itemLabel).map((t) => `<p class="warnline soft">${icon('link')}${esc(t)}</p>`).join('')}`;
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
    const who = ctx.people.get(a.actor_id)?.full_name || a.actor_name || 'Someone';
    const thing = { devices: '', device_ips: 'IP ', device_credentials: 'login ', networks: 'network ', device_ports: 'port ', software_installs: '' }[a.entity] ?? '';
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
    if (k === 'projection') v = PROJECTION[v] || v;
    else if (k === 'position_id') v = s.ix.pos.get(v)?.name || 'a removed position';
    else if (k === 'campus_id') v = campusName(v);
    else if (k === 'network_id') v = s.ix.net.get(v)?.name || 'a removed network';
    else if (k === 'type_id') v = s.ix.type.has(v) ? typeLabel(s.ix.type.get(v)) : 'a removed model';
    else if (k === 'departments') v = v.map((t) => ctx.dep[t]?.name || t).join(', ');
    else if (k === 'positions') v = v.join(', ');
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
      ? { ...dev, room_id: dev.room_id || '', position_id: dev.position_id || '', departments: [...dev.departments],
          positions: [...(dev.positions || [])], used_as: dev.used_as || '', area: dev.area || '',
          ips: ips.map((ip) => ({ id: ip.id, label: ip.label || '', network_id: ip.network_id || '', addr: ip._addr || '',
            mask: ip._prefix != null ? prefixToMask(ip._prefix) : '', gateway: ip.gateway ? splitInet(ip.gateway).addr : '',
            mac: ip.mac || '', hostname: ip.hostname || '', mode: ip.mode, notes: ip.notes || '' })),
          creds: creds.map((c) => ({ ...c })),
          ports: Object.fromEntries(ports.map((p) => [p.type_port_id, { connected_to: p.connected_to || '', assignment: p.assignment || '', notes: p.notes || '' }])),
          ...numbersDraft(dev) }
      : { id: '', type_id: '', campus_id: defaultCampus, room_id: '', name: '', departments: [], serial_number: '', firmware: '',
          location: '', status: 'active', notes: '', projection: null, position_id: '', positions: [...(preset.positions || [])], used_as: '', area: preset.area || '', ips: [blankIp()], creds: [], ports: {}, qty: clampQty(preset.qty || 1), numbering: true, start: '',
          ...numbersDraft(null) };
    if (!dev && preset.type_id) onTypePicked(preset.type_id, true);
    renderEdit();
    const target = focusId && $('#' + focusId, sheet.el);
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus(); }
    else $(draft.type_id && $('#f-name', sheet.el) ? '#f-name' : '#f-type', sheet.el)?.focus();
  }

  /** The numbers as the editor shows them (text, so blank means blank). */
  function numbersDraft(d) {
    const str = (v) => (v == null ? '' : String(v));
    return { fixture_id: str(d?.fixture_id), patch: d ? patchOf(d) : '', dmx_channels: str(d?.dmx_channels),
      asset_no: assetTag(d?.asset_no) };
  }

  /** Moving to another room: the patch, fixture ID and position belonged to the old room. Moving back restores them. */
  function followMove() {
    if (!dev) { draft.position_id = ''; return; }
    const home = draft.campus_id === dev.campus_id && (draft.room_id || '') === (dev.room_id || '');
    const was = numbersDraft(dev);
    if (home) Object.assign(draft, { fixture_id: was.fixture_id, patch: was.patch, position_id: dev.position_id || '' });
    else Object.assign(draft, { fixture_id: '', patch: '', position_id: '' });
  }

  function renderEdit(error = '') {
    const campusId = draft.campus_id;
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
    const fixture = isFixtureType(ty); // no name of its own
    const names = bulk ? bulkNames() : [];
    const locs = [...new Set(s.data.devices.filter((d) => d.campus_id === campusId && (!draft.area || posKey(d.area) === posKey(draft.area))).map((d) => d.location).filter(Boolean))].sort();
    const scroll = $('.sh-body', sheet.el)?.scrollTop || 0;
    sheet.render(`
      <header class="sh-head">
        <div class="sh-top"><span class="eyebrow">${dev ? 'Edit item' : 'New item'}</span>
          <button class="icon-btn" data-a="cancel" aria-label="Close">${icon('close')}</button></div>
        <h2>${esc(fixture ? ty.name : draft.name || (ty ? ty.name : dev ? dev.name : 'New item'))}</h2>
      </header>
      <form class="sh-body form" id="dev-form" novalidate autocomplete="off">
        <label class="field"><span>Model <b class="req">required</b></span><select id="f-type">
          <option value="" ${draft.type_id ? '' : 'selected'}>Choose a model…</option>
          ${[...typeGroups.keys()].sort().map((k) => `<optgroup label="${esc(k)}">${typeGroups.get(k).map((t) => `<option value="${t.id}" ${t.id === draft.type_id ? 'selected' : ''}>${esc(typeLabel(t))}</option>`).join('')}</optgroup>`).join('')}
          <option value="__new">＋ New model…</option>
          <option value="__unknown" ${unknownPick ? 'selected' : ''}>＋ Don’t know the model yet…</option>
        </select>
        ${unknownPick ? `<div class="inline-add unknown-add"><select id="f-ucat" aria-label="What kind of thing is it?">${CATEGORIES.filter((c) => c !== 'Cable').map((c) => `<option ${c === unknownCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <button type="button" class="btn" data-a="use-unknown">Use this</button><button type="button" class="btn ghost" data-a="unknown-cancel">Cancel</button></div>
          <small class="hint">Say what kind of thing it is. It goes in as “model unknown” so you can find out later.</small>` : ''}
        ${ty?.unknown && !unknownPick ? '<small class="hint warn-text">Model not known yet. Pick the real model here once you find out.</small>' : ''}
        ${unknownPick ? '' : ty ? `<small class="hint">${esc([ty.category, ty.part_number, ty.ports.length ? plural(ty.ports.length, 'port') : null].filter(Boolean).join(' · ') || 'Specs and ports come from the model.')}</small>` : `<small class="hint">The product this is, like Hoglet 4. Its specs and ports come from the model.</small>`}
        ${oldPatches ? `<small class="hint warn-text">What was recorded on the old model’s ports will be cleared when you save.</small>` : ''}</label>
        ${!dev ? `<div class="qty-row">
          <div class="field"><span>How many</span>
            <div class="stepper">
              <button type="button" class="icon-btn" data-a="qty-" aria-label="One fewer" ${draft.qty <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
              <input id="f-qty" class="mono" inputmode="numeric" value="${draft.qty}" aria-label="How many to add">
              <button type="button" class="icon-btn" data-a="qty+" aria-label="One more">${icon('plus')}</button>
            </div>
          </div>
          ${bulk && !fixture ? `<label class="check"><input type="checkbox" id="f-numbered" ${draft.numbering ? 'checked' : ''}><span>Number the names</span></label>` : ''}
        </div>` : ''}
        ${fixture
          ? `<div class="field"><span>Name</span><p class="ro-box">${esc(ty.name)}</p><small class="hint">A fixture goes by its model’s name. Its asset # tells it apart from the others.</small></div>`
          : `<label class="field"><span>${bulk ? 'Name for all of them' : 'Name'}</span><input id="f-name" value="${esc(draft.name)}" placeholder="${esc(bulk && ty ? bulkBase() : ty ? ty.name : 'FOH Switch, Camera 2, Stage Box…')}"></label>`}
        ${bulk && draft.numbering && !fixture ? `<div class="grid2">
          <label class="field"><span>Start numbering at</span><input id="f-start" class="mono" inputmode="numeric" value="${esc(draft.start)}" placeholder="${nextNumber(bulkBase(), draft.campus_id)}"></label>
          <p class="bulk-preview">${esc(names[0])}<i>→</i>${esc(names[names.length - 1])}</p>
        </div>` : ''}
        ${bulk ? `<p class="fine">Serial numbers, IPs and what's plugged into each port get filled in on each one after they're added.</p>` : ''}
        <div class="field"><span>Departments <b class="req">at least one</b></span>
          <div class="tag-picker">${ctx.departments.map((d) => `<button type="button" class="chip dep big" data-a="tag" data-tag="${d.slug}" data-dep="${d.slug}" aria-pressed="${draft.departments.includes(d.slug)}"><i class="dot"></i>${esc(d.name)}</button>`).join('')}</div>
        </div>
        ${purposeFields(ty)}

        <fieldset class="group"><legend>Where</legend>
          <div class="grid2">
            <label class="field"><span>Location</span><select id="f-campus">${ctx.campuses.map((c) => `<option value="${c.id}" ${c.id === campusId ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select></label>
            <label class="field"><span>Room</span><select id="f-room">
              <option value="">No room</option>
              ${roomSelectHtml(s.data.rooms, campusId, draft.room_id, esc)}
              <option value="__new" ${draft.room_id === '__new' ? 'selected' : ''}>＋ New room…</option>
            </select></label>
          </div>
          ${draft.room_id === '__new' ? `<div class="inline-add new-room"><input id="f-newroom" placeholder="Worship Center, Luken’s Office, Kids…" aria-label="New room name">
            <select id="f-newgroup" aria-label="Part of"><option value="">Not part of a group</option>${groupChoices(s.data.rooms, campusId).map((r) => `<option value="${r.id}">Part of ${esc(r.name)}</option>`).join('')}</select>
            <button type="button" class="btn" data-a="add-room">Add room</button></div>
            <small class="hint">Part of: a room inside a bigger area, like an office in E-Wing Offices. Most rooms aren’t part of anything.</small>` : ''}
          ${areaField()}
          <label class="field"><span>Spot</span><input id="f-location" value="${esc(draft.location)}" list="dl-loc" placeholder="FOH rack, Backstage rack, Cam 1…">
            <small class="hint">The exact place in the area, if it has one. Leave it blank for things that move around.</small></label>
          ${positionField()}
          ${isProjectorType(ty) ? `<div class="field"><span>Projection</span>
            <div class="tag-picker">${Object.entries(PROJECTION).map(([v, label]) => `<button type="button" class="chip big" data-a="proj" data-v="${v}" aria-pressed="${draft.projection === v}">${esc(label)}</button>`).join('')}</div>
            <small class="hint">Front: the projector is on the audience’s side of the screen. Rear: it’s behind the screen. Tap again to clear.</small></div>` : ''}
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
            <label class="field"><span>Firmware / OS</span><input id="f-firmware" class="mono" value="${esc(draft.firmware)}" placeholder="${runsSoftware(draft, s.ix.type.get(draft.type_id)) ? 'macOS Tahoe 26.1' : ''}"></label>
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
          <div class="field"><label for="f-patch">Patch ID</label>
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
        <label class="field"><span>Asset #</span><input id="f-asset_no" class="mono" value="${esc(draft.asset_no)}" placeholder="${dev ? '' : 'The next number'}" autocapitalize="characters" spellcheck="false" autocomplete="off">
          <small class="hint">UCP-000001 to UCP-999999. Its own number, never shared; it stays with the unit when it moves.</small></label>
      </div>
      ${moved && (dev.fixture_id != null || dev.patch_universe != null) ? `<p class="fine warn-text">Its patch ID and fixture ID belonged to the old room’s console, so they’re cleared. Add new ones if it’s patched here.</p>` : ''}
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
        patch_universe: p.universe, patch_address: p.address, dmx_channels: ch || null, fixture_id: Number(draft.fixture_id) || null, asset_no: parseAsset(draft.asset_no) || null, name: draft.name };
      const rig = [...s.data.devices.filter((d) => d.id !== draft.id && rigKey(d) === rigKey(me_)), me_];
      const probs = rigProblems(rig, (d) => s.ix.type.get(d.type_id)).get(me_.id) || [];
      for (const line of problemText(probs.filter(isProblem), itemLabel)) msgs.push(['bad', line + '.']);
      for (const line of problemText(probs.filter((x) => !isProblem(x)), itemLabel)) msgs.push(['soft', line + '.']);
      if (!msgs.some(([k]) => k === 'bad')) msgs.push(['ok', `Universe ${p.universe}, ${ch > 1 ? `addresses ${p.address}–${end}` : `address ${p.address}`}${ch ? '' : '. Set its channels to check for overlaps'}.`]);
    } else if (draft.fixture_id) {
      const rig = s.data.devices.filter((d) => d.id !== draft.id && d.campus_id === draft.campus_id && (d.room_id || '') === (draft.room_id || ''));
      const same = rig.filter((d) => String(d.fixture_id) === String(draft.fixture_id));
      if (same.length) msgs.push(['bad', `Fixture ID ${draft.fixture_id} is already ${same.map(itemLabel).join(', ')}.`]);
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

  /** Position (one or more) and Used as (one), each picked from what's already in use or typed in. */
  function purposeFields(ty) {
    const known = knownPositions(s);
    const pos = [...known, ...draft.positions.filter((p) => !known.some((k) => posKey(k) === posKey(p)))].sort((a, b) => a.localeCompare(b));
    const uses = knownUses(s, ty?.category);
    if (draft.used_as && !uses.some((u) => posKey(u) === posKey(draft.used_as))) uses.push(draft.used_as);
    const on = (p) => draft.positions.some((x) => posKey(x) === posKey(p));
    return `<div class="field purpose"><span>Operator position</span>
        <div class="tag-picker">${pos.map((p) => `<button type="button" class="chip big" data-a="posn" data-v="${esc(p)}" aria-pressed="${on(p)}">${esc(p)}</button>`).join('')}</div>
        <div class="inline-add purpose-add"><input id="f-newpos" maxlength="40" placeholder="Another operator position…" aria-label="Add an operator position" enterkeyhint="done">
          <button type="button" class="btn" data-a="add-posn">${icon('plus')}Add</button></div>
        <small class="hint">The job it’s part of: CG, Director, Audio… Pick more than one if it’s shared. Where it sits goes under Where.</small>
      </div>
      <div class="field purpose"><span>Used as</span>
        ${uses.length ? `<div class="tag-picker">${uses.map((u) => `<button type="button" class="chip big" data-a="use" data-v="${esc(u)}" aria-pressed="${posKey(u) === posKey(draft.used_as)}">${esc(u)}</button>`).join('')}</div>` : ''}
        <div class="inline-add purpose-add"><input id="f-newuse" maxlength="60" placeholder="${uses.length ? 'Something else…' : 'Stage display, Computer monitor…'}" aria-label="Used as" enterkeyhint="done">
          <button type="button" class="btn" data-a="add-use">Set</button></div>
        <small class="hint">What this one is used as${ty?.category ? `, among ${esc(ty.category.toLowerCase())}s` : ''}. Tap again to clear.</small>
      </div>`;
  }

  /** Area: the part of the room it's in. One, picked from what's in use or typed in. */
  function areaField() {
    const areas = knownAreas(s);
    if (draft.area && !areas.some((a) => posKey(a) === posKey(draft.area))) areas.push(draft.area);
    return `<div class="field purpose area-field"><span>Area</span>
        <div class="tag-picker">${areas.map((a) => `<button type="button" class="chip big" data-a="area" data-v="${esc(a)}" aria-pressed="${posKey(a) === posKey(draft.area)}">${esc(a)}</button>`).join('')}</div>
        <div class="inline-add purpose-add"><input id="f-newarea" maxlength="40" placeholder="Another area…" aria-label="Another area" enterkeyhint="done">
          <button type="button" class="btn" data-a="add-area">Set</button></div>
        <small class="hint">The part of the room it’s in. Tap again to clear.</small>
      </div>`;
  }

  function setArea(v) {
    collect();
    const name = canonical(knownAreas(s), v);
    draft.area = posKey(draft.area) === posKey(name) ? '' : name;
    dirty = true;
    renderEdit();
  }

  function addPosition() {
    const input = $('#f-newpos', sheet.el);
    const v = input?.value.trim();
    if (!v) { input?.focus(); return; }
    collect();
    const name = canonical(knownPositions(s), v);
    if (!draft.positions.some((x) => posKey(x) === posKey(name))) draft.positions.push(name);
    dirty = true;
    renderEdit();
    $('#f-newpos', sheet.el)?.focus();
  }

  function setUse(v) {
    collect();
    const name = canonical(knownUses(s, s.ix.type.get(draft.type_id)?.category), v);
    draft.used_as = posKey(draft.used_as) === posKey(name) ? '' : name;
    dirty = true;
    renderEdit();
  }

  /** Which batten or truss it hangs on: only when the room has positions (Lighting › Rigging sets them up). */
  function positionField() {
    const list = positionsIn(s, draft.room_id && draft.room_id !== '__new' ? draft.room_id : null);
    if (!list.length) return '';
    if (draft.position_id && !list.some((p) => p.id === draft.position_id)) draft.position_id = '';
    return `<label class="field"><span>Hung on</span><select id="f-position">
        <option value="">Not on a position</option>
        ${list.map((p) => `<option value="${p.id}" ${p.id === draft.position_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select><small class="hint">The batten or truss it’s mounted on. Lighting › Rigging shows each one.</small></label>`;
  }

  /** Reads every input back into the draft. */
  function collect() {
    const f = (id) => $(`#${id}`, sheet.el);
    if (!f('dev-form')) return;
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
    if (f('f-position')) draft.position_id = f('f-position').value;
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
    const ty = s.ix.type.get(draft.type_id);
    if (isFixtureType(ty)) return Array.from({ length: draft.qty }, () => ty.name);
    const base = bulkBase();
    const start = draft.start !== '' ? Number(draft.start) : nextNumber(base, draft.campus_id);
    return Array.from({ length: draft.qty }, (_, i) => (draft.numbering ? `${base} ${start + i}` : base));
  }

  /** Picking a type: the name and tags follow it unless they were changed by hand. */
  function onTypePicked(v, initial = false) {
    if (!initial) collect();
    if (v === '__new') { startNewType(); return; }
    if (v === '__unknown') { unknownPick = true; renderEdit(); $('#f-ucat', sheet.el)?.focus(); return; }
    unknownPick = false;
    const prev = s.ix.type.get(draft.type_id);
    const next = s.ix.type.get(v);
    draft.type_id = v;
    // The asset # stays with the unit even when its model is corrected.
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

  /** "Don't know the model yet": a placeholder model for that kind of thing, made once and shared. */
  async function useUnknown() {
    const cat = $('#f-ucat', sheet.el)?.value;
    if (!cat) return;
    collect();
    unknownCat = cat;
    const have = [...s.ix.type.values()].find((t) => t.unknown && !t.manufacturer && t.category === cat);
    let id = have?.id;
    try {
      if (!id) {
        const guess = /fixture|hazer|dimmer/i.test(cat) ? ['lighting'] : /microphone|speaker|amplifier|stagebox|wireless/i.test(cat) ? ['audio']
          : /switch|access point/i.test(cat) ? ['network'] : ['video'];
        id = await ctx.store.saveType({ type: { name: cat, category: cat, departments: draft.departments.length ? [...draft.departments] : guess, unknown: true, networked: !/fixture|hazer|dimmer|speaker|microphone/i.test(cat) } });
        await load(true);
      }
      unknownPick = false;
      onTypePicked(id, true);
      dirty = true;
      renderEdit();
    } catch (e) { ctx.toast(e.message, 'bad'); }
  }

  async function addRoom() {
    const input = $('#f-newroom', sheet.el);
    const name = input.value.trim();
    if (!name) return input.focus();
    const group = $('#f-newgroup', sheet.el)?.value || null;
    collect();
    try {
      const room = await ctx.store.addRoom(draft.campus_id, name, group);
      if (!s.data.rooms.some((r) => r.id === room.id)) s.data.rooms.push(room);
      s.ix.room.set(room.id, room);
      draft.room_id = room.id;
      renderEdit();
    } catch (e) { ctx.toast(e.message, 'bad'); }
  }

  async function save() {
    if (busy) return;
    collect();
    // A position or use typed in but not added yet still counts.
    const typedPos = $('#f-newpos', sheet.el)?.value.trim();
    if (typedPos) { const name = canonical(knownPositions(s), typedPos); if (!draft.positions.some((x) => posKey(x) === posKey(name))) draft.positions.push(name); }
    const typedUse = $('#f-newuse', sheet.el)?.value.trim();
    if (typedUse) draft.used_as = canonical(knownUses(s, s.ix.type.get(draft.type_id)?.category), typedUse);
    const typedArea = $('#f-newarea', sheet.el)?.value.trim();
    if (typedArea) draft.area = canonical(knownAreas(s), typedArea);
    const err = (m, sel) => { renderEdit(m); if (sel) $(sel, sheet.el)?.focus(); };
    if (!draft.type_id) return err('Pick a model, or choose “New model…” to add one.', '#f-type');
    if (!draft.departments.length) return err('Pick at least one department: Audio, Video, Lighting or Network.');
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
      const asset = () => {
        const n = parseAsset(draft.asset_no);
        if (Number.isNaN(n)) throw [`Asset # should look like UCP-000123 (1 to ${ASSET_MAX.toLocaleString()}).`, '#f-asset_no'];
        const other = n != null && n !== dev?.asset_no && s.data.devices.find((d) => d.asset_no === n && d.id !== draft.id);
        if (other) throw [`${assetTag(n)} is already ${other.name} at ${campusName(other.campus_id)}. Every item has its own asset #.`, '#f-asset_no'];
        return n;
      };
      try {
        const want = { fixture_id: whole('fixture_id', 'Fixture ID'), dmx_channels: whole('dmx_channels', 'DMX channels', 512),
          asset_no: asset() };
        const p = parsePatch(draft.patch);
        if (p.error) throw [p.error, '#f-patch'];
        want.patch_universe = p.empty ? null : p.universe;
        want.patch_address = p.empty ? null : p.address;
        const ch = want.dmx_channels || footprint({}, ty) || 1;
        if (want.patch_address && want.patch_address + ch - 1 > 512) throw [`With ${ch} channels, a patch at ${fmtPatch(want.patch_universe, want.patch_address)} runs past 512. Start at ${fmtPatch(want.patch_universe, 513 - ch)} or lower.`, '#f-patch'];
        for (const [k, v] of Object.entries(want)) {
          if (k === 'asset_no' && v == null) continue; // blank: the next number, filled in for you
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
        id: draft.id || '', type_id: draft.type_id, campus_id: draft.campus_id, room_id: draft.room_id || '',
        name: isFixtureType(s.ix.type.get(draft.type_id)) ? s.ix.type.get(draft.type_id).name : draft.name, // a fixture is its model
        departments: draft.departments, serial_number: draft.serial_number, firmware: draft.firmware, location: draft.location,
        status: draft.status, notes: draft.notes,
        projection: isProjectorType(s.ix.type.get(draft.type_id)) ? draft.projection || '' : '', // only projectors have one
        position_id: positionsIn(s, draft.room_id).some((p) => p.id === draft.position_id) ? draft.position_id : '',
        positions: draft.positions, used_as: draft.used_as || '', area: draft.area || '',
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
      ctx.toast(`Saved ${(!isFixtureType(s.ix.type.get(draft.type_id)) && draft.name.trim()) || typeLabel(s.ix.type.get(draft.type_id))}`);
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
          departments: draft.departments, status: 'active', notes: '', projection: isProjectorType(ty) ? draft.projection || '' : '',
          positions: draft.positions, used_as: draft.used_as || '', area: draft.area || '' },
        names,
      });
      busy = false; dirty = false;
      ctx.toast(ty?.networked === false && ctx.page?.id === 'network' ? `Added ${n} ${ty.name}. They're listed under Gear.` : `Added ${n} ${ty?.name || 'items'}`);
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
