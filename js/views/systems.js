// Systems: items that work together wherever each one sits, like a Clear-Com
// intercom (main station in Broadcast, belt packs on every camera) or a video
// switching system. Each member can say what it does ("Main station").

import { esc, icon, $, $$ } from '../util.js';
import { ALL } from '../picker.js';
import { statusPill } from './devices.js';
import { camNumber } from './cameras.js';

const HUB = /main|station|hub|core|router|matrix/i;

export function systemsView(host) {
  const { s, ctx } = host;
  const systems = () => s.extra?.systems || [];
  const members = (id) => (s.extra?.systemItems || []).filter((m) => m.system_id === id);
  const dev = (id) => s.data.devices.find((d) => d.id === id);
  const listed = () => (s.campus === ALL ? systems() : systems().filter((x) => x.campus_id === s.campus));

  function counts() {
    const out = { [ALL]: systems().length };
    for (const c of ctx.campuses) out[c.id] = systems().filter((x) => x.campus_id === c.id).length;
    return out;
  }

  /** Members grouped by room, then Spot: the room with the main station first. */
  function groups(sys) {
    const rows = members(sys.id).map((m) => ({ m, d: dev(m.device_id) })).filter((x) => x.d);
    const byRoom = new Map();
    for (const x of rows) {
      const k = x.d.room_id || '';
      if (!byRoom.has(k)) byRoom.set(k, new Map());
      const spot = x.d.location || '';
      const spots = byRoom.get(k);
      if (!spots.has(spot)) spots.set(spot, []);
      spots.get(spot).push(x);
    }
    const hubRoom = (k) => [...byRoom.get(k).values()].flat().some((x) => HUB.test(x.m.role || ''));
    const spotSort = (a, b) => {
      const na = camNumber(a), nb = camNumber(b);
      if (na != null && nb != null) return na - nb;
      if ((na != null) !== (nb != null)) return na != null ? 1 : -1;
      return (a === '') - (b === '') || a.localeCompare(b);
    };
    return [...byRoom.keys()].sort((a, b) => hubRoom(b) - hubRoom(a) || (host.roomName(a) || '').localeCompare(host.roomName(b) || ''))
      .map((k) => ({ room: host.roomName(k) || 'No room', spots: [...byRoom.get(k).entries()].sort((a, b) => spotSort(a[0], b[0])) }));
  }

  function draw(box) {
    const list = listed();
    host.setTally(`<b>${list.length}</b><span>${list.length === 1 ? 'system' : 'systems'}</span>`);
    const add = `<p class="result-note"><button class="btn link" data-sys-new>${icon('plus')}New system</button><span>for gear that works together, like an intercom</span></p>`;
    if (!list.length) {
      box.innerHTML = `<div class="empty"><h3>No systems ${s.campus === ALL ? 'yet' : `at ${esc(host.campusName(s.campus))} yet`}</h3>
        <p>A system ties together gear that works as one, wherever each piece sits: an intercom, a video switching system, a stream.</p>
        <div class="empty-actions"><button class="btn primary" data-sys-new>${icon('plus')}New system</button></div></div>`;
      return;
    }
    box.innerHTML = list.map((sys) => {
      const g = groups(sys);
      const n = members(sys.id).length;
      return `<section class="net sys">
        <header class="net-head">
          <div class="net-title"><h3>${esc(sys.name)}</h3><span class="count">${n}</span></div>
          <button type="button" class="btn small" data-sys-edit="${sys.id}">${icon('edit')}Edit</button>
          <p class="net-sub">${esc(host.campusName(sys.campus_id))}${g.length ? ` · ${esc(g.map((x) => x.room).join(', '))}` : ''}</p>
        </header>
        ${sys.notes ? `<p class="sys-notes">${esc(sys.notes)}</p>` : ''}
        ${g.length ? g.map(({ room, spots }) => `<div class="sys-room"><h4>${esc(room)}</h4><div class="sys-spots">
          ${spots.map(([spot, xs]) => `<div class="sys-spot"><p class="sys-spot-name">${esc(spot || 'No spot')}</p><ul>${xs.map(({ m, d }) => {
            const t = host.typeOf(d);
            return `<li><button type="button" data-model="${d.id}" class="${HUB.test(m.role || '') ? 'is-hub' : ''}">
              <small>${esc(m.role || t?.category || '')}</small><span>${esc(d.name)}</span>${d.status !== 'active' ? statusPill(d.status) : ''}</button></li>`;
          }).join('')}</ul></div>`).join('')}
        </div></div>`).join('') : '<p class="sys-empty">Nothing in this system yet. Tap Edit to add items.</p>'}
      </section>`;
    }).join('') + add;
  }

  function click(e) {
    const t = e.target.closest('[data-sys-new], [data-sys-edit]');
    if (!t) return;
    if (t.dataset.sysEdit) editSheet(t.dataset.sysEdit);
    else newSheet();
  }

  const head = (eyebrow, title) => `<header class="sh-head"><div class="sh-top"><span class="eyebrow">${esc(eyebrow)}</span><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div><h2>${esc(title)}</h2></header>`;
  const fail = (sheet, err, btn) => { const m = $('.form-msg', sheet.el); m.textContent = err.message || err; m.classList.add('bad'); if (btn) btn.disabled = false; };

  function newSheet() {
    const campus = s.campus !== ALL ? s.campus : ctx.me?.home_campus_id || ctx.campuses[0]?.id;
    const sheet = ctx.openSheet({ label: 'New system', className: 'sys-sheet' });
    sheet.render(`${head('Systems', 'New system')}
      <form class="sh-body form" novalidate>
        <label class="field"><span>Name <b class="req">required</b></span><input id="sy-name" maxlength="120" placeholder="Clear-Com intercom, Video switching…"></label>
        <label class="field"><span>Location</span><select id="sy-campus">${ctx.campuses.map((c) => `<option value="${c.id}" ${c.id === campus ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select></label>
        <label class="field"><span>How it’s connected</span><textarea id="sy-notes" rows="3" maxlength="2000" placeholder="What runs where, wired or wireless…"></textarea></label>
      </form>
      <footer class="sh-foot"><p class="form-msg" role="status"></p><span class="spacer"></span><button type="button" class="btn primary" data-save>Next: add items</button></footer>`);
    setTimeout(() => $('#sy-name', sheet.el)?.focus(), 60);
    sheet.el.addEventListener('click', async (e) => {
      const save = e.target.closest('[data-save]');
      if (!save) return;
      const name = $('#sy-name', sheet.el).value.trim();
      if (!name) return fail(sheet, 'Give the system a name.');
      save.disabled = true;
      try {
        const id = await ctx.store.saveGearRow('systems', { name, campus_id: $('#sy-campus', sheet.el).value, notes: $('#sy-notes', sheet.el).value.trim() || null });
        await host.load(true);
        editSheet(id);
      } catch (err) { fail(sheet, err, save); }
    });
  }

  /** Name, notes, and who's in it: roles, remove, and add from that location's items. */
  function editSheet(id) {
    let q = '';
    const sheet = ctx.openSheet({ label: 'Edit system', className: 'sys-sheet' });
    const render = () => {
      const sys = systems().find((x) => x.id === id);
      if (!sys) return sheet.close(true);
      const mine = members(id).map((m) => ({ m, d: dev(m.device_id) })).filter((x) => x.d)
        .sort((a, b) => HUB.test(b.m.role || '') - HUB.test(a.m.role || '') || a.d.name.localeCompare(b.d.name, undefined, { numeric: true }));
      const inIt = new Set(mine.map((x) => x.d.id));
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = (d) => [d.name, d.location, host.roomName(d.room_id), host.typeOf(d)?.name, host.typeOf(d)?.manufacturer, host.typeOf(d)?.category].filter(Boolean).join(' ').toLowerCase();
      const pool = words.length ? s.data.devices.filter((d) => d.campus_id === sys.campus_id && !inIt.has(d.id) && words.every((w) => hay(d).includes(w)))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, 30) : [];
      const keep = { name: $('#sy-name', sheet.el)?.value, notes: $('#sy-notes', sheet.el)?.value };
      sheet.render(`${head(host.campusName(sys.campus_id), sys.name)}
        <form class="sh-body form" novalidate>
          <label class="field"><span>Name</span><input id="sy-name" maxlength="120" value="${esc(keep.name ?? sys.name)}"></label>
          <label class="field"><span>How it’s connected</span><textarea id="sy-notes" rows="3" maxlength="2000">${esc(keep.notes ?? sys.notes ?? '')}</textarea></label>
          <div class="field"><span>In this system <b class="count">${mine.length}</b></span>
            ${mine.length ? `<ul class="sys-members">${mine.map(({ m, d }) => `<li>
              <span><b>${esc(d.name)}</b><small>${esc([host.roomName(d.room_id), d.location].filter(Boolean).join(' · ') || 'No room')}</small></span>
              <input data-role="${m.id}" maxlength="80" value="${esc(m.role || '')}" placeholder="What it does" aria-label="What ${esc(d.name)} does">
              <button type="button" class="icon-btn" data-rm="${m.id}" aria-label="Take ${esc(d.name)} out">${icon('close')}</button></li>`).join('')}</ul>` : '<p class="fine">Nothing yet. Search below to add items.</p>'}
          </div>
          <div class="field"><span>Add items</span>
            <div class="search">${icon('search')}<input id="sy-q" type="search" value="${esc(q)}" placeholder="Search ${esc(host.campusName(sys.campus_id))}: RS-701, Broadcast, Cam 3…" autocomplete="off"></div>
            ${words.length ? (pool.length ? `<ul class="sys-pool">${pool.map((d) => `<li><button type="button" data-add="${d.id}">${icon('plus')}<span><b>${esc(d.name)}</b><small>${esc([host.typeOf(d)?.manufacturer, host.roomName(d.room_id), d.location].filter(Boolean).join(' · '))}</small></span></button></li>`).join('')}</ul>` : '<p class="fine">Nothing else matches.</p>') : ''}
          </div>
        </form>
        <footer class="sh-foot"><p class="form-msg" role="status"></p>
          <button type="button" class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete system</span></button>
          <span class="spacer"></span><button type="button" class="btn primary" data-save>Done</button></footer>`);
      const input = $('#sy-q', sheet.el);
      if (document.activeElement === document.body || keep.focus) input.focus();
    };
    render();
    sheet.el.addEventListener('input', (e) => {
      if (e.target.id !== 'sy-q') return;
      q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const i = $('#sy-q', sheet.el); i.focus(); i.setSelectionRange(pos, pos);
    });
    sheet.el.addEventListener('click', async (e) => {
      const add = e.target.closest('[data-add]');
      if (add) {
        add.disabled = true;
        try { await ctx.store.saveGearRow('system_items', { system_id: id, device_id: add.dataset.add, role: null }); await host.load(true); render(); }
        catch (err) { fail(sheet, err, add); }
        return;
      }
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        rm.disabled = true;
        try { await ctx.store.deleteGearRow('system_items', rm.dataset.rm); await host.load(true); render(); }
        catch (err) { fail(sheet, err, rm); }
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.querySelector('span').textContent = 'Tap again to delete (the items stay)'; return; }
        del.disabled = true;
        try { await ctx.store.deleteGearRow('systems', id); ctx.toast('System deleted'); sheet.close(true); await host.load(true); }
        catch (err) { fail(sheet, err, del); }
        return;
      }
      const save = e.target.closest('[data-save]');
      if (!save) return;
      const name = $('#sy-name', sheet.el).value.trim();
      if (!name) return fail(sheet, 'Give the system a name.');
      save.disabled = true;
      try {
        const sys = systems().find((x) => x.id === id);
        const notes = $('#sy-notes', sheet.el).value.trim() || null;
        if (name !== sys.name || notes !== (sys.notes || null)) await ctx.store.saveGearRow('systems', { id, name, notes });
        for (const inp of $$('[data-role]', sheet.el)) {
          const m = members(id).find((x) => x.id === inp.dataset.role);
          const role = inp.value.trim() || null;
          if (m && role !== (m.role || null)) await ctx.store.saveGearRow('system_items', { id: m.id, role });
        }
        ctx.toast('Saved');
        sheet.close(true);
        await host.load(true);
      } catch (err) { fail(sheet, err, save); }
    });
  }

  return { draw, click, counts };
}
