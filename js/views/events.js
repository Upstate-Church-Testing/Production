// Events: the one-off services in Planning Center (Engage, a conference, a coffeehouse)
// as a whole. Which services count as events is set per Planning Center service
// (pco_service_types.is_event). The list is coming up first, then what's past. An event
// shows its times, a Live button, and two panes: Flow (the order of service as planned,
// with notes) and Team (who's on the production teams).
//
// Live is a full-screen production view of Planning Center Live (js/live.js, the same one
// PCO › Services opens for any service): where the service is, the clock, what's next, and
// for admins Take control, Back and Next.
// Staff and up (the Planning Center service is shared with staff).

import { esc, icon, $, debounce, initials, pageTitle } from '../util.js';
import { clock, realPhoto, teamKey, teamServices, hiddenPosition, STATUS_LABEL } from '../pco.js';
import { createLive, liveButtonHtml, shownTimes, timeName, dur } from '../live.js';

const CHECK_MS = 20000;       // the event list: has Planning Center changed?
const PAST_SHOWN = 6;         // past events listed (latest first)

export function mount(el, ctx) {
  let alive = true;
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
  };
  let checkTimer = null;
  const live = createLive(ctx, {
    tz: () => s.status?.time_zone,
    onClose: () => { nav.live = false; saveNav(); if (alive) $('[data-act="live"]', root)?.focus({ preventScroll: true }); },
  });

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
  const onVisible = () => { if (document.visibilityState === 'visible') check(); };
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'pco') load(true); }, 300));

  load();
  return {
    unmount() {
      alive = false;
      if (nav.live) { nav.live = false; saveNav(); } // left the page: Live doesn't come back on its own
      live.destroy();
      clearTimeout(checkTimer);
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
    const campusRank = new Map(ctx.campuses.map((cp, i) => [cp.id, i]));
    const rankOf = (p) => campusRank.get(typeById.get(p.service_type_id)?.campus_id) ?? 99;
    const start = (p) => {
      const svc = (p.times || []).filter((x) => x.kind === 'service' && x.starts_at).map((x) => Date.parse(x.starts_at)).sort((a, b) => a - b)[0];
      return svc ?? Date.parse(p.sort_date);
    };
    const plans = d.plans.filter((p) => typeById.has(p.service_type_id))
      .map((p) => ({ ...p, _start: start(p), _day: c.day(p.sort_date) }))
      .sort((a, b) => a._start - b._start || rankOf(a) - rankOf(b));
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
    if (nav.plan !== planId) nav.pane = 'flow';
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

  // Live (js/live.js) for the open event; it stays open through a reload into a new version.
  function openLive() {
    const m = model();
    const p = m && nav.plan ? m.plans.find((x) => x.id === nav.plan) : null;
    if (!p) return;
    nav.live = true;
    saveNav();
    live.open({ id: p.id, title: p.title || m.type(p).name, day: p._day });
  }

  function closeLive() {
    if (live.isOpen()) live.close(); else if (nav.live) { nav.live = false; saveNav(); }
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
        ${liveButtonHtml()}
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

// A note's team, by its Planning Center category, so cues read in their section's color.
function noteDep(category) {
  const c = String(category || '').toLowerCase();
  const dep = /light/.test(c) ? 'lighting' : /audio|sound|foh|mix/.test(c) ? 'audio' : /video|media|cg|camera|graphic|propresenter|lyric|broadcast/.test(c) ? 'video' : null;
  return dep ? `data-dep="${dep}"` : '';
}
