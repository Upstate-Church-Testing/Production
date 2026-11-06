// Events: the one-off services in Planning Center (Engage, a conference, a coffeehouse)
// as a whole. Which services count as events is set per Planning Center service
// (pco_service_types.is_event). The list is coming up first, then what's past; an event
// opens on three panes:
//   Live  where the service is right now, from Planning Center Live: the item that's up,
//         its time left (counting over in red), what's next, the service clock and
//         whether it's running long, and the run of show with each item's actual time.
//         When someone hits Next in Planning Center Live, this follows within a couple
//         of seconds (pco-live reads Live for every screen at once). Full screen keeps
//         the phone awake, for a confidence screen.
//   Flow  the order of service as planned, with notes.
//   Team  who's on the production teams.
// Staff and up (the Planning Center service is shared with staff).

import { esc, icon, $, debounce, initials, pageTitle } from '../util.js';
import { clock, realPhoto, teamKey, teamServices, hiddenPosition, STATUS_LABEL } from '../pco.js';

const POLL_MS = 2000;         // Live: ask this often while it's on screen
const SLOW_POLL_MS = 15000;   // …when the event isn't today
const CHECK_MS = 20000;       // the event list: has Planning Center changed?
const PAST_SHOWN = 6;         // past events listed (latest first)

export function mount(el, ctx) {
  let alive = true;
  const nav = ctx.eventsNav || (ctx.eventsNav = { plan: null, pane: null, full: false });
  const s = {
    status: undefined, data: null, error: null,
    items: new Map(),   // plan id -> its flow (from the sync), loaded when opened
    live: null,         // the last Live answer for nav.plan
    liveFor: null,      // which plan that answer is for
    liveError: null,
    offset: 0,          // server clock minus this device's
    sig: '',            // what the Live pane was last drawn from
  };
  let pollTimer = null;
  let checkTimer = null;
  let tickTimer = null;
  let wake = null;
  let wallFmt = null;
  const now = () => Date.now() + s.offset;
  /** Which pane the open event shows: Live on its day, Flow otherwise, until someone picks. */
  const paneOf = (m, p) => nav.pane || (p._day === m.today ? 'live' : 'flow');

  el.innerHTML = `<div class="ev-page" id="ev"><div class="loading">${'<div class="sk tall"></div>'.repeat(2)}</div></div>`;
  const root = $('#ev', el);

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open], [data-pane], [data-act]');
    if (!t) return;
    if (t.dataset.open) { open(t.dataset.open); return; }
    if (t.dataset.pane) { nav.pane = t.dataset.pane; draw(); return; }
    const act = t.dataset.act;
    if (act === 'back') { open(null); }
    else if (act === 'full') { setFull(!nav.full); }
    else if (act === 'retry') { load(); }
    else if (act === 'settings') { ctx.openSettings('pco'); }
  });
  const onKey = (e) => { if (e.key === 'Escape' && nav.full) setFull(false); };
  document.addEventListener('keydown', onKey);
  // The browser's own full screen (computers, iPads) ending with Esc ends ours too.
  let browserFull = false;
  const onFs = () => { if (!document.fullscreenElement && browserFull) { browserFull = false; if (nav.full) setFull(false); } };
  document.addEventListener('fullscreenchange', onFs);
  const onVisible = () => {
    if (document.visibilityState === 'visible') { poll(); check(); if (nav.full) keepAwake(true); }
  };
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'pco') load(true); }, 300));

  load();
  return {
    unmount() {
      alive = false;
      clearTimeout(pollTimer); clearTimeout(checkTimer); clearInterval(tickTimer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      document.removeEventListener('visibilitychange', onVisible);
      document.documentElement.classList.remove('lv-full-on');
      keepAwake(false);
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
    if (nav.plan !== planId) { s.live = null; s.liveFor = null; s.liveError = null; s.sig = ''; nav.pane = null; }
    nav.plan = planId;
    if (!planId) setFull(false, false);
    draw();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------- draw ---

  function draw() {
    if (!alive) return;
    clearInterval(tickTimer); tickTimer = null;
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
    if (plan) afterEvent(m, plan); else stopLive();
  }

  function head(extra = '') {
    return `<div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}${extra}</div></div>`;
  }

  function listHtml(m) {
    const n = m.upcoming.length;
    const tally = `<p class="tally"><b>${n}</b><span>coming up</span></p>`;
    if (!m.plans.length) {
      return `${head()}<div class="empty"><p>No events yet.</p><p class="fine">Events are Planning Center services marked as events (Simpsonville › Events).</p></div>`;
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
        <span class="ev-when">${isToday ? `<i class="ev-dot"></i>` : ''}${esc(when)}</span>
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
    const pane = paneOf(m, p);
    const items = s.items.get(p.id);
    if (items === undefined) loadItems(p.id);
    const crew = m.people.filter((x) => x.plan_id === p.id && !hiddenPosition(x.position));
    const steps = items?.filter?.((x) => x.kind !== 'header').length;
    // Planning Center lists the service time twice on some plans (the service, and an
    // "other" time named Service at the same start): once is enough.
    const svcStarts = new Set((p.times || []).filter((x) => x.kind === 'service').map((x) => x.starts_at));
    const times = (p.times || []).filter((x) => x.starts_at && !(x.kind !== 'service' && /^service$/i.test(x.name || '') && svcStarts.has(x.starts_at)))
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    return `<div class="page-head ev-top">
        <button type="button" class="btn small ghost ev-back" data-act="back">${icon('chevron', 'flip')}<span>Events</span></button>
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
            <b>${esc(m.c.time(x.starts_at))}</b><span>${esc(x.name || (x.kind === 'service' ? 'Service' : x.kind === 'rehearsal' ? 'Rehearsal' : 'Other'))}</span>
          </li>`).join('')}</ol>` : ''}
        <div class="seg ev-panes" role="tablist" aria-label="Show">
          <button type="button" role="tab" data-pane="live" aria-selected="${pane === 'live'}"><i class="ev-livedot" aria-hidden="true"></i>Live</button>
          <button type="button" role="tab" data-pane="flow" aria-selected="${pane === 'flow'}">${icon('list')}Flow${steps ? `<small>${steps}</small>` : ''}</button>
          <button type="button" role="tab" data-pane="team" aria-selected="${pane === 'team'}">${icon('team')}Team<small>${crew.filter((x) => x.status !== 'D').length}</small></button>
        </div>
        <section class="ev-pane" data-pane-body="${pane}">
          ${pane === 'live' ? `<div id="lv">${liveHtml(m, p)}</div>` : pane === 'flow' ? flowHtml(m, p, items) : teamHtml(m, p, crew)}
        </section>
      </article>`;
  }

  async function loadItems(planId) {
    s.items.set(planId, null);
    try { s.items.set(planId, (await ctx.store.pcoItems(planId)) || []); } catch (e) { s.items.set(planId, { error: e.message }); }
    if (alive && nav.plan === planId && (nav.pane || 'flow') !== 'live') draw();
    else if (alive && nav.plan === planId) { const tab = $('[data-pane="flow"]', root); const n = s.items.get(planId)?.filter?.((x) => x.kind !== 'header').length; if (tab && n) tab.innerHTML = `${icon('list')}Flow<small>${n}</small>`; }
  }

  // ------------------------------------------------------------- live ---

  function afterEvent(m, p) {
    if (paneOf(m, p) !== 'live') { stopLive(); return; }
    if (s.liveFor !== p.id) { s.live = null; s.liveFor = p.id; }
    tickTimer = setInterval(() => tick(m, p), 250);
    tick(m, p);
    if (!pollTimer) poll();
    keepAwake(nav.full);
  }

  function stopLive() {
    clearTimeout(pollTimer); pollTimer = null;
    clearInterval(tickTimer); tickTimer = null;
    keepAwake(false);
  }

  async function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    const m = model();
    const p = m && nav.plan ? m.plans.find((x) => x.id === nav.plan) : null;
    if (!alive || !p || paneOf(m, p) !== 'live') return;
    if (document.visibilityState === 'hidden') return; // onVisible starts it again
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
    if (!alive || nav.plan !== p.id || paneOf(m, p) !== 'live') return;
    const sig = liveSig();
    if (sig !== s.sig) { const box = $('#lv', root); if (box) box.innerHTML = liveHtml(m, p); }
    tick(m, p);
    pollTimer = setTimeout(poll, p._day === m.today ? POLL_MS : SLOW_POLL_MS);
  }

  function liveSig() {
    const st = s.live;
    return st ? [st.current_id, st.current?.start, st.next_id, st.controller, st.full_read_at, !!s.liveError, nav.full].join('|') : `none|${!!s.liveError}|${nav.full}`;
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
    const rows = items.map((it) => ({ it, t: timesFor.get(it.id) || null }));
    const run = rows.filter((r) => r.it.kind !== 'header' && !r.t?.exclude && (r.t || !timesFor.size));
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
    const after = cur >= 0 ? run.slice(cur + 1) : state === 'wait' ? run : [];
    const restMs = after.reduce((n, r) => n + len(r), 0);
    const projected = state === 'live' ? t + Math.max(0, item.left) + restMs : state === 'wait' && plannedStart ? Math.max(t, plannedStart) + planned : null;
    // When each item starts: what happened, then what's planned from now.
    // (Items before the current one that never went live were skipped: no time.)
    let at = state === 'wait' ? Math.max(t, plannedStart ?? t) : null;
    const when = new Map();
    run.forEach((r, k) => {
      if (r.t?.start && state !== 'wait' && (state !== 'live' || k <= cur)) {
        const end = r.t.end ? Date.parse(r.t.end) : run[k + 1]?.t?.start ? Date.parse(run[k + 1].t.start) : null;
        when.set(r.it.id, { start: Date.parse(r.t.start), actual: end ? end - Date.parse(r.t.start) : k === cur ? t - Date.parse(r.t.start) : null });
        if (k === cur) at = Math.max(t, Date.parse(r.t.start) + len(r));
      } else if (state === 'live' && k < cur) {
        when.set(r.it.id, { skipped: true });
      } else if (at != null) {
        when.set(r.it.id, { start: at, planned: true });
        at += len(r);
      }
    });
    const lastEnd = (pt?.live_ends_at ? Date.parse(pt.live_ends_at) : null)
      ?? run.map((r) => (r.t?.end ? Date.parse(r.t.end) : null)).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    return {
      pt, run, rows, cur, item, state, planned, plannedStart, first, projected, when, lastEnd,
      next: state === 'live' ? run[cur + 1] || null : state === 'wait' ? run[0] || null : null,
      after: state === 'live' ? run[cur + 2] || null : state === 'wait' ? run[1] || null : null,
    };
  }

  function liveHtml(m, p) {
    s.sig = liveSig();
    const st = s.live;
    if (!st) {
      if (s.liveError) return `<div class="lv lv-off"><p>Couldn’t reach Planning Center Live: ${esc(s.liveError)}</p><p class="fine">Trying again every few seconds.</p></div>`;
      return `<div class="lv lv-loading"><div class="sk tall"></div></div>`;
    }
    if (st.available === false) return `<div class="lv lv-off"><p>Planning Center Live isn’t available for this plan.</p>${st.note ? `<p class="fine">${esc(st.note)}</p>` : ''}</div>`;
    const w = where(st, now());
    const hhmm = (ms) => m.c.time(ms);
    const meta = (it) => [it.kind === 'song' ? 'Song' : it.kind === 'media' ? 'Media' : null, it.key_name ? `Key ${it.key_name}` : null,
      it.description && it.description.length <= 40 && !/\n/.test(it.description) ? it.description : null].filter(Boolean).join(' · ');
    const now_ = w.state === 'live' ? w.item.r.it : w.next?.it;
    const badge = w.state === 'live' ? '<span class="lv-badge is-live"><i></i>Live</span>'
      : w.state === 'done' ? '<span class="lv-badge is-done">Ended</span>' : '<span class="lv-badge">Not started</span>';
    const notes = (it) => (it?.notes || []).map((n) => `<span class="fl-note"><em ${noteDep(n.category)}>${esc(n.category)}</em>${esc(n.content)}</span>`).join('');
    const nowBlock = w.state === 'done'
      ? `<div class="lv-now"><small class="lv-k">Service</small>
          <h3>Over</h3>
          <div class="lv-clock is-small">${w.first && w.lastEnd ? esc(dur(w.lastEnd - w.first)) : '—'}</div>
          <p class="lv-sub">${w.first ? `Started ${esc(hhmm(w.first))}` : ''}${w.lastEnd ? ` · ended ${esc(hhmm(w.lastEnd))}` : ''} · planned ${esc(dur(w.planned))}</p>
        </div>`
      : `<div class="lv-now">
          <small class="lv-k">${w.state === 'live' ? 'Now' : 'Up first'}</small>
          <h3>${esc(now_?.title || 'Nothing in the flow')}</h3>
          ${now_ && meta(now_) ? `<p class="lv-meta">${esc(meta(now_))}</p>` : ''}
          <div class="lv-clock" data-tick="big">—</div>
          ${w.state === 'live' ? '<div class="lv-bar"><i data-tick="bar"></i></div>' : ''}
          <p class="lv-sub" data-tick="sub"></p>
          ${notes(now_) ? `<div class="lv-notes">${notes(now_)}</div>` : ''}
        </div>`;
    const next = w.state === 'done' ? null : w.state === 'live' ? w.next : w.after;
    const rows = w.rows.map((r) => {
      if (r.it.kind === 'header') return `<li class="fl-head"><span>${esc(r.it.title || 'Section')}</span></li>`;
      if (!w.run.includes(r)) return '';
      const k = w.run.indexOf(r);
      const at = w.when.get(r.it.id);
      const stateCls = at?.skipped ? 'is-skipped' : w.state === 'live' ? (k < w.cur ? 'is-done' : k === w.cur ? 'is-now' : '') : w.state === 'done' && at?.start && !at.planned ? 'is-done' : '';
      const planned = Math.max(0, r.it.length || 0) * 1000;
      const actual = at?.start && !at.planned && at.actual != null ? at.actual : null;
      const diff = actual != null && planned && k !== w.cur ? actual - planned : null;
      return `<li class="fl-item lv-row fl-${esc(r.it.kind)} ${stateCls}" ${k === w.cur ? 'data-tick-row="now"' : ''}>
        <span class="fl-time">${at?.start ? esc(hhmm(at.start).replace(/\s?[AP]M$/, '')) : ''}</span>
        <div class="fl-main"><b>${esc(r.it.title || 'Untitled')}</b>${meta(r.it) ? `<span class="fl-meta">${esc(meta(r.it))}</span>` : ''}</div>
        <span class="fl-len lv-len">${k === w.cur ? `<b data-tick="rowlen">${esc(dur(actual ?? 0))}</b><small>of ${esc(dur(planned))}</small>`
          : actual != null ? `<b>${esc(dur(actual))}</b>${diff != null && Math.abs(diff) >= 1000 ? `<small class="${diff > 0 ? 'is-over' : 'is-under'}">${diff > 0 ? '+' : '−'}${esc(dur(Math.abs(diff)))}</small>` : '<small>on time</small>'}`
          : at?.skipped ? '<small>Skipped</small>' : planned ? esc(dur(planned)) : ''}</span>
      </li>`;
    }).join('');
    return `<div class="lv ${nav.full ? 'is-full' : ''}" data-state="${w.state}">
        <div class="lv-top">
          ${badge}
          <span class="lv-by">${st.controller ? `Driven by <b>${esc(st.controller)}</b>` : w.state === 'live' ? 'Planning Center Live' : ''}</span>
          <span class="lv-wall" data-tick="wall"></span>
          <button type="button" class="btn small ghost lv-fullbtn" data-act="full" aria-pressed="${nav.full}" title="${nav.full ? 'Leave full screen' : 'Full screen (keeps the screen on)'}">${icon(nav.full ? 'close' : 'expand')}<span>${nav.full ? 'Done' : 'Full screen'}</span></button>
        </div>
        ${nowBlock}
        ${next ? `<div class="lv-next"><small class="lv-k">Next</small><b>${esc(next.it.title || 'Untitled')}</b><span>${esc(dur(Math.max(0, next.it.length || 0) * 1000))}</span></div>` : ''}
        ${w.state !== 'done' ? `<div class="lv-svc">
          <div><small class="lv-k">${w.state === 'live' ? 'Service' : 'Starts'}</small><b data-tick="svc">—</b></div>
          <div><small class="lv-k">Planned</small><b>${esc(dur(w.planned))}</b></div>
          <div><small class="lv-k">${w.state === 'live' ? 'On pace to end' : 'Ends about'}</small><b data-tick="proj">—</b><em data-tick="delta"></em></div>
        </div>` : ''}
        ${s.liveError ? `<p class="lv-warn">${icon('warn')}Lost Planning Center Live for a moment: ${esc(s.liveError)}. Still trying.</p>` : ''}
      </div>
      ${nav.full ? '' : `<ol class="flow lv-flow">${rows}</ol>
      <p class="lv-foot" data-tick="foot"></p>`}`;
  }

  /** Every quarter second: the numbers only. */
  function tick(m, p) {
    const box = $('#lv', root);
    if (!box || !s.live || s.live.available === false) return;
    const t = now();
    const w = where(s.live, t);
    const set = (k, v, cls) => {
      const x = $(`[data-tick="${k}"]`, box);
      if (!x) return;
      if (x.textContent !== v) x.textContent = v;
      if (cls !== undefined) { const c = k === 'big' && v.length > 6 ? `${cls} is-long` : cls; if (x.className !== c) x.className = c; }
    };
    if (!wallFmt) {
      const opts = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
      try { wallFmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: s.status?.time_zone || 'America/New_York' }); } catch { wallFmt = new Intl.DateTimeFormat('en-US', opts); }
    }
    set('wall', wallFmt.format(t));
    if (w.state === 'live') {
      const left = w.item.left;
      set('big', left >= 0 ? dur(left) : `+${dur(-left)}`, `lv-clock ${left < 0 ? 'is-over' : left < 30000 ? 'is-close' : ''}`);
      const bar = $('[data-tick="bar"]', box);
      if (bar) { bar.style.width = `${Math.min(100, w.item.length ? (w.item.elapsed / w.item.length) * 100 : 100).toFixed(1)}%`; bar.classList.toggle('is-over', left < 0); }
      set('sub', left >= 0 ? `${dur(w.item.elapsed)} in · ${dur(w.item.length)} planned` : `Over by ${dur(-left)} · ${dur(w.item.length)} planned`);
      set('rowlen', dur(w.item.elapsed));
      if (w.first) set('svc', dur(t - w.first));
    } else if (w.state === 'wait') {
      const until = w.plannedStart != null ? w.plannedStart - t : null;
      if (until != null && until > 0) {
        set('big', dur(until), 'lv-clock is-wait');
        set('sub', `Until ${m.c.time(w.plannedStart)} · waiting for Planning Center Live`);
      } else {
        set('big', until != null ? `+${dur(-until)}` : '—', 'lv-clock is-late');
        set('sub', `${w.plannedStart ? `Planned for ${m.c.time(w.plannedStart)} · ` : ''}waiting for someone to start Planning Center Live`);
      }
      set('svc', w.plannedStart ? m.c.time(w.plannedStart) : '—');
    }
    if (w.projected != null) {
      set('proj', m.c.time(w.projected));
      const target = w.state === 'live' && w.first != null ? (w.plannedStart ?? w.first) + w.planned : null;
      if (target != null) {
        const d = w.projected - target;
        set('delta', Math.abs(d) < 30000 ? 'on time' : `${d > 0 ? '+' : '−'}${dur(Math.abs(d))} ${d > 0 ? 'long' : 'short'}`, Math.abs(d) < 30000 ? 'is-ok' : d > 0 ? 'is-over' : 'is-under');
      } else set('delta', '');
    }
    const read = s.live.read_at ? Date.parse(s.live.read_at) : null;
    set('foot', `From Planning Center Live${read ? `, read ${Math.max(0, Math.round((t - read) / 1000))}s ago` : ''}. Updates by itself.`);
  }

  function setFull(on, redraw = true) {
    nav.full = !!on;
    document.documentElement.classList.toggle('lv-full-on', nav.full);
    // Where the browser can (not iPhone Safari), the whole screen: no browser bars either.
    try {
      if (nav.full && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().then(() => { browserFull = true; }).catch(() => {});
      } else if (!nav.full && document.fullscreenElement) { browserFull = false; document.exitFullscreen().catch(() => {}); }
    } catch { /* not offered */ }
    keepAwake(nav.full);
    if (redraw) { const m = model(); const p = m?.plans.find((x) => x.id === nav.plan); const box = $('#lv', root); if (m && p && box) { box.innerHTML = liveHtml(m, p); tick(m, p); } }
  }

  /** Full screen keeps the screen on (a phone as a confidence monitor). */
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock && document.visibilityState === 'visible') {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener?.('release', () => { wake = null; });
      } else if (!on && wake) { const w = wake; wake = null; await w.release(); }
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
      const rows = crew.filter((r) => r.team_id === tm.id && !hiddenPosition(r.position)).sort((a, b) => rank(a.position) - rank(b.position) || String(a.name).localeCompare(String(b.name)));
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
