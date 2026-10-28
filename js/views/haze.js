// Haze: every hazer at every location, how full its tank is, and the fluid on hand.
//
// A hazer is an ordinary lighting item in the "Hazer" category, so it keeps its
// patch and fixture ID and sits on the patch sheet, but it doesn't show up when
// you pick "Fixture". Its model says which fluid it takes and how big the tank is.
//   haze_checks  each look at a tank: level 0–100, filled or not, when
//   haze_stock   how many bottles of each fluid are at each location (not how full they are)
//   haze_fluids  the fluids themselves

import { esc, icon, $, $$ } from '../util.js';
import { patchOf } from '../lighting.js';
import { ALL } from '../picker.js';

export const isHazer = (t) => /\bhaze|hazer/i.test(t?.category || '');

const STALE_DAYS = 30; // a level older than this gets a nudge
const LEVELS = [[0, 'Empty'], [25, '¼'], [50, '½'], [75, '¾'], [100, 'Full']];

const day = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
const daysSince = (iso) => (Date.now() - Date.parse(iso)) / 864e5;
const levelText = (n) => (n == null ? 'Not checked yet' : n >= 100 ? 'Full' : n <= 0 ? 'Empty' : `${n}%`);
const levelClass = (n) => (n == null ? 'lvl-none' : n >= 50 ? 'lvl-ok' : n >= 25 ? 'lvl-low' : 'lvl-bad');
/** "3 weeks ago", "2 months ago": how old a reading is. */
const ago = (iso) => {
  const d = Math.floor(daysSince(iso));
  if (d < 1) return 'today';
  if (d < 14) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  const m = Math.round(d / 30.4);
  return m < 12 ? `${m} months ago` : 'over a year ago';
};
const liters = (n) => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })} L`;

export function hazeView(host) {
  const { s, ctx } = host;
  const x = () => s.extra || { fluids: [], stock: [], checks: [] };
  const fluid = (id) => x().fluids.find((f) => f.id === id) || null;
  const fluidName = (f) => (f ? [f.manufacturer, f.name].filter(Boolean).join(' ') : '');
  const hazers = () => s.data.devices.filter((d) => d.status !== 'retired' && isHazer(host.typeOf(d)));
  const checksOf = (id) => x().checks.filter((c) => c.device_id === id).sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  const stockAt = (campusId) => x().stock.filter((r) => r.campus_id === campusId);
  const pending = new Map(); // stock key → save in flight, so quick taps land in order

  /** Each location's hazers and fluid rows: what's stocked there plus what its hazers take. */
  function places() {
    const list = s.campus === ALL ? ctx.campuses : ctx.campuses.filter((c) => c.id === s.campus);
    return list.map((c) => {
      const hz = hazers().filter((d) => d.campus_id === c.id)
        .sort((a, b) => (host.roomName(a.room_id) || '').localeCompare(host.roomName(b.room_id) || '') || a.name.localeCompare(b.name, undefined, { numeric: true }));
      const ids = new Set(stockAt(c.id).map((r) => r.fluid_id));
      for (const d of hz) { const f = host.typeOf(d)?.haze_fluid_id; if (f && fluid(f)) ids.add(f); }
      const fluids = [...ids].map(fluid).filter(Boolean).sort((a, b) => fluidName(a).localeCompare(fluidName(b)));
      return { c, hz, fluids };
    }).filter((p) => p.hz.length || p.fluids.length || s.campus !== ALL);
  }

  function counts() {
    const out = { [ALL]: hazers().length };
    for (const c of ctx.campuses) out[c.id] = hazers().filter((d) => d.campus_id === c.id).length;
    return out;
  }

  // ------------------------------------------------------------ drawing --

  function draw(box) {
    const list = places();
    const shown = list.flatMap((p) => p.hz);
    const low = shown.filter((d) => { const c = checksOf(d.id)[0]; return c && c.level < 25; }).length;
    host.setTally(`<b>${shown.length}</b><span>${shown.length === 1 ? 'hazer' : 'hazers'}</span>${low ? `<small>${low} low</small>` : ''}`);
    if (!list.length) {
      box.innerHTML = `<div class="empty"><h3>No hazers yet</h3><p>Add a hazer in Gear with the category “Hazer” and it shows up here with its fluid.</p>
        <div class="empty-actions"><button class="btn" data-hz-fluid-new>${icon('plus')}Add a fluid</button></div></div>`;
      return;
    }
    box.innerHTML = (s.campus === ALL ? summary() : '') + list.map(place).join('')
      + `<p class="result-note hz-foot"><button class="btn link" data-hz-fluid-new>${icon('plus')}New fluid</button><span>for a fluid that isn’t listed yet</span></p>`;
  }

  /** Fluid on hand across every location. */
  function summary() {
    const by = new Map();
    for (const r of x().stock) {
      const o = by.get(r.fluid_id) || { n: 0, at: [] };
      o.n += r.bottles;
      if (r.bottles) o.at.push(host.campusName(r.campus_id));
      by.set(r.fluid_id, o);
    }
    const rows = [...by].map(([id, o]) => ({ f: fluid(id), ...o })).filter((r) => r.f && r.n);
    if (!rows.length) return '';
    return `<section class="hz-sum" aria-label="Fluid on hand everywhere">${rows.map((r) => `<div class="hz-sum-card">
        <small>${esc(r.f.manufacturer || 'Fluid')}${r.f.part_number ? ` · ${esc(r.f.part_number)}` : ''}</small>
        <b>${esc(r.f.name)}</b>
        <span><em>${r.n}</em> ${r.n === 1 ? 'bottle' : 'bottles'}${r.f.bottle_liters ? ` · ${liters(r.n * r.f.bottle_liters)}` : ''} · ${esc(r.at.join(', '))}</span>
      </div>`).join('')}</section>`;
  }

  function place({ c, hz, fluids }) {
    return `<section class="net hz-place">
      <header class="net-head"><div class="net-title"><h3>${esc(c.short_name)}</h3><span class="count">${hz.length}</span></div></header>
      ${hz.length ? `<ul class="hz-list">${hz.map(row).join('')}</ul>` : '<p class="hz-none">No hazer here</p>'}
      <div class="hz-stock">
        <h4>Fluid on hand</h4>
        ${fluids.length ? fluids.map((f) => stockRow(c.id, f)).join('') : '<p class="fine">No fluid listed here yet.</p>'}
        <button type="button" class="btn link" data-hz-stock-add="${c.id}">${icon('plus')}Add a fluid here</button>
      </div>
    </section>`;
  }

  function row(d) {
    const t = host.typeOf(d);
    const checks = checksOf(d.id);
    const last = checks[0];
    const filled = checks.find((ch) => ch.filled);
    const f = fluid(t?.haze_fluid_id);
    const lvl = last ? last.level : null;
    const patch = d.patch_universe != null ? `Patch ${patchOf(d)}` : 'No patch';
    const stale = last && daysSince(last.checked_at) > STALE_DAYS;
    const where = [host.roomName(d.room_id), d.location].filter(Boolean).join(' · ');
    return `<li class="hz-row">
      <span class="hz-tank ${levelClass(lvl)}" style="--lvl:${lvl ?? 0}%" aria-hidden="true"><i></i></span>
      <span class="hz-text">
        <span class="g-brand"><span>${esc(t?.manufacturer || 'No brand')}</span></span>
        <button type="button" class="hz-name" data-model="${d.id}">${esc(d.name)}</button>
        <span class="hz-sub">${esc([where, patch].filter(Boolean).join(' · '))} · <button type="button" class="btn link" data-hz-model="${t?.id || ''}">${f ? `Takes ${esc(fluidName(f))}` : 'Which fluid? Set it'}</button></span>
        <span class="hz-level"><b>${levelText(lvl)}</b>${lvl != null && t?.tank_liters ? ` · about ${liters((t.tank_liters * lvl) / 100)} of ${liters(t.tank_liters)}` : ''}${last ? ` · <span class="${stale ? 'hz-old' : ''}">checked ${esc(day(last.checked_at))}${stale ? `, ${esc(ago(last.checked_at))}` : ''}</span>` : ''}${filled ? ` · filled ${esc(day(filled.checked_at))}` : ''}</span>
      </span>
      <button type="button" class="btn small" data-hz-check="${d.id}">Check</button>
    </li>`;
  }

  function stockRow(campusId, f) {
    const n = stockAt(campusId).find((x) => x.fluid_id === f.id)?.bottles || 0;
    const key = `${campusId}|${f.id}`;
    return `<div class="hz-fluid ${n ? '' : 'is-out'}">
      <button type="button" class="hz-fluid-name" data-hz-fluid="${f.id}">
        <b>${esc(f.name)}</b>
        <small>${esc([f.manufacturer, f.part_number, f.bottle_liters ? `${liters(f.bottle_liters)} bottles` : null, f.base].filter(Boolean).join(' · '))}</small>
      </button>
      <span class="hz-step" role="group" aria-label="${esc(f.name)} bottles">
        <button type="button" class="icon-btn" data-hz-step="${key}" data-d="-1" aria-label="One fewer bottle" ${n ? '' : 'disabled'}>${icon('minus')}</button>
        <span><b>${n}</b><small>${n === 1 ? 'bottle' : 'bottles'}</small></span>
        <button type="button" class="icon-btn" data-hz-step="${key}" data-d="1" aria-label="One more bottle">${icon('plus')}</button>
      </span>
      <span class="hz-total">${n ? (f.bottle_liters ? liters(n * f.bottle_liters) : '') : 'None left'}</span>
    </div>`;
  }

  // -------------------------------------------------------------- clicks --

  function click(e) {
    const t = e.target.closest('[data-hz-check], [data-hz-step], [data-hz-fluid], [data-hz-fluid-new], [data-hz-model], [data-hz-stock-add]');
    if (!t) return;
    if (t.dataset.hzCheck) checkSheet(t.dataset.hzCheck);
    else if (t.dataset.hzStep) stepStock(t.dataset.hzStep, Number(t.dataset.d));
    else if (t.dataset.hzFluid) fluidSheet(fluid(t.dataset.hzFluid));
    else if (t.hasAttribute('data-hz-fluid-new')) fluidSheet(null);
    else if (t.hasAttribute('data-hz-model')) modelSheet(t.dataset.hzModel);
    else if (t.dataset.hzStockAdd) addStockSheet(t.dataset.hzStockAdd);
  }

  /** +/− on a bottle count: shows right away, saves in order. */
  function stepStock(key, d) {
    const [campus_id, fluid_id] = key.split('|');
    let r = stockAt(campus_id).find((x) => x.fluid_id === fluid_id);
    if (!r) { r = { campus_id, fluid_id, bottles: 0 }; x().stock.push(r); }
    const next = Math.max(0, Math.min(999, r.bottles + d));
    if (next === r.bottles) return;
    r.bottles = next;
    host.redraw();
    const run = async () => {
      try {
        const id = await ctx.store.saveGearRow('haze_stock', r.id ? { id: r.id, bottles: r.bottles } : { campus_id, fluid_id, bottles: r.bottles });
        if (!r.id && typeof id === 'string') r.id = id;
      } catch (err) { ctx.toast(err.message); host.load(true); }
    };
    const chain = (pending.get(key) || Promise.resolve()).then(run);
    pending.set(key, chain);
    chain.finally(() => { if (pending.get(key) === chain) { pending.delete(key); host.load(true); } });
  }

  // -------------------------------------------------------------- sheets --

  const head = (eyebrow, title) => `<header class="sh-head"><div class="sh-top"><span class="eyebrow">${esc(eyebrow)}</span><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div><h2>${esc(title)}</h2></header>`;
  const fail = (sheet, err, btn) => { const m = $('.form-msg', sheet.el); m.textContent = err.message || err; m.classList.add('bad'); if (btn) btn.disabled = false; };

  function checkSheet(id) {
    const d = s.data.devices.find((x) => x.id === id);
    if (!d) return;
    const t = host.typeOf(d);
    const f = fluid(t?.haze_fluid_id);
    const r = f && stockAt(d.campus_id).find((x) => x.fluid_id === f.id);
    const history = checksOf(d.id);
    let level = history[0]?.level ?? 100;
    let filled = false;
    const sheet = ctx.openSheet({ label: `Check ${d.name}`, className: 'hz-sheet' });
    sheet.render(`${head(`${host.campusName(d.campus_id)}${host.roomName(d.room_id) ? ` · ${host.roomName(d.room_id)}` : ''}`, `Check ${d.name}`)}
      <div class="sh-body form">
        <div class="field"><span>How full is the tank?</span>
          <div class="hz-levels">${LEVELS.map(([n, label]) => `<button type="button" class="chip big" data-lvl="${n}">${label}</button>`).join('')}</div>
          <div class="hz-slider"><input type="range" id="hz-lvl" min="0" max="100" step="5" value="${level}" aria-label="Level"><output id="hz-out"></output></div>
        </div>
        <button type="button" class="switch" role="switch" id="hz-filled" aria-checked="false"><span class="switch-track"><i></i></span>I filled it</button>
        ${r && r.bottles ? `<label class="hz-used" hidden><input type="checkbox" id="hz-used"> <span>Used up a bottle of ${esc(f.name)} <small>(${r.bottles - 1} left at ${esc(host.campusName(d.campus_id))} after)</small></span></label>` : ''}
        <label class="field"><span>Note</span><input id="hz-note" maxlength="500" placeholder="Anything to know"></label>
        ${history.length ? `<div class="hz-hist"><h4>Earlier</h4><ul>${history.slice(0, 6).map((c) => `<li><span>${esc(day(c.checked_at))}</span><b>${c.filled ? 'Filled' : levelText(c.level)}</b>${c.note ? `<small>${esc(c.note)}</small>` : ''}</li>`).join('')}</ul></div>` : ''}
      </div>
      <footer class="sh-foot"><p class="form-msg" role="status"></p><span class="spacer"></span><button type="button" class="btn primary" data-save>Save</button></footer>`);
    const range = $('#hz-lvl', sheet.el);
    const paint = () => {
      $('#hz-out', sheet.el).textContent = `${levelText(level)}${t?.tank_liters ? ` · about ${liters((t.tank_liters * level) / 100)}` : ''}`;
      range.value = level;
      $$('[data-lvl]', sheet.el).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.lvl) === level)));
      $('#hz-filled', sheet.el).setAttribute('aria-checked', String(filled));
      const used = $('.hz-used', sheet.el);
      if (used) used.hidden = !filled;
    };
    paint();
    range.addEventListener('input', () => { level = Number(range.value); if (level < 100) filled = false; paint(); });
    sheet.el.addEventListener('click', async (e) => {
      const lv = e.target.closest('[data-lvl]');
      if (lv) { level = Number(lv.dataset.lvl); if (level < 100) filled = false; paint(); return; }
      if (e.target.closest('#hz-filled')) { filled = !filled; if (filled) level = 100; paint(); return; }
      const save = e.target.closest('[data-save]');
      if (!save) return;
      save.disabled = true;
      try {
        await ctx.store.saveGearRow('haze_checks', { device_id: d.id, level, filled, checked_at: new Date().toISOString(), note: $('#hz-note', sheet.el).value.trim().slice(0, 500) || null });
        if (filled && $('#hz-used', sheet.el)?.checked) await ctx.store.saveGearRow('haze_stock', { id: r.id, bottles: Math.max(0, r.bottles - 1) });
        ctx.toast(filled ? `${d.name} filled` : `${d.name}: ${levelText(level)}`);
        sheet.close(true);
        await host.load(true);
      } catch (err) { fail(sheet, err, save); }
    });
  }

  /** Which fluid a hazer model takes, and its tank. Applies to every hazer of that model. */
  function modelSheet(typeId) {
    const t = s.data.types.find((x) => x.id === typeId);
    if (!t) return;
    const n = s.data.devices.filter((d) => d.type_id === t.id).length;
    const sheet = ctx.openSheet({ label: `${t.name} fluid`, className: 'hz-sheet' });
    sheet.render(`${head(t.manufacturer || 'Hazer', t.name)}
      <div class="sh-body form">
        <label class="field"><span>Fluid it takes</span>
          <select id="hz-mf"><option value="">Not set</option>${x().fluids.map((f) => `<option value="${f.id}" ${f.id === t.haze_fluid_id ? 'selected' : ''}>${esc(fluidName(f))}${f.part_number ? ` (${esc(f.part_number)})` : ''}</option>`).join('')}</select></label>
        <label class="field"><span>Tank size (liters)</span><input id="hz-tank" inputmode="decimal" value="${t.tank_liters ?? ''}" placeholder="2.5"></label>
        <p class="fine">This is for the model, so it applies to ${n === 1 ? 'the one' : `all ${n}`} ${esc(t.name)}${n === 1 ? '' : 's'}.</p>
      </div>
      <footer class="sh-foot"><p class="form-msg" role="status"></p><span class="spacer"></span><button type="button" class="btn primary" data-save>Save</button></footer>`);
    sheet.el.addEventListener('click', async (e) => {
      const save = e.target.closest('[data-save]');
      if (!save) return;
      const raw = $('#hz-tank', sheet.el).value.trim().replace(',', '.').replace(/\s*l$/i, '');
      const tank = raw ? Number(raw) : null;
      if (raw && !(tank > 0 && tank < 10000)) return fail(sheet, 'Type the tank size in liters, like 2.5.');
      save.disabled = true;
      try {
        await ctx.store.setHazerModel(t.id, { haze_fluid_id: $('#hz-mf', sheet.el).value || null, tank_liters: tank });
        ctx.toast('Saved');
        sheet.close(true);
        await host.load(true);
      } catch (err) { fail(sheet, err, save); }
    });
  }

  /** Put a fluid on a location's list: one that exists, or a new one. */
  function addStockSheet(campusId) {
    const here = new Set(stockAt(campusId).map((r) => r.fluid_id));
    const choices = x().fluids.filter((f) => !here.has(f.id));
    const sheet = ctx.openSheet({ label: 'Add a fluid', className: 'hz-sheet' });
    sheet.render(`${head(host.campusName(campusId), 'Add a fluid')}
      <div class="sh-body form">
        ${choices.length ? `<div class="hz-pick">${choices.map((f) => `<button type="button" class="hz-pick-row" data-pick="${f.id}"><b>${esc(f.name)}</b><small>${esc([f.manufacturer, f.part_number, f.bottle_liters ? `${liters(f.bottle_liters)} bottles` : null].filter(Boolean).join(' · '))}</small></button>`).join('')}</div>` : '<p class="fine">Every fluid is already listed here.</p>'}
        <label class="field"><span>Bottles here</span><input id="hz-full" inputmode="numeric" value="1"></label>
      </div>
      <footer class="sh-foot"><p class="form-msg" role="status"></p><button type="button" class="btn ghost" data-new>${icon('plus')}New fluid</button><span class="spacer"></span></footer>`);
    sheet.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-new]')) return fluidSheet(null, campusId);
      const pick = e.target.closest('[data-pick]');
      if (!pick) return;
      const full = Math.max(0, Math.min(999, parseInt($('#hz-full', sheet.el).value, 10) || 0));
      pick.disabled = true;
      try {
        await ctx.store.saveGearRow('haze_stock', { campus_id: campusId, fluid_id: pick.dataset.pick, bottles: full });
        ctx.toast(`Added ${fluid(pick.dataset.pick)?.name || 'fluid'}`);
        sheet.close(true);
        await host.load(true);
      } catch (err) { fail(sheet, err, pick); }
    });
  }

  /** Make or edit a fluid. From a location's list, a new one goes straight on it. */
  function fluidSheet(f, campusId = null) {
    const used = f ? x().stock.filter((r) => r.fluid_id === f.id && r.bottles).length : 0;
    const sheet = ctx.openSheet({ label: f ? f.name : 'New fluid', className: 'hz-sheet' });
    const v = (k) => esc(f?.[k] ?? '');
    sheet.render(`${head(f ? 'Haze fluid' : campusId ? `New fluid · ${host.campusName(campusId)}` : 'New fluid', f ? f.name : 'What fluid is it?')}
      <form class="sh-body form" novalidate>
        <label class="field"><span>Brand</span><input id="hf-brand" maxlength="80" value="${v('manufacturer')}" placeholder="Chauvet Professional"></label>
        <label class="field"><span>Name <b class="req">required</b></span><input id="hf-name" maxlength="120" value="${v('name')}" placeholder="Premium Haze Fluid"></label>
        <label class="field"><span>Part number</span><input id="hf-part" maxlength="60" value="${v('part_number')}" placeholder="Leave blank if you’re not sure"></label>
        <div class="hz-two">
          <label class="field"><span>Bottle size (liters)</span><input id="hf-size" inputmode="decimal" value="${v('bottle_liters')}" placeholder="5"></label>
          <label class="field"><span>Base</span><input id="hf-base" maxlength="40" list="hf-bases" value="${v('base')}" placeholder="Water-based"></label>
        </div>
        <datalist id="hf-bases"><option value="Water-based"><option value="Oil-based"><option value="Glycol-based"></datalist>
        <label class="field"><span>Notes</span><input id="hf-notes" maxlength="1000" value="${v('notes')}"></label>
        ${campusId ? '<label class="field"><span>Bottles here</span><input id="hf-full" inputmode="numeric" value="1"></label>' : ''}
      </form>
      <footer class="sh-foot"><p class="form-msg" role="status"></p>
        ${f ? `<button type="button" class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete fluid</span></button>` : ''}
        <span class="spacer"></span><button type="button" class="btn primary" data-save>${f ? 'Save' : 'Add fluid'}</button></footer>`);
    setTimeout(() => $(f ? '#hf-name' : '#hf-brand', sheet.el)?.focus(), 60);
    sheet.el.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.querySelector('span').textContent = used ? `Tap again: removes it from ${used} ${used === 1 ? 'location' : 'locations'}` : 'Tap again to delete'; return; }
        del.disabled = true;
        try { await ctx.store.deleteGearRow('haze_fluids', f.id); ctx.toast('Fluid deleted'); sheet.close(true); await host.load(true); }
        catch (err) { fail(sheet, err, del); }
        return;
      }
      const save = e.target.closest('[data-save]');
      if (!save) return;
      const val = (id) => $(id, sheet.el).value.trim();
      const name = val('#hf-name');
      if (!name) return fail(sheet, 'Give the fluid a name.');
      const sizeRaw = val('#hf-size').replace(',', '.').replace(/\s*l$/i, '');
      const size = sizeRaw ? Number(sizeRaw) : null;
      if (sizeRaw && !(size > 0 && size < 10000)) return fail(sheet, 'Type the bottle size in liters, like 5.');
      save.disabled = true;
      try {
        const row = { manufacturer: val('#hf-brand') || null, name, part_number: val('#hf-part') || null, bottle_liters: size, base: val('#hf-base') || null, notes: val('#hf-notes') || null };
        const id = await ctx.store.saveGearRow('haze_fluids', f ? { id: f.id, ...row } : row);
        if (!f && campusId) {
          const full = Math.max(0, Math.min(999, parseInt(val('#hf-full'), 10) || 0));
          await ctx.store.saveGearRow('haze_stock', { campus_id: campusId, fluid_id: id, bottles: full });
        }
        ctx.toast(f ? 'Saved' : `Added ${name}`);
        sheet.close(true);
        await host.load(true);
      } catch (err) { fail(sheet, err, save); }
    });
  }

  return { draw, click, counts };
}
