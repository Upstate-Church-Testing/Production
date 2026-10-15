// Services: what's coming up in Planning Center and who's on the production
// teams. Planning Center is connected once for the whole church (Settings ›
// Planning Center); nobody signs in to it here. What each person sees comes
// from their role in this app and the services an admin shares.

import { esc, icon, $, debounce, plural, timeAgo, initials } from '../util.js';
import { ALL, dropdownHtml, wireDropdown, locationDropdown } from '../picker.js';
import { clock, teamKey, realPhoto, STATUS_LABEL } from '../pco.js';

const POLL_MS = 60000;
const FAST_MS = 3000;

export function mount(el, ctx) {
  let alive = true;
  const isStaff = ctx.roleAtLeast(ctx.me.role, 'staff');
  const isAdmin = ctx.me.role === 'admin';
  const s = {
    status: undefined, // undefined while loading, null when Planning Center isn't connected
    data: null,
    error: null,
    campus: ctx.campus, // shared with Gear and Network; All on every launch
    type: ALL,
    team: ALL,
    mine: false,
    refreshing: false,
  };
  if (s.campus !== ALL && !ctx.campusById.has(s.campus)) s.campus = ALL;
  let timer = null;

  el.innerHTML = `
    <div class="page-head">
      <div class="mode-row">
        <div class="seg mode-seg" role="tablist" aria-label="Show" id="s-seg" hidden>
          <button type="button" role="tab" data-smode="all">All services</button>
          <button type="button" role="tab" data-smode="mine">My schedule</button>
        </div>
        <p class="tally" id="s-tally" aria-live="polite"></p>
      </div>
      <p class="head-meta svc-meta" id="s-meta"></p>
    </div>
    <div class="toolbar filter-bar" id="s-bar" hidden>
      <div class="filters">
        ${dropdownHtml('s-loc', 'Location', 'caps')}
        ${dropdownHtml('s-type', 'Service')}
        ${dropdownHtml('s-team', 'Team')}
      </div>
    </div>
    <div class="results svc" id="s-body"><div class="loading">${'<div class="sk tall"></div>'.repeat(3)}</div></div>`;

  // ---------------------------------------------------------- filters ---
  const view = () => model(); // recomputed on demand; cheap
  const loc = locationDropdown(ctx, $('#s-loc', el), {
    unit: ['service', 'services'],
    get: () => s.campus,
    set: (v) => { s.campus = ctx.campus = v; s.type = ALL; draw(); },
    counts: () => {
      const m = view();
      if (!m) return {};
      const counts = { [ALL]: m.plans.length };
      for (const c of ctx.campuses) counts[c.id] = m.plans.filter((p) => m.type(p).campus_id === c.id).length;
      return counts;
    },
  });
  const typeDd = wireDropdown($('#s-type', el), {
    label: 'Service',
    unit: ['service', 'services'],
    get: () => s.type,
    set: (v) => { s.type = v; draw(); },
    options: () => {
      const m = view();
      if (!m) return [{ value: ALL, label: 'All services' }];
      const here = m.plans.filter((p) => s.campus === ALL || m.type(p).campus_id === s.campus);
      const types = m.types.filter((t) => s.campus === ALL || t.campus_id === s.campus);
      return [{ value: ALL, label: 'All services', count: here.length },
        ...types.map((t) => ({ value: t.id, label: t.name, count: here.filter((p) => p.service_type_id === t.id).length }))];
    },
  });
  const teamDd = wireDropdown($('#s-team', el), {
    label: 'Team',
    get: () => s.team,
    set: (v) => { s.team = v; draw(); },
    options: () => {
      const m = view();
      const names = new Map();
      for (const t of m?.teams || []) if (!names.has(teamKey(t.name))) names.set(teamKey(t.name), t.name);
      return [{ value: ALL, label: 'All teams' }, ...[...names].map(([value, label]) => ({ value, label }))];
    },
  });

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-smode]');
    if (!t) return;
    if (t.dataset.smode) { s.mine = t.dataset.smode === 'mine'; draw(); return; }
    const act = t.dataset.act;
    if (act === 'settings') ctx.openSettings('pco');
    else if (act === 'refresh') refresh();
    else if (act === 'retry') load();
    else if (act === 'clear') { s.campus = ctx.campus = ALL; s.type = ALL; s.team = ALL; s.mine = false; draw(); }
    else if (act === 'mine') { s.mine = true; draw(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
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
    const types = d.types.filter((t) => t.access !== 'hidden'); // admins can read hidden ones; they don't show here
    const typeById = new Map(types.map((t) => [t.id, t]));
    const teams = d.teams.filter((t) => t.shown && typeById.has(t.service_type_id));
    const plans = d.plans.filter((p) => typeById.has(p.service_type_id))
      .sort((a, b) => Date.parse(a.sort_date) - Date.parse(b.sort_date) || placeOrder(typeById.get(a.service_type_id)) - placeOrder(typeById.get(b.service_type_id)));
    const people = new Map();
    for (const p of d.people) people.set(p.plan_id, [...(people.get(p.plan_id) || []), p]);
    const me = ctx.me.pco_person_id;
    const mine = me ? plans.filter((p) => (people.get(p.id) || []).some((x) => x.person_id === me)) : [];
    return { types, teams, plans, people, me, mine, type: (p) => typeById.get(p.service_type_id) };
  }
  function placeOrder(t) {
    const c = t?.campus_id ? ctx.campusById.get(t.campus_id) : null;
    return (c?.sort_order ?? 99) * 1000 + (t?.sequence ?? 999);
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
    $('#s-bar', el).hidden = !connected || !m?.plans.length;
    const seg = $('#s-seg', el);
    seg.hidden = !connected || !m?.me;
    seg.querySelectorAll('[data-smode]').forEach((b) => b.setAttribute('aria-selected', String((b.dataset.smode === 'mine') === s.mine)));
    drawHead();
    loc.update(); typeDd.update(); teamDd.update();

    if (s.error) {
      $('#s-tally', el).innerHTML = '';
      box.innerHTML = `<div class="empty"><h3>Couldn’t load services</h3><p>${esc(s.error)}</p><div class="empty-actions"><button class="btn" data-act="retry">Try again</button></div></div>`;
      return;
    }
    if (s.status === undefined) return; // still loading
    if (!connected) { $('#s-tally', el).innerHTML = ''; box.innerHTML = notConnected(); return; }
    if (!m.types.length) {
      $('#s-tally', el).innerHTML = '';
      box.innerHTML = s.status.syncing || !s.status.last_sync_at
        ? `<div class="empty"><h3>Getting services from Planning Center…</h3><p>The first update takes about a minute. This page fills in by itself.</p></div><div class="loading">${'<div class="sk tall"></div>'.repeat(2)}</div>`
        : `<div class="empty"><h3>No services are shared yet</h3><p>${isAdmin ? 'Pick which Planning Center services the team sees, and which teams show on them.' : 'An admin hasn’t shared any Planning Center services with your role yet.'}</p>${isAdmin ? `<div class="empty-actions"><button class="btn primary" data-act="settings">${icon('settings')}Choose services</button></div>` : ''}</div>`;
      return;
    }

    let plans = s.mine ? m.mine : m.plans;
    plans = plans.filter((p) => (s.campus === ALL || m.type(p).campus_id === s.campus) && (s.type === ALL || p.service_type_id === s.type));
    const weeks = s.status.weeks_ahead || 6;
    const filtering = s.campus !== ALL || s.type !== ALL || s.team !== ALL;
    $('#s-tally', el).innerHTML = `<b>${plans.length}</b><span>${plans.length === 1 ? 'service' : 'services'}</span><small>next ${plural(weeks, 'week')}${filtering ? ` · <button class="btn link" data-act="clear">Clear</button>` : ''}</small>`;

    const nextUp = !s.mine && m.me ? youBanner(m) : '';
    if (!plans.length) {
      box.innerHTML = `${nextUp}<div class="empty"><h3>${s.mine ? 'You’re not on anything coming up' : 'Nothing scheduled here'}</h3><p>${s.mine
        ? `Nothing in the next ${plural(weeks, 'week')}${filtering ? ' with these filters' : ''}. When you’re scheduled in Planning Center, it shows up here.`
        : `No ${s.type === ALL ? 'shared services' : 'plans for this service'}${s.campus !== ALL ? ` at ${esc(ctx.campusById.get(s.campus)?.short_name || 'this location')}` : ''} in the next ${plural(weeks, 'week')}.`}</p>
        ${filtering ? '<div class="empty-actions"><button class="btn" data-act="clear">Show everything</button></div>' : ''}</div>`;
      return;
    }

    const c = clock(s.status.time_zone);
    const days = new Map();
    for (const p of plans) {
      const k = c.day(p.sort_date);
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(p);
    }
    box.innerHTML = nextUp + [...days.values()].map((list) => `
      <section class="svc-day">
        <h2 class="svc-day-h"><span>${esc(c.weekday(list[0].sort_date))}</span> ${esc(c.date(list[0].sort_date))}<small>${esc(c.relative(list[0].sort_date))}</small></h2>
        <div class="svc-grid">${list.map((p) => card(p, m, c)).join('')}</div>
      </section>`).join('');
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
    const c = clock(s.status.time_zone);
    const mineRows = [];
    for (const p of m.mine) for (const r of m.people.get(p.id) || []) if (r.person_id === m.me && r.status !== 'D') mineRows.push({ p, r });
    if (!mineRows.length) return '';
    const first = mineRows.slice(0, 3);
    return `<section class="svc-you">
      <div class="svc-you-head"><h2>You’re on ${plural(new Set(mineRows.map((x) => x.p.id)).size, 'service')}</h2>
        <button class="btn small ghost" data-act="mine">${icon('calendar')}My schedule</button></div>
      <ul>${first.map(({ p, r }) => `<li>
        <span class="svc-you-when"><b>${esc(c.weekday(p.sort_date).slice(0, 3))} ${esc(c.date(p.sort_date))}</b><small>${esc(c.times(p.times.filter((t) => t.kind === 'service').map((t) => t.starts_at)) || c.time(p.sort_date))}</small></span>
        <span class="svc-you-what"><b>${esc(r.position || teamName(m, r.team_id))}</b><small>${esc(m.type(p).name)}</small></span>
        ${statusMark(r.status)}
      </li>`).join('')}</ul>
    </section>`;
  }

  const teamName = (m, id) => m.teams.find((t) => t.id === id)?.name || 'Team';

  function card(p, m, c) {
    const t = m.type(p);
    const campus = t.campus_id ? ctx.campusById.get(t.campus_id)?.short_name : null;
    const services = p.times.filter((x) => x.kind === 'service').map((x) => x.starts_at).filter(Boolean);
    const call = p.times.filter((x) => x.kind !== 'service' && x.starts_at).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0];
    const teams = m.teams.filter((tm) => tm.service_type_id === p.service_type_id && (s.team === ALL || teamKey(tm.name) === s.team))
      .sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99) || a.name.localeCompare(b.name));
    const roster = m.people.get(p.id) || [];
    const tally = { C: 0, U: 0, D: 0, open: 0 };
    const blocks = teams.map((tm) => teamBlock(tm, roster.filter((r) => r.team_id === tm.id), (p.needed || []).filter((n) => n.team_id === tm.id), m.me, tally)).join('');
    const sub = [p.title && !t.name.toLowerCase().includes(p.title.toLowerCase()) ? p.title : null, p.series_title].filter(Boolean).join(' · ');
    const mineHere = m.me && roster.some((r) => r.person_id === m.me);
    return `<article class="svc-card ${mineHere ? 'is-mine' : ''}">
      <header class="svc-top">
        <div class="svc-title">
          ${campus ? `<small class="svc-loc">${esc(campus)}</small>` : ''}
          <h3>${esc(t.name)}</h3>
          ${sub ? `<p class="svc-sub">${esc(sub)}</p>` : ''}
        </div>
        <div class="svc-times">
          <b>${esc(services.length ? c.times(services) : c.time(p.sort_date))}</b>
          ${call ? `<small>${esc(call.name || (call.kind === 'rehearsal' ? 'Rehearsal' : 'Call'))} ${esc(c.time(call.starts_at))}</small>` : ''}
        </div>
      </header>
      ${blocks || `<p class="svc-none">${teams.length ? '' : 'No production teams on this service.'}</p>`}
      <footer class="svc-foot">
        <span class="svc-counts">${[
          tally.C ? `<span class="is-C">${tally.C} confirmed</span>` : '',
          tally.U ? `<span class="is-U">${tally.U} not yet</span>` : '',
          tally.D ? `<span class="is-D">${tally.D} declined</span>` : '',
          tally.open ? `<span class="is-open">${tally.open} open</span>` : '',
        ].filter(Boolean).join('') || '<span>No one scheduled yet</span>'}</span>
        ${isStaff && p.url && p.url !== '#' ? `<a class="btn small ghost" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('open')}<span>Planning Center</span></a>` : ''}
      </footer>
    </article>`;
  }

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
