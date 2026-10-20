// Services: browse Planning Center by location, then date, then service
// (Vintage, Traditional, Modern…), and see that service's flow (the order of
// service, with run times and team notes), its times and who's on the
// production teams. Roster is the whole schedule at a glance: every position
// at every location, date by date, one pill per person. Planning Center is connected once for the whole church
// (Settings › Planning Center); nobody signs in to it here. What each person
// sees comes from their role in this app and the services an admin shares.

import { esc, icon, $, debounce, plural, timeAgo, initials } from '../util.js';
import { ALL, dropdownHtml, wireDropdown } from '../picker.js';
import { clock, teamKey, teamServices, realPhoto, STATUS_LABEL } from '../pco.js';
import { peopleView, LANYARDS } from './volunteers.js';

const POLL_MS = 60000;
const LETTER_NAME = { V: 'Vintage', M: 'Modern', N: 'North Modern', T: 'Traditional', E: 'Español', W: 'Midweek' };
const FAST_MS = 3000;

export function mount(el, ctx) {
  let alive = true;
  const isStaff = ctx.roleAtLeast(ctx.me.role, 'staff');
  const isAdmin = ctx.me.role === 'admin';
  // Where you were (location, date, service) lasts while the app is open.
  const nav = ctx.servicesNav || (ctx.servicesNav = { date: null, plan: null, pane: 'flow', at: 0, mode: 'services' });
  let pills = new Map(); // roster pill id -> its person and services, for the detail sheet
  const flows = new Map(); // plan id -> its items, loaded when opened
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

  el.innerHTML = `
    <div class="page-head">
      <div class="mode-row">
        <div class="seg mode-seg" role="tablist" aria-label="Show" id="s-seg" hidden>
          <button type="button" role="tab" data-smode="services">Services</button>
          <button type="button" role="tab" data-smode="roster">Roster</button>
          ${isStaff ? '<button type="button" role="tab" data-smode="people">People</button>' : ''}
          <button type="button" role="tab" data-smode="mine">My schedule</button>
        </div>
        <div class="ros-head" id="s-rhead" hidden>${dropdownHtml('s-rloc', 'Location', 'caps slim')}</div>
        <p class="tally" id="s-tally" aria-live="polite"></p>
      </div>
      <div class="ros-key" id="s-rkey" hidden></div>
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
  const loc = wireDropdown($('#s-loc', el), locOptions);
  const rloc = wireDropdown($('#s-rloc', el), locOptions);
  const people = peopleView({
    ctx, s, model: () => model(), kindName: (t, p) => kindName(t, p), openPlan: (id) => openPlan(id), reloadPeople: () => loadPeople(),
  });

  el.addEventListener('input', (e) => { if (nav.mode === 'people') people.input(e); });
  el.addEventListener('click', (e) => {
    if (nav.mode === 'people' && people.click(e)) return;
    const t = e.target.closest('[data-act], [data-smode], [data-campus], [data-date], [data-plan], [data-goto], [data-pane], [data-at], [data-rp]');
    if (!t) return;
    if (t.dataset.smode) { nav.mode = t.dataset.smode; draw(); window.scrollTo({ top: 0 }); return; }
    if (t.dataset.rp) { openPill(t.dataset.rp); return; }
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
    else if (act === 'mine') { nav.mode = 'mine'; draw(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (act === 'all-places') pickCampus(ALL);
  });

  const onVisible = () => { if (document.visibilityState === 'visible') checkStatus(); };
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = ctx.store.subscribe(debounce((table) => {
    if (table === 'pco' || table === 'profiles') load(true);
    else if (table === 'volunteers') loadPeople();
  }, 300));
  const clockTimer = setInterval(drawHead, 30000); // keeps "updated 3 min ago" honest
  const onResize = debounce(() => { if (nav.mode === 'roster') fitRoster(); }, 120);
  window.addEventListener('resize', onResize);

  load();
  return {
    unmount() {
      alive = false;
      clearTimeout(timer); clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('resize', onResize);
      unsubscribe();
    },
  };

  function pickCampus(id) {
    s.campus = ctx.campus = id;
    s.picked = true;
    if (nav.mode === 'mine') nav.mode = 'services';
    nav.date = null; nav.plan = null;
    draw();
  }

  /** Jump straight to one plan (from My schedule or "You're on"). */
  function openPlan(planId) {
    const m = model();
    const p = m?.plans.find((x) => x.id === planId);
    if (!p) return;
    s.campus = ctx.campus = m.type(p).campus_id || ALL;
    s.picked = true;
    nav.mode = 'services';
    nav.date = clock(s.status?.time_zone).day(p.sort_date);
    nav.plan = p.id;
    draw();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ------------------------------------------------------------- data ---

  async function load(quiet = false) {
    try {
      const [status, data, me] = await Promise.all([ctx.store.pcoStatus(), ctx.store.pcoData(), ctx.store.me().catch(() => null)]);
      s.status = status;
      s.data = data;
      s.error = null;
      flows.clear(); // a sync may have changed them
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
      const finished = !!st !== !!s.status || st?.last_sync_at !== s.status?.last_sync_at || (s.status?.syncing && !st?.syncing);
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
    const d = s.data;
    if (!d) return null;
    const c = clock(s.status?.time_zone);
    const types = d.types.filter((t) => t.access !== 'hidden'); // admins can read hidden ones; they don't show here
    const typeById = new Map(types.map((t) => [t.id, t]));
    const teams = d.teams.filter((t) => t.shown && teamServices(t).some((id) => typeById.has(id)));
    const start = (p) => {
      const first = p.times.find((x) => x.kind === 'service' && x.starts_at);
      return Date.parse(first?.starts_at || p.sort_date);
    };
    const plans = d.plans.filter((p) => typeById.has(p.service_type_id))
      .map((p) => ({ ...p, _day: c.day(p.sort_date), _start: start(p) }))
      .sort((a, b) => a._start - b._start || (typeById.get(a.service_type_id).sequence ?? 99) - (typeById.get(b.service_type_id).sequence ?? 99));
    const people = new Map();
    for (const p of d.people) people.set(p.plan_id, [...(people.get(p.plan_id) || []), p]);
    const me = ctx.me.pco_person_id;
    const mine = me ? plans.filter((p) => (people.get(p.id) || []).some((x) => x.person_id === me)) : [];
    const type = (p) => typeById.get(p.service_type_id);
    const plansAt = (campusId) => plans.filter((p) => type(p).campus_id === campusId);
    const places = ctx.campuses.filter((cp) => plansAt(cp.id).length);
    return { c, types, typeById, teams, plans, people, me, mine, type, plansAt, places };
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
    if (nav.mode === 'mine' && !m?.me) nav.mode = 'services';
    seg.hidden = !connected || !m?.plans.length;
    seg.querySelector('[data-smode="mine"]').hidden = !m?.me;
    seg.querySelectorAll('[data-smode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.smode === nav.mode)));
    const rosterMode = nav.mode === 'roster' && connected && !!m?.plans.length;
    el.classList.toggle('is-roster', rosterMode);
    el.classList.toggle('is-people', nav.mode === 'people');
    $('#s-rhead', el).hidden = !rosterMode;
    $('#s-rkey', el).hidden = !rosterMode;
    rloc.update();
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

    if (nav.mode === 'mine') { box.innerHTML = mySchedule(m); return; }
    if (nav.mode === 'roster') { box.innerHTML = roster(m); fitRoster(); return; }
    if (nav.mode === 'people') { people.draw(box); return; }
    if (s.campus === ALL || !m.plansAt(s.campus).length) { box.innerHTML = (m.me ? youBanner(m) : '') + placePicker(m); return; }
    box.innerHTML = campusView(m);
    $('.svc-dates .is-on', box)?.scrollIntoView({ block: 'nearest', inline: 'center' });
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
    if (!days.includes(nav.date)) { nav.date = days[0]; nav.plan = null; }
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
        return `<button type="button" role="tab" class="svc-date ${on ? 'is-on' : ''}" data-date="${d}" aria-selected="${on}">
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
    if (items === undefined) loadFlow(p.id);
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
    flows.set(planId, null); // loading
    try {
      const items = await ctx.store.pcoItems(planId);
      flows.set(planId, items || []);
    } catch (e) {
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

  function rosterData(m) {
    const scope = s.campus === ALL ? m.plans : m.plansAt(s.campus);
    const teamOf = new Map(m.teams.map((t) => [t.id, t]));
    const days = [...new Set(scope.map((p) => p._day))].sort();
    const campusAt = (id) => { const i = ctx.campuses.findIndex((c) => c.id === id); return i < 0 ? 999 : i; };
    // Teams with the same name (each service type has its own "Broadcast") are one team here.
    const teamRank = new Map();
    const posRank = new Map();
    for (const t of [...m.teams].sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99))) {
      const k = teamKey(t.name);
      if (!teamRank.has(k)) teamRank.set(k, teamRank.size);
      (t.positions || []).forEach((x, i) => { const pk = `${k}|${teamKey(x.name)}`; if (!posRank.has(pk)) posRank.set(pk, i); });
    }
    const rows = new Map();
    const cellFor = (p, team, position) => {
      const campusId = m.type(p).campus_id || '';
      const tk = teamKey(team.name);
      const pk = teamKey(position || team.name);
      const key = `${campusId}|${tk}|${pk}`;
      let row = rows.get(key);
      if (!row) {
        rows.set(key, row = { key, campusId, team: team.name, position: position || team.name, cells: new Map(),
          at: [campusAt(campusId), teamRank.get(tk) ?? 99, posRank.get(`${tk}|${pk}`) ?? 500] });
      }
      let cell = row.cells.get(p._day);
      if (!cell) row.cells.set(p._day, cell = { people: new Map(), openBy: new Map() });
      return cell;
    };
    for (const p of scope) {
      for (const r of m.people.get(p.id) || []) {
        const team = teamOf.get(r.team_id);
        if (!team) continue;
        const cell = cellFor(p, team, r.position);
        const who = r.person_id || r.name || r.id;
        let pill = cell.people.get(who);
        if (!pill) cell.people.set(who, pill = { person_id: r.person_id, name: r.name, photo: r.photo, entries: [] });
        pill.entries.push({ plan: p, status: r.status || 'U' });
      }
      for (const n of p.needed || []) {
        const team = teamOf.get(n.team_id);
        if (!team) continue;
        const cell = cellFor(p, team, n.position);
        cell.openBy.set(p.id, (cell.openBy.get(p.id) || 0) + Math.max(1, n.quantity || 1));
      }
    }
    const seq = (p) => m.type(p).sequence ?? 99;
    for (const row of rows.values()) {
      for (const cell of row.cells.values()) {
        for (const pill of cell.people.values()) {
          // First service on top, last on the bottom.
          pill.entries.sort((a, b) => a.plan._start - b.plan._start || seq(a.plan) - seq(b.plan));
          pill.status = wholeDay(pill.entries.map((e) => e.status));
        }
        // An open spot on Vintage and Modern is one spot for one person, not two.
        cell.open = Math.max(0, ...cell.openBy.values());
      }
    }
    const list = [...rows.values()].sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2] || a.position.localeCompare(b.position));
    // Show the team only where a location has the same position on two teams ("Audio").
    const seen = new Map();
    for (const r of list) { const k = `${r.campusId}|${teamKey(r.position)}`; seen.set(k, (seen.get(k) || 0) + 1); }
    for (const r of list) r.showTeam = seen.get(`${r.campusId}|${teamKey(r.position)}`) > 1;
    return { days, rows: list };
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

  function roster(m) {
    const { days, rows } = rosterData(m);
    pills = new Map();
    const campus = s.campus === ALL ? null : ctx.campusById.get(s.campus);
    const letters = new Set();
    if (!rows.length) {
      $('#s-rkey', el).innerHTML = '';
      return `<div class="empty"><h3>No one scheduled yet</h3><p>Nobody is on the shared teams${campus ? ` at ${esc(campus.short_name)}` : ''} in the next ${plural(s.status.weeks_ahead || 6, 'week')}.</p></div>`;
    }
    const today = m.c.day(Date.now());
    const totals = days.map(() => ({ C: 0, U: 0, D: 0, open: 0 }));
    const groups = [];
    for (const row of rows) {
      if (!groups.length || groups[groups.length - 1].campusId !== row.campusId) groups.push({ campusId: row.campusId, rows: [] });
      groups[groups.length - 1].rows.push(row);
    }
    const body = groups.map((g) => g.rows.map((row, ri) => {
      const cells = days.map((d, i) => {
        const cell = row.cells.get(d);
        if (!cell) return `<td class="${d === today ? 'is-today' : ''}"></td>`;
        // Same order every week: whoever's on the first service comes first.
        const first = (pill) => pill.entries[0].plan._start;
        const people = [...cell.people.values()].sort((a, b) => first(a) - first(b) || String(a.name).localeCompare(String(b.name)));
        for (const pill of people) totals[i][pill.status]++;
        totals[i].open += cell.open;
        const many = people.length + cell.open > 1;
        return `<td class="${d === today ? 'is-today' : ''}"><div class="ros-cell ${many ? 'is-many' : ''}">${people.map((pill) => pillHtml(m, row, d, pill, many, letters)).join('')}${
          Array.from({ length: cell.open }, () => '<span class="rp is-open">Open</span>').join('')}</div></td>`;
      }).join('');
      const label = row.showTeam ? `${row.position} · ${row.team}` : row.position;
      const loc = !campus && ri === 0
        ? `<th class="ros-loc" rowspan="${g.rows.length}" scope="rowgroup"><span>${esc(ctx.campusById.get(row.campusId)?.short_name || 'Other')}</span></th>` : '';
      return `<tr class="${ri === 0 ? 'ros-first' : ''}">${loc}<th class="ros-pos" scope="row" title="${esc(`${row.position} · ${row.team}`)}">${esc(label)}</th>${cells}</tr>`;
    }).join('')).join('');
    const head = days.map((d) => {
      const p = m.plans.find((x) => x._day === d);
      return `<th class="ros-day ${d === today ? 'is-today' : ''}" scope="col">${esc(d === today ? 'Today' : m.c.weekday(p.sort_date).slice(0, 3))} <b>${esc(m.c.date(p.sort_date))}</b></th>`;
    }).join('');
    const foot = totals.map((t) => `<td><span class="ros-tot">${[
      t.C ? `<span class="st-C" title="Confirmed">${t.C}</span>` : '',
      t.U ? `<span class="st-U" title="Requested">${t.U}</span>` : '',
      t.D ? `<span class="st-D" title="Declined">${t.D}</span>` : '',
      t.open ? `<span class="is-open" title="Open">${t.open}</span>` : '',
    ].join('')}</span></td>`).join('');

    // The key, up top beside the location picker.
    const used = [...letters].filter((l) => LETTER_NAME[l]).sort((a, b) => 'VMNTEW'.indexOf(a) - 'VMNTEW'.indexOf(b));
    $('#s-rkey', el).innerHTML = `
      <span class="rk"><i class="st-C"></i>Confirmed</span><span class="rk"><i class="st-U"></i>Requested</span><span class="rk"><i class="st-D"></i>Declined</span>
      <span class="rk-sep"></span>
      ${used.map((l) => `<span class="rk-l"><i>${l}</i>${esc(LETTER_NAME[l])}</span>`).join('')}
      <span class="rk-note">Any decline makes the whole pill red; any open request makes it yellow.</span>`;

    return `
      <div class="ros-wrap">
        <table class="ros ${campus ? 'one-place' : ''}">
          <thead><tr>${campus ? '' : '<th class="ros-corner ros-loc-h" scope="col">Location</th>'}<th class="ros-corner ros-pos-h" scope="col">Position</th>${head}</tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><th class="ros-foot-h" ${campus ? '' : 'colspan="2"'}>Totals</th>${foot}</tr></tfoot>
        </table>
      </div>`;
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
    const label = `${name}: ${STATUS_LABEL[pill.status]}${pill.entries.length > 1 ? ` (${pill.entries.map((e) => `${kindName(m.type(e.plan), e.plan)} ${(STATUS_LABEL[e.status] || STATUS_LABEL.U).toLowerCase()}`).join(', ')})` : ''}`;
    return `<button type="button" class="rp st-${pill.status} ${isMe ? 'is-me' : ''}" data-rp="${id}" title="${esc(label)}" aria-label="${esc(label)}">
      <span class="rp-dots">${dots}</span><b>${esc(shown)}</b>
    </button>`;
  }

  /** Scales the roster so every row fits on the screen; only the dates scroll sideways. */
  function fitRoster() {
    const wrap = $('.ros-wrap', el);
    const table = wrap && $('.ros', wrap);
    if (!wrap || !table) return;
    table.style.zoom = '';
    wrap.style.height = '';
    const natural = table.offsetHeight;
    if (!natural) return;
    const top = wrap.getBoundingClientRect().top + window.scrollY;
    const tabs = document.querySelector('.nav')?.getBoundingClientRect();
    const below = tabs && tabs.top > window.innerHeight / 2 ? window.innerHeight - tabs.top + 8 : 0; // the phone tab bar
    const room = Math.max(220, window.innerHeight - top - below - 14);
    const clamp = (z) => Math.max(0.55, Math.min(1.25, z)); // past 0.55 it scrolls instead of shrinking
    let z = clamp((room - 2) / natural);
    // Borders and text don't shrink exactly in step, so measure and adjust a couple of times.
    for (let i = 0; i < 4; i++) {
      table.style.zoom = z.toFixed(3);
      const bar = wrap.offsetHeight - wrap.clientHeight - 2; // a sideways scrollbar (desktops; not iPad)
      const space = room - 2 - Math.max(0, bar);
      const h = table.getBoundingClientRect().height;
      wrap.style.height = `${Math.min(room, Math.ceil(h) + 2 + Math.max(0, bar))}px`;
      if (h <= space + 0.5 && h > space - 6) break;
      const next = clamp(z * (space / h));
      if (Math.abs(next - z) < 0.002) break;
      z = next;
    }
  }

  /** One person's day on one position: each service and their answer to it. */
  function openPill(id) {
    const x = pills.get(id);
    const m = model();
    if (!x || !m) return;
    const { row, pill } = x;
    const isMe = m.me && pill.person_id === m.me;
    const name = pill.name || (isMe ? ctx.me.full_name || 'You' : 'Someone');
    const first = pill.entries[0].plan;
    const place = ctx.campusById.get(row.campusId)?.short_name;
    const counts = { C: 0, U: 0, D: 0 };
    for (const e of pill.entries) counts[e.status in counts ? e.status : 'U']++;
    const n = pill.entries.length;
    const all = n === 2 ? 'both' : `all ${n}`;
    const summary = pill.status === 'C' ? (n > 1 ? `Confirmed for ${all} services` : 'Confirmed')
      : pill.status === 'D' ? (counts.D === n ? (n > 1 ? `Declined ${all} services` : 'Declined') : `Declined ${counts.D} of ${n} services`)
      : counts.U === n ? (n > 1 ? `Hasn’t answered ${n === 2 ? 'either' : `any of the ${n}`} yet` : 'Hasn’t answered yet')
      : `Hasn’t answered ${counts.U} of ${n} services yet`;
    const photo = realPhoto(pill.photo);
    const sheet = ctx.openSheet({ label: name, className: 'rp-sheet' });
    const render = () => {
      const vol = isStaff && pill.person_id ? s.vol?.people.find((v) => v.pco_person_id === pill.person_id) : null;
      sheet.render(`
      <header class="sh-head">
        <div class="sh-top"><span class="eyebrow">${esc([place, `${m.c.weekday(first.sort_date)}, ${m.c.date(first.sort_date)}`].filter(Boolean).join(' · '))}</span>
          <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
        <div class="rp-who">
          <span class="ro-av">${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name))}</span>
          <div><h2>${esc(name)}${isMe ? ' <em class="you">You</em>' : ''}</h2><p class="sh-sub">${esc(row.position)} · ${esc(row.team)}</p></div>
        </div>
      </header>
      <div class="sh-body">
        <p class="rp-sum st-${pill.status}">${statusMark(pill.status)}<b>${esc(summary)}</b></p>
        <ul class="svc-mine">${pill.entries.map((e) => `<li><button type="button" class="svc-mine-row" data-goto="${e.plan.id}">
          <span class="rp-dots is-big"><i class="st-${esc(e.status)}">${esc(kindLetter(m.type(e.plan), e.plan))}</i></span>
          <span class="svc-you-when"><b>${esc(firstTime(m, e.plan))}</b><small>${esc(m.c.weekday(e.plan.sort_date).slice(0, 3))} ${esc(m.c.date(e.plan.sort_date))}</small></span>
          <span class="svc-you-what"><b>${esc(kindName(m.type(e.plan), e.plan))}</b><small>${esc(STATUS_LABEL[e.status] || STATUS_LABEL.U)}</small></span>
          ${statusMark(e.status)}
          ${icon('chevron', 'svc-place-go')}
        </button></li>`).join('')}</ul>
        ${vol ? `<section class="block rp-lan">
          <h3>Lanyard</h3>
          <div class="rp-lan-row">${people.lanyardChips(vol)}<span class="fine">${vol.lanyard ? esc(LANYARDS[vol.lanyard]) : 'No lanyard yet'}</span>
          <button type="button" class="btn small ghost" data-vprofile="${vol.id}">${icon('me')}Profile</button></div>
        </section>` : ''}
      </div>`);
    };
    sheet.el.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) { sheet.close(true); openPlan(g.dataset.goto); return; }
      const l = e.target.closest('[data-lan]');
      if (l) { people.setLanyard(l.dataset.vid, l.dataset.lan, () => { render(); if (nav.mode === 'roster') draw(); }); return; }
      const pr = e.target.closest('[data-vprofile]');
      if (pr) { sheet.close(true); people.openPerson(pr.dataset.vprofile); }
    });
    render();
  }

  function mySchedule(m) {
    const rows = [];
    for (const p of m.mine) for (const r of m.people.get(p.id) || []) if (r.person_id === m.me) rows.push({ p, r });
    $('#s-tally', el).innerHTML = rows.length ? `<b>${rows.length}</b><span>${rows.length === 1 ? 'time' : 'times'}</span><small>you’re scheduled</small>` : '';
    if (!rows.length) {
      return `<div class="empty"><h3>You’re not on anything coming up</h3><p>Nothing in the next ${plural(s.status.weeks_ahead || 6, 'week')}. When you’re scheduled in Planning Center, it shows up here.</p></div>`;
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

/** A person's answer for the whole day: any decline wins, then any request still out. */
function wholeDay(statuses) {
  if (statuses.includes('D')) return 'D';
  if (statuses.some((x) => x !== 'C')) return 'U';
  return 'C';
}
