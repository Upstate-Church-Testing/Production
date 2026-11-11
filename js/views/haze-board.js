// Lighting › Haze: the Sunday haze round on one sheet that fits the screen (no scrolling),
// in the console look (like PCO › Scheduling and House lights). One line per hazer in
// service, the locations in the order they're in everywhere else. Left off: spares, and
// the locations that aren't part of the haze round (LEFT_OUT). Across: the location, the
// hazer (its model's photo, its name, the room it's in, its brand), its tank (an upright
// can filled to the last level checked, marked ¼ ½ ¾ and Full), when it was last filled
// and last checked (the level is only as good as that date), and the fluid it takes with
// the bottles on hand at that location (− and +). Tapping a line opens the hazer: tap how
// full the tank is (Empty ¼ ½ ¾ Full), say if it was filled, and see the earlier checks.
// A hazer is an ordinary lighting item in the "Hazer" category (Gear); its model says which
// fluid it takes and how big the tank is (views/haze.js has those forms). Staff and up.
// (devices.haze_density, a percent per hazer, is kept but not shown for now.)

import { esc, icon, $, $$, debounce, pageTitle } from '../util.js';
import { hudPanel } from '../hud.js';
import { hazeView, isHazer } from './haze.js';
import { ALL } from '../picker.js';

const LEVELS = [[0, 'Empty'], [25, '¼'], [50, '½'], [75, '¾'], [100, 'Full']];
const STALE_DAYS = 30;
/** Locations that aren't part of the haze round (by code): not on the sheet. */
const LEFT_OUT = new Set(['GVL', 'LAU', 'UN']);
/** A phone shows a location's code, as Scheduling does. */
const SHORT = { AND: 'AN', MAU: 'MLN' };
const both = (full, short) => (short && short !== full ? `<span class="lf">${esc(full)}</span><span class="ls">${esc(short)}</span>` : esc(full));
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** How long ago a day was, in days: "Today", "Yesterday", "12 days ago". */
const daysAgo = (iso) => {
  const a = new Date(iso); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  const n = Math.round((b - a) / 864e5);
  return n <= 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days ago`;
};
/** The can: filled to --lvl, a line at each quarter, the quarters named beside it. */
const can = (lvl) => `<span class="hb-gauge"><span class="hb-can" style="--lvl:${lvl ?? 0}%"><i class="hb-liq"></i><u></u><u></u><u></u></span>
  <span class="hb-marks" aria-hidden="true"><em>Full</em><em>¾</em><em>½</em><em>¼</em></span></span>`;
const levelText = (n) => (n == null ? 'Not checked' : n >= 100 ? 'Full' : n <= 0 ? 'Empty' : n === 25 ? '¼' : n === 50 ? '½' : n === 75 ? '¾' : `${n}%`);
const levelClass = (n) => (n == null ? 'lvl-none' : n >= 50 ? 'lvl-ok' : n >= 25 ? 'lvl-low' : 'lvl-bad');
/** A hazer, drawn: for a model with no photo. */
const HAZER_ART = '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="17" height="12" rx="1.5"/><path d="M20 15h4v6h-4M7 12V9h7v3M6 27h11"/><path d="M27 13c1.5 1 1.5 2.500 0 3.500s-1.500 2.500 0 3.500" opacity=".7"/></svg>';

export function mount(el, ctx) {
  let alive = true;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const s = { data: null, extra: null, campus: ALL, first: true };

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
    const t = e.target.closest('[data-open], [data-step], [data-fluid], [data-model]');
    if (!t) return;
    if (t.dataset.open) openHazer(t.dataset.open);
    else if (t.dataset.step) forms.stepStock(t.dataset.step, Number(t.dataset.d));
    else if (t.dataset.fluid) forms.fluidSheet((s.extra?.fluids || []).find((f) => f.id === t.dataset.fluid));
    else if (t.dataset.model) forms.modelSheet(t.dataset.model);
  });
  const WATCH = new Set(['devices', 'device_types', 'rooms', 'haze_fluids', 'haze_stock', 'haze_checks']);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (!table || WATCH.has(table)) load(true); }, 300));
  const onResize = debounce(() => fit(), 100);
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  // (That window height can change with no resize event: look every second, and fit again.)
  let seenH = window.innerHeight;
  const watchH = setInterval(() => { if (window.innerHeight !== seenH) { seenH = window.innerHeight; fit(); } }, 1000);

  load(false);
  return {
    unmount() {
      alive = false;
      clearInterval(watchH);
      document.documentElement.classList.remove('hb-lock');
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
    draw();
  }

  function typeOf(d) { return s.data.types.find((t) => t.id === d.type_id) || null; }
  function roomName(id) { return s.data.rooms.find((r) => r.id === id)?.name || ''; }
  function fluid(id) { return (s.extra.fluids || []).find((f) => f.id === id) || null; }
  function checksOf(id) { return s.extra.checks.filter((c) => c.device_id === id).sort((a, b) => b.checked_at.localeCompare(a.checked_at)); }
  function bottles(campusId, fluidId) { return s.extra.stock.find((r) => r.campus_id === campusId && r.fluid_id === fluidId)?.bottles || 0; }
  function spare(d) { return d.status !== 'active'; }
  /** A date on the sheet: the day, and how long ago under it. */
  function when(label, k, old) {
    return `<span class="hb-d${k ? '' : ' is-none'}${old ? ' is-old' : ''}"><small>${label}</small><b>${k ? esc(day(k.checked_at)) : '—'}</b><i>${k ? daysAgo(k.checked_at) : 'Not on record'}</i></span>`;
  }

  /** One line per hazer in service, by location (by room, then name); a location on the
   *  round with none has one empty line. */
  function lines() {
    const hz = s.data.devices.filter((d) => d.status === 'active' && isHazer(typeOf(d)));
    const out = [];
    for (const c of ctx.campuses) {
      if (LEFT_OUT.has(c.code)) continue;
      const here = hz.filter((d) => d.campus_id === c.id)
        .sort((a, b) => roomName(a.room_id).localeCompare(roomName(b.room_id)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
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
        <div class="hb-r hb-hd" role="row"><span>${both('Location', 'Loc')}</span><span>Hazer</span><span>Tank</span><span class="hb-whd"><span>${both('Last filled', 'Filled / checked')}</span><span>Last checked</span></span><span class="hb-fl">Fluid on hand</span></div>
        ${list.map(line).join('')}
      </div>`;
    fit();
    if (s.first) {
      s.first = false;
      // The tanks fill from empty, once.
      if (!still()) {
        const cyl = $$('.hb-can', body);
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
    const checks = checksOf(d.id);
    const last = checks[0];
    const fill = checks.find((k) => k.filled);
    const lvl = last ? last.level : null;
    const stale = last && (Date.now() - Date.parse(last.checked_at)) / 864e5 > STALE_DAYS;
    const n = f ? bottles(c.id, f.id) : 0;
    const photo = t?.photo_path ? ctx.store.photoUrl(t.photo_path, true) : null;
    const room = [roomName(d.room_id), d.location].filter(Boolean).join(' · ') || 'No room set';
    const key = f ? `${c.id}|${f.id}` : '';
    const said = `${c.short_name} ${room} ${d.name}`;
    return `<div class="hb-r${first ? ' is-first' : ''}" role="row" style="${j}" data-id="${d.id}">
      ${loc}
      <button type="button" class="hb-who" data-open="${d.id}" aria-label="${esc(`${said}: open`)}">
        <span class="hb-pic">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy">` : HAZER_ART}</span>
        <span class="hb-nm"><b>${esc(d.name)}</b><span class="hb-room">${esc(room)}</span>
          <small><span class="lf">${esc(t?.manufacturer || '')}</span><span class="ls">${esc([t?.manufacturer, f ? `${n} ${n === 1 ? 'bottle' : 'bottles'}` : null].filter(Boolean).join(' · '))}</span></small></span>
      </button>
      <button type="button" class="hb-tk ${levelClass(lvl)}" data-open="${d.id}" aria-label="${esc(`${said} tank: ${levelText(lvl)}. Check it`)}">
        ${can(lvl)}<span class="hb-rd"><b>${lvl == null ? '—' : levelText(lvl)}</b></span>
      </button>
      <button type="button" class="hb-when" data-open="${d.id}" aria-label="${esc(`${said}: last filled ${fill ? day(fill.checked_at) : 'not on record'}, last checked ${last ? day(last.checked_at) : 'not on record'}`)}">
        ${when('<span class="lf">Last filled</span><span class="ls">Filled</span>', fill, false)}${when('<span class="lf">Last checked</span><span class="ls">Checked</span>', last, stale)}
      </button>
      <span class="hb-fl">${f ? `<button type="button" class="hb-fname" data-fluid="${f.id}"><b>${esc(f.name)}</b><small>${esc([f.manufacturer, f.bottle_liters ? `${Number(f.bottle_liters)} L` : null].filter(Boolean).join(' · '))}</small></button>
          <span class="hb-step${n ? '' : ' is-out'}" role="group" aria-label="${esc(`${f.name} bottles at ${c.short_name}`)}">
            <button type="button" data-step="${key}" data-d="-1" aria-label="One fewer bottle" ${n ? '' : 'disabled'}>${icon('minus')}</button>
            <span><b>${n}</b><small>${n === 1 ? 'bottle' : 'bottles'}</small></span>
            <button type="button" data-step="${key}" data-d="1" aria-label="One more bottle">${icon('plus')}</button></span>`
        : `<button type="button" class="hb-set" data-model="${t?.id || ''}">Set its fluid</button>`}</span>
    </div>`;
  }

  /** The sheet is as tall as the screen has left, its lines sharing that evenly, so it all
   *  shows at once. (A screen too short for that keeps a smallest line height and scrolls.) */
  function fit() {
    const board = $('.hb-board', body);
    if (!board) return;
    document.documentElement.classList.add('hb-lock'); // (measured as it will be: the page's home-bar strip gone)
    const top = board.getBoundingClientRect().top + window.scrollY;
    // Down to the bottom of the screen, less the sheet's own margin (which keeps it clear of
    // the home bar). Never past it, never short of it.
    const room = screenBottom();
    let h = Math.max(0, Math.floor(room - top - (parseFloat(getComputedStyle(board).marginBottom) || 0)));
    board.style.height = `${h}px`;
    // Anything else still under it comes off too, and so does whatever of the sheet itself
    // is past the window's edge.
    const over = Math.max(document.documentElement.scrollHeight - room, Math.ceil(board.getBoundingClientRect().bottom) - room);
    if (over > 0 && over < h) { h -= over; board.style.height = `${h}px`; }
    const row = $('.hb-r:not(.hb-hd)', board);
    // With every line showing, the page itself holds still: nothing to scroll, nothing bounces.
    // (A few px of leeway: lines still rising into place on opening count as taller.)
    document.documentElement.classList.toggle('hb-lock', board.scrollHeight <= board.clientHeight + 8);
    if (row) board.style.setProperty('--rowh', `${Math.floor(row.getBoundingClientRect().height)}px`); // the cans are sized to their line
  }

  /** Where the screen really ends, measured now. The iPhone home-screen app sometimes
   *  reports its window about a status bar shorter than the screen it fills (iOS 26.0), and
   *  sometimes not, changing without notice: so the screen's own height is used there
   *  whenever the window is within a status bar of it (further off is a keyboard). */
  function screenBottom() {
    const ios = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
    const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    if (!(ios && standalone)) return window.innerHeight;
    const tall = window.innerHeight > window.innerWidth;
    const full = tall ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const short = full - window.innerHeight;
    return short >= 0 && short <= 90 ? full : window.innerHeight;
  }

  function hazerOf(id) {
    const d = s.data.devices.find((x) => x.id === id);
    return d ? { d, c: ctx.campusById.get(d.campus_id) } : null;
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
      ];
      panel.render(`<header class="hp-head"><p class="hp-crumb">${esc(c.short_name)} · Haze${spare(d) ? ' · Spare' : ''}</p><h2>${esc(d.name)}</h2>
          <button type="button" class="hp-x" data-close aria-label="Close">${icon('close')}</button></header>
        <div class="hp-body hb-p">
          <div class="hb-p-top"><span class="hb-pic is-big">${photo ? `<img src="${esc(photo)}" alt="">` : HAZER_ART}</span>
            <dl class="hb-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></div>
          <button type="button" class="hb-link" data-pm="${t?.id || ''}">Change this model’s fluid or tank size</button>
          <h3>How full is the tank?</h3>
          <div class="hb-big ${levelClass(level)}">${can(level)}
            <div class="hb-when">${when('Last filled', history.find((k) => k.filled), false)}${when('Last checked', history[0], false)}</div></div>
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
