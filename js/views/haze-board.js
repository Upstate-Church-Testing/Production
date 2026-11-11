// Lighting › Haze: every location's hazers on one sheet that fits the screen (no scrolling),
// in the console look (like PCO › Scheduling and House lights). One line per hazer, the
// locations in the order they're in everywhere else; a location with no hazer still has
// its line. Across: the location, the hazer (its model's photo, its name, brand and room; a
// spare says so), its density (a percent, typed in: Enter or leaving it asks "Are you
// sure?"; clearing it takes it off), its tank (a cylinder lying on its side, filled to the
// last level checked, marked ¼ ½ ¾ and Full), and the fluid it takes with the bottles on
// hand at that location (− and +). Tapping the hazer or its tank opens it: tap how full
// the tank is (Empty ¼ ½ ¾ Full), say if it was filled, and see the earlier checks.
// A hazer is an ordinary lighting item in the "Hazer" category (Gear); its model says which
// fluid it takes and how big the tank is (views/haze.js has those forms). Staff and up.

import { esc, icon, $, $$, debounce, pageTitle, timeAgo } from '../util.js';
import { hudConfirm, hudPanel } from '../hud.js';
import { hazeView, isHazer } from './haze.js';
import { ALL } from '../picker.js';

const LEVELS = [[0, 'Empty'], [25, '¼'], [50, '½'], [75, '¾'], [100, 'Full']];
const STALE_DAYS = 30;
/** A phone shows a location's code, as Scheduling does. */
const SHORT = { AND: 'AN', MAU: 'MLN' };
const both = (full, short) => (short && short !== full ? `<span class="lf">${esc(full)}</span><span class="ls">${esc(short)}</span>` : esc(full));
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const levelText = (n) => (n == null ? 'Not checked' : n >= 100 ? 'Full' : n <= 0 ? 'Empty' : n === 25 ? '¼' : n === 50 ? '½' : n === 75 ? '¾' : `${n}%`);
const levelClass = (n) => (n == null ? 'lvl-none' : n >= 50 ? 'lvl-ok' : n >= 25 ? 'lvl-low' : 'lvl-bad');
/** A hazer, drawn: for a model with no photo. */
const HAZER_ART = '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="17" height="12" rx="1.5"/><path d="M20 15h4v6h-4M7 12V9h7v3M6 27h11"/><path d="M27 13c1.5 1 1.5 2.500 0 3.500s-1.500 2.500 0 3.500" opacity=".7"/></svg>';

export function mount(el, ctx) {
  let alive = true;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const s = { data: null, extra: null, campus: ALL, edit: null, asking: false, first: true };

  el.innerHTML = `<div class="hz" id="hb">
      <div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}<p class="hb-count" id="hb-count" role="status"></p></div></div>
      <div class="results hb-body" id="hb-body"><div class="loading"><div class="sk tall"></div></div></div>
    </div>`;
  const body = $('#hb-body', el);

  // The forms for a model's fluid and tank, a fluid, and the bottle counts (views/haze.js).
  const forms = hazeView({
    s, ctx,
    typeOf: (d) => typeOf(d),
    roomName: (id) => roomName(id),
    campusName: (id) => ctx.campusById.get(id)?.short_name || '',
    load: () => load(true),
    redraw: () => draw(),
    setTally() {},
  });

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open], [data-dn], [data-step], [data-fluid], [data-model]');
    if (!t || s.asking) return;
    if (t.dataset.dn) startEdit(t.closest('.hb-dn'));
    else if (t.dataset.open) openHazer(t.dataset.open);
    else if (t.dataset.step) forms.stepStock(t.dataset.step, Number(t.dataset.d));
    else if (t.dataset.fluid) forms.fluidSheet((s.extra?.fluids || []).find((f) => f.id === t.dataset.fluid));
    else if (t.dataset.model) forms.modelSheet(t.dataset.model);
  });
  const WATCH = new Set(['devices', 'device_types', 'rooms', 'haze_fluids', 'haze_stock', 'haze_checks']);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (!table || WATCH.has(table)) load(true); }, 300));
  const onResize = debounce(() => fit(), 100);
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);

  load(false);
  return {
    unmount() {
      alive = false;
      unsubscribe();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    },
  };

  // ------------------------------------------------------------------ data ---
  async function load(live) {
    try {
      const [data, extra] = await Promise.all([ctx.store.networkData(), ctx.store.gearExtras()]);
      if (!alive) return;
      s.data = data;
      s.extra = { fluids: [], stock: [], checks: [], ...extra };
    } catch (e) {
      if (alive && !s.data) body.innerHTML = `<div class="empty"><p>Couldn’t load haze: ${esc(e.message)}</p></div>`;
      return;
    }
    if (live && (s.edit || s.asking)) return; // typing a density: it's drawn again when that's done
    draw();
  }

  function typeOf(d) { return s.data.types.find((t) => t.id === d.type_id) || null; }
  function roomName(id) { return s.data.rooms.find((r) => r.id === id)?.name || ''; }
  function fluid(id) { return (s.extra.fluids || []).find((f) => f.id === id) || null; }
  function checksOf(id) { return s.extra.checks.filter((c) => c.device_id === id).sort((a, b) => b.checked_at.localeCompare(a.checked_at)); }
  function bottles(campusId, fluidId) { return s.extra.stock.find((r) => r.campus_id === campusId && r.fluid_id === fluidId)?.bottles || 0; }
  function spare(d) { return d.status !== 'active'; }

  /** One line per hazer, by location (each location's in-service ones first); a location
   *  with none has one empty line. */
  function lines() {
    const hz = s.data.devices.filter((d) => d.status !== 'retired' && isHazer(typeOf(d)));
    const out = [];
    for (const c of ctx.campuses) {
      const here = hz.filter((d) => d.campus_id === c.id)
        .sort((a, b) => spare(a) - spare(b) || roomName(a.room_id).localeCompare(roomName(b.room_id)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (!here.length) out.push({ c, d: null, first: true });
      here.forEach((d, i) => out.push({ c, d, first: i === 0 }));
    }
    return out;
  }

  // ------------------------------------------------------------------ draw ---
  function draw() {
    if (!alive || !s.data) return;
    const list = lines();
    const hz = list.filter((x) => x.d);
    const low = hz.filter((x) => { const c = checksOf(x.d.id)[0]; return c && c.level < 25; }).length;
    const none = new Set(list.filter((x) => !x.d).map((x) => x.c.id)).size;
    $('#hb-count', el).innerHTML = `<b>${hz.length}</b> ${hz.length === 1 ? 'hazer' : 'hazers'}${none ? ` <i>·</i> ${none} ${none === 1 ? 'location' : 'locations'} without` : ''}${low ? ` <i>·</i> <em>${low} low</em>` : ''}`;
    body.innerHTML = `<div class="hb-board${s.first && !still() ? ' hb-boot' : ''}" style="--n:${list.length}">
        <div class="hb-r hb-hd" role="row"><span>${both('Location', 'Loc')}</span><span>Hazer</span><span>Density</span><span>Tank</span><span class="hb-fl">Fluid on hand</span></div>
        ${list.map(line).join('')}
      </div>`;
    fit();
    if (s.first) {
      s.first = false;
      // The tanks fill from empty, once.
      if (!still()) {
        const cyl = $$('.hb-cyl', body);
        cyl.forEach((n) => { n.dataset.to = n.style.getPropertyValue('--lvl'); n.style.setProperty('--lvl', '0%'); });
        requestAnimationFrame(() => requestAnimationFrame(() => cyl.forEach((n) => n.style.setProperty('--lvl', n.dataset.to))));
        setTimeout(() => $('.hb-board', body)?.classList.remove('hb-boot'), 700);
      }
      document.fonts?.ready.then(() => { if (alive) fit(); });
    }
  }

  function line({ c, d, first }, i) {
    const loc = `<span class="hb-loc">${first ? `<b>${both(c.short_name, SHORT[c.code] || c.code)}</b>` : ''}</span>`;
    const j = `--j:${Math.random().toFixed(2)}`;
    if (!d) return `<div class="hb-r is-first is-none" role="row" style="${j}">${loc}<span class="hb-nohz">No hazer</span></div>`;
    const t = typeOf(d);
    const f = fluid(t?.haze_fluid_id);
    const last = checksOf(d.id)[0];
    const lvl = last ? last.level : null;
    const stale = last && (Date.now() - Date.parse(last.checked_at)) / 864e5 > STALE_DAYS;
    const n = f ? bottles(c.id, f.id) : 0;
    const photo = t?.photo_path ? ctx.store.photoUrl(t.photo_path, true) : null;
    const brand = [t?.manufacturer, t && t.name !== d.name && !d.name.startsWith(t.name) ? t.name : null].filter(Boolean).join(' ');
    const room = roomName(d.room_id);
    const key = f ? `${c.id}|${f.id}` : '';
    return `<div class="hb-r${first ? ' is-first' : ''}${spare(d) ? ' is-spare' : ''}" role="row" style="${j}" data-id="${d.id}">
      ${loc}
      <button type="button" class="hb-who" data-open="${d.id}" aria-label="${esc(`${c.short_name} ${d.name}: open`)}">
        <span class="hb-pic">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy">` : HAZER_ART}</span>
        <span class="hb-nm"><b>${esc(d.name)}${spare(d) ? '<i>Spare</i>' : ''}</b>
          <small><span class="lf">${esc([brand, room].filter(Boolean).join(' · '))}</span><span class="ls">${esc([t?.manufacturer, f ? `${n} ${n === 1 ? 'bottle' : 'bottles'}` : null].filter(Boolean).join(' · '))}</span></small></span>
      </button>
      <span class="hb-dn" data-id="${d.id}">${density(d, c)}</span>
      <button type="button" class="hb-tk ${levelClass(lvl)}" data-open="${d.id}" aria-label="${esc(`${c.short_name} ${d.name} tank: ${levelText(lvl)}${last ? `, checked ${day(last.checked_at)}` : ''}. Check it`)}">
        <span class="hb-gauge"><span class="hb-cyl" style="--lvl:${lvl ?? 0}%"><i class="hb-liq"></i><u></u><u></u><u></u></span>
          <span class="hb-marks" aria-hidden="true"><em>¼</em><em>½</em><em>¾</em><em>${both('Full', 'F')}</em></span></span>
        <span class="hb-rd"><b>${lvl == null ? '—' : levelText(lvl)}</b><small class="${stale ? 'is-old' : ''}">${last ? esc(day(last.checked_at)) : 'Not checked'}</small></span>
      </button>
      <span class="hb-fl">${f ? `<button type="button" class="hb-fname" data-fluid="${f.id}"><b>${esc(f.name)}</b><small>${esc([f.manufacturer, f.bottle_liters ? `${Number(f.bottle_liters)} L` : null].filter(Boolean).join(' · '))}</small></button>
          <span class="hb-step${n ? '' : ' is-out'}" role="group" aria-label="${esc(`${f.name} bottles at ${c.short_name}`)}">
            <button type="button" data-step="${key}" data-d="-1" aria-label="One fewer bottle" ${n ? '' : 'disabled'}>${icon('minus')}</button>
            <span><b>${n}</b><small>${n === 1 ? 'bottle' : 'bottles'}</small></span>
            <button type="button" data-step="${key}" data-d="1" aria-label="One more bottle">${icon('plus')}</button></span>`
        : `<button type="button" class="hb-set" data-model="${t?.id || ''}">Set its fluid</button>`}</span>
    </div>`;
  }

  function density(d, c) {
    const n = d.haze_density;
    const label = `${c.short_name} ${d.name} density`;
    return `<button type="button" class="hb-dv${n == null ? ' is-empty' : ''}" data-dn="1" aria-label="${esc(n == null ? `${label}: not set. Set it` : `${label}: ${n}%. Change it`)}">
      ${n == null ? '<span class="hb-dash">—</span>' : `<span class="hb-bar" style="--lv:${n}%"></span><span class="hb-n"><b>${n}</b><small>%</small></span>`}</button>`;
  }

  /** The sheet is as tall as the screen has left, its lines sharing that evenly, so it all
   *  shows at once. (A screen too short for that keeps a smallest line height and scrolls.) */
  function fit() {
    const board = $('.hb-board', body);
    if (!board) return;
    const top = board.getBoundingClientRect().top + window.scrollY;
    const cs = getComputedStyle(document.documentElement);
    const gap = (parseFloat(cs.getPropertyValue('--vgap')) || 0) + (parseFloat(getComputedStyle(board).marginBottom) || 0);
    let h = Math.max(0, Math.floor(window.innerHeight - top - gap));
    board.style.height = `${h}px`;
    // Whatever's still under it (the home indicator's strip, say) comes off too.
    const over = document.documentElement.scrollHeight - window.innerHeight;
    if (over > 0 && over < h) { h -= over; board.style.height = `${h}px`; }
  }

  // --------------------------------------------------------------- density ---
  function hazerOf(id) {
    const d = s.data.devices.find((x) => x.id === id);
    return d ? { d, c: ctx.campusById.get(d.campus_id) } : null;
  }

  function startEdit(cell) {
    const h = cell && hazerOf(cell.dataset.id);
    if (!h || s.asking) return;
    if (s.edit) stopEdit();
    s.edit = { cell, id: h.d.id };
    cell.classList.add('is-edit');
    cell.innerHTML = `<label class="hb-ed"><input type="text" inputmode="numeric" autocomplete="off" maxlength="4" value="${h.d.haze_density ?? ''}"
      aria-label="${esc(`${h.c.short_name} ${h.d.name} density, 0 to 100. Enter to save, Esc to cancel`)}"><span>%</span></label>`;
    const input = $('input', cell);
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(cell, input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); stopEdit(); }
    });
    // Leaving it (a phone keyboard's ✓, tapping away, Tab) asks the same way Enter does.
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!alive || s.edit?.cell !== cell || s.asking || !cell.isConnected) return;
        if (document.visibilityState === 'hidden') { stopEdit(); return; }
        submit(cell, input.value, true);
      }, 0);
    });
  }

  function stopEdit() {
    s.edit = null;
    draw();
  }

  async function submit(cell, raw, leaving = false) {
    const h = hazerOf(cell.dataset.id);
    if (!h) { stopEdit(); return; }
    const text = String(raw).trim().replace(/\s*%$/, '');
    let next = null;
    if (text !== '') {
      if (!/^\d{1,3}$/.test(text) || Number(text) > 100) {
        cell.classList.remove('is-bad'); void cell.offsetWidth; cell.classList.add('is-bad');
        ctx.toast('Type a density from 0 to 100.');
        if (leaving) stopEdit();
        return;
      }
      next = Number(text);
    }
    const was = h.d.haze_density ?? null;
    if (was === next) { stopEdit(); return; }
    s.asking = true;
    const yes = await hudConfirm({
      title: 'Are you sure you want to confirm this change?',
      where: `${h.c.short_name} · ${h.d.name} · Haze density`,
      from: was == null ? '' : `${was}%`,
      to: next == null ? '' : `${next}%`,
      note: h.d.updated_at && was != null ? `Last changed ${timeAgo(h.d.updated_at)}` : '',
      yes: 'Yes',
      no: 'Cancel',
    });
    s.asking = false;
    if (!alive) return;
    if (!yes) { stopEdit(); return; }
    h.d.haze_density = next; // shown now; put back if it doesn't save
    stopEdit();
    try { await ctx.store.setHazeDensity(h.d.id, next); }
    catch (e) { h.d.haze_density = was; draw(); ctx.toast(e.message, 'bad'); }
  }

  // ---------------------------------------------------------------- a hazer ---
  /** One hazer, opened: what it is, how full its tank is (tap it), and the earlier checks. */
  function openHazer(id) {
    const h = hazerOf(id);
    if (!h) return;
    const { d, c } = h;
    const t = typeOf(d);
    const f = fluid(t?.haze_fluid_id);
    const history = checksOf(d.id);
    const stock = f ? s.extra.stock.find((r) => r.campus_id === c.id && r.fluid_id === f.id) : null;
    let level = history[0]?.level ?? null;
    let filled = false;
    let saving = false;
    const photo = t?.photo_path ? ctx.store.photoUrl(t.photo_path) : null;
    const panel = hudPanel({ label: `${c.short_name} ${d.name}`, className: 'hb-panel' });
    const paint = () => {
      const facts = [
        ['Model', [t?.manufacturer, t?.name].filter(Boolean).join(' ') || 'Not set'],
        ['Room', [roomName(d.room_id), d.location].filter(Boolean).join(' · ') || 'Not set'],
        ['Fluid', f ? [f.manufacturer, f.name].filter(Boolean).join(' ') : 'Not set'],
        ['Tank', t?.tank_liters ? `${Number(t.tank_liters)} L` : 'Not set'],
        ['Density', d.haze_density == null ? 'Not set' : `${d.haze_density}%`],
      ];
      panel.render(`<header class="hp-head"><p class="hp-crumb">${esc(c.short_name)} · Haze${spare(d) ? ' · Spare' : ''}</p><h2>${esc(d.name)}</h2>
          <button type="button" class="hp-x" data-close aria-label="Close">${icon('close')}</button></header>
        <div class="hp-body hb-p">
          <div class="hb-p-top"><span class="hb-pic is-big">${photo ? `<img src="${esc(photo)}" alt="">` : HAZER_ART}</span>
            <dl class="hb-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></div>
          <button type="button" class="hb-link" data-pm="${t?.id || ''}">Change this model’s fluid or tank size</button>
          <h3>How full is the tank?</h3>
          <div class="hb-big ${levelClass(level)}"><span class="hb-gauge"><span class="hb-cyl" style="--lvl:${level ?? 0}%"><i class="hb-liq"></i><u></u><u></u><u></u></span>
            <span class="hb-marks" aria-hidden="true"><em>¼</em><em>½</em><em>¾</em><em>Full</em></span></span></div>
          <div class="hb-lv" role="group" aria-label="Tank level">${LEVELS.map(([n, label]) => `<button type="button" data-lvl="${n}" aria-pressed="${n === level}">${label}</button>`).join('')}</div>
          <button type="button" class="hb-tog" data-filled role="switch" aria-checked="${filled}"><i></i>I filled it</button>
          ${stock?.bottles ? `<label class="hb-used" ${filled ? '' : 'hidden'}><input type="checkbox" id="hb-used"> Used up a bottle of ${esc(f.name)} (${stock.bottles - 1} left at ${esc(c.short_name)} after)</label>` : ''}
          <label class="hb-note"><span>Note</span><input id="hb-note" maxlength="500" placeholder="Anything to know" value="${esc($('#hb-note', panel.el)?.value || '')}"></label>
          ${history.length ? `<h3>Earlier checks</h3><ul class="hb-hist">${history.slice(0, 6).map((k) => `<li><span>${esc(day(k.checked_at))}</span><b>${k.filled ? 'Filled' : levelText(k.level)}</b><small>${esc(k.note || '')}</small></li>`).join('')}</ul>` : ''}
        </div>
        <footer class="hp-foot"><p class="hb-msg" role="status"></p><span class="spacer"></span>
          <button type="button" class="hb-btn" data-close>Cancel</button>
          <button type="button" class="hb-btn is-go" data-save ${level == null ? 'disabled' : ''}>Save check</button></footer>`, { keepScroll: true });
    };
    paint();
    panel.el.addEventListener('click', async (e) => {
      if (saving) return;
      const lv = e.target.closest('[data-lvl]');
      // (Drawn again, what was tapped is gone from the panel: stop there, or the panel would
      // take it for a tap outside and close.)
      if (lv) { e.stopPropagation(); level = Number(lv.dataset.lvl); if (level < 100) filled = false; paint(); return; }
      if (e.target.closest('[data-filled]')) { e.stopPropagation(); filled = !filled; if (filled) level = 100; paint(); return; }
      const pm = e.target.closest('[data-pm]');
      if (pm) { panel.close(true); if (pm.dataset.pm) forms.modelSheet(pm.dataset.pm); return; }
      const save = e.target.closest('[data-save]');
      if (!save || level == null) return;
      saving = true;
      save.disabled = true;
      try {
        await ctx.store.saveGearRow('haze_checks', { device_id: d.id, level, filled, checked_at: new Date().toISOString(), note: $('#hb-note', panel.el).value.trim().slice(0, 500) || null });
        if (filled && stock && $('#hb-used', panel.el)?.checked) await ctx.store.saveGearRow('haze_stock', { id: stock.id, bottles: Math.max(0, stock.bottles - 1) });
        ctx.toast(filled ? `${d.name} filled` : `${d.name}: ${levelText(level)}`);
        panel.close(true);
        load(true);
      } catch (err) {
        saving = false;
        save.disabled = false;
        const m = $('.hb-msg', panel.el);
        if (m) m.textContent = err.message || String(err);
      }
    });
  }
}
