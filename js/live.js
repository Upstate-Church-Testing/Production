// Live: a production view of Planning Center Live for one plan that fills the app's window
// (never the browser's own full screen), on its own layer
// over the whole app (on <body>, not inside the page, so nothing can clip it). Used by Events
// (an event's Live button) and PCO › Services (any service's Live button): createLive(ctx, …)
// gives a view its own Live, opened with live.open({ id, title, day }).
//
// It shows:
//   Before the service: what's on now (Doors Open), a countdown to the next thing on the
//     schedule, what that is, and the first item up with its notes.
//   During: the item that's up, its time left in big numbers (amber near the end, red and
//     counting up once over), what's next and after that, and the service clock.
//   Pre-service items (Planning Center's "Pre-service": Online Welcome Host, Campus
//     Countdown Video) lead up to the service time, the way Planning Center times them: with
//     2:15 of them and the service at 11:30, the first is due at 11:27:45. Post-service items
//     follow the end. The service's length (Planned) and when it's on pace to end count the
//     service itself, like Planning Center.
//   Next to each name, what that person is on for this plan (Amy Bray · VOX 4), from
//     event_item_gear: entered per plan on purpose, not read from Planning Center notes.
//     It opens the gear (the mic, an IEM pack) only when that's logged in Gear.
// When someone hits Next in Planning Center Live, this follows within a couple of seconds
// (pco-live reads Live for every screen at once). The screen stays awake while it's open.
// Admins can drive Live from here: Take control, then Back and Next, as the Planning
// Center account Tally is connected with (it shows as that person in Planning Center Live).
// Staff and up (pco-live checks).

import { esc, icon, $ } from './util.js';
import { clock } from './pco.js';
import { buildIndex, openDeviceSheet } from './views/devices.js';

const POLL_MS = 1500;          // ask this often while it's open
const SLOW_POLL_MS = 15000;    // …when the plan isn't today
const GEAR_EVERY_MS = 30000;   // who's on which mic, read again this often

/**
 * opts.tz(): the time zone (Planning Center's). opts.onClose(): after Live closes (the view
 * forgets it was open, puts focus back).
 */
export function createLive(ctx, opts = {}) {
  let alive = true;
  const isAdmin = ctx.me.role === 'admin';
  const tz = () => opts.tz?.() || 'America/New_York';
  let plan = null;           // { id, title, day } while open
  const s = {
    live: null,         // the last Live answer for the plan
    liveFor: null,      // which plan that answer is for
    liveError: null,
    offset: 0,          // server clock minus this device's
    sig: '',            // what the layer was last drawn from
    busy: null,         // a Take control / Next / Back on its way to Planning Center
    ctlError: null,     // why the last one didn't go through (shown in the Live view itself)
    mics: null,         // { plan, map: item id -> { label, device_ids }, at }: what each person is on
  };
  let gearData = null;  // Gear (items, models, rooms), read the first time a mic is opened
  let pollTimer = null;
  let tickTimer = null;
  let wake = null;
  let wallFmt = null;
  let layer = null;          // the layer, on <body> while open
  // The server's clock, steadily: of the last 20 answers, the one with the quickest round trip
  // sets the offset (a slow one's half-way guess is the least sure), and the time shown never
  // steps backwards (a correction waits instead of jumping the countdown back).
  const clockSamples = [];
  let lastNow = 0;
  const noteClock = (serverNow, asked, got) => {
    const at = Date.parse(serverNow);
    if (!Number.isFinite(at)) return;
    clockSamples.push({ rtt: got - asked, off: at - (asked + got) / 2 });
    if (clockSamples.length > 20) clockSamples.shift();
    s.offset = clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
  };
  const now = () => { lastNow = Math.max(lastNow, Date.now() + s.offset); return lastNow; };
  const cl = () => clock(tz());
  const wall = () => {
    if (!wallFmt) {
      const o = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
      try { wallFmt = new Intl.DateTimeFormat('en-US', { ...o, timeZone: tz() }); } catch { wallFmt = new Intl.DateTimeFormat('en-US', o); }
    }
    return wallFmt;
  };
  /** 11:30 AM, or 11:27:45 AM when it isn't on the minute (a pre-service lead-in). */
  const hms = (ms) => (Math.floor(ms / 1000) % 60 ? wall().format(ms) : cl().time(ms));

  const onKey = (e) => { if (e.key === 'Escape' && layer) close(); };
  document.addEventListener('keydown', onKey);
  const onVisible = () => { if (document.visibilityState === 'visible' && layer) { poll(); keepAwake(true); } };
  document.addEventListener('visibilitychange', onVisible);

  return {
    open,
    close,
    isOpen: () => !!layer,
    planId: () => plan?.id || null,
    destroy() {
      if (layer) close(true);
      alive = false;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };

  /** Open Live for a plan ({ id, title, day: '2026-11-08' }), or bring it up to date. */
  function open(p) {
    if (!alive || !p?.id) return;
    if (s.liveFor !== p.id) { s.live = null; s.liveFor = p.id; s.liveError = null; s.sig = ''; s.ctlError = null; }
    plan = { ...p };
    if (!layer) {
      s.sig = ''; // a new, empty layer: draw it even if nothing changed since it was last open
      layer = document.createElement('div');
      layer.className = 'lvx-root';
      layer.setAttribute('role', 'dialog');
      layer.setAttribute('aria-modal', 'true');
      layer.setAttribute('aria-label', `Live: ${plan.title || 'service'}`);
      layer.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act], [data-gear]');
        if (!b) return;
        if (b.dataset.gear) { openGear(b.dataset.gear); return; }
        if (b.dataset.act === 'close') close();
        else if (['take', 'release', 'next', 'previous'].includes(b.dataset.act)) drive(b.dataset.act);
      });
      document.body.appendChild(layer);
      document.documentElement.classList.add('lv-full-on');
      window.addEventListener('resize', fitTitle);
      document.fonts?.ready?.then(() => fitTitle()).catch(() => {});
      // (It fills the app's own window and nothing more: never the browser's full screen.)
      paint();
      $('[data-act="close"]', layer)?.focus({ preventScroll: true });
    } else {
      paint();
    }
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 250);
    tick();
    if (!pollTimer) poll();
    keepAwake(true);
  }

  /** quiet: the view is going away (no onClose, no update). */
  function close(quiet = false) {
    const was = !!layer;
    clearTimeout(pollTimer); pollTimer = null;
    clearInterval(tickTimer); tickTimer = null;
    keepAwake(false);
    if (layer) { layer.remove(); layer = null; s.sig = ''; window.removeEventListener('resize', fitTitle); }
    document.documentElement.classList.remove('lv-full-on');
    plan = null;
    if (quiet || !was) return;
    opts.onClose?.();
    ctx.updateNow?.(); // leaving Live: a good moment for a waiting new version
  }

  async function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    const p = plan;
    if (!alive || !layer || !p) return;
    if (document.visibilityState === 'hidden') return; // onVisible starts it again
    if (!s.mics || s.mics.plan !== p.id || Date.now() - s.mics.at > GEAR_EVERY_MS) loadMics(p.id);
    const asked = Date.now();
    try {
      const st = await ctx.store.pcoLive(p.id);
      if (!alive || plan?.id !== p.id) return;
      const got = Date.now();
      // The server's clock, so every screen counts the same second (half the round trip back).
      if (st?.now) noteClock(st.now, asked, got);
      s.live = st; s.liveFor = p.id; s.liveError = null;
    } catch (e) {
      s.liveError = e.message;
    }
    if (!alive || !layer || plan?.id !== p.id) return;
    paint();
    // A new version waiting: take it now (Live comes straight back), unless a Next is on its way.
    if (!s.busy && ctx.updateNow?.()) return;
    pollTimer = setTimeout(poll, p.day === cl().day(Date.now()) ? POLL_MS : SLOW_POLL_MS);
  }

  /** What each person in this plan is on (VOX 4), and its gear when logged. */
  async function loadMics(planId) {
    const at = Date.now();
    if (s.mics?.plan === planId) s.mics.at = at; // don't ask twice while this one's out
    try {
      const rows = (await ctx.store.eventGear?.(planId)) || [];
      if (!alive || plan?.id !== planId) return;
      const map = new Map(rows.map((r) => [String(r.item_id), { label: r.label, device_ids: r.device_ids || [] }]));
      const changed = JSON.stringify([...map]) !== JSON.stringify([...(s.mics?.plan === planId ? s.mics.map : [])]);
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
    const p = plan;
    if (!isAdmin || !p || s.busy) return;
    s.busy = action;
    s.ctlError = null;
    paint();
    const asked = Date.now();
    try {
      const st = await ctx.store.pcoLive(p.id, action);
      if (!alive || plan?.id !== p.id) return;
      if (st?.now) noteClock(st.now, asked, Date.now());
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
    // What the screen shows, not when Planning Center was last read: the items are read again
    // every 20 seconds, and drawing it all again for nothing made the bar start over from zero.
    const it = (r) => (r ? [r.it.id, r.it.title, r.it.length, r.t?.start].join('~') : '');
    return [plan?.id, plan?.title, s.live?.current_id, s.live?.current?.start, s.live?.controller, s.live?.controller_id, s.live?.me_id,
      !!s.liveError, !!s.live, s.live?.available, s.busy, s.ctlError, s.mics?.v, w?.state, w?.block?.id, w?.nextBlock?.id,
      w ? [it(w.item?.r), it(w.next), it(w.then), it(w.upFirst), it(w.run?.[1]), w.planned, w.pre, w.post, w.plannedStart, w.first, w.svcBegan, w.svcEnded, w.lastEnd].join('|') : ''].join('|');
  }

  /** Redraw the layer when what it shows changed (the numbers tick on their own). */
  function paint() {
    if (!layer || !plan) return;
    const w = s.live && s.live.available !== false && s.liveFor === plan.id ? where(s.live, now()) : null;
    const sig = sigOf(w);
    if (sig === s.sig) { tick(); return; }
    s.sig = sig;
    layer.innerHTML = liveHtml(w);
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
    const sum = (list) => list.reduce((n, r) => n + len(r), 0);
    // Planning Center's sections: pre-service items lead up to the service time, the service
    // runs from it, post-service items follow its end.
    const pos = (r) => (r.it.position === 'pre' || r.it.position === 'post' ? r.it.position : 'during');
    const pre = sum(run.filter((r) => pos(r) === 'pre'));
    const post = sum(run.filter((r) => pos(r) === 'post'));
    const planned = sum(run.filter((r) => pos(r) === 'during')); // the service's own length
    const plannedStart = pt?.starts_at ? Date.parse(pt.starts_at) : null;
    const firstDue = plannedStart != null ? plannedStart - pre : null; // when the first item is due
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
    // When the service actually began: the first service item's start (not the pre-service ones).
    const duringStarts = starts(run.filter((r, k) => pos(r) === 'during' && (state !== 'live' || k <= cur)));
    const svcBegan = duringStarts.length ? Math.min(...duringStarts) : null;
    // On pace to end: the service's end (the rest of pre-service, then the service), against the
    // service time plus its length. Once into post-service, the end of that.
    let projected = null;
    let target = null;
    if (state === 'live') {
      const after = run.slice(cur + 1);
      const base = plannedStart ?? svcBegan ?? first;
      if (pos(run[cur]) === 'post') {
        projected = t + Math.max(0, item.left) + sum(after.filter((r) => pos(r) === 'post'));
        target = base + planned + post;
      } else {
        projected = t + Math.max(0, item.left) + sum(after.filter((r) => pos(r) !== 'post'));
        target = base + planned;
      }
    }
    const lastEnd = (pt?.live_ends_at ? Date.parse(pt.live_ends_at) : null)
      ?? run.map((r) => (r.t?.end ? Date.parse(r.t.end) : null)).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    const duringEnds = run.filter((r) => pos(r) === 'during' && r.t?.end).map((r) => Date.parse(r.t.end));
    const svcEnded = duringEnds.length ? Math.max(...duringEnds) : lastEnd;
    // Before the service: the plan's schedule (Doors Open, then the service). What's on now
    // (the latest-starting block under way) and the next thing to start.
    const blocks = shownTimes(pts).map((x) => ({ ...x, s: Date.parse(x.starts_at), e: x.ends_at ? Date.parse(x.ends_at) : null }));
    const block = state === 'wait' ? blocks.filter((x) => x.kind !== 'service' && x.s <= t && (x.e == null || x.e > t)).sort((a, b) => b.s - a.s)[0] || null : null;
    const nextBlock = state === 'wait' ? blocks.find((x) => x.s > t) || null : null;
    return {
      pt, run, cur, item, state, planned, pre, post, plannedStart, firstDue, first, svcBegan, svcEnded, projected, target, lastEnd, block, nextBlock,
      pos,
      next: state === 'live' ? run[cur + 1] || null : null,
      then: state === 'live' ? run[cur + 2] || null : null,
      upFirst: state === 'wait' ? run[0] || null : null,
    };
  }

  function liveHtml(w) {
    const st = s.live;
    const c = cl();
    const title = plan.title || 'Service';
    // Close, then the plan's name in capitals sized to fill the rest of the row (fitTitle), so
    // it's plain which service this is at a glance. Nothing else up there.
    const top = () => `<header class="lvx-top">
        <button type="button" class="lvx-close" data-act="close" aria-label="Close Live">${icon('close')}</button>
        <h1 class="lvx-event"><span>${esc(title)}</span></h1>
      </header>`;
    if (!st || st.available === false || !w) {
      const msg = !st || s.liveFor !== plan.id ? (s.liveError ? `Couldn’t reach Planning Center Live: ${esc(s.liveError)}. Trying again.` : 'Reading Planning Center Live…')
        : `Planning Center Live isn’t available for this plan.${st.note ? ` ${esc(st.note)}` : ''}`;
      return `<div class="lvx">${top()}<p class="lvx-msg">${msg}</p></div>`;
    }
    const hhmm = (ms) => c.time(ms);
    const meta = (it) => [it.position === 'pre' ? 'Pre-service' : it.position === 'post' ? 'Post-service' : null,
      it.kind === 'song' ? 'Song' : it.kind === 'media' ? 'Media' : null, it.key_name ? `Key ${it.key_name}` : null,
      it.description && it.description.length <= 40 && !/\n/.test(it.description) ? it.description : null].filter(Boolean).join(' · ');
    const itemCard = (r, k, o = {}) => `<section class="lvx-card ${o.cls || ''}">
        <div class="lvx-k"><span>${esc(k)}</span>${o.right || ''}</div>
        <div class="lvx-who"><h2>${esc(r.it.title || 'Untitled')}</h2>${micHtml(r.it)}${o.len ? `<span class="lvx-t lvx-wholen">${esc(o.len)}</span>` : ''}</div>
        ${meta(r.it) ? `<p class="lvx-meta">${esc(meta(r.it))}</p>` : ''}
        ${o.clock || ''}
        ${o.after || ''}
      </section>`;
    let main = '';
    if (w.state === 'live') {
      const r = w.item.r;
      const len = (x) => dur(Math.max(0, x.it.length || 0) * 1000);
      // Now (its length is at the end of the bar), then the next two, each with its length at the bottom right.
      main = itemCard(r, 'Now', {
        cls: 'is-now',
        // The bar with how far in on its left and the item's length on its right, drawn where it
        // already is (so a redraw doesn't run it up from zero); tick() keeps it moving.
        clock: `<div class="lvx-clock ${w.item.left < 0 ? 'is-over' : w.item.left < 30000 ? 'is-close' : ''}" data-tick="big">${esc(w.item.left >= 0 ? dur(w.item.left) : `+${dur(-w.item.left)}`)}</div>
          <div class="lvx-barrow"><span class="lvx-t" data-tick="in">${esc(dur(w.item.elapsed))}</span><div class="lv-bar"><i data-tick="bar" class="${w.item.left < 0 ? 'is-over' : ''}" style="width:${Math.min(100, w.item.length ? (w.item.elapsed / w.item.length) * 100 : 100).toFixed(1)}%"></i></div><span class="lvx-t">${esc(dur(w.item.length))}</span></div>`,
      }) + `<div class="lvx-stack">${w.next
        ? itemCard(w.next, 'Next', { cls: 'is-next', len: len(w.next) }) + (w.then ? itemCard(w.then, 'Then', { cls: 'is-next is-then', len: len(w.then) }) : '')
        : '<section class="lvx-card is-next"><div class="lvx-k"><span>Next</span></div><h2>End of the service</h2></section>'}</div>`;
    } else if (w.state === 'wait') {
      const late = w.firstDue != null && now() >= w.firstDue;
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
        right: w.firstDue != null ? `<span class="lvx-len">${esc(hms(w.firstDue))}</span>` : '',
        len: dur(Math.max(0, w.upFirst.it.length || 0) * 1000),
        after: w.run[1] ? `<p class="lvx-then">Then <b>${esc(w.run[1].it.title || 'Untitled')}</b></p>` : '',
      }) : '';
      main = nowCard + `<div class="lvx-stack">${nextCard}${first}</div>`;
    } else {
      main = `<section class="lvx-card is-now">
          <div class="lvx-k"><span>Service</span></div>
          <h2>Over</h2>
          <div class="lvx-clock is-small">${(w.svcBegan ?? w.first) && w.svcEnded ? esc(dur(w.svcEnded - (w.svcBegan ?? w.first))) : '—'}</div>
          <p class="lvx-sub">${(w.svcBegan ?? w.first) ? `Started ${esc(hhmm(w.svcBegan ?? w.first))}` : ''}${w.svcEnded ? ` · ended ${esc(hhmm(w.svcEnded))}` : ''} · planned ${esc(dur(w.planned))}</p>
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

  /** The plan's name as big as the row allows on one line (two lines if it's very long),
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
          <p class="lvx-ctl-note">${st.controller ? `<b>${esc(st.controller)}</b> is driving in Planning Center Live. Taking control moves it here.` : 'Nobody is driving Planning Center Live. Take control to run it from here.'}</p>
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

  /** What this person is on for this plan (VOX 4): opens its gear when that's logged. */
  function micHtml(it) {
    const g = s.mics?.plan === plan?.id ? s.mics.map.get(String(it.id)) : null;
    if (!g?.label) return '';
    return g.device_ids?.length
      ? `<button type="button" class="lvx-mic is-link" data-gear="${esc(it.id)}">${esc(g.label)}</button>`
      : `<span class="lvx-mic">${esc(g.label)}</span>`;
  }

  /** Every quarter second: the numbers only. */
  function tick() {
    if (!layer || !plan) return;
    if (!s.live || s.live.available === false || s.liveFor !== plan.id) return;
    const c = cl();
    const t = now();
    const w = where(s.live, t);
    // The schedule moved on (Doors Open became Worship Center Doors Open, the service time passed): redraw.
    if (sigOf(w) !== s.sig) { paint(); return; }
    const set = (k, v, cls) => {
      const x = $(`[data-tick="${k}"]`, layer);
      if (!x) return;
      if (x.textContent !== v) x.textContent = v;
      if (cls !== undefined) {
        const cn = k !== 'big' ? cls : v.length > 6 ? `${cls} is-long` : cls;
        if (x.className !== cn) x.className = cn;
      }
    };
    set('wall', wall().format(t));
    if (w.state === 'live') {
      const left = w.item.left;
      set('big', left >= 0 ? dur(left) : `+${dur(-left)}`, `lvx-clock ${left < 0 ? 'is-over' : left < 30000 ? 'is-close' : ''}`);
      const bar = $('[data-tick="bar"]', layer);
      if (bar) { bar.style.width = `${Math.min(100, w.item.length ? (w.item.elapsed / w.item.length) * 100 : 100).toFixed(1)}%`; bar.classList.toggle('is-over', left < 0); }
      set('in', dur(w.item.elapsed));
      // The service clock: from when the service began; in pre-service, counting down to it.
      if (w.svcBegan != null) set('svc', dur(t - w.svcBegan));
      else if (w.plannedStart != null) set('svc', t < w.plannedStart ? `−${dur(w.plannedStart - t)}` : '0:00');
      if (w.projected != null) {
        set('proj', c.time(w.projected));
        const d = w.projected - w.target;
        set('delta', Math.abs(d) < 30000 ? 'on time' : `${d > 0 ? '+' : '−'}${dur(Math.abs(d))} ${d > 0 ? 'long' : 'short'}`, Math.abs(d) < 30000 ? 'is-ok' : d > 0 ? 'is-over' : 'is-under');
      }
    } else if (w.state === 'wait') {
      // Counting down to the next thing on the schedule before then (Doors Open), else to the
      // first item: the first pre-service one, due before the service time.
      const due = w.firstDue;
      const block = w.nextBlock && w.nextBlock.kind !== 'service' && (due == null || w.nextBlock.s < due) ? w.nextBlock : null;
      const target = block ? block.s : due;
      const leadIn = w.pre > 0 && w.upFirst;
      if (target != null && target > t) {
        set('big', dur(target - t), 'lvx-clock is-wait');
        set('sub', block ? `Until ${timeName(block)} · ${c.time(target)}`
          : leadIn ? `Until ${w.upFirst.it.title || 'the first item'} · ${hms(target)} · service at ${c.time(w.plannedStart)}`
            : `Until the service · ${c.time(target)}`);
      } else {
        set('big', due != null ? `+${dur(t - due)}` : '—', 'lvx-clock is-over');
        set('sub', due == null ? 'Starts when someone starts Planning Center Live'
          : leadIn ? `${w.upFirst.it.title || 'The first item'} was due at ${hms(due)} (service at ${c.time(w.plannedStart)}) · starts when someone starts Planning Center Live`
            : `Past the service time (${c.time(w.plannedStart)}) · starts when someone starts Planning Center Live`);
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
}

/** The Live button for a plan's page. */
export function liveButtonHtml() {
  return `<button type="button" class="ev-live-btn" data-act="live">
      <i class="ev-livedot" aria-hidden="true"></i>
      <span><b>Live</b><small>Where the service is, from Planning Center Live</small></span>
      ${icon('expand')}
    </button>`;
}

/** A plan's times once each: Planning Center lists the service twice on some plans (the
 *  service, and an "other" time named Service at the same start). */
export function shownTimes(times) {
  const svcStarts = new Set(times.filter((x) => x.kind === 'service').map((x) => x.starts_at));
  return times.filter((x) => x.starts_at && !(x.kind !== 'service' && /^service$/i.test(x.name || '') && svcStarts.has(x.starts_at)))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}

export const timeName = (x) => x.name || (x.kind === 'service' ? 'Service' : x.kind === 'rehearsal' ? 'Rehearsal' : 'Other');

/** 75000 → "1:15", 3725000 → "1:02:05". */
export function dur(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
