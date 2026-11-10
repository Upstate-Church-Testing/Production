// Services: browse Planning Center by location, then date, then service
// (Vintage, Traditional, Modern…), and see that service's flow (the order of
// service, with run times and team notes), its times and who's on the
// production teams. Scheduling (the roster) is the whole schedule at a glance: every position
// at every location, date by date, one pill per person. Each of these is its own page
// under PCO in the sidebar (Services, Scheduling, People, My schedule): the page's
// scope.mode says which. Planning Center is connected once for the whole church
// (Settings › Planning Center); nobody signs in to it here. What each person
// sees comes from their role in this app and the services an admin shares.
// Staff can open a service's Live (js/live.js, the same view as Events): where the service is
// in Planning Center Live, the clock, what's next, and for admins Take control, Back and Next.

import { esc, icon, $, $$, debounce, plural, timeAgo, initials, pageTitle } from '../util.js';
import { ALL, dropdownHtml, wireDropdown } from '../picker.js';
import { clock, teamKey, teamServices, realPhoto, STATUS_LABEL } from '../pco.js';
import { peopleView, LANYARDS } from './volunteers.js';
import { microBadge } from '../lanyard.js';
import { openPersonFull } from './person-full.js';
import { openScheduleSheet, takeOff } from './schedule-sheet.js';
import { pcoModel, rosterData as sharedRosterData } from '../roster.js';
import { createLive, liveButtonHtml } from '../live.js';

const POLL_MS = 20000; // backup for the live push (a phone that slept, a dropped connection)

// The Scheduling grid on a phone uses short labels so three weeks fit across. Both the
// full and the short label are drawn; CSS shows one (.lf full, .ls short).
/** How many people each position's team should have (Scheduling › Team counts spots short of it). */
const TEAM_NEED = 3;
const both = (full, short) => (short && short !== full ? `<span class="lf">${esc(full)}</span><span class="ls">${esc(short)}</span>` : esc(full));
/** AN, FF, FI, GVL, GCC, HB, MLN, SVL: a location's code, with the two the team says differently. */
const CAMPUS_SHORT = { AND: 'AN', MAU: 'MLN' };
const campusShort = (c) => (c ? CAMPUS_SHORT[c.code] || c.code || c.short_name : 'Other');
/** CG, LX, C1, TD, DIR…: positions as the team says them. Anything unknown stays as it is. */
function positionShort(name) {
  const n = String(name || '').trim();
  const cam = /^cam(?:era)?\s*(\d+)\b/i.exec(n);
  if (cam) return `C${cam[1]}`;
  if (/^td\b|\bswitcher\b/i.test(n)) return 'TD';
  const ptz = /^ptz\s*seat\s*(\d+)/i.exec(n);
  if (ptz) return `PTZ${ptz[1]}`;
  return n
    .replace(/\bcomputer graphics\b/gi, 'CG')
    .replace(/\blight(?:ing|s)?\b/gi, 'LX')
    .replace(/\bdirector\b/gi, 'DIR')
    .replace(/\bproducer\b/gi, 'PROD')
    .replace(/\bstage manager\b/gi, 'SM')
    .replace(/\(?\btraining\b\)?/gi, 'TR')
    .replace(/\b(?:audio|sound)\b/gi, 'AUD')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ');
}
const teamShort = (t) => (String(t).length <= 4 ? t : String(t).split(/[\s/]+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase());
/** First name and last initial, for a name that doesn't fit its pill on a phone. */
function nameShort(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length < 2 ? name : `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
/** On a phone, a name that doesn't fit its pill shows as "First L."; one that fits stays whole. */
function fitNames(table) {
  const names = [...table.querySelectorAll('.rp b')].filter((b) => b.querySelector('.ns'));
  names.forEach((b) => b.classList.remove('is-short'));
  if (window.innerWidth >= 700) return;
  names.filter((b) => b.scrollWidth > b.clientWidth + 0.5).forEach((b) => b.classList.add('is-short'));
}
const FAST_MS = 3000;

export function mount(el, ctx) {
  let alive = true;
  const isStaff = ctx.roleAtLeast(ctx.me.role, 'staff');
  const isAdmin = ctx.me.role === 'admin';
  // Where you were (location, date, service) lasts while the app is open.
  const nav = ctx.servicesNav || (ctx.servicesNav = { date: null, plan: null, pane: 'flow', at: 0, mode: 'services' });
  // Home sent us here about a Sunday: who declined (or hasn't answered) that day stands out,
  // with a line saying who, until it's closed or this page is left.
  let attn = null;
  if (ctx.pending?.attention) { attn = ctx.pending.attention; ctx.pending = null; nav.week = 'sun'; }
  // Which PCO page this is. With one, the page stays on its own view and a jump to
  // another view (a plan from My schedule) goes to that page.
  const fixed = ctx.page?.scope?.mode || null;
  if (fixed) nav.mode = fixed;
  const PAGE_FOR = { services: 'services', roster: 'scheduling', people: 'people', mine: 'my-schedule' };
  /** Show another view: on its own page when this page is fixed to one. */
  const setMode = (m) => {
    if (fixed && m !== fixed) { nav.mode = m; ctx.go(PAGE_FOR[m]); return; }
    nav.mode = m; draw(); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  let pills = new Map(); // roster pill id -> its person and services, for the detail sheet
  let opens = new Map(); // roster open-spot id -> its row, day and services (staff schedule from it)
  const flows = new Map(); // plan id -> its items, loaded when opened
  const staleFlows = new Set(); // read again after a sync, while the old flow stays on screen
  const s = {
    status: undefined, // undefined while loading, null when Planning Center isn't connected
    data: null,
    error: null,
    campus: ctx.campus, // shared with Gear and Network; All on every launch
    refreshing: false,
    picked: false,      // a location was chosen on this screen (or by default)
    vol: null,          // staff: { people, members } from the volunteer list
    volError: null,
  };
  if (nav.mode === 'people' && !isStaff) nav.mode = 'services';
  if (s.campus !== ALL && !ctx.campusById.has(s.campus)) s.campus = ALL;
  let timer = null;
  // Live for the service that's open. Which one is kept for the session, so a reload into a
  // new version comes straight back to it.
  const LIVE_KEY = 'ucp.services.live';
  const liveSaved = () => { try { return sessionStorage.getItem(LIVE_KEY); } catch { return null; } };
  const liveSave = (id) => { try { if (id) sessionStorage.setItem(LIVE_KEY, id); else sessionStorage.removeItem(LIVE_KEY); } catch { /* private mode */ } };
  let liveRestored = false;
  // Scheduling's Team column (staff): who's on each team in Planning Center, by position,
  // from the volunteer list (s.vol). Whether it's open lasts while the app is open.
  let crewIx = null;       // { vol, byPco: Planning Center person id -> volunteer }
  // Schedule ⇄ Team (staff): the same grid, with who's on each team in place of the dates.
  // The switch sits right of Production in the top row on phones, in the page's head on a
  // computer (placeTools). Where each grid was scrolled to is kept per view and week.
  if (!nav.view || !isStaff) nav.view = 'sched';
  let viewBusy = false;
  const scrollMem = new Map(); // "sched:sun" -> { left, top }
  const viewSw = () => document.getElementById('s-view');
  const narrow = matchMedia('(max-width: 859px)');
  // Sundays ⇄ Wednesdays: the board stays, what's on it goes out top left to bottom right,
  // then the other week's comes in the same way (styles.css, "Sundays ⇄ Wednesdays").
  let weekBusy = false;
  let weekWant = null; // tapped while one was still moving: go there once it's done
  // Scheduling's scroll bar (barHtml, bindBar, paintBar)
  let sbWrap = null;   // the grid it's following (the week that's showing)
  let sbGeo = null;    // { labels: px under the labels, lf, cols: each date's place along the dates }
  const live = createLive(ctx, {
    tz: () => s.status?.time_zone,
    onClose: () => { liveSave(null); if (alive) $('[data-act="live"]', el)?.focus({ preventScroll: true }); },
  });

  el.innerHTML = `
    <div class="page-head">
      <div class="mode-row">
        ${fixed ? pageTitle(ctx.page) : ''}
        <div class="seg mode-seg" role="tablist" aria-label="Show" id="s-seg" hidden>
          <button type="button" role="tab" data-smode="services">Services</button>
          <button type="button" role="tab" data-smode="roster">Scheduling</button>
          ${isStaff ? '<button type="button" role="tab" data-smode="people">People</button>' : ''}
          <button type="button" role="tab" data-smode="mine">My schedule</button>
        </div>
        <div class="ros-tools">
          ${isStaff ? `<div class="hud-sw ros-view" role="tablist" aria-label="Schedule or team" id="s-view" data-on="0" hidden>
            <button type="button" role="tab" data-view="sched">Schedule</button>
            <button type="button" role="tab" data-view="team">Team</button>
          </div>` : ''}
          <div class="hud-sw ros-week" role="tablist" aria-label="Which services" id="s-week" data-on="0" hidden>
            <button type="button" role="tab" data-week="sun">${both('Sundays', 'Sun')}</button>
            <button type="button" role="tab" data-week="mid">${both('Wednesdays', 'Wed')}</button>
          </div>
        </div>
        <p class="tally" id="s-tally" aria-live="polite"></p>
      </div>
      <p class="head-meta svc-meta" id="s-meta"></p>
    </div>
    <div class="toolbar filter-bar svc-bar" id="s-bar" hidden>
      <div class="filters">${dropdownHtml('s-loc', 'Location', 'caps')}</div>
    </div>
    <div class="results svc" id="s-body"><div class="loading">${'<div class="sk tall"></div>'.repeat(2)}</div></div>`;

  // Only locations that have shared services are offered. (The roster has a slim copy up top.)
  const locOptions = {
    label: 'Location',
    unit: () => (nav.mode === 'people' ? ['person', 'people'] : ['service', 'services']),
    get: () => s.campus,
    set: (v) => { pickCampus(v); },
    options: () => {
      const m = model();
      if (!m) return [{ value: ALL, label: 'All locations' }];
      return [{ value: ALL, label: 'All locations', count: m.plans.length },
        ...m.places.map((c) => ({ value: c.id, label: c.short_name, count: m.plansAt(c.id).length }))];
    },
  };
  // Scheduling always shows every location at once.
  const rosterCampus = () => ALL;
  const loc = wireDropdown($('#s-loc', el), locOptions);
  const people = peopleView({
    ctx, s, model: () => model(), kindName: (t, p) => kindName(t, p), openPlan: (id) => openPlan(id), reloadPeople: () => loadPeople(),
  });

  el.addEventListener('input', (e) => { if (nav.mode === 'people') people.input(e); });
  // Scheduling's scroll bar: dragging the thumb, tapping the track (the arrows are clicks).
  el.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.ros-sb-track');
    if (!track || !sbWrap || !sbGeo) return;
    const wrap = sbWrap;
    const dates = wrap.scrollWidth - sbGeo.labels;
    const tw = track.getBoundingClientRect();
    const thumb = e.target.closest('.ros-sb-thumb');
    e.preventDefault();
    if (!thumb) { // the track: go there (that point in the middle)
      const at = (e.clientX - tw.left) / tw.width;
      const shown = wrap.clientWidth - sbGeo.labels;
      wrap.scrollTo({ left: at * dates - shown / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return;
    }
    const x0 = e.clientX;
    const s0 = wrap.scrollLeft;
    thumb.setPointerCapture(e.pointerId);
    thumb.classList.add('is-drag');
    const move = (ev) => { wrap.scrollLeft = s0 + ((ev.clientX - x0) / tw.width) * dates; };
    const up = () => { thumb.classList.remove('is-drag'); thumb.removeEventListener('pointermove', move); thumb.removeEventListener('pointerup', up); thumb.removeEventListener('pointercancel', up); };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('pointercancel', up);
  });

  el.addEventListener('click', (e) => {
    if (nav.mode === 'people' && people.click(e)) return;
    const t = e.target.closest('[data-act], [data-smode], [data-week], [data-view], [data-campus], [data-date], [data-plan], [data-goto], [data-pane], [data-at], [data-rp], [data-ro], [data-sb]');
    if (!t) return;
    if (t.dataset.smode) { setMode(t.dataset.smode); return; }
    if (t.dataset.week) { switchWeek(t.dataset.week); return; }
    if (t.dataset.view) { switchView(t.dataset.view); return; }
    if (t.dataset.sb) { stepWeek(Number(t.dataset.sb)); return; }
    if (t.dataset.rp) { openFull({ pillId: t.dataset.rp }); return; }
    if (t.dataset.ro) { openOpen(t.dataset.ro); return; }
    if (t.dataset.campus) { pickCampus(t.dataset.campus); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (t.dataset.date) { nav.date = t.dataset.date; nav.plan = null; nav.at = 0; draw(); return; }
    if (t.dataset.plan) { nav.plan = t.dataset.plan; nav.at = 0; draw(); return; }
    if (t.dataset.pane) { nav.pane = t.dataset.pane; draw(); return; }
    if (t.dataset.at) { nav.at = Number(t.dataset.at); draw(); return; }
    if (t.dataset.goto) { openPlan(t.dataset.goto); return; }
    const act = t.dataset.act;
    if (act === 'settings') ctx.openSettings('pco');
    else if (act === 'refresh') refresh();
    else if (act === 'retry') load();
    else if (act === 'mine') setMode('mine');
    else if (act === 'all-places') pickCampus(ALL);
    else if (act === 'attn-off') { attn = null; draw(); }
    else if (act === 'live') openLive(nav.plan);
    else if (act === 'crew-p') openFull({ volId: t.dataset.v }); // them, full screen
  });

  // The Schedule | Team switch lives outside this page's element on a phone (the top row),
  // so its taps are heard there, and it's taken back out when the page is left.
  const onViewTap = (e) => { const b = e.target.closest('[data-view]'); if (b) switchView(b.dataset.view); };
  viewSw()?.addEventListener('click', (e) => { if (!el.contains(e.currentTarget)) onViewTap(e); });
  const onNarrow = () => placeTools();
  narrow.addEventListener('change', onNarrow);
  placeTools();

  const onVisible = () => { if (document.visibilityState === 'visible') checkStatus(); };
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = ctx.store.subscribe(debounce((table) => {
    if (table === 'pco' || table === 'profiles') load(true);
    else if (table === 'volunteers') loadPeople();
  }, 300));
  const clockTimer = setInterval(drawHead, 30000); // keeps "updated 3 min ago" honest
  // Wednesdays take their size from the Sunday grid, so a resize works both out again.
  const onResize = debounce(() => { if (nav.mode === 'roster' && !weekBusy && !viewBusy) draw(); }, 120);
  window.addEventListener('resize', onResize);

  load();
  return {
    unmount() {
      alive = false;
      if (live.isOpen()) liveSave(null); // left the page with Live open: don't bring it back next time
      live.destroy();
      clearTimeout(timer); clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('resize', onResize);
      document.documentElement.classList.remove('ros-lock');
      narrow.removeEventListener('change', onNarrow);
      const sw = viewSw();
      if (sw && !el.contains(sw)) sw.remove(); // out of the top row
      unsubscribe();
    },
  };

  function pickCampus(id) {
    s.campus = ctx.campus = id;
    s.picked = true;
    if (nav.mode === 'mine' && !fixed) nav.mode = 'services';
    nav.date = null; nav.plan = null;
    draw();
  }

  /** Live for a service (staff): its location and name up top, "Simpsonville Vintage". */
  function openLive(planId) {
    const m = model();
    const p = m?.plans.find((x) => x.id === planId);
    if (!isStaff || !p) return;
    const t = m.type(p);
    const campus = t.campus_id ? ctx.campusById.get(t.campus_id)?.short_name : null;
    const name = kindName(t, p);
    liveSave(p.id);
    live.open({ id: p.id, title: campus && !name.toLowerCase().includes(campus.toLowerCase()) ? `${campus} ${name}` : name, day: p._day });
  }

  /** Jump straight to one plan (from My schedule or "You're on"). */
  function openPlan(planId) {
    const m = model();
    const p = m?.plans.find((x) => x.id === planId);
    if (!p) return;
    s.campus = ctx.campus = m.type(p).campus_id || ALL;
    s.picked = true;
    nav.date = clock(s.status?.time_zone).day(p.sort_date);
    nav.plan = p.id;
    setMode('services');
  }

  // ------------------------------------------------------------- data ---

  async function load(quiet = false) {
    try {
      const [status, data, me] = await Promise.all([ctx.store.pcoStatus(), ctx.store.pcoData(), ctx.store.me().catch(() => null)]);
      s.status = status;
      s.data = data;
      s.error = null;
      for (const id of flows.keys()) staleFlows.add(id); // a sync may have changed them: read again, showing the old one meanwhile
      if (me) ctx.me.pco_person_id = me.pco_person_id ?? null; // matched by email during a sync
    } catch (e) {
      if (!quiet || !s.data) s.error = e.message;
    }
    if (isStaff) await loadPeople(false);
    if (!alive) return;
    // First time in: go straight to your home location if it has services.
    if (!s.picked && s.campus === ALL) {
      const m = model();
      const home = ctx.me.home_campus_id;
      if (m && home && m.plansAt(home).length) s.campus = home;
    }
    draw();
    schedule();
    // Live was open before a reload (a new version): straight back to that service and its Live.
    if (!liveRestored) {
      liveRestored = true;
      const id = liveSaved();
      if (id && isStaff && nav.mode === 'services' && model()?.plans.some((x) => x.id === id)) { openPlan(id); openLive(id); }
      else if (id) liveSave(null);
    }
  }

  /** Staff: the volunteer list (lanyards, tags, notes) and who's on which team. */
  async function loadPeople(redraw = true) {
    try {
      s.vol = await ctx.store.volunteers();
      s.volError = null;
    } catch (e) { s.volError = e.message; }
    if (redraw && alive && (nav.mode === 'people' || nav.mode === 'roster')) {
      if (nav.mode === 'people') people.drawList(); else draw();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!alive || s.status === null) return;
    timer = setTimeout(checkStatus, s.status?.syncing ? FAST_MS : POLL_MS);
  }

  // Cheap check; reload the services only when a sync has finished since.
  async function checkStatus() {
    if (!alive || document.visibilityState === 'hidden') return schedule();
    try {
      const st = await ctx.store.pcoStatus();
      // Reload when Planning Center data changed (the sync runs every 30 seconds but
      // usually finds nothing new), or when a refresh someone asked for has finished.
      const changedAt = (x) => x?.changed_at ?? x?.last_sync_at;
      const finished = !!st !== !!s.status || changedAt(st) !== changedAt(s.status) || (s.status?.syncing && !st?.syncing);
      s.status = st;
      if (finished) return load(true);
      drawHead();
    } catch { /* try again later */ }
    schedule();
  }

  async function refresh() {
    if (s.refreshing) return;
    s.refreshing = true;
    drawHead();
    try {
      await ctx.store.pco('sync');
      s.status = { ...s.status, syncing: true };
    } catch (e) { ctx.toast(e.message); }
    s.refreshing = false;
    drawHead();
    schedule();
  }

  /** Everything the screen needs, worked out from what this person is allowed to read. */
  function model() {
    return pcoModel(s.data, s.status, ctx, nav.week);
  }


  // ---------------------------------------------------------- drawing ---

  function drawHead() {
    if (!alive) return;
    const st = s.status;
    const meta = $('#s-meta', el);
    if (!st) { meta.innerHTML = ''; return; }
    const when = st.syncing || s.refreshing
      ? `<span class="svc-sync">${icon('refresh')}Updating from Planning Center…</span>`
      : st.last_sync_at ? `Updated ${esc(timeAgo(st.last_sync_at))}` : 'Waiting for the first update';
    const err = isStaff && st.last_sync_error ? `<span class="svc-err">${icon('warn')}Last update didn’t finish: ${esc(st.last_sync_error)}</span>` : '';
    meta.innerHTML = `${when}${isStaff && !st.syncing && !s.refreshing ? ` <i>·</i> <button class="btn link" data-act="refresh">Refresh</button>` : ''}${err ? `<br>${err}` : ''}`;
  }

  function draw() {
    if (!alive) return;
    const box = $('#s-body', el);
    const m = model();
    const connected = !!s.status;
    const seg = $('#s-seg', el);
    if (nav.mode === 'mine' && !m?.me && !fixed) nav.mode = 'services';
    seg.hidden = !!fixed || !connected || !m?.plans.length; // a PCO page is one view: the sidebar picks
    seg.querySelector('[data-smode="mine"]').hidden = !m?.me;
    seg.querySelectorAll('[data-smode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.smode === nav.mode)));
    const rosterMode = nav.mode === 'roster' && connected && !!m?.plans.length;
    el.classList.toggle('is-roster', rosterMode);
    document.documentElement.classList.toggle('ros-lock', rosterMode); // the page holds still; only the grid scrolls sideways
    if (rosterMode && window.scrollY) window.scrollTo(0, 0); // coming from a page that was scrolled down
    el.classList.toggle('is-people', nav.mode === 'people');
    const wk = $('#s-week', el);
    wk.hidden = !rosterMode || m.weeks.size < 2; // only once there's a midweek to show
    markSw(wk, 'week', m?.week);
    const vw = viewSw();
    if (vw) { vw.hidden = !rosterMode; markSw(vw, 'view', nav.view); }
    $('#s-bar', el).hidden = !connected || !m?.plans.length || nav.mode === 'mine' || rosterMode;
    drawHead();
    loc.update();
    $('#s-tally', el).innerHTML = '';

    if (s.error) {
      box.innerHTML = `<div class="empty"><h3>Couldn’t load services</h3><p>${esc(s.error)}</p><div class="empty-actions"><button class="btn" data-act="retry">Try again</button></div></div>`;
      return;
    }
    if (s.status === undefined) return; // still loading
    if (!connected) { box.innerHTML = notConnected(); return; }
    if (!m.types.length) {
      box.innerHTML = s.status.syncing || !s.status.last_sync_at
        ? `<div class="empty"><h3>Getting services from Planning Center…</h3><p>The first update takes about a minute. This page fills in by itself.</p></div><div class="loading">${'<div class="sk tall"></div>'.repeat(2)}</div>`
        : `<div class="empty"><h3>No services are shared yet</h3><p>${isAdmin ? 'Pick which Planning Center services the team sees, and which teams show on them.' : 'An admin hasn’t shared any Planning Center services with your role yet.'}</p>${isAdmin ? `<div class="empty-actions"><button class="btn primary" data-act="settings">${icon('settings')}Choose services</button></div>` : ''}</div>`;
      return;
    }
    const weeks = s.status.weeks_ahead || 6;
    if (!m.plans.length) {
      box.innerHTML = `<div class="empty"><h3>Nothing scheduled yet</h3><p>No shared services in the next ${plural(weeks, 'week')}.</p></div>`;
      return;
    }

    if (nav.mode === 'mine' && !m.me) {
      box.innerHTML = `<div class="empty"><h3>Your schedule isn’t linked yet</h3><p>Your account is matched to Planning Center by email. Once your Planning Center profile has the same email as this account, the services you’re on show up here.</p></div>`;
      return;
    }
    if (nav.mode === 'mine') { box.innerHTML = mySchedule(m); return; }
    if (nav.mode === 'roster') {
      // Sundays and Wednesdays are both drawn and laid out, one over the other on the same
      // stage, so switching between them only moves what's already there (switchWeek).
      // Planning Center refreshes redraw them every few seconds: each stays where it was.
      for (const w of $$('.ros-wrap', box)) scrollMem.set(`${w.dataset.vw}:${w.dataset.wk}`, { left: w.scrollLeft, top: w.scrollTop });
      const keep = { get: (w) => scrollMem.get(`${nav.view}:${w}`) };
      const weeks = ['sun', 'mid'].filter((w) => m.rosterIn(w).length);
      if (!weeks.includes(m.week)) weeks.push(m.week);
      const wrapOf = (w) => $(`.ros-wrap[data-wk="${w}"]`, box);
      const teamNow = nav.view === 'team' && isStaff && !!s.vol;
      const lay = (geo = null) => {
        pills = new Map();
        opens = new Map();
        box.innerHTML = (attn && m.week === 'sun' ? attentionHtml(m) : '')
          + `<div class="ros-stage">${weeks.map((w) => roster(m, w, rosterCampus(m), w === m.week, geo?.get(w))).join('')}${barHtml()}</div>`;
      };
      // Team takes its every measurement from the schedule's grid (label columns, each row's
      // height, the width of a date, the size it's scaled to), so no line moves between the
      // two: the schedule is laid out and measured first, then Team is laid out to match.
      let geo = null;
      if (teamNow) {
        nav.view = 'sched';
        lay();
        let size0 = null;
        if (wrapOf('sun')) size0 = fitRoster(null, wrapOf('sun'));
        if (wrapOf('mid')) fitRoster(size0 || { z: null, extra: 0 }, wrapOf('mid'));
        geo = new Map(weeks.map((w) => {
          const wrap = wrapOf(w); // where the schedule was left: those are the dates Team's columns line up with
          const k = scrollMem.get(`sched:${w}`);
          if (wrap && k) wrap.scrollLeft = k.left; else if (wrap) scrollToNext(wrap);
          return [w, measureGrid(wrap)];
        }));
        nav.view = 'team';
      }
      lay(geo);
      // Wednesdays is a few rows: the size they are on Sundays (every location), not blown up
      // to fill the screen.
      if (geo) { for (const w of weeks) matchGrid(wrapOf(w), geo.get(w)); } else {
        let size = null;
        if (wrapOf('sun')) size = fitRoster(null, wrapOf('sun'));
        if (wrapOf('mid')) fitRoster(size || { z: null, extra: 0 }, wrapOf('mid'));
      }
      for (const w of weeks) {
        const wrap = wrapOf(w);
        if (!wrap) continue;
        const k = keep.get(w);
        if (k) { wrap.scrollLeft = k.left; wrap.scrollTop = k.top; } else if (nav.view === 'team') alignTeam(wrap, geo?.get(w)); else scrollToNext(wrap);
        if (attn && w === 'sun' && m.week === 'sun') markAttention(wrap, !k);
      }
      fitStage();
      $$('.ros-wrap', box).forEach((w) => w.addEventListener('scroll', () => { if (w === sbWrap) paintBar(); }, { passive: true }));
      bindBar();
      return;
    }
    if (nav.mode === 'people') { people.draw(box); return; }
    if (s.campus === ALL || !m.plansAt(s.campus).length) { box.innerHTML = (m.me ? youBanner(m) : '') + placePicker(m); return; }
    box.innerHTML = campusView(m);
    // On a phone the dates scroll sideways; keep the picked one in view without moving the page.
    const strip = $('.svc-dates', box);
    const onDate = $('.is-on', strip || box);
    if (strip && onDate && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = onDate.offsetLeft - (strip.clientWidth - onDate.offsetWidth) / 2;
  }

  // Step 1: pick a location.
  function placePicker(m) {
    return `<section class="svc-step">
      <h2 class="svc-step-h">Pick a location</h2>
      <div class="svc-places">${m.places.map((cp) => {
        const list = m.plansAt(cp.id);
        const kinds = new Set(list.map((p) => p.service_type_id)).size;
        const next = list[0];
        return `<button type="button" class="svc-place" data-campus="${cp.id}">
          <b>${esc(cp.short_name)}</b>
          <small>${plural(kinds, 'service')} <i>·</i> next ${esc(m.c.weekday(next.sort_date).slice(0, 3))} ${esc(m.c.date(next.sort_date))}</small>
          ${icon('chevron', 'svc-place-go')}
        </button>`;
      }).join('')}</div>
    </section>`;
  }

  // Steps 2 and 3: pick a date, then a service on that date; then the service itself.
  function campusView(m) {
    const here = m.plansAt(s.campus);
    const days = [...new Set(here.map((p) => p._day))];
    // Opens on the next service; the ones that already happened stay to the left, dimmed.
    if (!days.includes(nav.date)) { nav.date = days.find((d) => d >= m.today) || days[days.length - 1]; nav.plan = null; }
    const onDay = here.filter((p) => p._day === nav.date);
    if (!onDay.some((p) => p.id === nav.plan)) nav.plan = onDay[0]?.id || null;
    const plan = onDay.find((p) => p.id === nav.plan);
    const campus = ctx.campusById.get(s.campus);
    const kinds = new Set(here.map((p) => p.service_type_id)).size;
    $('#s-tally', el).innerHTML = `<b>${kinds}</b><span>${kinds === 1 ? 'service' : 'services'}</span><small>at ${esc(campus?.short_name || '')}</small>`;

    return `
      <div class="svc-dates" role="tablist" aria-label="Date">${days.map((d) => {
        const p = here.find((x) => x._day === d);
        const on = d === nav.date;
        return `<button type="button" role="tab" class="svc-date ${on ? 'is-on' : ''} ${d < m.today ? 'is-past' : ''}" data-date="${d}" aria-selected="${on}" ${d < m.today ? 'title="Already happened"' : ''}>
          <small>${esc(m.c.weekday(p.sort_date).slice(0, 3))}</small><b>${esc(m.c.date(p.sort_date))}</b>
        </button>`;
      }).join('')}</div>
      ${onDay.length > 1 ? `<div class="seg svc-kinds" role="tablist" aria-label="Service">${onDay.map((p) => {
        const on = p.id === nav.plan;
        return `<button type="button" role="tab" data-plan="${p.id}" aria-selected="${on}">${esc(kindName(m.type(p), p))}<small>${esc(firstTime(m, p))}</small></button>`;
      }).join('')}</div>` : ''}
      ${plan ? detail(m, plan) : ''}`;
  }

  // "Simpsonville - Modern [North Auditorium]" → "North Modern"; "GCC - Vintage" → "Vintage".
  function kindName(t, p) {
    const campus = t.campus_id ? ctx.campusById.get(t.campus_id) : null;
    const room = (t.name.match(/\[([^\]]+)\]/) || [])[1];
    let n = t.name.replace(/\[[^\]]*\]/g, ' ');
    if (campus) n = n.replace(new RegExp(campus.short_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    n = n.replace(/^[\s:\-–—·|]+|[\s:\-–—·|]+$/g, '').replace(/\s+/g, ' ').trim();
    if (room) n = `${room.trim().split(/\s+/)[0]} ${n}`.trim();
    return n || p?.title || 'Service';
  }

  function firstTime(m, p) {
    const services = p.times.filter((x) => x.kind === 'service').map((x) => x.starts_at).filter(Boolean);
    return services.length ? m.c.times(services) : m.c.time(p.sort_date);
  }

  function detail(m, p) {
    const t = m.type(p);
    const campus = t.campus_id ? ctx.campusById.get(t.campus_id)?.short_name : null;
    const teams = m.teams.filter((tm) => teamServices(tm).includes(p.service_type_id))
      .sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99) || a.name.localeCompare(b.name));
    const roster = m.people.get(p.id) || [];
    const tally = { C: 0, U: 0, D: 0, open: 0 };
    const blocks = teams.map((tm) => teamBlock(tm, roster.filter((r) => r.team_id === tm.id), (p.needed || []).filter((n) => n.team_id === tm.id), m.me, tally)).join('');
    const sub = [p.title && !t.name.toLowerCase().includes(p.title.toLowerCase()) ? p.title : null, p.series_title].filter(Boolean).join(' · ');
    const times = [...p.times].filter((x) => x.starts_at).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const items = flows.get(p.id);
    if (items === undefined || staleFlows.has(p.id)) loadFlow(p.id);
    const crewCount = roster.filter((r) => r.status !== 'D').length;
    const pane = nav.pane === 'team' ? 'team' : 'flow';
    return `<article class="svc-detail">
      <header class="svc-dhead">
        <div class="svc-title">
          <small class="svc-loc">${esc([campus, `${m.c.weekday(p.sort_date)}, ${m.c.date(p.sort_date)}`].filter(Boolean).join(' · '))}</small>
          <h2>${esc(kindName(t, p))}</h2>
          <p class="svc-sub">${esc(t.name)}${sub ? ` · ${esc(sub)}` : ''}</p>
        </div>
        ${isStaff && p.url && p.url !== '#' ? `<a class="btn small ghost" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('open')}<span>Planning Center</span></a>` : ''}
      </header>
      ${times.length ? `<ol class="svc-times-list">${times.map((x) => `<li class="${x.kind === 'service' ? 'is-service' : ''}">
          <b>${esc(m.c.time(x.starts_at))}</b><span>${esc(x.name || (x.kind === 'service' ? 'Service' : x.kind === 'rehearsal' ? 'Rehearsal' : 'Other'))}</span>
        </li>`).join('')}</ol>` : ''}
      ${isStaff ? liveButtonHtml() : ''}
      <div class="seg svc-panes" role="tablist" aria-label="Show">
        <button type="button" role="tab" data-pane="flow" aria-selected="${pane === 'flow'}">${icon('list')}Flow${items?.length ? `<small>${items.filter((x) => x.kind !== 'header').length}</small>` : ''}</button>
        <button type="button" role="tab" data-pane="team" aria-selected="${pane === 'team'}">${icon('team')}Team<small>${crewCount}</small></button>
      </div>
      <div class="svc-split" data-show="${pane}">
        <section class="svc-flow" aria-label="Flow of service">${flowHtml(m, p, items)}</section>
        <section class="svc-crew" aria-label="Team">
          <div class="svc-teams">${blocks || '<p class="svc-none">No production teams on this service.</p>'}</div>
          <footer class="svc-foot">
            <span class="svc-counts">${[
              tally.C ? `<span class="is-C">${tally.C} confirmed</span>` : '',
              tally.U ? `<span class="is-U">${tally.U} requested</span>` : '',
              tally.D ? `<span class="is-D">${tally.D} declined</span>` : '',
              tally.open ? `<span class="is-open">${tally.open} open</span>` : '',
            ].filter(Boolean).join('') || '<span>No one scheduled yet</span>'}</span>
          </footer>
        </section>
      </div>
    </article>`;
  }

  async function loadFlow(planId) {
    staleFlows.delete(planId);
    const had = flows.get(planId);
    if (had === undefined) flows.set(planId, null); // loading (the first time only; after that the old flow stays up)
    try {
      const items = (await ctx.store.pcoItems(planId)) || [];
      if (Array.isArray(had) && JSON.stringify(had) === JSON.stringify(items)) return; // nothing new: leave the page as it is
      flows.set(planId, items);
    } catch (e) {
      if (Array.isArray(had)) return; // keep the flow that's showing
      flows.set(planId, { error: e.message });
    }
    if (alive && nav.plan === planId) draw();
  }

  // The order of service with a running clock: pre-service items lead up to the
  // start, the service runs from it, post-service items follow the end.
  function flowHtml(m, p, items) {
    if (items === undefined || items === null) return `<div class="loading">${'<div class="sk"></div>'.repeat(3)}</div>`;
    if (items.error) return `<p class="svc-none">Couldn’t load the flow: ${esc(items.error)}</p>`;
    if (!items.some((x) => x.kind !== 'header')) return '<p class="svc-none">No flow in Planning Center for this service yet.</p>';
    const list = [...items].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const starts = p.times.filter((x) => x.kind === 'service' && x.starts_at).map((x) => Date.parse(x.starts_at)).sort((a, b) => a - b);
    const at = Math.min(nav.at || 0, Math.max(0, starts.length - 1));
    const start = starts[at] ?? Date.parse(p.sort_date);
    const secs = (x) => (x.kind === 'header' ? 0 : Math.max(0, x.length || 0));
    const total = (pos) => list.filter((x) => x.position === pos).reduce((n, x) => n + secs(x), 0);
    const during = total('during');
    const clockAt = { pre: start - total('pre') * 1000, during: start, post: start + during * 1000 };
    const hhmm = (ms) => m.c.time(ms).replace(/\s?[AP]M$/, '');
    const rows = list.map((x) => {
      if (x.kind === 'header') return `<li class="fl-head"><span>${esc(x.title || 'Section')}</span></li>`;
      const pos = x.position === 'pre' || x.position === 'post' ? x.position : 'during';
      const when = clockAt[pos];
      clockAt[pos] += secs(x) * 1000;
      const desc = x.description || '';
      const short = desc && desc.length <= 60 && !/\n/.test(desc);
      const meta = [
        pos === 'pre' ? 'Pre-service' : pos === 'post' ? 'Post-service' : null,
        x.kind === 'song' ? 'Song' : x.kind === 'media' ? 'Media' : null,
        x.key_name ? `Key ${x.key_name}` : null,
        short ? desc : null,
        x.arrangement,
      ].filter(Boolean);
      return `<li class="fl-item fl-${esc(x.kind)} ${pos !== 'during' ? 'is-out' : ''}">
        <span class="fl-time">${esc(hhmm(when))}</span>
        <div class="fl-main">
          <b>${esc(x.title || 'Untitled')}</b>
          ${meta.length ? `<span class="fl-meta">${meta.map((t) => esc(t)).join(' <i>·</i> ')}</span>` : ''}
          ${(x.notes || []).map((n) => `<span class="fl-note"><em ${noteDep(n.category)}>${esc(n.category)}</em>${esc(n.content)}</span>`).join('')}
          ${desc && !short ? `<details class="fl-desc"><summary>${esc(desc.split('\n')[0].slice(0, 70))}${desc.length > 70 || /\n/.test(desc) ? '…' : ''}</summary><p>${esc(desc).replace(/\n/g, '<br>')}</p></details>` : ''}
        </div>
        <span class="fl-len">${secs(x) ? esc(duration(secs(x))) : ''}</span>
      </li>`;
    }).join('');
    const pick = starts.length > 1 ? `<div class="seg svc-at" role="radiogroup" aria-label="Times for">
        ${starts.map((t, i) => `<button type="button" role="radio" data-at="${i}" aria-checked="${i === at}" aria-selected="${i === at}">${esc(m.c.time(t))}</button>`).join('')}
      </div>` : '';
    return `<div class="fl-top">
        <p class="fl-sum">Runs <b>${esc(duration(during))}</b> <i>·</i> ${esc(m.c.time(start))} to ${esc(m.c.time(start + during * 1000))}</p>
        ${pick}
      </div>
      <ol class="flow">${rows}</ol>`;
  }

  // ------------------------------------------------------------ roster ---
  // Positions at each location down the side, dates across. Someone on the same
  // position for several services that day (Vintage and Modern, say) is one pill,
  // with a dot for each service stacked first to last, lettered V, M, N (North)
  // or T (Traditional). The pill is the day as a whole: declined if they declined
  // any of them, requested if any still needs an answer, confirmed only when every
  // one is. The grid is scaled to fit the screen top to bottom; only dates scroll.

  function rosterData(m, week, where) {
    return sharedRosterData(m, week, where, ctx.campuses);
  }


  /** V, M, N (North), T (Traditional): which service a dot is. */
  function kindLetter(t, p) {
    const n = `${t.name} ${kindName(t, p)}`.toLowerCase();
    if (/north/.test(n)) return 'N';
    if (/tradition/.test(n)) return 'T';
    if (/vintage/.test(n)) return 'V';
    if (/modern/.test(n)) return 'M';
    if (/espa|spanish/.test(n)) return 'E';
    if (/midweek|wednesday/.test(n)) return 'W';
    const k = kindName(t, p).replace(/[^A-Za-z]/g, '');
    return k && k.toLowerCase() !== String(p.title || '').replace(/[^A-Za-z]/g, '').toLowerCase() ? k[0].toUpperCase() : '';
  }

  function roster(m, week, where, active = true, geo = null) {
    const { days, rows } = rosterData(m, week, where);
    const campus = where === ALL ? null : ctx.campusById.get(where);
    const letters = new Set();
    if (!rows.length) {
      return `<div class="ros-wrap ros-none ${active ? 'is-active' : ''}" data-wk="${week}" data-vw="${nav.view}"><div class="empty"><h3>No one scheduled yet</h3><p>Nobody is on the shared teams${campus ? ` at ${esc(campus.short_name)}` : ''} in the next ${plural(s.status.weeks_ahead || 6, 'week')}.</p></div></div>`;
    }
    const today = m.today;
    const next = days.find((d) => d >= today); // where coming up starts: a line down its left side
    // Sundays ⇄ Wednesdays goes across from the labels and the next date (what's on screen):
    // each cell's place in that order (--c), with its row (--r).
    const firstShown = Math.max(0, days.indexOf(next));
    const colOf = (i) => 2 + Math.max(0, i - firstShown);
    const when = (d) => `${d === today ? 'is-today' : d < today ? 'is-past' : ''}${d === next && next !== days[0] ? ' is-next' : ''}${d === next ? ' is-up' : ''}`; // past columns are dimmed
    const totals = days.map(() => ({ C: 0, U: 0, D: 0, open: 0 }));
    const groups = [];
    for (const row of rows) {
      if (!groups.length || groups[groups.length - 1].campusId !== row.campusId) groups.push({ campusId: row.campusId, rows: [] });
      groups[groups.length - 1].rows.push(row);
    }
    let rowNo = 0;
    // Team: the same rows, with everyone on each position's team in Planning Center across
    // (by name, with their badge; each opens their profile) in place of the dates. As many
    // columns as the biggest team, three at least; a dashed box is a spot nobody's on.
    const teamView = nav.view === 'team' && isStaff && !!s.vol;
    const crews = teamView ? new Map(rows.map((row) => [row, crewFor(m, row, week)])) : null;
    const crewSpots = teamView ? Math.max(3, ...[...crews.values()].map((t) => t.length)) : 0;
    // as many columns as the schedule shows across, so its lines carry on to the right edge
    const crewMax = Math.max(crewSpots, geo?.across || 0);
    // Every position wants TEAM_NEED people on its team: a spot short of that is "needed"
    // (red). Counted for the whole grid and for each location.
    const lacking = (row) => (teamView ? Math.max(0, TEAM_NEED - crews.get(row).length) : 0);
    const teamSpots = teamView ? rows.length * TEAM_NEED : 0;
    const teamMissing = teamView ? rows.reduce((n, row) => n + lacking(row), 0) : 0;
    const body = groups.map((g) => g.rows.map((row, ri) => {
      const r = rowNo++;
      const cells = teamView ? Array.from({ length: crewMax }, (_, k) => {
        const x = crews.get(row)[k];
        if (!x) return k < TEAM_NEED ? `<td style="--c:${2 + k}"><div class="ros-cell"><i class="rp is-team is-none" title="${esc(`${row.position}: one more needed on the team`)}">Needed</i></div></td>` : `<td style="--c:${2 + k}"></td>`;
        const lan = x.lanyard || null;
        const inner = `${lan ? microBadge(lan, `${LANYARDS[lan]} lanyard`) : ''}<b>${nameShort(x.name) === x.name ? esc(x.name) : `<span class="nf">${esc(x.name)}</span><span class="ns">${esc(nameShort(x.name))}</span>`}</b>`;
        return `<td style="--c:${2 + k}"><div class="ros-cell">${x.id
          ? `<button type="button" class="rp is-team" data-act="crew-p" data-v="${esc(x.id)}" title="${esc(`${x.name}: on the ${row.position} team`)}">${inner}</button>`
          : `<span class="rp is-team" title="${esc(x.name)}">${inner}</span>`}</div></td>`;
      }).join('') : days.map((d, i) => {
        const cell = row.cells.get(d);
        if (!cell) return `<td class="${when(d)}" style="--c:${colOf(i)}"></td>`;
        // Same order every week: whoever's on the first service comes first.
        const first = (pill) => pill.entries[0].plan._start;
        const people = [...cell.people.values()].sort((a, b) => first(a) - first(b) || String(a.name).localeCompare(String(b.name)));
        for (const pill of people) totals[i][pill.status]++;
        totals[i].open += cell.open;
        const many = people.length + cell.open > 1;
        return `<td class="${when(d)}" style="--c:${colOf(i)}"><div class="ros-cell ${many ? 'is-many' : ''}">${people.map((pill) => pillHtml(m, row, d, pill, many, letters)).join('')}${
          openPills(row, d, cell)}</div></td>`;
      }).join('');
      const label = row.showTeam ? `${row.position} · ${row.team}` : row.position;
      const short = row.showTeam ? `${positionShort(row.position)}·${teamShort(row.team)}` : positionShort(row.position);
      const place = ctx.campusById.get(row.campusId);
      const loc = !campus && ri === 0
        ? `<th class="ros-loc" style="--c:0" rowspan="${g.rows.length}" scope="rowgroup" title="${esc(place?.short_name || 'Other')}"><span>${both(place?.short_name || 'Other', campusShort(place))}${
          teamView ? ((n) => (n ? `<em class="ros-miss" title="${esc(`${n} more needed at ${place?.short_name || 'this location'}`)}">${both(`${n} needed`, `−${n}`)}</em>` : `<em class="ros-miss is-full" title="Every spot filled">${both('Full', 'OK')}</em>`))(g.rows.reduce((a, x) => a + lacking(x), 0)) : ''}</span></th>` : '';
      return `<tr class="${ri === 0 ? 'ros-first' : ''}" style="--r:${r + 1}">${loc}<th class="ros-pos" style="--c:1" scope="row" title="${esc(`${row.position} · ${row.team}`)}"><div class="pos-in"><span class="pos-l">${both(label, short)}</span></div></th>${cells}</tr>`;
    }).join('')).join('');
    const head = teamView ? `<th class="ros-day ros-team-h" colspan="${crewMax}" style="--c:2" scope="colgroup"><span class="dh">On the team <b>${teamSpots - teamMissing} of ${teamSpots} spots filled</b>${teamMissing ? `<em class="ros-miss">${teamMissing} needed</em>` : '<em class="ros-miss is-full">Full</em>'}</span></th>` : days.map((d, i) => {
      const p = m.plans.find((x) => x._day === d);
      return `<th class="ros-day ${when(d)}" style="--c:${colOf(i)}" scope="col" ${d < today ? 'title="Already happened"' : ''}><span class="dh">${d === today ? 'Today' : `<span class="lf">${esc(m.c.weekday(p.sort_date).slice(0, 3))}</span>`} <b>${esc(m.c.date(p.sort_date))}</b></span></th>`;
    }).join('');
    const foot = teamView ? `<td colspan="${crewMax}" style="--c:2"><span class="ros-tot is-team"><span class="st-C" title="Spots filled">${teamSpots - teamMissing}</span>${teamMissing ? `<span class="st-D" title="Still needed">${teamMissing}</span>` : ''}<span class="is-open" title="Spots in all (${TEAM_NEED} a position)">${teamSpots}</span><small>${teamMissing ? `${teamMissing} of ${teamSpots} spots still need someone` : `All ${teamSpots} spots filled`}</small></span></td>` : totals.map((t, i) => `<td class="${when(days[i])}" style="--c:${colOf(i)}"><span class="ros-tot">${[
      t.C ? `<span class="st-C" title="Confirmed">${t.C}</span>` : '',
      t.U ? `<span class="st-U" title="Requested">${t.U}</span>` : '',
      t.D ? `<span class="st-D" title="Declined">${t.D}</span>` : '',
      t.open ? `<span class="is-open" title="Open">${t.open}</span>` : '',
    ].join('')}</span></td>`).join('');

    return `
      <div class="ros-wrap ${active ? 'is-active' : ''}" data-wk="${week}" data-vw="${teamView ? 'team' : 'sched'}">
        <table class="ros ${campus ? 'one-place' : ''} ${teamView ? 'is-team' : ''}" style="--rows:${rowNo};--cols:${teamView ? crewMax + 1 : colOf(days.length - 1)}">
          <thead><tr style="--r:0">${campus ? '' : `<th class="ros-corner ros-loc-h" scope="col">${both('Location', 'Loc')}</th>`}<th class="ros-corner ros-pos-h" scope="col"><div class="pos-in"><span class="pos-l">${both('Position', 'Pos')}</span></div></th>${head}</tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr style="--r:${rowNo + 1}"><th class="ros-foot-h" ${campus ? '' : 'colspan="2"'}>${campus ? both('Totals', 'Tot') : 'Totals'}</th>${foot}</tr></tfoot>
        </table>
      </div>`;
  }

  /** Open spots: staff tap one to schedule someone into it. */
  function openPills(row, day, cell) {
    if (!cell.open) return '';
    if (!isStaff) return '<span class="rp is-open">Open</span>'.repeat(cell.open);
    const id = `o${opens.size}`;
    opens.set(id, { row, day, cell });
    return `<button type="button" class="rp is-open" data-ro="${id}" title="Schedule someone" aria-label="Open: schedule someone for ${esc(row.position)}">Open</button>`.repeat(cell.open);
  }

  function openOpen(id) {
    const x = opens.get(id);
    const m = model();
    if (!x || !m || !isStaff) return;
    const spots = [...x.cell.openBy.keys()]
      .map((pid) => ({ plan: m.plans.find((p) => p.id === pid), team_id: x.cell.openTeam.get(pid) }))
      .filter((sp) => sp.plan && sp.team_id)
      .sort((a, b) => a.plan._start - b.plan._start || (m.type(a.plan).sequence ?? 99) - (m.type(b.plan).sequence ?? 99));
    if (!spots.length) return;
    openScheduleSheet({ ctx, m, row: x.row, spots, h: { kindName, kindLetter, firstTime, weeks: s.status?.weeks_ahead || 6 } });
  }

  function pillHtml(m, row, day, pill, many, letters) {
    const id = `p${pills.size}`;
    pills.set(id, { row, day, pill });
    const isMe = m.me && pill.person_id === m.me;
    const name = pill.name || (isMe ? ctx.me.full_name || 'You' : 'Someone');
    // Two people in one box: first name and last initial so both fit.
    const parts = name.trim().split(/\s+/);
    const shown = many && parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : name;
    const dots = pill.entries.map((e) => {
      const l = kindLetter(m.type(e.plan), e.plan);
      if (l) letters.add(l);
      return `<i class="st-${esc(e.status)}">${esc(l)}</i>`;
    }).join('');
    // Their badge (staff can see it): a little black badge with V, C or S; none means they need one.
    const lan = isStaff && pill.person_id ? lanyardOf(pill.person_id) : null;
    const label = `${name}${lan ? ` (${LANYARDS[lan]} lanyard)` : ''}: ${STATUS_LABEL[pill.status]}${pill.entries.length > 1 ? ` (${pill.entries.map((e) => `${kindName(m.type(e.plan), e.plan)} ${(STATUS_LABEL[e.status] || STATUS_LABEL.U).toLowerCase()}`).join(', ')})` : ''}`;
    return `<button type="button" class="rp st-${pill.status} ${isMe ? 'is-me' : ''}" data-rp="${id}" title="${esc(label)}" aria-label="${esc(label)}">
      <span class="rp-dots">${dots}</span>${lan ? microBadge(lan, `${LANYARDS[lan]} lanyard`) : ''}<b>${many || nameShort(name) === name ? esc(shown) : `<span class="nf">${esc(name)}</span><span class="ns">${esc(nameShort(name))}</span>`}</b>${isStaff && pill.invite ? `<span class="rp-mail" title="Invite not sent yet">${icon('mail')}</span>` : ''}
    </button>`;
  }

  /** Who Home sent us about: their pills on that day. */
  function attentionPills() {
    const want = new Set(attn.statuses);
    return [...pills.entries()].filter(([, v]) => v.day === attn.day && want.has(v.pill.status));
  }

  /** The line over the grid: who declined (or hasn't answered) and what to do. */
  function attentionHtml(m) {
    const { rows } = rosterData(m, 'sun', ALL);
    const who = [];
    for (const row of rows) {
      const cell = row.cells.get(attn.day);
      for (const pill of cell ? cell.people.values() : []) {
        if (attn.statuses.includes(pill.status)) who.push(`${pill.name || 'Someone'} (${row.position}${ctx.campusById.get(row.campusId)?.short_name ? `, ${ctx.campusById.get(row.campusId).short_name}` : ''})`);
      }
    }
    const plan = m.plans.find((p) => p._day === attn.day);
    const when = plan ? `${m.c.weekday(plan.sort_date)}, ${m.c.date(plan.sort_date)}` : 'Sunday';
    const declined = attn.statuses.includes('D');
    const text = !who.length ? `Everyone on ${when} is set now.`
      : declined ? `${who.join(', ')} declined for ${when}. Tap ${who.length === 1 ? 'them' : 'each one'} below to find someone else.`
        : `${who.join(', ')} ${who.length === 1 ? 'hasn’t' : 'haven’t'} answered for ${when} yet. Tap ${who.length === 1 ? 'them' : 'one'} below to resend or swap.`;
    return `<div class="ros-attn ${declined ? 'is-bad' : 'is-wait'}" role="status">${icon('warn')}<p>${esc(text)}</p>
      <button type="button" class="btn icon ghost small" data-act="attn-off" aria-label="Done">${icon('close')}</button></div>`;
  }

  /** Mark them on the grid, and bring the first into view the first time. */
  function markAttention(wrap, scroll) {
    const hits = attentionPills().map(([id]) => $(`[data-rp="${id}"]`, wrap)).filter(Boolean);
    hits.forEach((b) => b.classList.add('is-attn'));
    if (scroll && hits[0]) {
      const r = hits[0].getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      if (r.top < w.top || r.bottom > w.bottom) wrap.scrollTop += r.top - w.top - (w.height - r.height) / 2;
    }
  }

  /** First look at the grid: the week that just happened (dimmed) is the first column beside
   *  the positions, for follow-up, with the next service (today, or the next date) right after
   *  it. With nothing in the past, the next service is first. */
  function scrollToNext(wrap) {
    const upcoming = $('thead .ros-day:not(.is-past)', wrap);
    const before = upcoming ? upcoming.previousElementSibling : $$('thead .ros-day.is-past', wrap).pop();
    const next = before?.classList.contains('is-past') ? before : upcoming;
    const edge = $$('thead .ros-corner', wrap).pop();
    if (!next || !edge) return;
    // Safari measures inside a zoomed table in unzoomed pixels and Chrome in zoomed ones,
    // so step toward it and measure again until the next date sits right beside the labels.
    for (let i = 0; i < 6; i++) {
      const off = next.getBoundingClientRect().left - edge.getBoundingClientRect().right;
      if (Math.abs(off) < 0.5) break;
      const was = wrap.scrollLeft;
      wrap.scrollLeft = was + off;
      if (wrap.scrollLeft === was) break; // at the end: can't go further
    }
  }

  /** Scales the roster so every row fits on the screen; only the dates scroll sideways.
   *  Returns the size it settled on ({ z: zoom, extra: px added to each row }). Given one,
   *  it uses that instead (Wednesdays at the Sunday size); given { z: null }, it fits
   *  without making rows taller. */
  /** The stage (the grid's frame) the height of the week that's showing. */
  function fitStage() {
    const stage = $('.ros-stage', el);
    const wrap = stage && $('.ros-wrap.is-active', stage);
    if (!stage || !wrap) return;
    const edges = stage.offsetHeight - stage.clientHeight; // its top and bottom border
    stage.style.height = `${wrap.offsetHeight + sbH() + edges}px`;
  }

  // ------------------------------------------------------- the scroll bar ---
  // Under the totals, in the grid's own look (the browser's is hidden): its track runs under
  // the dates only, with a tick at each date (the next one lit, the past shaded); the thumb is
  // the dates on screen. Drag it, tap the track to go there, or step a week with the arrows
  // under the labels. Not on phones (swipe), where it takes no room.
  function sbH() { return window.innerWidth >= 700 ? 18 : 0; } // its height (styles.css .ros-sb)

  function barHtml() {
    return `<div class="ros-sb">
      <div class="ros-sb-step">
        <button type="button" data-sb="-1" aria-label="Back a week">${icon('chevron')}</button>
        <button type="button" data-sb="1" aria-label="On a week">${icon('chevron')}</button>
      </div>
      <div class="ros-sb-track" aria-hidden="true"><span class="ros-sb-past"></span><span class="ros-sb-ticks"></span><b class="ros-sb-thumb"><i></i></b></div>
    </div>`;
  }

  /** Follow the grid that's showing: where its dates start, and each date's place along them. */
  function bindBar() {
    const stage = $('.ros-stage', el);
    const bar = stage && $('.ros-sb', stage);
    const wrap = stage && $('.ros-wrap.is-active', stage);
    sbWrap = wrap || null;
    if (!bar || !wrap || !sbH()) { sbGeo = null; return; }
    const table = $('.ros', wrap);
    const tr = table?.getBoundingClientRect();
    const corners = table ? $$('thead .ros-corner', table).map((c) => c.getBoundingClientRect()) : [];
    if (!tr?.width || !corners.length) { bar.classList.add('is-off'); sbGeo = null; return; }
    // Measured as parts of the table (Safari and Chrome measure a zoomed table differently;
    // the parts are the same in both), then put in the grid's own pixels. The labels stay put
    // while the dates scroll, so their width is from the first one's left edge.
    const lf = (corners[corners.length - 1].right - corners[0].left) / tr.width;
    const days = $$('thead .ros-day', table);
    const cols = days.map((d) => {
      const r = d.getBoundingClientRect();
      return { at: ((r.left - tr.left) / tr.width - lf) / (1 - lf), w: r.width / tr.width / (1 - lf), up: d.classList.contains('is-up'), past: d.classList.contains('is-past') };
    });
    const full = Math.max(wrap.scrollWidth, wrap.clientWidth);
    sbGeo = { labels: lf * full, lf, cols };
    bar.style.setProperty('--sb-l', `${Math.round(lf * full)}px`);
    const firstUp = cols.find((c) => !c.past);
    $('.ros-sb-past', bar).style.width = `${((firstUp ? firstUp.at : 1) * 100).toFixed(2)}%`;
    $('.ros-sb-ticks', bar).innerHTML = cols.map((c, i) => (i ? `<i class="${c.up ? 'is-up' : ''}" style="left:${(c.at * 100).toFixed(2)}%"></i>` : '')).join('')
      + (cols.find((c) => c.up && cols.indexOf(c) === 0) ? '<i class="is-up" style="left:0"></i>' : '');
    paintBar();
  }

  /** The thumb where the grid is. */
  function paintBar() {
    const bar = $('.ros-stage .ros-sb', el);
    const wrap = sbWrap;
    if (!bar || !wrap || !sbGeo) return;
    const dates = wrap.scrollWidth - sbGeo.labels;
    const shown = wrap.clientWidth - sbGeo.labels;
    const can = dates > shown + 1;
    bar.classList.toggle('is-off', !can);
    const th = $('.ros-sb-thumb', bar);
    const w = can ? Math.max(0.06, shown / dates) : 1;
    const left = can ? Math.min(1 - w, wrap.scrollLeft / dates) : 0;
    th.style.width = `${(w * 100).toFixed(3)}%`;
    th.style.left = `${(left * 100).toFixed(3)}%`;
    $('[data-sb="-1"]', bar).disabled = !can || wrap.scrollLeft <= 1;
    $('[data-sb="1"]', bar).disabled = !can || wrap.scrollLeft >= wrap.scrollWidth - wrap.clientWidth - 1;
  }

  /** Step a week: the next date (or the one before) lines up beside the labels. */
  function stepWeek(dir) {
    const wrap = sbWrap;
    if (!wrap || !sbGeo) return;
    const dates = wrap.scrollWidth - sbGeo.labels;
    const at = wrap.scrollLeft / dates;
    const starts = sbGeo.cols.map((c) => c.at);
    const target = dir > 0 ? starts.find((x) => x > at + 0.002) : [...starts].reverse().find((x) => x < at - 0.002);
    if (target == null) return;
    wrap.scrollTo({ left: target * dates, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }



  /** Sundays ⇄ Wednesdays, with both already laid out: what's on this one goes out (top left
   *  to bottom right), the frame eases to the other's height while their lines cross over,
   *  then the other's comes in the same way. Reduced motion: straight across. */
  function switchWeek(w) {
    if (viewBusy) return;
    if (weekBusy) {
      weekWant = w;
      markSw($('#s-week', el), 'week', w);
      return;
    }
    if (nav.week === w) return;
    const stage = $('.ros-stage', el);
    const from = stage && $('.ros-wrap.is-active', stage);
    const to = stage && $(`.ros-wrap[data-wk="${w}"]`, stage);
    nav.week = w;
    markSw($('#s-week', el), 'week', w);
    if (!from || !to || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { draw(); return; }
    weekBusy = true;
    const span = (wrap) => {
      const t = $('.ros', wrap);
      return { t, rows: Number(t?.style.getPropertyValue('--rows')) || 6, cols: Number(t?.style.getPropertyValue('--cols')) || 6 };
    };
    const a = span(from);
    const b = span(to);
    a.t?.classList.add('wk-out');
    setTimeout(() => {
      if (!alive) return;
      // The frame to the new height; the old lines fade as the new ones (still empty) come up.
      b.t?.classList.add('wk-hide');
      to.classList.add('is-active', 'is-entering');
      from.classList.remove('is-active');
      from.classList.add('is-leaving');
      stage.classList.add('is-moving');
      void stage.offsetWidth;
      to.classList.remove('is-entering');
      fitStage();
      bindBar();
      setTimeout(() => {
        if (!alive) return;
        from.classList.remove('is-leaving');
        a.t?.classList.remove('wk-out');
        stage.classList.remove('is-moving');
        if (b.t) {
          b.t.classList.add('wk-in');
          void b.t.offsetWidth;
          b.t.classList.remove('wk-hide');
        }
        setTimeout(() => {
          b.t?.classList.remove('wk-in');
          weekBusy = false;
          const next = weekWant;
          weekWant = null;
          if (next && next !== nav.week && alive) switchWeek(next);
          else markSw($('#s-week', el), 'week', nav.week);
        }, b.rows * 14 + b.cols * 26 + 420);
      }, 400);
    }, a.rows * 8 + a.cols * 14 + 180);
  }

  /** Someone's lanyard (volunteer, coach, staff), by their Planning Center person id. */
  function lanyardOf(pcoId) {
    const vol = s.vol;
    if (!vol) return null;
    if (crewIx?.vol !== vol) crewIx = { vol, byPco: new Map((vol.people || []).filter((v) => v.pco_person_id).map((v) => [String(v.pco_person_id), v])) };
    return crewIx.byPco.get(String(pcoId))?.lanyard || null;
  }

  /** A row's team in Planning Center: everyone on that location's team (any of its services
   *  on this grid) who's assigned that position, by name, with their volunteer record. */
  function crewFor(m, row, week) {
    const vol = s.vol;
    if (!vol) return [];
    if (crewIx?.vol !== vol) crewIx = { vol, byPco: new Map((vol.people || []).filter((v) => v.pco_person_id).map((v) => [String(v.pco_person_id), v])) };
    const types = new Set(m.rosterTypes(week).filter((t) => t.campus_id === row.campusId).map((t) => t.id));
    const tk = teamKey(row.team);
    const teams = new Set(m.teams.filter((t) => teamKey(t.name) === tk && teamServices(t).some((id) => types.has(id))).map((t) => String(t.id)));
    const pk = teamKey(row.position);
    const who = new Map();
    for (const x of vol.members || []) {
      if (!teams.has(String(x.team_id)) || !(x.positions || []).some((p) => teamKey(p) === pk)) continue;
      const v = crewIx.byPco.get(String(x.person_id));
      who.set(String(x.person_id), { name: v?.name || 'Someone', id: v?.id || null, lanyard: v?.lanyard || null });
    }
    return [...who.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A laid-out schedule grid's measurements, for Team to match (matchGrid). Sizes are in the
   *  table's own pixels: `f` is how many screen pixels one of them is at its zoom (browsers
   *  measure a zoomed table differently; a probe at the same zoom says which). */
  function measureGrid(wrap) {
    const table = wrap && $('.ros', wrap);
    if (!table) return null;
    const z = table.style.zoom || '1';
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;width:100px;height:1px;zoom:${z}`;
    wrap.appendChild(probe);
    const f = probe.getBoundingClientRect().width / 100 || 1;
    probe.remove();
    const w = (n) => (n ? n.getBoundingClientRect().width / f : 0);
    const corner = $$('thead .ros-corner', table).pop();
    const edge = corner ? corner.getBoundingClientRect().right : 0;
    const labels = corner ? (edge - table.getBoundingClientRect().left) / f : 0;
    // each date's width, from the first one showing beside the labels (they aren't all the same)
    const days = $$('thead .ros-day', table);
    const from = Math.max(0, days.findIndex((d) => d.getBoundingClientRect().right > edge + 2));
    const cols = days.slice(from).map(w).filter(Boolean);
    // how far that first date is tucked under the labels (screen pixels; a couple at most)
    const off = days[from] ? Math.max(0, edge - days[from].getBoundingClientRect().left) : 0;
    const room = wrap.clientWidth / f - labels + off / f;
    let across = 0;
    for (let sum = 0; cols.length && sum < room + 1; across += 1) sum += cols[Math.min(across, cols.length - 1)];
    return {
      z, f, cols, across, off, loc: w($('thead .ros-loc-h', table)), pos: w($('thead .ros-pos-h', table)),
      rows: $$('tbody tr', table).map((tr) => tr.getBoundingClientRect().height / f),
      head: $('thead tr', table).getBoundingClientRect().height / f, foot: ($('tfoot tr', table)?.getBoundingClientRect().height || 0) / f,
      wrapH: wrap.style.height, fits: wrap.classList.contains('fits'),
    };
  }

  /** Team's grid at the schedule's measurements: nothing but what's in the cells differs. */
  function matchGrid(wrap, g) {
    const table = wrap && $('.ros', wrap);
    if (!table || !g) { if (wrap) fitRoster(null, wrap); return; }
    table.style.zoom = g.z;
    const px = (n) => `${n.toFixed(3)}px`;
    const n = $$('tbody tr:first-child td', table).length;
    const widths = [...(g.loc ? [g.loc] : []), g.pos, ...Array.from({ length: n }, (_, k) => g.cols[Math.min(k, g.cols.length - 1)] || 144)];
    table.insertAdjacentHTML('afterbegin', `<colgroup>${widths.map((x) => `<col style="width:${px(x)}">`).join('')}</colgroup>`);
    table.style.width = px(widths.reduce((a, b) => a + b, 0));
    table.classList.add('is-matched');
    $$('tbody tr', table).forEach((tr, i) => { if (g.rows[i]) tr.style.height = px(g.rows[i]); });
    const hr = $('thead tr', table); if (hr) hr.style.height = px(g.head);
    const fr = $('tfoot tr', table); if (fr && g.foot) fr.style.height = px(g.foot);
    wrap.style.height = g.wrapH;
    wrap.classList.toggle('fits', g.fits);
    fitNames(table);
  }

  /** Team's first column exactly where the schedule's first date sits beside the labels. */
  function alignTeam(wrap, g) {
    wrap.scrollLeft = 0;
    const first = $('tbody tr:first-child td', wrap);
    const edge = $$('thead .ros-corner', wrap).pop();
    if (!g?.off || !first || !edge) return;
    for (let i = 0; i < 6; i++) {
      const d = (edge.getBoundingClientRect().right - first.getBoundingClientRect().left) - g.off;
      if (Math.abs(d) < 0.3) break;
      const was = wrap.scrollLeft;
      wrap.scrollLeft = was - d;
      if (wrap.scrollLeft === was) break;
    }
  }

  /** A two-way switch (.hud-sw): which side is on. The lit block slides to it. */
  function markSw(sw, key, value) {
    if (!sw) return;
    const bs = $$(`[data-${key}]`, sw);
    bs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset[key] === value)));
    sw.dataset.on = String(Math.max(0, bs.findIndex((b) => b.dataset[key] === value)));
  }

  /** Schedule | Team goes right of Production in the top row on phones and small iPads, and
   *  in front of Sundays | Wednesdays in the page's head on a computer. */
  function placeTools() {
    const sw = viewSw();
    if (!sw) return;
    const slot = ctx.topSlot?.();
    const home = $('.ros-tools', el);
    if (slot) { if (sw.parentElement !== slot) slot.appendChild(sw); } else if (home && sw.parentElement !== home) home.prepend(sw);
  }

  /** Schedule ⇄ Team: the labels stay; what's in the grid goes out top left to bottom right,
   *  then the other view's comes in the same way. Reduced motion: straight across. */
  async function switchView(v) {
    if (!isStaff || viewBusy || weekBusy || v === nav.view || nav.mode !== 'roster') return;
    const sw = viewSw();
    markSw(sw, 'view', v);
    if (v === 'team' && !s.vol) {
      sw?.classList.add('is-busy');
      await loadPeople(false);
      sw?.classList.remove('is-busy');
      if (!alive) return;
      if (!s.vol) { markSw(sw, 'view', nav.view); ctx.toast('Couldn’t load the teams.', 'bad'); return; }
    }
    const from = $('.ros-wrap.is-active .ros', el);
    nav.view = v;
    if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) { draw(); return; }
    viewBusy = true;
    const n = (t, k) => Number(t?.style.getPropertyValue(k)) || 6;
    from.classList.add('vw-out');
    setTimeout(() => {
      if (!alive) return;
      draw();
      const to = $('.ros-wrap.is-active .ros', el);
      if (!to) { viewBusy = false; return; }
      to.classList.add('vw-hide');
      void to.offsetWidth;
      to.classList.add('vw-in');
      to.classList.remove('vw-hide');
      setTimeout(() => { to.classList.remove('vw-in'); viewBusy = false; }, n(to, '--rows') * 14 + Math.min(6, n(to, '--cols')) * 26 + 420);
    }, n(from, '--rows') * 8 + Math.min(6, n(from, '--cols')) * 14 + 200);
  }

  /** The home indicator's strip (an iPad's or iPhone's home-screen app; 0 elsewhere). */
  function safeBottom() {
    const probe = document.createElement('div');
    probe.className = 'sab-probe';
    document.body.append(probe);
    const v = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    probe.remove();
    return v;
  }
  /** What iOS 26.0 leaves off the bottom of a home-screen app (app.js fitBottom; 0 elsewhere). */
  function vgapPx() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vgap')) || 0; }

  function fitRoster(size = null, wrap = $('.ros-wrap.is-active', el)) {
    const table = wrap && $('.ros', wrap);
    if (!wrap || !table) return null;
    const rows = $$('tbody tr', table);
    table.style.zoom = '';
    wrap.style.height = '';
    rows.forEach((tr) => { tr.style.height = ''; });
    const natural = table.offsetHeight;
    if (!natural) return null;
    const top = wrap.getBoundingClientRect().top + window.scrollY;
    const tabs = document.querySelector('.nav')?.getBoundingClientRect();
    const below = tabs && tabs.top > window.innerHeight / 2 ? window.innerHeight - tabs.top + 8 : 0; // the phone tab bar
    // A phone: down to the bottom edge. Wider (iPads, computers): level with the sidebar's
    // bottom, clear of an iPad's home indicator, reaching the real bottom where iOS 26.0 lays
    // the home-screen app out short (--vgap).
    const room = Math.max(220, window.innerWidth < 700 ? window.innerHeight - top - below
      : window.innerHeight + vgapPx() - safeBottom() - top - below - 16) - sbH();
    // On a phone, never so big that fewer than three weeks fit across beside the labels.
    let MAX = window.innerWidth < 600 ? 1.25 : 1.5;
    if (window.innerWidth < 700) {
      const corner = $$('thead .ros-corner', table).pop()?.getBoundingClientRect();
      const left = table.getBoundingClientRect().left;
      // The three weeks it opens on: the next service and the two after it.
      // (Team: its first three people across; its one header spans them all.)
      const cols = table.classList.contains('is-team') ? $$('tbody tr:first-child td', table) : $$('thead .ros-day', table);
      const next = cols.findIndex((c) => !c.classList.contains('is-past'));
      const from = Math.max(0, Math.min(next < 0 ? 0 : next, cols.length - 3));
      const three = cols.slice(from, from + 3).reduce((w, c) => w + c.getBoundingClientRect().width, 0);
      const wider = table.offsetWidth > wrap.clientWidth + 1; // more dates than fit: columns are at their narrowest
      if (wider && corner && three) MAX = Math.min(MAX, Math.max(0.8, wrap.clientWidth / (corner.right - left + three)));
    }
    const clamp = (z) => Math.max(0.55, Math.min(MAX, z)); // past 0.55 it scrolls instead of shrinking
    const apply = (z) => {
      table.style.zoom = z.toFixed(3);
      const bar = Math.max(0, wrap.offsetHeight - wrap.clientHeight - 2); // a sideways scrollbar (desktops; not iPad)
      const h = table.getBoundingClientRect().height;
      wrap.style.height = `${Math.min(room, Math.ceil(h) + 2 + bar)}px`;
      return { h, space: room - 2 - bar };
    };
    let natRows = null; // each row's own height, measured before any is made taller
    const grow = (zz, extra) => {
      natRows ??= rows.map((tr) => tr.getBoundingClientRect().height / zz);
      rows.forEach((tr, k) => { tr.style.height = `${(natRows[k] + extra).toFixed(2)}px`; });
      return apply(zz);
    };
    const done = (r) => {
      fitNames(table);
      wrap.classList.toggle('fits', wrap.scrollHeight <= wrap.clientHeight + 1); // nothing to scroll up and down
      return r;
    };
    if (size?.z) { // a size worked out elsewhere: use it as it is
      apply(size.z);
      if (size.extra > 0) grow(size.z, size.extra);
      return done(size);
    }
    // Text and borders snap to pixels, so height doesn't follow zoom smoothly (a step down
    // can drop a lot, a step up add a lot). Measure, and close in on the biggest zoom that fits.
    let z = clamp((room - 2) / natural);
    let fits = null; // biggest zoom seen that fits
    let tall = null; // smallest zoom seen that doesn't
    for (let i = 0; i < 8; i++) {
      const { h, space } = apply(z);
      if (h <= space + 0.5) {
        fits = fits == null ? z : Math.max(fits, z);
        if (h > space - 6) break;
      } else {
        tall = tall == null ? z : Math.min(tall, z);
      }
      let next = clamp(z * (space / h));
      if (tall != null && next >= tall) next = fits != null ? (fits + tall) / 2 : tall - 0.01;
      if (fits != null && next <= fits) next = tall != null ? (fits + tall) / 2 : fits + 0.01;
      next = clamp(next);
      if (Math.abs(next - z) < 0.002) break;
      z = next;
    }
    // End on a zoom that fits (if none does, even at the smallest, the table scrolls).
    if (fits != null && Number(table.style.zoom) !== Number(fits.toFixed(3))) apply(fits);

    // Room left over even at the biggest size (few rows, or a tall screen):
    // make the rows taller so the grid still reaches the bottom of the screen.
    const zz = Number(table.style.zoom) || 1;
    let { h, space } = apply(zz);
    if (size || zz < MAX - 0.001 || h >= space - 4 || !rows.length) return done({ z: zz, extra: 0 });
    let extra = (space - h) / zz / rows.length;
    for (let i = 0; i < 3; i++) {
      ({ h, space } = grow(zz, extra));
      if (h <= space + 0.5 && h > space - 4) break;
      extra += (space - h) / zz / rows.length;
    }
    if (h > space + 0.5) { extra -= (h - space) / zz / rows.length + 0.5; grow(zz, extra); }
    return done({ z: zz, extra });
  }

  /** One person's day on one position: each service and their answer to it. */
  /** Someone full screen (views/person-full.js): from a name on the grid (with that spot) or
   *  the Team column. Built from Planning Center and their People record each time it's
   *  drawn, so a lanyard change shows at once. */
  function openFull({ pillId = null, volId = null } = {}) {
    const x = pillId ? pills.get(pillId) : null;
    if (!model() || (pillId && !x)) return;
    const pcoId = x?.pill.person_id || (volId && s.vol?.people.find((v) => v.id === volId)?.pco_person_id) || null;
    const recOf = () => (isStaff ? (volId && s.vol?.people.find((v) => v.id === volId)) || (pcoId && s.vol?.people.find((v) => String(v.pco_person_id) === String(pcoId))) || null : null);
    const get = () => {
      const m = model();
      if (!m) return null;
      const rec = recOf();
      const p = people.profile(rec?.id || null, pcoId);
      const isMe = !!(m.me && pcoId && pcoId === m.me);
      const name = rec?.name || x?.pill.name || p?.name || (isMe ? ctx.me.full_name || 'You' : 'Someone');
      const photo = realPhoto(x?.pill.photo || rec?.photo || null);
      // The spot that was tapped: that day there, each service and its answer.
      let spot = null;
      if (x) {
        const { row, pill } = x;
        const first = pill.entries[0].plan;
        const counts = { C: 0, U: 0, D: 0 };
        for (const e of pill.entries) counts[e.status in counts ? e.status : 'U']++;
        const n = pill.entries.length;
        const all = n === 2 ? 'both' : `all ${n}`;
        const summary = pill.status === 'C' ? (n > 1 ? `Confirmed for ${all} services` : 'Confirmed')
          : pill.status === 'D' ? (counts.D === n ? (n > 1 ? `Declined ${all} services` : 'Declined') : `Declined ${counts.D} of ${n} services`)
            : counts.U === n ? (n > 1 ? `Hasn’t answered ${n === 2 ? 'either' : `any of the ${n}`} yet` : 'Hasn’t answered yet')
              : `Hasn’t answered ${counts.U} of ${n} services yet`;
        const waiting = isStaff ? pill.entries.filter((e) => e.invite && e.status !== 'D') : [];
        spot = {
          title: `${m.c.weekday(first.sort_date)}, ${m.c.date(first.sort_date)} · ${[ctx.campusById.get(row.campusId)?.short_name, row.position].filter(Boolean).join(' ')}`,
          status: pill.status,
          summary,
          entries: pill.entries.map((e) => ({ planId: e.plan.id, letter: kindLetter(m.type(e.plan), e.plan), kind: kindName(m.type(e.plan), e.plan), time: firstTime(m, e.plan), status: e.status || 'U' })),
          invite: waiting.length ? {
            links: waiting.filter((e) => e.plan.url && e.plan.url !== '#').map((e) => ({ href: e.plan.url, label: `${kindName(m.type(e.plan), e.plan)} in Planning Center` })),
            canTakeOff: pill.entries.some((e) => e.invite && e.ppid),
          } : null,
        };
      }
      // Everything coming up, a day at a time.
      const days = new Map();
      for (const u of p?.upcoming || []) {
        const k = `${u.plan._day}|${u.campusId || ''}`;
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(u);
      }
      const upcoming = [...days.values()].map((list) => {
        const u = list[0];
        const plans = [...new Map(list.map((y) => [y.plan.id, y.plan])).values()];
        const sts = list.map((y) => y.status);
        return {
          planId: u.plan.id,
          day: m.c.weekday(u.plan.sort_date).slice(0, 3),
          date: m.c.date(u.plan.sort_date),
          what: [...new Set(list.map((y) => y.position))].join(', '),
          detail: [ctx.campusById.get(u.campusId)?.short_name, plans.map((pl) => kindName(m.type(pl), pl)).join(', ')].filter(Boolean).join(' · '),
          status: sts.includes('D') ? 'D' : sts.some((y) => y !== 'C') ? 'U' : 'C',
        };
      });
      const gaveBy = rec?.lanyard_by ? ctx.people.get(rec.lanyard_by)?.full_name : null;
      return {
        name, photo, isMe,
        where: x ? `${x.row.team} · ${x.row.position}` : '',
        places: p ? people.places(p).join(' · ') : '',
        canLanyard: !!rec,
        lanyard: rec?.lanyard || null,
        lanyardNote: rec ? (rec.lanyard ? `Given ${timeAgo(rec.lanyard_at)}${gaveBy ? ` by ${gaveBy}` : ''}` : 'Needs a badge') : '',
        spot,
        upcoming,
        teams: (p?.teams || []).map((t) => ({ team: t.team, place: people.placeName(t.campusId) })),
        tags: rec?.tags || [],
        notes: rec ? rec.notes || '' : null,
        pcoUrl: pcoId ? `https://services.planningcenteronline.com/people/AC${pcoId}` : null,
      };
    };
    openPersonFull(ctx, {
      get,
      goto: (id) => openPlan(id),
      setLanyard: (kind) => new Promise((resolve) => {
        const rec = recOf();
        if (!rec) { resolve(); return; }
        // setLanyard toggles: giving the one they have takes it back (None).
        people.setLanyard(rec.id, kind || rec.lanyard, () => { if (nav.mode === 'roster' && alive) draw(); });
        resolve();
      }),
      saveNotes: async (text) => {
        const rec = recOf();
        if (!rec) return;
        await ctx.store.saveVolunteer({ id: rec.id, notes: text });
        rec.notes = text;
      },
      takeOff: async () => {
        const ids = x ? x.pill.entries.filter((e) => e.invite && e.ppid).map((e) => e.ppid) : [];
        await takeOff(ctx, ids);
        ctx.toast(`${x?.pill.name || 'They'} taken back off`);
      },
    });
  }

  function mySchedule(m) {
    const rows = [];
    for (const p of m.mine) for (const r of m.people.get(p.id) || []) if (r.person_id === m.me) rows.push({ p, r });
    $('#s-tally', el).innerHTML = rows.length ? `<b>${rows.length}</b><span>${rows.length === 1 ? 'time' : 'times'}</span><small>you’re scheduled</small>` : '';
    if (!rows.length) {
      return `<div class="empty"><h3>You’re not on anything coming up</h3><p>Nothing scheduled from today on. When you’re scheduled in Planning Center, it shows up here.</p></div>`;
    }
    return `<ul class="svc-mine">${rows.map(({ p, r }) => {
      const t = m.type(p);
      const campus = t.campus_id ? ctx.campusById.get(t.campus_id)?.short_name : '';
      return `<li><button type="button" class="svc-mine-row" data-goto="${p.id}">
        <span class="svc-you-when"><b>${esc(m.c.weekday(p.sort_date).slice(0, 3))} ${esc(m.c.date(p.sort_date))}</b><small>${esc(firstTime(m, p))}</small></span>
        <span class="svc-you-what"><b>${esc(r.position || teamName(m, r.team_id))}</b><small>${esc([campus, kindName(t, p)].filter(Boolean).join(' · '))}</small></span>
        ${statusMark(r.status)}
        ${icon('chevron', 'svc-place-go')}
      </button></li>`;
    }).join('')}</ul>`;
  }

  function notConnected() {
    return isAdmin
      ? `<div class="empty svc-connect">
          <h3>Connect Planning Center once, for everyone</h3>
          <p>Paste a Planning Center token in Settings and every service you share shows up here, with who’s on Broadcast, FOH and the other production teams. Nobody else has to sign in to Planning Center or have the right permissions there.</p>
          <div class="empty-actions"><button class="btn primary" data-act="settings">${icon('link')}Connect Planning Center</button></div>
        </div>`
      : `<div class="empty"><h3>Planning Center isn’t connected yet</h3><p>Once an admin connects it, the services you’re allowed to see show up here. You won’t need a Planning Center login of your own.</p></div>`;
  }

  function youBanner(m) {
    const mineRows = [];
    for (const p of m.mine) for (const r of m.people.get(p.id) || []) if (r.person_id === m.me && r.status !== 'D') mineRows.push({ p, r });
    if (!mineRows.length) return '';
    return `<section class="svc-you">
      <div class="svc-you-head"><h2>You’re on ${plural(new Set(mineRows.map((x) => x.p.id)).size, 'service')}</h2>
        <button class="btn small ghost" data-act="mine">${icon('calendar')}My schedule</button></div>
      <ul>${mineRows.slice(0, 3).map(({ p, r }) => `<li><button type="button" class="svc-mine-row" data-goto="${p.id}">
        <span class="svc-you-when"><b>${esc(m.c.weekday(p.sort_date).slice(0, 3))} ${esc(m.c.date(p.sort_date))}</b><small>${esc(firstTime(m, p))}</small></span>
        <span class="svc-you-what"><b>${esc(r.position || teamName(m, r.team_id))}</b><small>${esc(m.type(p).name)}</small></span>
        ${statusMark(r.status)}
      </button></li>`).join('')}</ul>
    </section>`;
  }

  const teamName = (m, id) => m.teams.find((t) => t.id === id)?.name || 'Team';

  function teamBlock(tm, rows, needed, me, tally) {
    const order = new Map((tm.positions || []).map((x, i) => [teamKey(x.name), i]));
    const rank = (pos) => (order.has(teamKey(pos)) ? order.get(teamKey(pos)) : 500);
    const statusRank = { C: 0, U: 1, D: 2 };
    const list = [
      ...rows.map((r) => ({ kind: 'person', r, at: rank(r.position) })),
      ...needed.flatMap((n) => Array.from({ length: Math.max(1, n.quantity || 1) }, () => ({ kind: 'open', n, at: rank(n.position) }))),
    ].sort((a, b) => a.at - b.at
      || (a.kind === 'open') - (b.kind === 'open')
      || (statusRank[a.r?.status] ?? 3) - (statusRank[b.r?.status] ?? 3)
      || String(a.r?.name || '').localeCompare(String(b.r?.name || '')));
    if (!list.length) return `<div class="svc-team"><h4>${esc(tm.name)}</h4><p class="svc-none">No one scheduled yet</p></div>`;
    for (const x of list) { if (x.kind === 'open') tally.open++; else if (tally[x.r.status] != null) tally[x.r.status]++; }
    return `<div class="svc-team">
      <h4>${esc(tm.name)} <span class="count">${rows.filter((r) => r.status !== 'D').length}</span></h4>
      <ul class="ro-list">${list.map((x) => (x.kind === 'open' ? `<li class="ro is-open">
          <span class="ro-av">${icon('plus')}</span>
          <span class="ro-who"><b>Open</b><small>${esc(x.n.position || 'Any position')}</small></span>
        </li>` : person(x.r, me))).join('')}</ul>
    </div>`;
  }

  function person(r, me) {
    const photo = realPhoto(r.photo);
    const isMe = me && r.person_id === me;
    return `<li class="ro is-${esc(r.status || 'U')} ${isMe ? 'is-me' : ''}">
      <span class="ro-av">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(initials(r.name))}</span>
      <span class="ro-who"><b>${esc(r.name || 'Someone')}${isMe ? ' <em class="you">You</em>' : ''}</b><small>${esc(r.position || 'On the team')}</small></span>
      ${statusMark(r.status)}
    </li>`;
  }
}

// A note's team, by its Planning Center category, so cues read in their section's color.
function noteDep(category) {
  const c = String(category || '').toLowerCase();
  const dep = /light/.test(c) ? 'lighting' : /audio|sound|foh|mix/.test(c) ? 'audio' : /video|media|cg|camera|graphic|propresenter|lyric|broadcast/.test(c) ? 'video' : null;
  return dep ? `data-dep="${dep}"` : '';
}

function duration(sec) {
  const h = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function statusMark(st) {
  const label = STATUS_LABEL[st] || STATUS_LABEL.U;
  const glyph = st === 'C' ? icon('check') : st === 'D' ? icon('close') : '<i aria-hidden="true">?</i>';
  return `<span class="ro-st st-${esc(st || 'U')}" role="img" aria-label="${label}" title="${label}">${glyph}</span>`;
}

