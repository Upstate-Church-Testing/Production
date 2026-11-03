// Lighting › Rigging: a room's hanging positions (battens, trusses), front to
// back, and which lights are mounted on each.
//
//   One location   pick a room; each position lists its lights by model with
//                  their fixture IDs and patch, then what isn't on a position.
//                  "Hang lights" picks what's on a position; "Edit positions"
//                  adds, renames, reorders and deletes them.
//   All locations  every rigged room at a glance.
//
// A position belongs to one room. Moving a light to another room takes it down.

import { esc, icon, $, $$, plural } from '../util.js';
import { ALL } from '../picker.js';
import { typeThumb, typeLabel } from './types.js';
import { positionsIn } from './devices.js';
import { isFixtureType, patchOf, assetTag, itemLabel, nameNumber } from '../lighting.js';

const TROUBLE = new Set(['broken', 'repair', 'check', 'retired']);
const unitOrder = (a, b) => (a.fixture_id ?? 1e9) - (b.fixture_id ?? 1e9) || (a.asset_no ?? 1e9) - (b.asset_no ?? 1e9)
  || nameNumber(a.name) - nameNumber(b.name) || a.name.localeCompare(b.name);

/**
 * host: { s, ctx, typeOf, matches(d), load(quiet), setCampus(id), campusName(id), setTally(html) }
 * Returns { draw(box), click(e), counts() }.
 */
export function rigView(host) {
  const { s, ctx } = host;
  const typeOf = host.typeOf;
  s.rroom = s.rroom || {}; // campus id → chosen room id
  const roomName = (id) => s.ix.room.get(id)?.name || 'No room';
  const posName = (id) => s.ix.pos.get(id)?.name || null;

  /** Lights: lighting fixtures and hazers (and anything with DMX modes) that could hang somewhere. */
  function isLight(d) {
    if (!d.departments.includes('lighting')) return false;
    const t = typeOf(d);
    const cat = t?.category || '';
    if (/console|wing|computer|switch|node|gateway|wall station|control panel|display|monitor|router/i.test(cat)) return false;
    return isFixtureType(t) || /haz|fog/i.test(cat) || !!t?.dmx_modes?.length;
  }
  /** On the rig page: lights, plus anything already on a position (a speaker on a batten still shows). */
  const onRig = (d) => (!!d.position_id && s.ix.pos.has(d.position_id)) || isLight(d);

  /** Rooms worth showing at a location: any with positions, and any with lights (storage only once it has positions). */
  function roomsAt(campusId) {
    const ids = new Set((s.data.positions || []).filter((p) => p.campus_id === campusId).map((p) => p.room_id));
    for (const d of s.data.devices) {
      if (d.campus_id === campusId && d.room_id && onRig(d) && !/storage/i.test(roomName(d.room_id))) ids.add(d.room_id);
    }
    const rank = (id) => { const n = roomName(id); return /^worship/i.test(n) ? 0 : 1; };
    return [...ids].filter((id) => s.ix.room.has(id))
      .sort((a, b) => rank(a) - rank(b) || (s.ix.room.get(a).sort_order ?? 99) - (s.ix.room.get(b).sort_order ?? 99) || roomName(a).localeCompare(roomName(b)))
      .map(roomInfo);
  }

  function roomInfo(roomId) {
    const pos = positionsIn(s, roomId);
    const items = s.data.devices.filter((d) => d.room_id === roomId && onRig(d));
    const hung = items.filter((d) => d.position_id && s.ix.pos.has(d.position_id));
    return { roomId, campusId: s.ix.room.get(roomId).campus_id, pos, items, hung };
  }

  function chosen(rooms) {
    return rooms.find((r) => r.roomId === s.rroom[s.campus]) || rooms.find((r) => r.pos.length) || rooms[0];
  }

  function counts() {
    const out = { [ALL]: 0 };
    for (const c of ctx.campuses) {
      out[c.id] = roomsAt(c.id).reduce((n, r) => n + r.items.length, 0);
      out[ALL] += out[c.id];
    }
    return out;
  }

  function tally(hung, total) {
    host.setTally(`<b>${hung}</b><span>hung</span><small>of ${plural(total, 'light')}</small>`);
  }

  // ---------------------------------------------------------- drawing ----

  function draw(box) {
    if (s.campus === ALL) return drawAll(box);
    const rooms = roomsAt(s.campus);
    if (!rooms.length) {
      tally(0, 0);
      box.innerHTML = `<div class="empty"><h3>No lights at ${esc(host.campusName(s.campus))} yet</h3>
        <p>Rooms with lighting fixtures show up here. Add each room’s battens and trusses, then hang the lights on them.</p></div>`;
      return;
    }
    const r = chosen(rooms);
    const searching = !!s.q;
    const loose = r.items.filter((d) => !d.position_id || !s.ix.pos.has(d.position_id));
    tally(r.hung.length, r.items.length);
    const tabs = rooms.length > 1
      ? `<div class="seg px-rooms" role="tablist" aria-label="Room">${rooms.map((x) => `<button type="button" role="tab" data-rg-room="${x.roomId}" aria-selected="${x.roomId === r.roomId}">${esc(roomName(x.roomId))}<small>${x.items.length}</small></button>`).join('')}</div>`
      : `<h3 class="px-room">${esc(roomName(r.roomId))}</h3>`;
    const head = `<div class="px-head">${tabs}
      <button type="button" class="btn" data-rg="positions">${icon(r.pos.length ? 'edit' : 'plus')}${r.pos.length ? 'Edit positions' : 'Add positions'}</button></div>`;

    if (!r.pos.length) {
      box.innerHTML = `${head}
        <div class="empty rg-none"><h3>No positions in ${esc(roomName(r.roomId))} yet</h3>
          <p>Add the battens and trusses here, front of the room first. Then hang the lights on each one.</p>
          <div class="empty-actions"><button class="btn primary" data-rg="positions">${icon('plus')}Add positions</button></div></div>
        ${looseSection(loose, false)}`;
      return;
    }

    const sections = r.pos.map((p, i) => posSection(p, i, r, searching)).join('');
    box.innerHTML = `${head}
      <p class="px-sum"><b>${r.hung.length}</b> of ${plural(r.items.length, 'light')} hung on ${plural(r.pos.length, 'position')}${loose.length ? `<i>·</i>${loose.length} not on a position` : ''}</p>
      <ol class="rg-list" aria-label="Positions, front to back">${sections || `<li class="muted">Nothing on a position matches.</li>`}</ol>
      ${looseSection(loose, true)}`;
  }

  function posSection(p, i, r, searching) {
    const on = r.items.filter((d) => d.position_id === p.id);
    const shown = on.filter((d) => host.matches(d));
    if (searching && !shown.length) return '';
    const trouble = on.filter((d) => TROUBLE.has(d.status)).length;
    return `<li class="rg-pos ${on.length ? '' : 'is-empty'}" id="rg-${p.id}">
      <header class="rg-pos-head">
        <span class="rg-ord" aria-hidden="true">${i + 1}</span>
        <div class="rg-pos-name"><h3>${esc(p.name)}</h3>${p.notes ? `<p>${esc(p.notes)}</p>` : ''}</div>
        <span class="rg-pos-count">${on.length ? `<b>${on.length}</b> ${on.length === 1 ? 'light' : 'lights'}` : 'Nothing hung yet'}${trouble ? `<em>${icon('warn')}${trouble}</em>` : ''}</span>
        <button type="button" class="btn small" data-rg="hang" data-pos="${p.id}">${icon(on.length ? 'edit' : 'plus')}<span>${on.length ? 'Change' : 'Hang lights'}</span></button>
      </header>
      ${shown.length ? modelGroups(shown) : ''}
    </li>`;
  }

  function looseSection(list, withHint) {
    const shown = list.filter((d) => host.matches(d));
    if (!shown.length) return '';
    return `<section class="rg-pos rg-loose">
      <header class="rg-pos-head">
        <div class="rg-pos-name"><h3>Not on a position</h3>${withHint ? '<p>Tap Hang lights on a position to put these up.</p>' : ''}</div>
        <span class="rg-pos-count"><b>${shown.length}</b> ${shown.length === 1 ? 'light' : 'lights'}</span>
      </header>
      ${modelGroups(shown)}
    </section>`;
  }

  /** Lights by model: photo, name, and one chip per light (fixture ID over patch). */
  function modelGroups(list) {
    const groups = new Map();
    for (const d of list) {
      if (!groups.has(d.type_id)) groups.set(d.type_id, []);
      groups.get(d.type_id).push(d);
    }
    const order = [...groups.keys()].sort((a, b) => typeLabel(typeOf({ type_id: a })).localeCompare(typeLabel(typeOf({ type_id: b }))));
    return `<div class="rg-models">${order.map((tid) => {
      const units = groups.get(tid).sort(unitOrder);
      const t = typeOf(units[0]);
      return `<div class="rg-model">
        ${typeThumb(ctx, t, 'rg-thumb')}
        <div class="rg-model-body">
          <p class="rg-model-name"><b>${esc(t?.name || 'Model')}</b><small>${esc([t?.manufacturer, t?.unknown ? 'model unknown' : null, `${units.length}`].filter(Boolean).join(' · '))}</small></p>
          <div class="rg-units">${units.map(unitChip).join('')}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  function unitChip(d) {
    const fixture = isFixtureType(typeOf(d));
    const top = d.fixture_id != null ? String(d.fixture_id) : fixture ? null : d.name;
    const sub = d.patch_universe != null ? patchOf(d) : assetTag(d.asset_no);
    const bad = TROUBLE.has(d.status);
    return `<button type="button" class="rg-unit ${bad ? 'is-bad' : ''}" data-model="${d.id}" title="${esc(`${itemLabel(d)}${d.location ? ` · ${d.location}` : ''}${bad ? ' · needs attention' : ''}`)}">
      ${top ? `<b>${esc(top)}</b>` : ''}<i>${esc(sub || '—')}</i></button>`;
  }

  function drawAll(box) {
    const rooms = ctx.campuses.flatMap((c) => roomsAt(c.id)).sort((a, b) => (b.pos.length > 0) - (a.pos.length > 0));
    const total = rooms.reduce((n, r) => n + r.items.length, 0);
    const hung = rooms.reduce((n, r) => n + r.hung.length, 0);
    tally(hung, total);
    if (!rooms.length) {
      box.innerHTML = `<div class="empty"><h3>No lights yet</h3><p>Rooms with lighting fixtures show up here, with their battens and trusses.</p></div>`;
      return;
    }
    const rigged = rooms.filter((r) => r.pos.length);
    box.innerHTML = `<p class="px-sum"><b>${rigged.length}</b> of ${plural(rooms.length, 'room')} with lights ${rigged.length === 1 ? 'has' : 'have'} positions<i>·</i>${hung} of ${plural(total, 'light')} hung</p>
      <div class="px-cards">${rooms.map((r) => `<button type="button" class="px-card ${r.pos.length ? '' : 'is-bare'}" data-rg-go="${r.roomId}">
        <span class="px-card-head"><small>${esc(host.campusName(r.campusId))}</small><b>${esc(roomName(r.roomId))}</b></span>
        <span class="px-card-count"><b>${r.hung.length}</b>/${r.items.length} hung</span>
        <span class="rg-card-pos">${r.pos.length ? `${plural(r.pos.length, 'position')}: ${esc(r.pos.slice(0, 3).map((p) => p.name).join(', '))}${r.pos.length > 3 ? '…' : ''}` : 'No positions yet'}</span>
      </button>`).join('')}</div>`;
  }

  // ----------------------------------------------------------- events ----

  function click(e) {
    const t = e.target.closest('[data-rg], [data-rg-room], [data-rg-go]');
    if (!t) return;
    if (t.dataset.rgRoom) { s.rroom[s.campus] = t.dataset.rgRoom; host.redraw(); }
    else if (t.dataset.rgGo) {
      const room = s.ix.room.get(t.dataset.rgGo);
      s.rroom[room.campus_id] = room.id;
      host.setCampus(room.campus_id);
    } else if (t.dataset.rg === 'hang') hangSheet(t.dataset.pos);
    else if (t.dataset.rg === 'positions') {
      const r = chosen(roomsAt(s.campus));
      if (r) positionsSheet(r.roomId);
    }
  }

  const head = (eyebrow, title) => `<header class="sh-head"><div class="sh-top"><span class="eyebrow">${esc(eyebrow)}</span><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div><h2>${esc(title)}</h2></header>`;
  const fail = (sheet, err, btn) => { const m = $('.form-msg', sheet.el); m.textContent = err.message || err; m.classList.add('bad'); if (btn) btn.disabled = false; };

  // ------------------------------------------------- hang lights sheet ----

  /** Check what's on a position: lights in the room by model, one tap each (or a whole model). */
  function hangSheet(posId) {
    const p = s.ix.pos.get(posId);
    if (!p) return;
    const start = new Set(s.data.devices.filter((d) => d.position_id === posId).map((d) => d.id));
    const picked = new Set(start);
    let q = '';
    let everything = false;
    let busy = false;
    const sheet = ctx.openSheet({ label: `Lights on ${p.name}`, className: 'rg-sheet' });

    const pool = () => s.data.devices.filter((d) => d.room_id === p.room_id && (everything || onRig(d) || picked.has(d.id)));
    const words = () => q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (d) => { const t = typeOf(d); return [d.name, t?.name, t?.manufacturer, t?.category, d.location, d.fixture_id != null ? String(d.fixture_id) : null, patchOf(d), assetTag(d.asset_no), posName(d.position_id)].filter(Boolean).join(' ').toLowerCase(); };
    const delta = () => ({ add: [...picked].filter((id) => !start.has(id)), off: [...start].filter((id) => !picked.has(id)) });

    function render() {
      const w = words();
      const list = pool().filter((d) => w.every((x) => hay(d).includes(x)));
      const groups = new Map();
      for (const d of list) { if (!groups.has(d.type_id)) groups.set(d.type_id, []); groups.get(d.type_id).push(d); }
      const here = (tid) => groups.get(tid).some((d) => start.has(d.id));
      const order = [...groups.keys()].sort((a, b) => here(b) - here(a) || typeLabel(typeOf({ type_id: a })).localeCompare(typeLabel(typeOf({ type_id: b }))));
      const { add, off } = delta();
      const label = busy ? 'Saving…' : add.length && off.length ? `Save: ${add.length} up, ${off.length} down`
        : add.length ? `Hang ${plural(add.length, 'light')}` : off.length ? `Take down ${plural(off.length, 'light')}` : 'No changes';
      const scroll = $('.sh-body', sheet.el)?.scrollTop || 0;
      sheet.render(`${head(roomName(p.room_id), p.name)}
        <div class="sh-body">
          <p class="fine">Check every light mounted on ${esc(p.name)}. One on another position moves here.</p>
          <div class="search">${icon('search')}<input id="rg-q" type="search" value="${esc(q)}" placeholder="Search model, fixture ID, patch or asset #" autocomplete="off" enterkeyhint="search"></div>
          ${order.length ? order.map((tid) => pickGroup(tid, groups.get(tid).sort(unitOrder))).join('') : `<p class="muted">${q ? 'Nothing here matches.' : 'No lights in this room yet.'}</p>`}
          <label class="check rg-everything"><input type="checkbox" id="rg-all" ${everything ? 'checked' : ''}><span>Show all gear in ${esc(roomName(p.room_id))}<small class="hint">Not just lights: a speaker or camera on a batten, say.</small></span></label>
        </div>
        <footer class="sh-foot"><p class="form-msg" role="status"></p><span class="spacer"></span>
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="button" class="btn primary" data-save ${busy || !(add.length + off.length) ? 'disabled' : ''}>${label}</button></footer>`);
      const body = $('.sh-body', sheet.el);
      if (body) body.scrollTop = scroll;
      for (const box of $$('[data-grp]', sheet.el)) {
        const ids = box.dataset.grp.split(',');
        const n = ids.filter((id) => picked.has(id)).length;
        box.checked = n === ids.length;
        box.indeterminate = n > 0 && n < ids.length;
      }
    }

    function pickGroup(tid, units) {
      const t = typeOf(units[0]);
      const n = units.filter((d) => picked.has(d.id)).length;
      return `<fieldset class="rg-pick-group">
        <label class="rg-pick-head"><input type="checkbox" data-grp="${units.map((d) => d.id).join(',')}" aria-label="All ${esc(t?.name || 'of these')}">
          ${typeThumb(ctx, t, 'rg-thumb')}
          <span><b>${esc(t?.name || 'Model')}</b><small>${esc([t?.manufacturer, `${n} of ${units.length} here`].filter(Boolean).join(' · '))}</small></span></label>
        <div class="rg-picks">${units.map((d) => {
          const on = picked.has(d.id);
          const other = d.position_id && d.position_id !== p.id ? posName(d.position_id) : null;
          const top = d.fixture_id != null ? String(d.fixture_id) : isFixtureType(t) ? assetTag(d.asset_no) : d.name;
          const sub = d.patch_universe != null ? patchOf(d) : top !== assetTag(d.asset_no) ? assetTag(d.asset_no) : '';
          return `<label class="rg-pick ${on ? 'is-on' : ''} ${TROUBLE.has(d.status) ? 'is-bad' : ''}"><input type="checkbox" data-dev="${d.id}" ${on ? 'checked' : ''}>
            <span><b>${esc(top)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}${other ? `<em>${on ? 'Moves from' : 'On'} ${esc(other)}</em>` : ''}</span></label>`;
        }).join('')}</div>
      </fieldset>`;
    }

    render();
    sheet.el.addEventListener('input', (e) => {
      if (e.target.id !== 'rg-q') return;
      q = e.target.value;
      const at = e.target.selectionStart;
      render();
      const i = $('#rg-q', sheet.el); i.focus(); i.setSelectionRange(at, at);
    });
    sheet.el.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.dev) { el.checked ? picked.add(el.dataset.dev) : picked.delete(el.dataset.dev); render(); }
      else if (el.dataset.grp) { for (const id of el.dataset.grp.split(',')) el.checked ? picked.add(id) : picked.delete(id); render(); }
      else if (el.id === 'rg-all') { everything = el.checked; render(); }
    });
    sheet.el.addEventListener('click', async (e) => {
      const save = e.target.closest('[data-save]');
      if (!save || busy) return;
      const { add, off } = delta();
      if (!add.length && !off.length) return;
      busy = true; render();
      try {
        if (add.length) await ctx.store.setDevicePosition(add, p.id);
        if (off.length) await ctx.store.setDevicePosition(off, null);
        ctx.toast(add.length && off.length ? `${p.name}: ${add.length} up, ${off.length} down` : add.length ? `Hung ${plural(add.length, 'light')} on ${p.name}` : `Took ${plural(off.length, 'light')} down from ${p.name}`);
        sheet.close(true);
        await host.load(true);
      } catch (err) { busy = false; render(); fail(sheet, err); }
    });
  }

  // ------------------------------------------------- edit positions ------

  /** Add, rename, reorder (front to back) and delete a room's positions. */
  function positionsSheet(roomId) {
    const room = s.ix.room.get(roomId);
    if (!room) return;
    const onIt = (id) => s.data.devices.filter((d) => d.position_id === id).length;
    let rows = positionsIn(s, roomId).map((p) => ({ id: p.id, name: p.name, notes: p.notes || '', was: p, sure: false }));
    let busy = false;
    const sheet = ctx.openSheet({ label: `Positions in ${room.name}`, className: 'rg-sheet' });

    const collect = () => {
      for (const el of $$('[data-name]', sheet.el)) rows[+el.dataset.name].name = el.value;
      for (const el of $$('[data-notes]', sheet.el)) rows[+el.dataset.notes].notes = el.value;
    };

    function render(focus) {
      const scroll = $('.sh-body', sheet.el)?.scrollTop || 0;
      sheet.render(`${head(`${host.campusName(room.campus_id)} · Rigging`, `Positions in ${room.name}`)}
        <div class="sh-body">
          <p class="fine">Front of the room first, like the battens hang. The arrows move a position toward the front or the back.</p>
          ${rows.length ? `<ol class="rg-edit-list">${rows.map((r, i) => {
            const n = r.id ? onIt(r.id) : 0;
            return `<li class="rg-edit-row ${r.sure ? 'is-sure' : ''}">
              <span class="rg-ord" aria-hidden="true">${i + 1}</span>
              <div class="rg-edit-fields">
                <input data-name="${i}" value="${esc(r.name)}" maxlength="60" placeholder="Position name" aria-label="Position ${i + 1} name">
                ${r.notes || r.withNotes ? `<input data-notes="${i}" value="${esc(r.notes)}" maxlength="300" placeholder="Notes: trim height, circuits, how it flies…" aria-label="Notes for position ${i + 1}" class="rg-notes-in">`
                  : `<button type="button" class="btn link rg-notes-btn" data-addnote="${i}">${icon('plus')}Notes</button>`}
                ${r.sure ? `<p class="rg-sure">${icon('warn')}<span>Tap the trash again to delete it.${n ? ` ${plural(n, 'light')} on it ${n === 1 ? 'comes' : 'come'} down (they stay in the room).` : ''}</span></p>` : ''}
              </div>
              <div class="rg-edit-btns">
                <button type="button" class="icon-btn" data-mv="${i}" data-d="-1" aria-label="Move toward the front" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
                <button type="button" class="icon-btn" data-mv="${i}" data-d="1" aria-label="Move toward the back" ${i === rows.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
                <button type="button" class="icon-btn danger-text" data-rm="${i}" aria-label="Delete ${esc(r.name || 'this position')}">${icon('trash')}</button>
              </div>
            </li>`;
          }).join('')}</ol>` : '<p class="muted">No positions yet. Add the first one below.</p>'}
          <div class="field"><span>Add a position</span>
            <div class="inline-add rg-add"><input id="rg-new" maxlength="60" placeholder="FOH Batten, Midstage Batten Left, Upstage Truss…" autocomplete="off" enterkeyhint="done">
              <button type="button" class="btn" data-addpos>${icon('plus')}Add</button></div>
            <small class="hint">It goes at the back. Move it with the arrows.</small>
          </div>
        </div>
        <footer class="sh-foot"><p class="form-msg" role="status"></p><span class="spacer"></span>
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="button" class="btn primary" data-save ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save positions'}</button></footer>`);
      const body = $('.sh-body', sheet.el);
      if (body) body.scrollTop = scroll;
      if (focus) $(focus, sheet.el)?.focus();
    }

    function addRow() {
      collect();
      const input = $('#rg-new', sheet.el);
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      rows.push({ id: null, name, notes: '', was: null, sure: false });
      render('#rg-new');
      const body = $('.sh-body', sheet.el);
      if (body) body.scrollTop = body.scrollHeight;
    }

    render(rows.length ? null : '#rg-new');
    sheet.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'rg-new') { e.preventDefault(); addRow(); }
    });
    sheet.el.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-mv], [data-rm], [data-addpos], [data-addnote], [data-save]');
      if (!t || busy) return;
      if (t.dataset.addpos != null) return addRow();
      collect();
      if (t.dataset.addnote != null) { rows[+t.dataset.addnote].withNotes = true; render(`[data-notes="${t.dataset.addnote}"]`); return; }
      if (t.dataset.mv != null) {
        const i = +t.dataset.mv, j = i + Number(t.dataset.d);
        if (j < 0 || j >= rows.length) return;
        [rows[i], rows[j]] = [rows[j], rows[i]];
        render(`[data-mv="${j}"][data-d="${t.dataset.d}"]`);
        return;
      }
      if (t.dataset.rm != null) {
        const i = +t.dataset.rm;
        const r = rows[i];
        if (r.id && !r.sure) { rows.forEach((x) => { x.sure = false; }); r.sure = true; render(`[data-rm="${i}"]`); return; }
        rows.splice(i, 1);
        render();
        return;
      }
      // Save: deletes first, then everything in its new order.
      const names = rows.map((r) => r.name.trim());
      if (names.some((n) => !n)) return fail(sheet, 'Every position needs a name.');
      const dup = names.find((n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i);
      if (dup) return fail(sheet, `Two positions are called “${dup}”. Give each its own name.`);
      busy = true; render();
      try {
        const keep = new Set(rows.filter((r) => r.id).map((r) => r.id));
        for (const p of positionsIn(s, roomId)) if (!keep.has(p.id)) await ctx.store.deletePosition(p.id);
        for (const [i, r] of rows.entries()) {
          const name = r.name.trim(), notes = r.notes.trim() || null;
          if (!r.id) r.id = await ctx.store.savePosition({ campus_id: room.campus_id, room_id: roomId, name, notes, sort_order: i });
          else if (name !== r.was.name || notes !== (r.was.notes || null) || i !== r.was.sort_order) await ctx.store.savePosition({ id: r.id, name, notes, sort_order: i });
          r.was = { name, notes, sort_order: i }; // a retry after an error skips what already saved
        }
        ctx.toast(`Saved the positions in ${room.name}`);
        sheet.close(true);
        s.rroom[room.campus_id] = roomId;
        await host.load(true);
      } catch (err) {
        busy = false; render(); fail(sheet, err);
        await host.load(true); // some of it may have saved
      }
    });
  }

  return { draw, click, counts };
}
