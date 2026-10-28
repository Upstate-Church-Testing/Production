// Cameras: each location's camera positions (Cam 1…Cam N) and the gear on each.
//
// A position is a camera_builds row: its number and whether it's in service.
// Its gear is every item at that location whose Spot is "Cam N", so moving a
// lens to another camera is just changing its Spot. A Spot like "Cam 7" with
// no row yet still shows up, as in service.

import { esc, icon, $ } from '../util.js';
import { statusPill } from './devices.js';
import { ALL } from '../picker.js';

/** "Cam 3", "Camera 3", "cam03", "Cam #3" → 3; anything else → null. */
export function camNumber(spot) {
  const m = /^\s*cam(?:era)?\s*#?\s*0*(\d{1,2})\s*$/i.exec(spot || '');
  return m ? Number(m[1]) : null;
}

// Body first, then what hangs off it.
const ORDER = ['camera', 'lens', 'monitor', 'camera rig', 'battery', 'tripod', 'camera support'];
const rank = (t) => { const i = ORDER.indexOf((t?.category || '').toLowerCase()); return i < 0 ? ORDER.length : i; };

export function camerasView(host) {
  const { s, ctx } = host;
  const builds = () => s.extra?.builds || [];

  /** Positions at a location: rows plus any Spot "Cam N" without one. */
  function positions(campusId) {
    const gear = new Map();
    for (const d of s.data.devices) {
      if (d.campus_id !== campusId || d.status === 'retired') continue;
      const n = camNumber(d.location);
      if (n == null) continue;
      if (!gear.has(n)) gear.set(n, []);
      gear.get(n).push(d);
    }
    const rows = builds().filter((b) => b.campus_id === campusId);
    const nums = [...new Set([...rows.map((b) => b.number), ...gear.keys()])].sort((a, b) => a - b);
    return nums.map((n) => {
      const row = rows.find((b) => b.number === n) || null;
      const parts = (gear.get(n) || []).sort((a, b) => rank(host.typeOf(a)) - rank(host.typeOf(b)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      return { n, row, inService: row ? row.in_service : true, note: row?.note || '', parts };
    });
  }

  function places() {
    const list = s.campus === ALL ? ctx.campuses : ctx.campuses.filter((c) => c.id === s.campus);
    return list.map((c) => ({ c, pos: positions(c.id) })).filter((p) => p.pos.length || s.campus !== ALL);
  }

  function counts() {
    const out = { [ALL]: 0 };
    for (const c of ctx.campuses) { out[c.id] = positions(c.id).length; out[ALL] += out[c.id]; }
    return out;
  }

  function draw(box) {
    const list = places();
    const all = list.flatMap((p) => p.pos);
    const live = all.filter((p) => p.inService).length;
    host.setTally(all.length ? `<b>${live}</b><span>of ${all.length} cameras in service</span>` : '');
    if (!list.length) {
      box.innerHTML = `<div class="empty"><h3>No camera builds yet</h3>
        <p>Pick a location to set up its cameras. Gear shows up on a camera when its Spot is “Cam 1”, “Cam 2” and so on.</p></div>`;
      return;
    }
    box.innerHTML = list.map(({ c, pos }) => {
      const on = pos.filter((p) => p.inService).length;
      const out = pos.filter((p) => !p.inService).map((p) => p.n);
      return `<section class="cam-place">
        <header class="cam-head">
          <div><h3>${esc(c.short_name)}</h3>
            <p class="fine">${pos.length ? `${on} of ${pos.length} in service${out.length ? ` · Cam ${out.join(' and ')} out of commission` : ''}` : 'No cameras set up here yet'}</p></div>
          <button type="button" class="btn small" data-cam-add="${c.id}">${icon('plus')}Add camera</button>
        </header>
        ${pos.length ? `<div class="cam-grid">${pos.map((p) => card(c, p)).join('')}</div>` : ''}
      </section>`;
    }).join('') + '<p class="result-note cam-hint">To put gear on a camera, open the item and set its Spot to “Cam 3”.</p>';
  }

  function card(c, p) {
    return `<article class="cam-card ${p.inService ? '' : 'is-out'}">
      <header>
        <b>Cam ${p.n}</b>
        <button type="button" class="cam-state" data-cam-state="${c.id}|${p.n}" aria-label="Cam ${p.n}: ${p.inService ? 'in service' : 'out of commission'}. Change">
          <i></i>${p.inService ? 'In service' : 'Out of commission'}</button>
      </header>
      ${p.note ? `<p class="cam-note">${esc(p.note)}</p>` : ''}
      ${p.parts.length ? `<ul>${p.parts.map((d) => {
        const t = host.typeOf(d);
        return `<li><button type="button" data-model="${d.id}">
          <small>${esc(t?.manufacturer || t?.category || '')}</small><span>${esc(d.name)}</span>${d.status !== 'active' ? statusPill(d.status) : ''}</button></li>`;
      }).join('')}</ul>` : '<p class="cam-empty">No gear on this camera</p>'}
    </article>`;
  }

  function click(e) {
    const add = e.target.closest('[data-cam-add]');
    if (add) return addCamera(add.dataset.camAdd, add);
    const st = e.target.closest('[data-cam-state]');
    if (st) { const [campusId, n] = st.dataset.camState.split('|'); stateSheet(campusId, Number(n)); }
  }

  async function addCamera(campusId, btn) {
    const n = Math.max(0, ...positions(campusId).map((p) => p.n)) + 1;
    btn.disabled = true;
    try {
      await ctx.store.saveGearRow('camera_builds', { campus_id: campusId, number: n, in_service: true });
      ctx.toast(`Added Cam ${n}`);
      await host.load(true);
    } catch (err) { ctx.toast(err.message); btn.disabled = false; }
  }

  function stateSheet(campusId, n) {
    const p = positions(campusId).find((x) => x.n === n);
    if (!p) return;
    let inService = p.inService;
    const sheet = ctx.openSheet({ label: `Cam ${n}`, className: 'cam-sheet' });
    const render = () => sheet.render(`
      <header class="sh-head"><div class="sh-top"><span class="eyebrow">${esc(host.campusName(campusId))}</span><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div><h2>Cam ${n}</h2></header>
      <div class="sh-body form">
        <div class="seg cam-seg" role="radiogroup" aria-label="Cam ${n}">
          <button type="button" role="radio" data-in="1" aria-checked="${inService}" aria-selected="${inService}">In service</button>
          <button type="button" role="radio" data-in="0" aria-checked="${!inService}" aria-selected="${!inService}">Out of commission</button>
        </div>
        <label class="field"><span>Note</span><input id="cam-note" maxlength="200" value="${esc(p.note)}" placeholder="${inService ? 'Anything to know about this camera' : 'Why it’s out, what it’s waiting on'}"></label>
        <p class="fine">${p.parts.length ? `${p.parts.length} ${p.parts.length === 1 ? 'item has' : 'items have'} the Spot “Cam ${n}”. Removing the camera leaves them as they are.` : `Nothing has the Spot “Cam ${n}” yet.`}</p>
      </div>
      <footer class="sh-foot"><p class="form-msg" role="status"></p>
        ${p.row ? `<button type="button" class="btn ghost danger-text" data-del><span>Remove Cam ${n}</span></button>` : ''}
        <span class="spacer"></span><button type="button" class="btn primary" data-save>Save</button></footer>`);
    render();
    sheet.el.addEventListener('click', async (e) => {
      const opt = e.target.closest('[data-in]');
      if (opt) { inService = opt.dataset.in === '1'; const note = $('#cam-note', sheet.el).value; render(); $('#cam-note', sheet.el).value = note; return; }
      const save = e.target.closest('[data-save]');
      if (save) {
        save.disabled = true;
        const note = $('#cam-note', sheet.el).value.trim().slice(0, 200) || null;
        try {
          await ctx.store.saveGearRow('camera_builds', p.row ? { id: p.row.id, in_service: inService, note } : { campus_id: campusId, number: n, in_service: inService, note });
          ctx.toast(`Cam ${n} ${inService ? 'in service' : 'out of commission'}`);
          sheet.close(true);
          await host.load(true);
        } catch (err) { $('.form-msg', sheet.el).textContent = err.message; $('.form-msg', sheet.el).classList.add('bad'); save.disabled = false; }
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.querySelector('span').textContent = `Tap again to remove Cam ${n}`; return; }
        del.disabled = true;
        try { await ctx.store.deleteGearRow('camera_builds', p.row.id); ctx.toast(`Removed Cam ${n}`); sheet.close(true); await host.load(true); }
        catch (err) { ctx.toast(err.message); del.disabled = false; }
      }
    });
  }

  return { draw, click, counts };
}
