// Events: the one-off services in Planning Center (Engage, a conference, a coffeehouse)
// as a whole. Which services count as events is set per Planning Center service
// (pco_service_types.is_event). The list is coming up first, then what's past. An event
// shows its times, a Live button, and two panes: Flow (the order of service as planned,
// with notes) and Team (who's on the production teams).
//
// Live is a full-screen production view of Planning Center Live, on its own layer over
// the whole app (not inside the page, so nothing can clip it). It shows:
//   Before the service: what's on now (Doors Open), a countdown to the next thing on the
//     schedule, what that is, and the first item up with its notes.
//   During: the item that's up, its time left in big numbers (amber near the end, red and
//     counting up once over), what's next and after that, and the service clock.
//   Next to each name, what that person is on for this event (Amy Bray · VOX 4), from
//     event_item_gear: entered per event on purpose, not read from Planning Center notes.
//     It opens the gear (the mic, an IEM pack) only when that's logged in Gear.
// When someone hits Next in Planning Center Live, this follows within a couple of seconds
// (pco-live reads Live for every screen at once). The screen stays awake while it's open.
// Admins can drive Live from here: Take control, then Back and Next, as the Planning
// Center account Tally is connected with (it shows as that person in Planning Center Live).
// Staff and up (the Planning Center service is shared with staff).

import { esc, icon, $, debounce, initials, pageTitle } from '../util.js';
import { clock, realPhoto, teamKey, teamServices, hiddenPosition, STATUS_LABEL } from '../pco.js';
import { buildIndex, openDeviceSheet } from './devices.js';

const POLL_MS = 1500;         // Live: ask this often while it's open
const SLOW_POLL_MS = 15000;   // …when the event isn't today
const CHECK_MS = 20000;       // the event list: has Planning Center changed?
const PAST_SHOWN = 6;         // past events listed (latest first)

const GEAR_EVERY_MS = 30000;   // Live: who's on which mic, read again this often

export function mount(el, ctx) {
  let alive = true;
  const isAdmin = ctx.me.role === 'admin';
  // Where you were (the event, Live open) lasts through a reload into a new version.
  const NAV_KEY = 'ucp.events.nav';
  const nav = ctx.eventsNav || (ctx.eventsNav = (() => {
    try { const v = JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null'); if (v && typeof v === 'object') return { plan: v.plan || null, pane: v.pane || 'flow', live: !!v.live }; } catch { /* none */ }
    return { plan: null, pane: 'flow', live: false };
  })());
  const saveNav = () => { try { sessionStorage.setItem(NAV_KEY, JSON.stringify({ plan: nav.plan, pane: nav.pane, live: nav.live })); } catch { /* private mode */ } };
  const s = {
    status: undefined, data: null, error: null,
    items: new Map(),   // plan id -> its flow (from the sync), loaded when opened
    live: null,         // the last Live answer for nav.plan
    liveFor: null,      // which plan that answer is for
    liveError: null,
    offset: 0,          // server clock minus this device's
    sig: '',            // what the Live layer was last drawn from
    busy: null,         // a Take control / Next / Back on its way to Planning Center
    ctlError: null,     // why the last one didn't go through (shown in the Live view itself)
    mics: null,         // { plan, map: item id -> { label, device_ids }, at }: what each person is on
  };
  let gearData = null;  // Gear (items, models, rooms), read the first time a mic is opened
  let pollTimer = null;
  let checkTimer = null;
  let tickTimer = null;
  let wake = null;
  let wallFmt = null;
  let layer = null;          // the Live layer, on <body> while open
  let browserFull = false;   // the browser's own full screen (computers, iPads)
  const now = () => Date.now() + s.offset;

  el.innerHTML = `<div class="ev-page" id="ev"><div class="loading">${'<div class="sk tall"></div>'.repeat(2)}</div></div>`;
  const root = $('#ev', el);

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open], [data-pane], [data-act]');
    if (!t) return;
    if (t.dataset.open) { open(t.dataset.open); return; }
    if (t.dataset.pane) { nav.pane = t.dataset.pane; saveNav(); draw(); return; }
    const act = t.dataset.act;
    if (act === 'back') open(null);
    else if (act === 'live') openLive();
    else if (act === 'retry') load();
    else if (act === 'settings') ctx.openSettings('pco');
  });
  const onKey = (e) => { if (e.key === 'Escape' && layer) closeLive(); };
  document.addEventListener('keydown', onKey);
  const onFs = () => { if (!document.fullscreenElement && browserFull) { browserFull = false; if (layer) closeLive(); } };
  document.addEventListener('fullscreenchange', onFs);
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    check();
    if (layer) { poll(); keepAwake(true); }
  };
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'pco') load(true); }, 300));

  load();
  return {
    unmount() {
      alive = false;
      closeLive();
      clearTimeout(checkTimer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
    },
  };

  // ------------------------------------------------------------- data ---

  async function load(quiet = false) {
    try {
      const [status, data] = await Promise.all([ctx.store.pcoStatus(), ctx.store.pcoData()]);
      s.status = status; s.data = data; s.error = null;
      for (const id of s.items.keys()) s.items.delete(id); // a sync may have changed the flow
    } catch (e) {
      if (!quiet || !s.data) s.error = e.message;
    }
    if (!alive) return;
    draw();
    clearTimeout(checkTimer);
    checkTimer = setTimeout(check, CHECK_MS);
  }

  async function check() {
    clearTimeout(checkTimer);
    if (!alive) return;
    if (document.visibilityState !== 'hidden') {
      try {
        const st = await ctx.store.pcoStatus();
        const changed = (x) => x?.changed_at ?? x?.last_sync_at;
        if (changed(st) !== changed(s.status)) return load(true);
      } catch { /* next time */ }
    }
    checkTimer = setTimeout(check, CHECK_MS);
  }

  function model() {
    const d = s.data;
    if (!d) return null;
    const c = clock(s.status?.time_zone);
    const types = d.types.filter((t) => t.is_event && t.access !== 'hidden');
    const typeById = new Map(types.map((t) => [t.id, t]));
    const start = (p) => {
      const svc = (p.times || []).filter((x) => x.kind === 'service' && x.starts_at).map((x) => Date.parse(x.starts_at)).sort((a, b) => a - b)[0];
      return svc ?? Date.parse(p.sort_date);
    };
    const plans = d.plans.filter((p) => typeById.has(p.service_type_id))
      .map((p) => ({ ...p, _start: start(p), _day: c.day(p.sort_date) }))
      .sort((a, b) => a._start - b._start);
    const today = c.day(Date.now());
    const people = d.people.filter((x) => plans.some((p) => p.id === x.plan_id));
    const teams = d.teams.filter((t) => t.shown && teamServices(t).some((id) => typeById.has(id)));
    return {
      c, today, plans, teams, people, type: (p) => typeById.get(p.service_type_id),
      upcoming: plans.filter((p) => p._day >= today),
      past: plans.filter((p) => p._day < today).reverse().slice(0, PAST_SHOWN),
    };
  }

  function open(planId) {
    if (nav.plan !== planId) { s.live = null; s.liveFor = null; s.liveError = null; s.sig = ''; nav.pane = 'flow'; }
    if (!planId) closeLive();
    nav.plan = planId;
    saveNav();
    draw();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------- draw ---

  function draw() {
    if (!alive) return;
    if (s.error && !s.data) {
      root.innerHTML = `${head()}<div class="empty"><p>Couldn’t load events: ${esc(s.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
      return;
    }
    if (s.status === undefined) return;
    if (s.status === null) {
      root.innerHTML = `${head()}<div class="empty"><p>Planning Center isn’t connected.</p>${ctx.me.role === 'admin' ? '<button class="btn" data-act="settings">Connect it</button>' : ''}</div>`;
      return;
    }
    const m = model();
    const plan = nav.plan ? m.plans.find((p) => p.id === nav.plan) : null;
    if (nav.plan && !plan) nav.plan = null;
    root.innerHTML = plan ? eventHtml(m, plan) : listHtml(m);
    if (plan && nav.live) openLive();
    else if (!plan) closeLive();
  }

  function head(extra = '') {
    return `<div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}${extra}</div></div>`;
  }

  function listHtml(m) {
    const n = m.upcoming.length;
    const tally = `<p class="tally"><b>${n}</b><span>coming up</span></p>`;
    if (!m.plans.length) {
      return `${head()}<div class="empty"><p>No events yet.</p><p class="fine">Events are Planning Center services marked as events (Settings › Planning Center).</p></div>`;
    }
    const card = (p) => {
      const t = m.type(p);
      const campus = t.campus_id ? ctx.campusById.get(t.campus_id)?.short_name : null;
      const svc = (p.times || []).filter((x) => x.kind === 'service' && x.starts_at).map((x) => x.starts_at);
      const isToday = p._day === m.today;
      const when = isToday ? 'Today' : m.c.relative(p.sort_date);
      const crew = m.people.filter((x) => x.plan_id === p.id && x.status !== 'D' && !hiddenPosition(x.position)).length;
      return `<li><button type="button" class="ev-card ${isToday ? 'is-today' : ''} ${p._day < m.today ? 'is-past' : ''}" data-open="${esc(p.id)}">
        <span class="ev-day"><small>${esc(m.c.weekday(p.sort_date).slice(0, 3))}</small><b>${esc(m.c.date(p.sort_date).replace(/^\D+/, ''))}</b><small>${esc(m.c.date(p.sort_date).replace(/\s.*$/, ''))}</small></span>
        <span class="ev-what"><b>${esc(p.title || t.name)}</b>
          <small>${esc([campus, svc.length ? m.c.times(svc) : m.c.time(p.sort_date), crew ? `${crew} on the team` : null].filter(Boolean).join(' · '))}</small></span>
        <span class="ev-when">${isToday ? '<i class="ev-dot"></i>' : ''}${esc(when)}</span>
        ${icon('chevron', 'ev-go')}
      </button></li>`;
    };
    return `${head(tally)}
      <div class="results ev-list">
        ${m.upcoming.length ? `<section><h2 class="ev-h">Coming up</h2><ul class="ev-cards">${m.upcoming.map(card).join('')}</ul></section>` : '<p class="svc-none">Nothing coming up.</p>'}
        ${m.past.length ? `<section><h2 class="ev-h">Past</h2><ul class="ev-cards">${m.past.map(card).join('')}</ul></section>` : ''}
      </div>`;
  }

  function eventHtml(m, p) {
    const t = m.type(p);
    const campus = t.campus_id ? ctx.campusById.get(t.campus_id)?.short_name : null;
    const pane = nav.pane === 'team' ? 'team' : 'flow';
    const items = s.items.get(p.id);
    if (items === undefined) loadItems(p.id);
    const crew = m.people.filter((x) => x.plan_id === p.id && !hiddenPosition(x.position));
    const steps = items?.filter?.((x) => x.kind !== 'header').length;
    const times = shownTimes(p.times || []);
    return `<div class="page-head ev-top">
        <button type="button" class="btn small ghost ev-back" data-act="back">${icon('chevron')}<span>Events</span></button>
      </div>
      <article class="svc-detail ev-detail">
        <header class="svc-dhead">
          <div class="svc-title">
            <small class="svc-loc">${esc([campus, `${m.c.weekday(p.sort_date)}, ${m.c.date(p.sort_date)}`].filter(Boolean).join(' · '))}</small>
            <h2>${esc(p.title || t.name)}</h2>
            <p class="svc-sub">${esc(t.name)}${p.series_title ? ` · ${esc(p.series_title)}` : ''}</p>
          </div>
          ${p.url && p.url !== '#' ? `<a class="btn small ghost" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('open')}<span>Planning Center</span></a>` : ''}
        </header>
        ${times.length ? `<ol class="svc-times-list">${times.map((x) => `<li class="${x.kind === 'service' ? 'is-service' : ''}">
            <b>${esc(m.c.time(x.starts_at))}</b><span>${esc(timeName(x))}</span>
          </li>`).join('')}</ol>` : ''}
        <button type="button" class="ev-live-btn" data-act="live">
          <i class="ev-livedot" aria-hidden="true"></i>
          <span><b>Live</b><small>Where the service is, from Planning Center Live</small></span>
          ${icon('expand')}
        </button>
        <div class="seg ev-panes" role="tablist" aria-label="Show">
          <button type="button" role="tab" data-pane="flow" aria-selected="${pane === 'flow'}">${icon('list')}Flow${steps ? `<small>${steps}</small>` : ''}</button>
          <button type="button" role="tab" data-pane="team" aria-selected="${pane === 'team'}">${icon('team')}Team<small>${crew.filter((x) => x.status !== 'D').length}</small></button>
        </div>
        <section class="ev-pane">${pane === 'flow' ? flowHtml(m, p, items) : teamHtml(m, p, crew)}</section>
      </article>`;
  }

  async function loadItems(planId) {
    s.items.set(planId, null);
    try { s.items.set(planId, (await ctx.store.pcoItems(planId)) || []); } catch (e) { s.items.set(planId, { error: e.message }); }
    if (alive && nav.plan === planId) draw();
  }

  // ------------------------------------------------------------- live ---

  function current() {
    const m = model();
    const p = m && nav.plan ? m.plans.find((x) => x.id === nav.plan) : null;
    return p ? { m, p } : null;
  }

  function openLive() {
    const cur = current();
    if (!cur) return;
    nav.live = true;
    saveNav();
    if (s.liveFor !== cur.p.id) { s.live = null; s.liveFor = cur.p.id; s.liveError = null; s.sig = ''; }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'lvx-root';
      layer.setAttribute('role', 'dialog');
      layer.setAttribute('aria-modal', 'true');
      layer.setAttribute('aria-label', `Live: ${cur.p.title || 'event'}`);
      layer.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act], [data-gear]');
        if (!b) return;
        if (b.dataset.gear) { openGear(b.dataset.gear); return; }
        if (b.dataset.act === 'close') closeLive();
        else if (['take', 'release', 'next', 'previous'].includes(b.dataset.act)) drive(b.dataset.act);
      });
      document.body.appendChild(layer);
      document.documentElement.classList.add('lv-full-on');
      window.addEventListener('resize', fitTitle);
      document.fonts?.ready?.then(() => fitTitle()).catch(() => {});
      // Where the browser can (not iPhone Safari), the whole screen: no browser bars either.
      try {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen && matchMedia('(hover: hover)').matches) {
          document.documentElement.requestFullscreen().then(() => { browserFull = true; }).catch(() => {});
        }
      } catch { /* not offered */ }
      paint();
      $('[data-act="close"]', layer)?.focus({ preventScroll: true });
    }
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 250);
    tick();
    if (!pollTimer) poll();
    keepAwake(true);
  }

  function closeLive() {
    nav.live = false;
    clearTimeout(pollTimer); pollTimer = null;
    clearInterval(tickTimer); tickTimer = null;
    keepAwake(false);
    if (layer) { layer.remove(); layer = null; window.removeEventListener('resize', fitTitle); }
    document.documentElement.classList.remove('lv-full-on');
    if (document.fullscreenElement && browserFull) { browserFull = false; document.exitFullscreen().catch(() => {}); }
    saveNav();
    if (alive) $('[data-act="live"]', root)?.focus({ preventScroll: true });
    if (alive) ctx.updateNow?.(); // leaving Live: a good moment for a waiting new version
  }

  async function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    const cur = current();
    if (!alive || !layer || !cur) return;
    if (document.visibilityState === 'hidden') return; // onVisible starts it again
    const { m, p } = cur;
    if (!s.mics || s.mics.plan !== p.id || Date.now() - s.mics.at > GEAR_EVERY_MS) loadMics(p.id);
    const asked = Date.now();
    try {
      const st = await ctx.store.pcoLive(p.id);
      if (!alive || nav.plan !== p.id) return;
      const got = Date.now();
      // The server's clock, so every screen counts the same second (half the round trip back).
      if (st?.now) s.offset = Date.parse(st.now) - (asked + got) / 2;
      s.live = st; s.liveFor = p.id; s.liveError = null;
    } catch (e) {
      s.liveError = e.message;
    }
    if (!alive || !layer || nav.plan !== p.id) return;
    paint();
    // A new version waiting: take it now (Live comes straight back), unless a Next is on its way.
    if (!s.busy && ctx.updateNow?.()) return;
    pollTimer = setTimeout(poll, p._day === m.today ? POLL_MS : SLOW_POLL_MS);
  }

  /** What each person in this event is on (VOX 4), and its gear when logged. */
  async function loadMics(planId) {
    const at = Date.now();
    if (s.mics?.plan === planId) s.mics.at = at; // don't ask twice while this one's out
    try {
      const rows = (await ctx.store.eventGear?.(planId)) || [];
      if (!alive || nav.plan !== planId) return;
      const map = new Map(rows.map((r) => [String(r.item_id), { label: r.label, device_ids: r.device_ids || [] }]));
      const changed = JSON.stringify([...map]) !== JSON.stringify([...(s.mics?.map || [])]);
      s.mics = { plan: planId, map, at, v: (s.mics?.v || 0) + (changed ? 1 : 0) };
      if (changed) paint();
    } catch { /* next time */ }
  }

  /** The gear someone's on: straight to it when it's one item, a short list when it's more (mic and pack). */
  async function openGear(itemId) {
    const g = s.mics?.map.get(String(itemId));
    if (!g?.device_ids?.length) return;
    try {
      if (!gearData) { const data = await ctx.store.networkData(); gearData = { data, ix: buildIndex(data), campus: ctx.campus }; }
    } catch (e) { ctx.toast(`Couldn’t open Gear: ${e.message}`); return; }
    const reload = async () => { try { const data = await ctx.store.networkData(); gearData.data = data; gearData.ix = buildIndex(data); } catch { /* keep what's there */ } };
    const host = { s: gearData, load: reload, setOpen: () => {} };
    const devs = g.device_ids.map((id) => gearData.ix.dev.get(id)).filter(Boolean);
    if (!devs.length) { ctx.toast(`The gear for ${g.label} isn’t in Gear any more.`); return; }
    if (devs.length === 1) { openDeviceSheet(ctx, host, devs[0].id); return; }
    const sheet = ctx.openSheet({
      label: g.label,
      render: (api) => api.render(`<header class="sh-head"><div class="sh-title"><h2>${esc(g.label)}</h2></div>
          <button type="button" class="btn icon ghost" data-close aria-label="Close">${icon('close')}</button></header>
        <div class="sh-body"><ul class="lvx-gear">${devs.map((d) => {
          const t = gearData.ix.type.get(d.type_id);
          return `<li><button type="button" data-dev="${esc(d.id)}"><b>${esc(d.name || t?.name || 'Item')}</b><small>${esc([t?.manufacturer, t?.name].filter(Boolean).join(' '))}</small>${icon('chevron')}</button></li>`;
        }).join('')}</ul></div>`),
    });
    sheet.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dev]');
      if (b) { sheet.close(true); openDeviceSheet(ctx, host, b.dataset.dev); }
    });
  }

  /** Admins: drive Planning Center Live as Tally's Planning Center account. */
  async function drive(action) {
    const cur = current();
    if (!isAdmin || !cur || s.busy) return;
    s.busy = action;
    s.ctlError = null;
    paint();
    const asked = Date.now();
    try {
      const st = await ctx.store.pcoLive(cur.p.id, action);
      if (!alive || nav.plan !== cur.p.id) return;
      if (st?.now) s.offset = Date.parse(st.now) - (asked + Date.now()) / 2;
      s.live = st; s.liveError = null;
    } catch (e) {
      s.ctlError = e.message || 'That didn’t go through.';
    } finally {
      s.busy = null;
      if (alive) paint();
    }
  }

  /** What the layer shows, in short: a change means drawing it again. */
  function sigOf(w) {
    return [s.live?.current_id, s.live?.current?.start, s.live?.controller, s.live?.controller_id, s.live?.me_id, s.live?.full_read_at,
      !!s.liveError, !!s.live, s.busy, s.ctlError, s.mics?.v, w?.state, w?.block?.id, w?.nextBlock?.id].join('|');
  }

  /** Redraw the layer when what it shows changed (the numbers tick on their own). */
  function paint() {
    const cur = current();
    if (!layer || !cur) return;
    const w = s.live && s.live.available !== false ? where(s.live, now()) : null;
    const sig = sigOf(w);
    if (sig === s.sig) { tick(); return; }
    s.sig = sig;
    layer.innerHTML = liveHtml(cur.m, cur.p, w);
    fitTitle();
    tick();
  }

  /** Where the service is, worked out from a Live answer and the time now. */
  function where(st, t) {
    const items = st.items || [];
    const pts = st.plan_times || [];
    const services = pts.filter((x) => x.kind === 'service').sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    // The service time in play: the one Live is on, else the next one not over yet, else the last.
    const pt = (st.current && pts.find((x) => x.id === st.current.plan_time_id))
      || services.find((x) => !x.live_ends_at && Date.parse(x.ends_at || x.starts_at) > t - 3600e3)
      || services[services.length - 1] || null;
    const timesFor = new Map((st.item_times || []).filter((x) => x && (!pt || x.plan_time_id === pt.id)).map((x) => [x.item_id, x]));
    const run = items.filter((it) => it.kind !== 'header').map((it) => ({ it, t: timesFor.get(it.id) || null }))
      .filter((r) => !r.t?.exclude && (r.t || !timesFor.size));
    const cur = st.current ? run.findIndex((r) => r.it.id === st.current.item_id) : -1;
    const len = (r) => Math.max(0, r.it.length || 0) * 1000;
    const planned = run.reduce((n, r) => n + len(r), 0);
    const plannedStart = pt?.starts_at ? Date.parse(pt.starts_at) : null;
    const starts = (list) => list.filter((r) => r.t?.start).map((r) => Date.parse(r.t.start));
    // Over: Live ended this service time, or it ran around the service time. Times left from
    // trying Live out earlier (a rehearsal) don't count: that's still "not started".
    const lastStart = Math.max(-Infinity, ...starts(run));
    const ran = Number.isFinite(lastStart) && (plannedStart == null || lastStart >= plannedStart - 30 * 60e3);
    const state = cur >= 0 ? 'live' : pt?.live_ends_at || ran ? 'done' : 'wait';
    const counted = state === 'live' ? starts(run.slice(0, cur + 1)) : state === 'done' ? starts(run) : [];
    const first = counted.length ? Math.min(...counted) : (state !== 'wait' && pt?.live_starts_at ? Date.parse(pt.live_starts_at) : null);
    let item = null;
    if (cur >= 0) {
      const r = run[cur];
      const begun = Date.parse(st.current.start || r.t?.start || t);
      item = { r, begun, elapsed: t - begun, length: len(r), left: len(r) - (t - begun) };
    }
    const rest = state === 'live' ? run.slice(cur + 1) : state === 'wait' ? run : [];
    const restMs = rest.reduce((n, r) => n + len(r), 0);
    const projected = state === 'live' ? t + Math.max(0, item.left) + restMs : null;
    const lastEnd = (pt?.live_ends_at ? Date.parse(pt.live_ends_at) : null)
      ?? run.map((r) => (r.t?.end ? Date.parse(r.t.end) : null)).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    // Before the service: the plan's schedule (Doors Open, then the service). What's on now
    // (the latest-starting block under way) and the next thing to start.
    const blocks = shownTimes(pts).map((x) => ({ ...x, s: Date.parse(x.starts_at), e: x.ends_at ? Date.parse(x.ends_at) : null }));
    const block = state === 'wait' ? blocks.filter((x) => x.kind !== 'service' && x.s <= t && (x.e == null || x.e > t)).sort((a, b) => b.s - a.s)[0] || null : null;
    const nextBlock = state === 'wait' ? blocks.find((x) => x.s > t) || null : null;
    return {
      pt, run, cur, item, state, planned, plannedStart, first, projected, lastEnd, block, nextBlock,
      next: state === 'live' ? run[cur + 1] || null : null,
      then: state === 'live' ? run[cur + 2] || null : null,
      upFirst: state === 'wait' ? run[0] || null : null,
    };
  }

  function liveHtml(m, p, w) {
    const st = s.live;
    const title = p.title || m.type(p).name;
    // Close, then the event in capitals sized to fill the rest of the row (fitTitle), so it's
    // plain which event this is at a glance. Nothing else up there.
    const top = () => `<header class="lvx-top">
        <button type="button" class="lvx-close" data-act="close" aria-label="Close Live">${icon('close')}</button>
        <h1 class="lvx-event"><span>${esc(title)}</span></h1>
      </header>`;
    if (!st || st.available === false || !w) {
      const msg = !st ? (s.liveError ? `Couldn’t reach Planning Center Live: ${esc(s.liveError)}. Trying again.` : 'Reading Planning Center Live…')
        : `Planning Center Live isn’t available for this plan.${st.note ? ` ${esc(st.note)}` : ''}`;
      return `<div class="lvx">${top()}<p class="lvx-msg">${msg}</p></div>`;
    }
    const hhmm = (ms) => m.c.time(ms);
    const meta = (it) => [it.kind === 'song' ? 'Song' : it.kind === 'media' ? 'Media' : null, it.key_name ? `Key ${it.key_name}` : null,
      it.description && it.description.length <= 40 && !/\n/.test(it.description) ? it.description : null].filter(Boolean).join(' · ');
    const itemCard = (r, k, opts = {}) => `<section class="lvx-card ${opts.cls || ''}">
        <div class="lvx-k"><span>${esc(k)}</span>${opts.right || ''}</div>
        <div class="lvx-who"><h2>${esc(r.it.title || 'Untitled')}</h2>${micHtml(r.it)}${opts.len ? `<span class="lvx-t lvx-wholen">${esc(opts.len)}</span>` : ''}</div>
        ${meta(r.it) ? `<p class="lvx-meta">${esc(meta(r.it))}</p>` : ''}
        ${opts.clock || ''}
        ${opts.after || ''}
      </section>`;
    let main = '';
    if (w.state === 'live') {
      const r = w.item.r;
      const len = (x) => dur(Math.max(0, x.it.length || 0) * 1000);
      // Now (its length is at the end of the bar), then the next two, each with its length at the bottom right.
      main = itemCard(r, 'Now', {
        cls: 'is-now',
        // The bar with how far in on its left and the item's length on its right.
        clock: `<div class="lvx-clock" data-tick="big">—</div>
          <div class="lvx-barrow"><span class="lvx-t" data-tick="in"></span><div class="lv-bar"><i data-tick="bar"></i></div><span class="lvx-t">${esc(dur(w.item.length))}</span></div>`,
      }) + `<div class="lvx-stack">${w.next
        ? itemCard(w.next, 'Next', { cls: 'is-next', len: len(w.next) }) + (w.then ? itemCard(w.then, 'Then', { cls: 'is-next is-then', len: len(w.then) }) : '')
        : '<section class="lvx-card is-next"><div class="lvx-k"><span>Next</span></div><h2>End of the service</h2></section>'}</div>`;
    } else if (w.state === 'wait') {
      const late = w.plannedStart != null && now() >= w.plannedStart;
      const nowCard = `<section class="lvx-card is-now">
          <div class="lvx-k"><span>Now</span>${w.block ? `<span class="lvx-len">${esc(hhmm(w.block.s))}${w.block.e ? `–${esc(hhmm(w.block.e))}` : ''}</span>` : ''}</div>
          <h2>${esc(late ? 'Waiting for Planning Center Live' : w.block ? timeName(w.block) : 'Before the service')}</h2>
          <div class="lvx-clock" data-tick="big">—</div>
          <p class="lvx-sub" data-tick="sub"></p>
        </section>`;
      const nextCard = !late && w.nextBlock && w.nextBlock.kind !== 'service' ? `<section class="lvx-card is-sched">
          <div class="lvx-k"><span>Next</span><span class="lvx-len">${esc(hhmm(w.nextBlock.s))}</span></div>
          <h2>${esc(timeName(w.nextBlock))}</h2>
        </section>` : '';
      const first = w.upFirst ? itemCard(w.upFirst, 'Up first', {
        cls: 'is-next',
        right: w.plannedStart ? `<span class="lvx-len">${esc(hhmm(w.plannedStart))}</span>` : '',
        len: dur(Math.max(0, w.upFirst.it.length || 0) * 1000),
        after: w.run[1] ? `<p class="lvx-then">Then <b>${esc(w.run[1].it.title || 'Untitled')}</b></p>` : '',
      }) : '';
      main = nowCard + `<div class="lvx-stack">${nextCard}${first}</div>`;
    } else {
      main = `<section class="lvx-card is-now">
          <div class="lvx-k"><span>Service</span></div>
          <h2>Over</h2>
          <div class="lvx-clock is-small">${w.first && w.lastEnd ? esc(dur(w.lastEnd - w.first)) : '—'}</div>
          <p class="lvx-sub">${w.first ? `Started ${esc(hhmm(w.first))}` : ''}${w.lastEnd ? ` · ended ${esc(hhmm(w.lastEnd))}` : ''} · planned ${esc(dur(w.planned))}</p>
        </section>`;
    }
    const foot = w.state === 'live' ? `<footer class="lvx-foot">
        <span><small>Service</small><b data-tick="svc">—</b></span>
        <span><small>Planned</small><b>${esc(dur(w.planned))}</b></span>
        <span><small>On pace to end</small><b data-tick="proj">—</b><em data-tick="delta"></em></span>
        ${st.controller && !isAdmin ? `<span class="lvx-by"><small>Driving</small><b>${esc(st.controller)}</b></span>` : ''}
      </footer>` : w.state === 'wait' ? `<footer class="lvx-foot">
        <span><small>Service</small><b>${w.plannedStart ? esc(hhmm(w.plannedStart)) : '—'}</b></span>
        <span><small>Planned</small><b>${esc(dur(w.planned))}</b></span>
        <span><small>Ends about</small><b>${w.plannedStart ? esc(hhmm(w.plannedStart + w.planned)) : '—'}</b></span>
      </footer>` : '';
    return `<div class="lvx" data-state="${w.state}">
        ${top()}
        <div class="lvx-main">${main}</div>
        ${foot}
        ${isAdmin ? controlsHtml(st, w) : ''}
        ${s.liveError ? `<p class="lv-warn">${icon('warn')}Lost Planning Center Live for a moment: ${esc(s.liveError)}. Still trying.</p>` : ''}
      </div>`;
  }

  /** The event's name as big as the row allows on one line (two lines if it's very long),
   *  with the close button matching its height. */
  function fitTitle() {
    const h = layer && $('.lvx-event', layer);
    const span = h?.firstElementChild;
    if (!h || !span) return;
    h.style.whiteSpace = 'nowrap';
    h.style.fontSize = '100px';
    const avail = h.clientWidth;
    const natural = span.getBoundingClientRect().width;
    if (!avail || !natural) return;
    let size = Math.min(60, Math.floor((100 * avail) / natural * 0.98));
    if (size < 22) { size = 22; h.style.whiteSpace = 'normal'; }
    h.style.fontSize = `${size}px`;
    layer.style.setProperty('--lvx-x', `${Math.max(36, Math.min(54, Math.round(size * 1.05)))}px`);
  }

  /** Admins: Take control, then Back and Next (as Tally's Planning Center account). */
  function controlsHtml(st, w) {
    const mine = !!st.me_id && st.controller_id === st.me_id;
    const off = s.busy ? 'disabled' : '';
    const label = (act, text) => (s.busy === act ? 'Sending…' : text);
    const err = s.ctlError ? `<p class="lvx-ctl-err" role="alert">${icon('warn')}${esc(s.ctlError)}</p>` : '';
    if (!mine) {
      return `<div class="lvx-ctl">
          <button type="button" class="lvx-btn is-take" data-act="take" ${off}>${esc(label('take', 'Take control'))}</button>
          <p class="lvx-ctl-note">${st.controller ? `<b>${esc(st.controller)}</b> is driving in Planning Center Live. Taking control moves it to Tally.` : 'Nobody is driving Planning Center Live. Take control to run it from here.'}</p>
          ${err}
        </div>`;
    }
    return `<div class="lvx-ctl">
        <div class="lvx-btns">
          <button type="button" class="lvx-btn is-back" data-act="previous" ${off} ${w.state === 'wait' ? 'disabled' : ''}>${icon('chevron')}<span>${esc(label('previous', 'Back'))}</span></button>
          <button type="button" class="lvx-btn is-go" data-act="next" ${off} ${w.state === 'done' ? 'disabled' : ''}><span>${esc(label('next', 'Next'))}</span>${icon('chevron')}</button>
        </div>
        <p class="lvx-ctl-note">Driving Planning Center Live as <b>${esc(st.controller || 'Tally')}</b>. <button type="button" class="lvx-let" data-act="release" ${off}>Let go</button></p>
        ${err}
      </div>`;
  }

  /** What this person is on for this event (VOX 4): opens its gear when that's logged. */
  function micHtml(it) {
    const g = s.mics?.plan === nav.plan ? s.mics.map.get(String(it.id)) : null;
    if (!g?.label) return '';
    return g.device_ids?.length
      ? `<button type="button" class="lvx-mic is-link" data-gear="${esc(it.id)}">${esc(g.label)}</button>`
      : `<span class="lvx-mic">${esc(g.label)}</span>`;
  }

  /** Every quarter second: the numbers only. */
  function tick() {
    if (!layer) return;
    const cur = current();
    if (!cur || !s.live || s.live.available === false) return;
    const { m } = cur;
    const t = now();
    const w = where(s.live, t);
    // The schedule moved on (Doors Open became Worship Center Doors Open, the service time passed): redraw.
    if (sigOf(w) !== s.sig) { paint(); return; }
    const set = (k, v, cls) => {
      const x = $(`[data-tick="${k}"]`, layer);
      if (!x) return;
      if (x.textContent !== v) x.textContent = v;
      if (cls !== undefined) {
        const c = k !== 'big' ? cls : v.length > 6 ? `${cls} is-long` : cls;
        if (x.className !== c) x.className = c;
      }
    };
    if (!wallFmt) {
      const opts = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
      try { wallFmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: s.status?.time_zone || 'America/New_York' }); } catch { wallFmt = new Intl.DateTimeFormat('en-US', opts); }
    }
    set('wall', wallFmt.format(t));
    if (w.state === 'live') {
      const left = w.item.left;
      set('big', left >= 0 ? dur(left) : `+${dur(-left)}`, `lvx-clock ${left < 0 ? 'is-over' : left < 30000 ? 'is-close' : ''}`);
      const bar = $('[data-tick="bar"]', layer);
      if (bar) { bar.style.width = `${Math.min(100, w.item.length ? (w.item.elapsed / w.item.length) * 100 : 100).toFixed(1)}%`; bar.classList.toggle('is-over', left < 0); }
      set('in', dur(w.item.elapsed));
      if (w.first) set('svc', dur(t - w.first));
      if (w.projected != null) {
        set('proj', m.c.time(w.projected));
        const target = (w.plannedStart ?? w.first) + w.planned;
        const d = w.projected - target;
        set('delta', Math.abs(d) < 30000 ? 'on time' : `${d > 0 ? '+' : '−'}${dur(Math.abs(d))} ${d > 0 ? 'long' : 'short'}`, Math.abs(d) < 30000 ? 'is-ok' : d > 0 ? 'is-over' : 'is-under');
      }
    } else if (w.state === 'wait') {
      const target = w.nextBlock ? w.nextBlock.s : w.plannedStart;
      if (target != null && target > t) {
        set('big', dur(target - t), 'lvx-clock is-wait');
        set('sub', w.nextBlock?.kind === 'service' || !w.nextBlock ? `Until the service · ${m.c.time(target)}` : `Until ${timeName(w.nextBlock)} · ${m.c.time(target)}`);
      } else {
        set('big', w.plannedStart != null ? `+${dur(t - w.plannedStart)}` : '—', 'lvx-clock is-over');
        set('sub', w.plannedStart != null ? `Past the service time (${m.c.time(w.plannedStart)}) · starts when someone starts Planning Center Live` : 'Starts when someone starts Planning Center Live');
      }
    }
  }

  /** The screen stays on while Live is open (a phone as a confidence screen). */
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock && document.visibilityState === 'visible') {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener?.('release', () => { wake = null; });
        if (!layer) { const x = wake; wake = null; await x.release(); } // closed while asking
      } else if (!on && wake) { const x = wake; wake = null; await x.release(); }
    } catch { wake = null; }
  }

  // ------------------------------------------------------- flow, team ---

  function flowHtml(m, p, items) {
    if (items === undefined || items === null) return `<div class="loading">${'<div class="sk"></div>'.repeat(3)}</div>`;
    if (items.error) return `<p class="svc-none">Couldn’t load the flow: ${esc(items.error)}</p>`;
    if (!items.some((x) => x.kind !== 'header')) return '<p class="svc-none">No flow in Planning Center for this event yet.</p>';
    const list = [...items].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const secs = (x) => (x.kind === 'header' ? 0 : Math.max(0, x.length || 0));
    const total = list.reduce((n, x) => n + secs(x), 0);
    let at = p._start;
    const rows = list.map((x) => {
      if (x.kind === 'header') return `<li class="fl-head"><span>${esc(x.title || 'Section')}</span></li>`;
      const when = at; at += secs(x) * 1000;
      const desc = x.description || '';
      const short = desc && desc.length <= 60 && !/\n/.test(desc);
      const meta = [x.kind === 'song' ? 'Song' : x.kind === 'media' ? 'Media' : null, x.key_name ? `Key ${x.key_name}` : null, short ? desc : null, x.arrangement].filter(Boolean);
      return `<li class="fl-item fl-${esc(x.kind)}">
        <span class="fl-time">${esc(m.c.time(when).replace(/\s?[AP]M$/, ''))}</span>
        <div class="fl-main">
          <b>${esc(x.title || 'Untitled')}</b>
          ${meta.length ? `<span class="fl-meta">${meta.map((v) => esc(v)).join(' <i>·</i> ')}</span>` : ''}
          ${(x.notes || []).map((n) => `<span class="fl-note"><em ${noteDep(n.category)}>${esc(n.category)}</em>${esc(n.content)}</span>`).join('')}
          ${desc && !short ? `<details class="fl-desc"><summary>${esc(desc.split('\n')[0].slice(0, 70))}${desc.length > 70 || /\n/.test(desc) ? '…' : ''}</summary><p>${esc(desc).replace(/\n/g, '<br>')}</p></details>` : ''}
        </div>
        <span class="fl-len">${secs(x) ? esc(dur(secs(x) * 1000)) : ''}</span>
      </li>`;
    }).join('');
    return `<div class="fl-top"><p class="fl-sum">Runs <b>${esc(dur(total * 1000))}</b> <i>·</i> ${esc(m.c.time(p._start))} to ${esc(m.c.time(p._start + total * 1000))}</p></div>
      <ol class="flow">${rows}</ol>`;
  }

  function teamHtml(m, p, crew) {
    const teams = m.teams.filter((tm) => teamServices(tm).includes(p.service_type_id))
      .sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99) || a.name.localeCompare(b.name));
    const needed = (p.needed || []).filter((n) => !hiddenPosition(n.position));
    const blocks = teams.map((tm) => {
      const order = new Map((tm.positions || []).map((x, i) => [teamKey(x.name), i]));
      const rank = (pos) => (order.has(teamKey(pos)) ? order.get(teamKey(pos)) : 500);
      const rows = crew.filter((r) => r.team_id === tm.id).sort((a, b) => rank(a.position) - rank(b.position) || String(a.name).localeCompare(String(b.name)));
      const open = needed.filter((n) => n.team_id === tm.id);
      if (!rows.length && !open.length) return '';
      return `<div class="svc-team"><h4>${esc(tm.name)} <span class="count">${rows.filter((r) => r.status !== 'D').length}</span></h4>
        <ul class="ro-list">${rows.map((r) => person(r)).join('')}${open.flatMap((n) => Array.from({ length: Math.max(1, n.quantity || 1) }, () => `<li class="ro is-open">
          <span class="ro-av">${icon('plus')}</span><span class="ro-who"><b>Open</b><small>${esc(n.position || 'Any position')}</small></span></li>`)).join('')}</ul></div>`;
    }).join('');
    return `<div class="svc-teams">${blocks || '<p class="svc-none">No one on the production teams for this event yet.</p>'}</div>`;
  }

  function person(r) {
    const photo = realPhoto(r.photo);
    const isMe = ctx.me.pco_person_id && r.person_id === ctx.me.pco_person_id;
    const st = r.status || 'U';
    const label = STATUS_LABEL[st] || STATUS_LABEL.U;
    const glyph = st === 'C' ? icon('check') : st === 'D' ? icon('close') : '<i aria-hidden="true">?</i>';
    return `<li class="ro is-${esc(st)} ${isMe ? 'is-me' : ''}">
      <span class="ro-av">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(initials(r.name))}</span>
      <span class="ro-who"><b>${esc(r.name || 'Someone')}${isMe ? ' <em class="you">You</em>' : ''}</b><small>${esc(r.position || 'On the team')}</small></span>
      <span class="ro-st st-${esc(st)}" role="img" aria-label="${label}" title="${label}">${glyph}</span>
    </li>`;
  }
}

/** A plan's times once each: Planning Center lists the service twice on some plans (the
 *  service, and an "other" time named Service at the same start). */
function shownTimes(times) {
  const svcStarts = new Set(times.filter((x) => x.kind === 'service').map((x) => x.starts_at));
  return times.filter((x) => x.starts_at && !(x.kind !== 'service' && /^service$/i.test(x.name || '') && svcStarts.has(x.starts_at)))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}

const timeName = (x) => x.name || (x.kind === 'service' ? 'Service' : x.kind === 'rehearsal' ? 'Rehearsal' : 'Other');

/** 75000 → "1:15", 3725000 → "1:02:05". */
function dur(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

// A note's team, by its Planning Center category, so cues read in their section's color.
function noteDep(category) {
  const c = String(category || '').toLowerCase();
  const dep = /light/.test(c) ? 'lighting' : /audio|sound|foh|mix/.test(c) ? 'audio' : /video|media|cg|camera|graphic|propresenter|lyric|broadcast/.test(c) ? 'video' : null;
  return dep ? `data-dep="${dep}"` : '';
}
