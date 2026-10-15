// Services: browse Planning Center by location, then date, then service
// (Vintage, Traditional, Modern…), and see that service's times and who's on
// the production teams. Planning Center is connected once for the whole church
// (Settings › Planning Center); nobody signs in to it here. What each person
// sees comes from their role in this app and the services an admin shares.

import { esc, icon, $, debounce, plural, timeAgo, initials } from '../util.js';
import { ALL, dropdownHtml, wireDropdown } from '../picker.js';
import { clock, teamKey, teamServices, realPhoto, STATUS_LABEL } from '../pco.js';

const POLL_MS = 60000;
const FAST_MS = 3000;

export function mount(el, ctx) {
  let alive = true;
  const isStaff = ctx.roleAtLeast(ctx.me.role, 'staff');
  const isAdmin = ctx.me.role === 'admin';
  // Where you were (location, date, service) lasts while the app is open.
  const nav = ctx.servicesNav || (ctx.servicesNav = { date: null, plan: null });
  const s = {
    status: undefined, // undefined while loading, null when Planning Center isn't connected
    data: null,
    error: null,
    campus: ctx.campus, // shared with Gear and Network; All on every launch
    mine: false,
    refreshing: false,
    picked: false,      // a location was chosen on this screen (or by default)
  };
  if (s.campus !== ALL && !ctx.campusById.has(s.campus)) s.campus = ALL;
  let timer = null;

  el.innerHTML = `
    <div class="page-head">
      <div class="mode-row">
        <div class="seg mode-seg" role="tablist" aria-label="Show" id="s-seg" hidden>
          <button type="button" role="tab" data-smode="all">Services</button>
          <button type="button" role="tab" data-smode="mine">My schedule</button>
        </div>
        <p class="tally" id="s-tally" aria-live="polite"></p>
      </div>
      <p class="head-meta svc-meta" id="s-meta"></p>
    </div>
    <div class="toolbar filter-bar svc-bar" id="s-bar" hidden>
      <div class="filters">${dropdownHtml('s-loc', 'Location', 'caps')}</div>
    </div>
    <div class="results svc" id="s-body"><div class="loading">${'<div class="sk tall"></div>'.repeat(2)}</div></div>`;

  // Only locations that have shared services are offered.
  const loc = wireDropdown($('#s-loc', el), {
    label: 'Location',
    unit: ['service', 'services'],
    get: () => s.campus,
    set: (v) => { pickCampus(v); },
    options: () => {
      const m = model();
      if (!m) return [{ value: ALL, label: 'All locations' }];
      return [{ value: ALL, label: 'All locations', count: m.plans.length },
        ...m.places.map((c) => ({ value: c.id, label: c.short_name, count: m.plansAt(c.id).length }))];
    },
  });

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-smode], [data-campus], [data-date], [data-plan], [data-goto]');
    if (!t) return;
    if (t.dataset.smode) { s.mine = t.dataset.smode === 'mine'; draw(); return; }
    if (t.dataset.campus) { pickCampus(t.dataset.campus); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (t.dataset.date) { nav.date = t.dataset.date; nav.plan = null; draw(); return; }
    if (t.dataset.plan) { nav.plan = t.dataset.plan; draw(); return; }
    if (t.dataset.goto) { openPlan(t.dataset.goto); return; }
    const act = t.dataset.act;
    if (act === 'settings') ctx.openSettings('pco');
    else if (act === 'refresh') refresh();
    else if (act === 'retry') load();
    else if (act === 'mine') { s.mine = true; draw(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (act === 'all-places') pickCampus(ALL);
  });

  const onVisible = () => { if (document.visibilityState === 'visible') checkStatus(); };
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'pco' || table === 'profiles') load(true); }, 300));
  const clockTimer = setInterval(drawHead, 30000); // keeps "updated 3 min ago" honest

  load();
  return {
    unmount() {
      alive = false;
      clearTimeout(timer); clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
    },
  };

  function pickCampus(id) {
    s.campus = ctx.campus = id;
    s.picked = true;
    s.mine = false;
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
    s.mine = false;
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
      if (me) ctx.me.pco_person_id = me.pco_person_id ?? null; // matched by email during a sync
    } catch (e) {
      if (!quiet || !s.data) s.error = e.message;
    }
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
    return { c, types, teams, plans, people, me, mine, type, plansAt, places };
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
    seg.hidden = !connected || !m?.me;
    seg.querySelectorAll('[data-smode]').forEach((b) => b.setAttribute('aria-selected', String((b.dataset.smode === 'mine') === s.mine)));
    $('#s-bar', el).hidden = !connected || !m?.plans.length || s.mine;
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

    if (s.mine) { box.innerHTML = mySchedule(m); return; }
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
      <div class="svc-teams">${blocks || '<p class="svc-none">No production teams on this service.</p>'}</div>
      <footer class="svc-foot">
        <span class="svc-counts">${[
          tally.C ? `<span class="is-C">${tally.C} confirmed</span>` : '',
          tally.U ? `<span class="is-U">${tally.U} not yet</span>` : '',
          tally.D ? `<span class="is-D">${tally.D} declined</span>` : '',
          tally.open ? `<span class="is-open">${tally.open} open</span>` : '',
        ].filter(Boolean).join('') || '<span>No one scheduled yet</span>'}</span>
      </footer>
    </article>`;
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

function statusMark(st) {
  const label = STATUS_LABEL[st] || STATUS_LABEL.U;
  const glyph = st === 'C' ? icon('check') : st === 'D' ? icon('close') : '<i aria-hidden="true">?</i>';
  return `<span class="ro-st st-${esc(st || 'U')}" role="img" aria-label="${label}" title="${label}">${glyph}</span>`;
}
