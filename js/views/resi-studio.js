// Resi › Studio: Resi Studio's schedule, kept in Tally so it can be read without opening Studio,
// side by side with Planning Center's clock for every location. Resi's API can't list or change
// scheduled events (only start or stop one right now), so the team types each event in here from
// Studio, with the same fields as Studio's event form. Planning Center comes from Tally's own copy
// of it (pco_plans: each plan's times, its services and rehearsals).
//
// The board: one day at a time, a row per location (all ten, A to Z; an encoder that isn't at a
// location gets a row of its own). In each row, Planning Center's rehearsals (thin, dashed) and
// services (clear, outlined, with dotted lines down from their start and end), then Resi: the
// pre-buffer (the encoder on early) hatched, then the event, lighter where it runs outside
// Planning Center's time. Each Resi run is checked against Planning Center: under the board are
// the services Resi doesn't cover, Resi runs that start after or stop before the service (or
// rehearsal) they're for, Resi runs with nothing in Planning Center then, and two events on one
// encoder that run into each other. ‹ › go to the previous and next day with something on it.
// Every event: under each encoder, what it is, how it repeats and ends, the pre-buffer, when the
// encoder comes on, the start, the duration and the end, and how its next run lines up with
// Planning Center. Tap one to change it. Encoders: as named in Studio › Settings › Encoders, each
// at its location. Staff and up.

import { esc, icon, $, $$, debounce, timeAgo, pageTitle } from '../util.js';
import { hudConfirm, hudPanel } from '../hud.js';
import * as R from '../resi-sched.js';

const PRE_CHIPS = [0, 5, 10, 15, 30, 60];
const UNITS = [['hour', 'Hours'], ['day', 'Days'], ['week', 'Weeks'], ['month', 'Months']];
const MAX_RUN = 720; // Resi: an encoder can't run more than 12 hours straight
/** A phone shows a location's code, as Scheduling does. */
const SHORT = { AND: 'AN', MAU: 'MLN' };
const both = (full, short) => (short && short !== full ? `<span class="lf">${esc(full)}</span><span class="ls">${esc(short)}</span>` : esc(full));
/** The board's lanes, in px: a rehearsal, a service, a Resi event; the gap between lanes and
 *  the row's padding. */
const LANE = { reh: 16, svc: 24, resi: 32, gap: 3, pad: 7, sep: 5 };
const PCO_BACK_DAYS = 21; // Planning Center plans this far back are on the board too
/** Planning Center service types left off the board for now: Simpsonville's Traditional. */
const LEFT_OUT = /^traditional$/i;

/** The Planning Center times the Resi run [start, end] is for: the services it really overlaps
 *  (at least half the service, or half the run: not one it just clips the end of), or if none,
 *  the rehearsals it does. lead: minutes Resi starts before them (negative: after); tail:
 *  minutes it runs past their end (negative: stops before). null when nothing lines up. */
export function matchRun(run, services, rehearsals) {
  const over = (list) => list.filter((y) => {
    const o = Math.min(run.end, y.end) - Math.max(run.start, y.start);
    return o > 0 && (o >= (y.end - y.start) / 2 || o >= (run.end - run.start) / 2);
  });
  const sv = over(services);
  const items = sv.length ? sv : over(rehearsals);
  if (!items.length) return null;
  const first = Math.min(...items.map((y) => y.start));
  const last = Math.max(...items.map((y) => y.end));
  return { kind: sv.length ? 'service' : 'rehearsal', items, first, last, lead: first - run.start, tail: run.end - last, noEnd: items.some((y) => y.noEnd) };
}

/** "Vintage and Modern", each name once. */
const names = (items) => [...new Set(items.map((y) => y.name))].join(' and ');

/** Lanes for overlapping bars: each item gets .lane; returns how many lanes. */
function pack(items, a = (x) => x.start, b = (x) => x.end) {
  const ends = [];
  for (const it of [...items].sort((x, y) => a(x) - a(y) || b(y) - b(x))) {
    let lane = ends.findIndex((e) => e <= a(it));
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = b(it);
    it.lane = lane;
  }
  return ends.length;
}

const ago = (n) => `${n} min`;

export function mount(el, ctx) {
  let alive = true;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canEdit = ctx.roleAtLeast(ctx.me.role, 'staff');
  const s = { data: null, pco: null, pcoError: null, date: null, moving: false, flash: null };

  el.innerHTML = `<div class="rs">
      <div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}
        ${canEdit ? `<div class="rs-acts">
          <button type="button" class="rs-btn" data-act="encoders" aria-label="Encoders">${icon('settings')}<span>Encoders</span></button>
          <button type="button" class="rs-btn is-main" data-act="add" aria-label="Add an event">${icon('plus')}<span>Event</span></button></div>` : ''}
        </div>
        <p class="rs-note">Resi is copied over from Resi Studio by hand (Resi’s API can’t read scheduled events), so change it here when you change it in Studio. Services and rehearsals come from Planning Center.</p>
      </div>
      <div class="results rs-body" id="rs-body"><div class="loading"><div class="sk tall"></div></div></div>
    </div>`;
  const body = $('#rs-body', el);

  el.addEventListener('click', onClick);
  el.addEventListener('keydown', (e) => { // a row in Every event opens like a button
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('tr[data-ev]')) { e.preventDefault(); e.target.click(); }
  });
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'resi_studio' || table === 'pco') load(); }, 300));
  load(true);
  return { unmount() { alive = false; unsubscribe(); } };

  // ------------------------------------------------------------------ data ---
  async function load(first = false) {
    const from = new Date(Date.now() - PCO_BACK_DAYS * 864e5).toISOString();
    const [resi, pco] = await Promise.allSettled([ctx.store.resiStudio(), ctx.store.resiPco ? ctx.store.resiPco(from) : Promise.resolve(null)]);
    if (!alive) return;
    if (resi.status === 'rejected') {
      if (!s.data) body.innerHTML = `<div class="empty"><h3>Couldn’t load the schedule</h3><p>${esc(resi.reason?.message || '')}</p></div>`;
      return;
    }
    s.data = resi.value;
    if (pco.status === 'fulfilled' && pco.value) { s.pco = indexPco(pco.value); s.pcoError = null; }
    else if (pco.status === 'rejected') s.pcoError = pco.reason?.message || 'Couldn’t load Planning Center.';
    if (!s.date) s.date = startDate();
    draw(first);
  }

  /** Planning Center by day and location: { byDate: Map(date -> Map(campus -> { services,
   *  rehearsals })), dates }. Every location's shared services (not hidden ones, not one-off
   *  events, not Traditional for now). Times are Eastern. A time on two plans that day
   *  (Vintage and Modern share the line check) shows once. A placeholder time ("PLEASE IGNORE
   *  DATE") is left out. */
  function indexPco({ types, plans }) {
    const keep = new Map((types || []).filter((t) => t.campus_id && t.access !== 'hidden' && !t.is_event && !LEFT_OUT.test(t.name)).map((t) => [t.id, t]));
    const byDate = new Map();
    for (const p of plans || []) {
      const t = keep.get(p.service_type_id);
      if (!t) continue;
      const room = /\[([^\]]+)\]/.exec(t.name)?.[1] || null;
      const label = (p.title || t.name.split(' - ').slice(1).join(' - ') || t.name).replace(/\s*\[[^\]]+\]/, '').trim() || t.name;
      for (const x of p.times || []) {
        if (!x?.starts_at || (x.kind !== 'service' && x.kind !== 'rehearsal')) continue;
        if (/\bignore\b/i.test(x.name || '')) continue;
        const a = R.eastern(x.starts_at);
        let end;
        let noEnd = false;
        if (x.ends_at) { const b = R.eastern(x.ends_at); end = b.date === a.date ? b.min : 1440; } else { noEnd = true; end = a.min + 60; }
        if (end <= a.min) end = a.min + 1;
        if (!byDate.has(a.date)) byDate.set(a.date, new Map());
        const day = byDate.get(a.date);
        if (!day.has(t.campus_id)) day.set(t.campus_id, { services: [], rehearsals: [] });
        const at = day.get(t.campus_id);
        const name = x.kind === 'service' ? label : (x.name || 'Rehearsal');
        const list = x.kind === 'service' ? at.services : at.rehearsals;
        const same = list.find((y) => y.start === a.min && y.end === end && y.name === name);
        if (same) { if (!same.plans.includes(label)) same.plans.push(label); continue; }
        list.push({ kind: x.kind, start: a.min, end, noEnd, name, plans: [label], room, url: p.url && /^https?:/.test(p.url) ? p.url : null });
      }
    }
    for (const day of byDate.values()) for (const at of day.values()) { at.services.sort((a, b) => a.start - b.start); at.rehearsals.sort((a, b) => a.start - b.start); }
    return { byDate, dates: [...byDate.keys()].sort() };
  }
  function pcoAt(campusId, date) { return (campusId && s.pco?.byDate.get(date)?.get(campusId)) || { services: [], rehearsals: [] }; }

  function encoders() {
    return [...(s.data?.encoders || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }
  function schedules() { return s.data?.schedules || []; }
  function encoderOf(id) { return (s.data?.encoders || []).find((e) => e.id === id); }
  function campusOf(enc) { return enc?.campus_id ? ctx.campusById.get(enc.campus_id) : null; }

  /** The previous or next day (dir -1 or 1) with a Resi run or anything in Planning Center. */
  function nextAny(from, dir) {
    const a = R.nextDate(schedules(), from, dir);
    const dates = s.pco?.dates || [];
    const b = dir > 0 ? dates.find((d) => d > from) : [...dates].reverse().find((d) => d < from);
    if (!a || !b) return a || b || null;
    return dir > 0 ? (a < b ? a : b) : (a > b ? a : b);
  }

  /** Today, if anything still runs today; otherwise the next day something does. */
  function startDate() {
    const t = R.today();
    const now = new Date().getHours() * 60 + new Date().getMinutes();
    const resiLater = schedules().some((ev) => !ev.paused && runs(ev, t).some((r) => r.end > now));
    const pcoLater = [...(s.pco?.byDate.get(t)?.values() || [])].some((at) => [...at.services, ...at.rehearsals].some((x) => x.end > now));
    if (resiLater || pcoLater) return t;
    return nextAny(t, 1) || t;
  }

  /** An event's runs on a date, moved onto Eastern time when it's set in another zone. */
  function runs(ev, date) {
    const shift = R.zoneShift(ev.timezone, date);
    return R.runsOn(ev, date).map((r) => ({ ...r, on: r.on + shift, start: r.start + shift, end: r.end + shift }));
  }

  /** Every row of the board for a date, with what's on it and what doesn't line up. */
  function dayRows(date) {
    const encs = encoders();
    const rows = ctx.campuses.map((campus) => ({ campus, encs: encs.filter((e) => e.campus_id === campus.id) }));
    for (const e of encs.filter((x) => !x.campus_id || !ctx.campusById.get(x.campus_id))) rows.push({ campus: null, encs: [e] });
    return rows.map((row) => {
      const where = row.campus?.short_name || row.encs[0]?.name || '';
      const pco = row.campus ? pcoAt(row.campus.id, date) : { services: [], rehearsals: [] };
      const services = pco.services.map((x) => ({ ...x }));
      const rehearsals = pco.rehearsals.map((x) => ({ ...x }));
      const resi = row.encs.flatMap((enc) => schedules().filter((ev) => ev.encoder_id === enc.id)
        .flatMap((ev) => runs(ev, date).map((r) => ({ ev, enc, r })))).sort((a, b) => a.r.on - b.r.on);
      const issues = [];
      // two on one encoder that run into each other (pre-buffer included); paused ones don't run
      for (const enc of row.encs) {
        const live = resi.filter((x) => x.enc.id === enc.id && !x.ev.paused);
        for (let i = 1; i < live.length; i += 1) {
          if (live[i].r.on < live[i - 1].r.end) {
            live[i].clash = true; live[i - 1].clash = true;
            issues.push({ bad: true, text: `${live[i - 1].ev.name} and ${live[i].ev.name} run into each other on the ${enc.name} encoder (pre-buffer included). Studio won’t run both, so one of them is copied over wrong.` });
          }
        }
      }
      if (row.campus) {
        for (const x of resi) {
          x.match = matchRun(x.r, services, rehearsals);
          if (x.ev.paused) continue;
          const m = x.match;
          const span = `${R.clock(x.r.start)}–${R.clock(x.r.end)}`;
          if (!m) { issues.push({ bad: false, text: `${x.ev.name} (${span}): nothing in Planning Center at ${where} lines up with it.` }); continue; }
          const svc = m.kind === 'service';
          const many = new Set(m.items.map((y) => y.name)).size > 1;
          const begins = svc ? `the ${R.clock(m.first)} ${names(m.items)} service starts` : `${names(m.items)} ${many ? 'start' : 'starts'} (${R.clock(m.first)})`;
          const finishes = svc ? `the ${names(m.items)} service ends (${R.clock(m.last)})` : `${names(m.items)} ${many ? 'end' : 'ends'} (${R.clock(m.last)})`;
          if (m.lead < 0) { x.late = true; issues.push({ bad: svc, text: `${x.ev.name} starts at ${R.clock(x.r.start)}, ${ago(-m.lead)} after ${begins}.` }); }
          if (m.tail < 0 && !m.noEnd) { x.early = true; issues.push({ bad: svc, text: `${x.ev.name} stops at ${R.clock(x.r.end)}, ${ago(-m.tail)} before ${finishes}.` }); }
        }
        if (row.encs.some((e) => e.installed !== false)) {
          for (const sv of services) {
            const mine = resi.filter((x) => x.match?.items.includes(sv));
            if (mine.some((x) => !x.ev.paused)) continue;
            sv.missing = true;
            issues.push({ bad: true, text: mine.length ? `The ${R.clock(sv.start)} ${sv.name} service’s Resi event (${mine[0].ev.name}) is paused in Studio.` : `No Resi event for the ${R.clock(sv.start)} ${sv.name} service (${R.clock(sv.start)}–${sv.noEnd ? '?' : R.clock(sv.end)}).` });
          }
        }
      }
      return { ...row, where, services, rehearsals, resi, issues };
    });
  }

  // ------------------------------------------------------------------ draw ---
  function draw(first = false) {
    if (!alive || !s.data) return;
    const encs = encoders();
    body.innerHTML = `<section class="rs-day" aria-label="The schedule, day by day">${boardHtml()}</section>
      <section class="rs-all" aria-labelledby="rs-all-h"><h2 class="rs-h" id="rs-all-h">Every Resi event</h2>${encs.length ? listHtml(encs) : `<div class="empty rs-empty"><h3>No encoders yet</h3><p>Add each encoder as it’s named in Resi Studio › Settings › Encoders.</p>
        ${canEdit ? `<button type="button" class="rs-btn is-main" data-act="encoders">${icon('plus')}<span>Add encoders</span></button>` : ''}</div>`}</section>`;
    const board = $('.rs-board', body);
    if (first && board && !still()) {
      board.classList.add('rs-boot');
      setTimeout(() => board.classList.remove('rs-boot'), (ctx.campuses.length + 2) * 45 + 1300);
    }
    if (s.flash) {
      for (const n of $$(`[data-ev="${CSS.escape(s.flash)}"]`, body)) { n.classList.add('is-flash'); setTimeout(() => n.classList.remove('is-flash'), 1200); }
      s.flash = null;
    }
  }

  function boardHtml() {
    const date = s.date;
    const t = R.today();
    const prev = nextAny(date, -1);
    const next = nextAny(date, 1);
    const rows = dayRows(date);
    const nSvc = rows.reduce((n, x) => n + x.services.length, 0);
    const nResi = rows.reduce((n, x) => n + x.resi.filter((y) => !y.ev.paused).length, 0);
    const nPaused = rows.reduce((n, x) => n + x.resi.filter((y) => y.ev.paused).length, 0);
    const issues = rows.flatMap((x) => x.issues.map((i) => ({ ...i, where: x.where })));
    const relative = date === t ? 'Today' : date === R.addDays(t, 1) ? 'Tomorrow' : date === R.addDays(t, -1) ? 'Yesterday' : '';
    const d = R.day(date);
    const count = [nSvc ? `${nSvc} service${nSvc === 1 ? '' : 's'}` : '', nResi ? `${nResi} Resi event${nResi === 1 ? '' : 's'}` : '', nPaused ? `${nPaused} paused` : ''].filter(Boolean).join(' · ') || 'Nothing scheduled';
    const head = `<div class="rs-bhead">
        <button type="button" class="rs-nav" data-go="prev" ${prev ? '' : 'disabled'} aria-label="${prev ? `Back to ${R.dateText(prev)}` : 'Nothing earlier'}">${icon('chevron')}</button>
        <h2 class="rs-date" aria-live="polite"><b>${esc(R.DAY3[d.getDay()])}</b><span>${esc(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</span>${relative ? `<em>${relative}</em>` : ''}</h2>
        <button type="button" class="rs-nav is-next" data-go="next" ${next ? '' : 'disabled'} aria-label="${next ? `On to ${R.dateText(next)}` : 'Nothing later'}">${icon('chevron')}</button>
        ${date !== t ? '<button type="button" class="rs-today" data-go="today">Today</button>' : ''}
        <p class="rs-count">${esc(count)}</p>
      </div>`;
    const items = rows.flatMap((x) => [...x.services, ...x.rehearsals, ...x.resi.map((y) => ({ start: y.r.on, end: y.r.end }))]);
    const pcoNote = s.pcoError ? `<p class="rs-warn">Planning Center didn’t load (${esc(s.pcoError)}), so only Resi is on the board.</p>` : '';
    if (!items.length) {
      return `${head}${pcoNote}<div class="rs-board is-empty"><p>Nothing in Planning Center or Resi on this day.</p></div>`;
    }
    // the hours shown: the first hour anything starts to the hour after the last thing ends
    let t0 = Math.floor(Math.min(...items.map((x) => x.start)) / 60) * 60;
    let t1 = Math.ceil(Math.max(...items.map((x) => x.end)) / 60) * 60;
    if (t1 - t0 < 240) { const pad = 240 - (t1 - t0); t0 -= Math.floor(pad / 120) * 60; t1 = t0 + 240; }
    t0 = Math.max(0, t0); t1 = Math.min(1440, Math.max(t1, t0 + 60));
    const span = t1 - t0;
    const step = span > 720 ? 120 : 60;
    const pct = (m) => `${(((Math.min(Math.max(m, t0), t1) - t0) / span) * 100).toFixed(3)}%`;
    const wid = (a, b) => `${((Math.max(0, Math.min(b, t1) - Math.max(a, t0)) / span) * 100).toFixed(3)}%`;
    const ticks = [];
    for (let m = t0; m <= t1; m += step) ticks.push(`<span class="rs-tick ${m === t0 ? 'is-first' : ''} ${m === t1 ? 'is-last' : ''}" style="left:${pct(m)}">${esc(R.clock(m).replace(':00', ''))}</span>`);
    const nowM = new Date().getHours() * 60 + new Date().getMinutes();
    const showNow = date === t && nowM >= t0 && nowM <= t1;

    const bodyRows = rows.map((row, ri) => {
      const nR = pack(row.rehearsals);
      const nS = pack(row.services);
      const nE = pack(row.resi, (x) => x.r.on, (x) => x.r.end);
      let y = LANE.pad;
      const yR = y; y += nR * (LANE.reh + LANE.gap) + (nR ? LANE.sep - LANE.gap : 0);
      const yS = y; y += nS * (LANE.svc + LANE.gap) + (nS ? LANE.sep - LANE.gap : 0);
      const yE = y; y += nE * (LANE.resi + LANE.gap) - (nE ? LANE.gap : 0);
      const h = Math.max(48, y + LANE.pad);
      const pcoBar = (x, kind, top, hgt) => {
        const tip = [`${x.name}${x.room ? ` (${x.room})` : ''}`, `${R.clock(x.start)}–${x.noEnd ? '?' : R.clock(x.end)}${x.noEnd ? ' (no end time in Planning Center)' : ''}`, x.plans.length > 1 || x.plans[0] !== x.name ? `On ${x.plans.join(', ')}` : '', 'Planning Center'].filter(Boolean).join('\n');
        const inner = kind === 'svc'
          ? `<b>${esc(R.clockShort(x.start, true))}</b><span>${esc(x.name)}${x.room ? ` · ${esc(x.room)}` : ''}</span>`
          : `<b>${esc(R.clockShort(x.start, true))}</b><span>${esc(x.name)}</span>`;
        const tag = x.url ? 'a' : 'span';
        const tiny = ((x.end - x.start) / span) * 100 < 2.6; // too short for its label: the label's in the tooltip
        return `<${tag} class="rs-p is-${kind} ${x.missing ? 'is-missing' : ''} ${x.noEnd ? 'is-open' : ''} ${tiny ? 'is-tiny' : ''}" ${x.url ? `href="${esc(x.url)}" target="_blank" rel="noopener"` : ''}
            style="left:${pct(x.start)};width:${wid(x.start, x.end)};top:${top + x.lane * (hgt + LANE.gap)}px;height:${hgt}px" title="${esc(tip)}" ${tiny ? `aria-label="${esc(tip)}"` : ''}>${tiny ? '' : inner}</${tag}>`;
      };
      const guides = row.services.map((x) => {
        const top = yS + x.lane * (LANE.svc + LANE.gap);
        return `<i class="rs-guide" style="left:${pct(x.start)};top:${top}px"></i>${x.noEnd ? '' : `<i class="rs-guide" style="left:${pct(x.end)};top:${top}px"></i>`}`;
      }).join('');
      const blocks = row.resi.map((x) => {
        const { ev, r, match: m } = x;
        const w = Math.max(1, r.end - r.on);
        const pre = Math.max(0, r.start - r.on);
        const len = Math.max(1, r.end - r.start);
        // inside the event, the stretch Planning Center has (solid); before and after it, lighter
        const a = m ? Math.min(100, Math.max(0, ((m.first - r.start) / len) * 100)) : 0;
        const b = m ? Math.min(100, Math.max(0, ((m.last - r.start) / len) * 100)) : 100;
        const off = m ? [m.lead > 0 ? `${m.lead} before` : m.lead < 0 ? `${-m.lead} late` : '', m.noEnd ? '' : m.tail > 0 ? `${m.tail} after` : m.tail < 0 ? `${-m.tail} short` : ''].filter(Boolean).join(' · ') : (row.campus ? 'not in PCO' : '');
        const tip = [ev.name, `${x.enc.name} encoder`, pre ? `Encoder on ${R.clock(r.on)} (${pre} min pre-buffer)` : '', `Starts ${R.clock(r.start)}`, `Ends ${R.clock(r.end)} (${R.dur(ev.duration_min)})`,
          m ? `Planning Center: ${m.items.map((y) => `${y.name} ${R.clock(y.start)}–${R.clock(y.end)}`).join(', ')}` : row.campus ? 'Nothing in Planning Center then' : '',
          m && m.lead ? `${m.lead > 0 ? `Starts ${m.lead} min before` : `Starts ${-m.lead} min after`} Planning Center` : '',
          m && m.tail && !m.noEnd ? `${m.tail > 0 ? `Runs ${m.tail} min past` : `Stops ${-m.tail} min before`} Planning Center's end` : '',
          ev.paused ? 'Paused in Studio' : '', x.clash ? 'Runs into another event on this encoder' : ''].filter(Boolean).join('\n');
        const bad = !ev.paused && m?.kind === 'service' && (x.late || x.early);
        return `<button type="button" class="rs-blk ${ev.paused ? 'is-paused' : ''} ${x.clash ? 'is-clash' : ''} ${bad ? 'is-off' : ''} ${m ? '' : 'is-alone'}" data-ev="${esc(ev.id)}" ${canEdit ? '' : 'disabled'}
            style="left:${pct(r.on)};width:${wid(r.on, r.end)};top:${yE + x.lane * (LANE.resi + LANE.gap)}px;height:${LANE.resi}px;--pre:${((pre / w) * 100).toFixed(3)}%;--a:${a.toFixed(2)}%;--b:${b.toFixed(2)}%" title="${esc(tip)}">
            ${pre ? '<i class="rs-buf" aria-hidden="true"></i>' : ''}
            <span class="rs-ev"><b>${esc(ev.name)}</b><small>${esc(`${R.clockShort(r.start, true)}–${R.clockShort(r.end, true)}`)}${off ? ` · <em>${esc(off)}</em>` : ''}${ev.paused ? ' · Paused' : ''}</small></span>
          </button>`;
      }).join('');
      const cp = row.campus;
      const sub = row.encs.length ? row.encs.map((e) => `${e.name}${e.installed === false ? ' (not installed)' : ''}`).join(', ') : 'No encoder';
      return `<div class="rs-row" style="--r:${ri};height:${h}px">
          <div class="rs-enc"><b>${cp ? both(cp.short_name, SHORT[cp.code] || cp.code) : esc(row.where)}</b><small>${row.encs.length ? `${icon('live')}${esc(sub)}` : esc(sub)}</small></div>
          <div class="rs-track">${guides}${row.rehearsals.map((x) => pcoBar(x, 'reh', yR, LANE.reh)).join('')}${row.services.map((x) => pcoBar(x, 'svc', yS, LANE.svc)).join('')}${blocks}
            ${!row.rehearsals.length && !row.services.length && !row.resi.length ? '<span class="rs-none">—</span>' : ''}${showNow ? `<i class="rs-now" style="left:${pct(nowM)}"></i>` : ''}</div>
        </div>`;
    }).join('');
    const bad = issues.filter((x) => x.bad);
    const notes = issues.filter((x) => !x.bad);
    const checked = rows.some((x) => x.encs.some((e) => e.installed !== false) && x.services.length);
    const diff = issues.length
      ? `<section class="rs-diff" aria-label="Where Resi and Planning Center differ"><h3>Resi and Planning Center <span>${bad.length ? `${bad.length} to fix` : ''}${bad.length && notes.length ? ' · ' : ''}${notes.length ? `${notes.length} to look at` : ''}</span></h3>
          <ul>${[...bad, ...notes].map((x) => `<li class="${x.bad ? 'is-bad' : ''}"><b>${esc(x.where)}</b><span>${esc(x.text)}</span></li>`).join('')}</ul></section>`
      : checked ? '<p class="rs-ok">Resi covers every service in Planning Center on this day, start to end.</p>' : '';
    return `${head}${pcoNote}
      <div class="rs-scroll"><div class="rs-board" style="--hrs:${span / 60}">
        <div class="rs-row rs-axis"><div class="rs-enc rs-corner">${both('Location', 'Loc')}</div><div class="rs-track">${ticks.join('')}${showNow ? `<span class="rs-nowl" style="left:${pct(nowM)}">Now</span>` : ''}</div></div>
        ${bodyRows}
      </div></div>
      <ul class="rs-legend" aria-label="Key">
        <li><i class="k-reh"></i>Rehearsal (Planning Center)</li><li><i class="k-svc"></i>Service (Planning Center)</li>
        <li><i class="k-buf"></i>Pre-buffer: the encoder on early</li><li><i class="k-ev"></i>Resi event<i class="k-ev is-soft"></i>outside Planning Center’s time</li></ul>
      ${diff}`;
  }

  function listHtml(encs) {
    const t = R.today();
    const order = (ev) => {
      const days = ev.repeats && (ev.repeat_unit || 'week') === 'week' ? (ev.repeat_days?.length ? Math.min(...ev.repeat_days) : ev.start_date ? R.weekday(ev.start_date) : 7) : ev.start_date ? R.weekday(ev.start_date) : 7;
      return days * 1440 + (R.mins(ev.start_time) || 0);
    };
    return encs.map((enc) => {
      const cp = campusOf(enc);
      const list = schedules().filter((ev) => ev.encoder_id === enc.id)
        .map((ev) => ({ ev, over: R.isOver(ev, t) }))
        .sort((a, b) => a.over - b.over || order(a.ev) - order(b.ev) || a.ev.name.localeCompare(b.ev.name));
      const rows = list.map(({ ev, over }) => {
        const start = R.mins(ev.start_time);
        const pre = Number(ev.prebuffer_min) || 0;
        const zone = ev.timezone && ev.timezone !== R.HOME_ZONE ? ` <em class="rs-tz">${esc(R.zoneShort(ev.timezone))}</em>` : '';
        const tags = [ev.paused ? '<em class="rs-tag is-paused">Paused</em>' : '', over ? '<em class="rs-tag">Ended</em>' : ''].join('');
        const by = [ev.who?.full_name || ev.updated_by_name, ev.updated_at ? timeAgo(ev.updated_at) : ''].filter(Boolean).join(', ');
        const vs = over ? null : vsPco(ev, cp);
        return `<tr class="rs-tr ${over ? 'is-over' : ''} ${ev.paused ? 'is-paused' : ''}" data-ev="${esc(ev.id)}" ${canEdit ? 'tabindex="0" role="button"' : ''} title="${esc(by ? `Last changed by ${by}` : '')}">
          <th scope="row" class="rs-c-ev"><b>${esc(ev.name)}</b>${tags}${vs ? `<small class="${vs.bad ? 'is-bad' : ''}">${esc(vs.text)}</small>` : ev.description ? `<small>${esc(ev.description)}</small>` : ''}</th>
          <td class="rs-c-rep" data-l="Repeats"><b>${esc(R.repeatText(ev))}</b><small>${esc(R.endText(ev))}</small></td>
          <td class="rs-c-n" data-l="Pre-buffer">${pre ? `${pre}<small> min</small>` : '<span class="rs-dim">None</span>'}</td>
          <td class="rs-c-n" data-l="Encoder on">${esc(R.clock(start - pre))}</td>
          <td class="rs-c-n is-key" data-l="Starts">${esc(R.clock(start))}${zone}</td>
          <td class="rs-c-n" data-l="Duration" title="${esc(R.durWords(ev.duration_min))}">${esc(R.dur(ev.duration_min))}</td>
          <td class="rs-c-n" data-l="Ends">${esc(R.clock(start + Number(ev.duration_min || 0)))}</td>
        </tr>`;
      }).join('');
      return `<div class="rs-grp">
          <div class="rs-ghead"><h3>${esc(enc.name)}</h3>${cp && cp.short_name !== enc.name ? `<span class="rs-loc">${esc(cp.short_name)}</span>` : ''}${enc.installed === false ? '<span class="rs-loc is-off">Not installed</span>' : ''}
            <span class="rs-gn">${list.length ? `${list.length} event${list.length === 1 ? '' : 's'}` : 'Nothing scheduled'}</span>
            ${canEdit ? `<button type="button" class="rs-add" data-add="${esc(enc.id)}" aria-label="Add an event on ${esc(enc.name)}">${icon('plus')}<span>Event</span></button>` : ''}</div>
          ${list.length ? `<table class="rs-t"><thead><tr><th scope="col">Event</th><th scope="col">Repeats</th><th scope="col">Pre-buffer</th><th scope="col">Encoder on</th><th scope="col">Starts</th><th scope="col">Duration</th><th scope="col">Ends</th></tr></thead>
            <tbody>${rows}</tbody></table>` : ''}
        </div>`;
    }).join('');
  }

  /** How an event's next run lines up with Planning Center at its encoder's location:
   *  { text, bad, match, date } or null when there's nothing to compare with. */
  function vsPco(ev, campus, fromDate = R.today()) {
    if (!campus || !s.pco) return null;
    const date = R.firstRun(ev, fromDate);
    if (!date) return null;
    const r = runs(ev, date)[0];
    const at = pcoAt(campus.id, date);
    if (!s.pco.byDate.has(date)) return { text: `${R.dateText(date)}: Planning Center has no plans that day yet`, bad: false, date };
    const m = matchRun(r, at.services, at.rehearsals);
    if (!m) return { text: `${R.dateText(date)}: nothing in Planning Center at ${campus.short_name} lines up with it`, bad: false, date };
    const what = m.kind === 'service' ? `${R.clock(m.first)} ${names(m.items)}` : names(m.items);
    const lead = m.lead > 0 ? `${m.lead} min before` : m.lead < 0 ? `${-m.lead} min late` : 'same start';
    const tail = m.noEnd ? '' : m.tail > 0 ? `${m.tail} min after` : m.tail < 0 ? `${-m.tail} min short` : 'same end';
    return { text: `${what} (${R.clock(m.first)}–${R.clock(m.last)}): ${[lead, tail].filter(Boolean).join(', ')}`, bad: m.kind === 'service' && (m.lead < 0 || (!m.noEnd && m.tail < 0)), match: m, date };
  }

  // --------------------------------------------------------------- actions ---
  function onClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') { openEvent(null); return; }
    if (act === 'encoders') { openEncoders(); return; }
    const add = e.target.closest('[data-add]');
    if (add) { openEvent(null, { encoderId: add.dataset.add }); return; }
    const go = e.target.closest('[data-go]');
    if (go && !go.disabled) { goDay(go.dataset.go); return; }
    const ev = e.target.closest('[data-ev]');
    if (ev && canEdit && !ev.disabled) openEvent(schedules().find((x) => x.id === ev.dataset.ev));
  }

  /** Another day on the board: what's there slides out, the other day's slides in. */
  function goDay(where) {
    if (s.moving) return;
    const to = where === 'today' ? R.today() : nextAny(s.date, where === 'prev' ? -1 : 1);
    if (!to || to === s.date) return;
    const dir = to > s.date ? 1 : -1;
    const sec = $('.rs-day', body);
    if (!sec || still()) { s.date = to; draw(); return; }
    s.moving = true;
    sec.classList.add(dir > 0 ? 'rs-out-l' : 'rs-out-r');
    setTimeout(() => {
      if (!alive) return;
      s.date = to;
      sec.innerHTML = boardHtml();
      sec.classList.remove('rs-out-l', 'rs-out-r');
      sec.classList.add(dir > 0 ? 'rs-in-l' : 'rs-in-r');
      void sec.offsetWidth;
      sec.classList.add('rs-go');
      setTimeout(() => { sec.classList.remove('rs-in-l', 'rs-in-r', 'rs-go'); s.moving = false; $(`.rs-nav${dir > 0 ? '.is-next' : ':not(.is-next)'}`, sec)?.focus({ preventScroll: true }); }, 380);
    }, 170);
  }

  // ------------------------------------------------------------ an event ---
  function formFrom(ev, encoderId, copy) {
    const sunday = R.addDays(R.today(), (7 - R.weekday(R.today())) % 7);
    if (!ev) {
      return {
        id: null, encoder_id: encoderId || encoders()[0]?.id || '', name: '', description: '', encoder_preset: '', encoder_channel: '',
        prebuffer_min: '0', start_date: sunday, start_time: '', dur_h: '', dur_m: '', timezone: R.HOME_ZONE,
        repeats: true, repeat_every: '1', repeat_unit: 'week', repeat_days: [R.weekday(sunday)], repeat_month: 'date',
        ends: 'never', ends_on: '', ends_after: '', destinations: '', paused: false, notes: '',
      };
    }
    const d = Number(ev.duration_min) || 0;
    return {
      id: copy ? null : ev.id, encoder_id: ev.encoder_id, name: copy ? `Copy of ${ev.name}` : ev.name, description: ev.description || '',
      encoder_preset: ev.encoder_preset || '', encoder_channel: ev.encoder_channel || '', prebuffer_min: String(ev.prebuffer_min ?? 0),
      start_date: ev.start_date ? String(ev.start_date).slice(0, 10) : '', start_time: R.hhmm(ev.start_time), dur_h: String(Math.floor(d / 60)), dur_m: String(d % 60),
      timezone: ev.timezone || R.HOME_ZONE, repeats: !!ev.repeats, repeat_every: String(ev.repeat_every || 1), repeat_unit: ev.repeat_unit || 'week',
      repeat_days: [...(ev.repeat_days || [])].map(Number), repeat_month: ev.repeat_month || 'date', ends: ev.ends || 'never',
      ends_on: ev.ends_on ? String(ev.ends_on).slice(0, 10) : '', ends_after: ev.ends_after ? String(ev.ends_after) : '',
      destinations: ev.destinations || '', paused: !!ev.paused, notes: ev.notes || '',
    };
  }

  /** The form as a row for the database, or { error }. */
  function toRow(f) {
    const int = (v) => (String(v).trim() === '' ? null : Math.round(Number(v)));
    const dur = (int(f.dur_h) || 0) * 60 + (int(f.dur_m) || 0);
    const pre = int(f.prebuffer_min) || 0;
    const days = [...new Set(f.repeat_days)].sort();
    const row = {
      encoder_id: f.encoder_id, name: f.name.trim(), description: f.description.trim() || null,
      encoder_preset: f.encoder_preset.trim() || null, encoder_channel: f.encoder_channel.trim() || null,
      prebuffer_min: pre, start_date: f.start_date || null, start_time: f.start_time || null, duration_min: dur, timezone: f.timezone,
      repeats: !!f.repeats, repeat_every: Math.max(1, int(f.repeat_every) || 1), repeat_unit: f.repeat_unit, repeat_days: f.repeat_unit === 'week' ? days : [],
      repeat_month: f.repeat_month, ends: f.repeats ? f.ends : 'never', ends_on: f.repeats && f.ends === 'on' ? f.ends_on || null : null,
      ends_after: f.repeats && f.ends === 'after' ? int(f.ends_after) : null,
      destinations: f.destinations.trim() || null, paused: !!f.paused, notes: f.notes.trim() || null,
    };
    if (f.id) row.id = f.id;
    const err = !row.name ? 'Give the event a name (as it is in Studio).'
      : !row.encoder_id ? 'Pick the encoder.'
        : !row.start_time ? 'Set the start time.'
          : !(dur > 0) ? 'Set how long it runs (the duration).'
            : dur > 1440 ? 'The duration can’t be more than 24 hours.'
              : pre < 0 || pre > MAX_RUN ? 'The pre-buffer is in minutes, 0 to 720.'
                : pre + dur > MAX_RUN ? 'An encoder can’t run more than 12 hours straight (pre-buffer and duration together).'
                  : !row.repeats && !row.start_date ? 'A one-time event needs its start date.'
                    : row.repeats && row.repeat_unit === 'week' && !days.length ? 'Pick the day it repeats on.'
                      : row.repeats && row.repeat_unit === 'month' && !row.start_date ? 'Repeating monthly needs a start date.'
                        : row.repeats && row.ends === 'on' && !row.ends_on ? 'Pick the date it ends.'
                          : row.repeats && row.ends === 'on' && row.start_date && row.ends_on < row.start_date ? 'It ends before it starts.'
                            : row.repeats && row.ends === 'after' && !(row.ends_after >= 1) ? 'How many times does it run?'
                              : null;
    return err ? { error: err } : { row };
  }

  function openEvent(ev, { encoderId, copy = false } = {}) {
    if (!canEdit) return;
    const f = formFrom(ev, encoderId, copy);
    const was = JSON.stringify(f);
    const isNew = !f.id;
    let saving = false;
    const panel = hudPanel({
      label: isNew ? 'New event' : f.name,
      className: 'rs-panel',
      beforeClose: async () => saving || JSON.stringify(f) === was || hudConfirm({ title: 'Leave without saving?', where: f.name || 'New event', yes: 'Leave', no: 'Keep editing', showChange: false, note: 'What you changed here won’t be kept.' }),
    });
    paint();
    $('[name="name"]', panel.el)?.focus({ preventScroll: true });

    panel.el.addEventListener('input', (e) => { take(e.target); summary(); });
    panel.el.addEventListener('change', (e) => {
      take(e.target);
      if (['repeat_unit', 'encoder_id'].includes(e.target.name) || (e.target.name === 'start_date' && f.repeat_unit === 'month')) paint(true);
      else { syncEnds(); summary(); }
    });
    panel.el.addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-pre]');
      if (chip) { f.prebuffer_min = chip.dataset.pre; $('[name="prebuffer_min"]', panel.el).value = f.prebuffer_min; markChips(); summary(); return; }
      const dayB = e.target.closest('[data-day]');
      if (dayB) {
        const n = Number(dayB.dataset.day);
        f.repeat_days = f.repeat_days.includes(n) ? f.repeat_days.filter((x) => x !== n) : [...f.repeat_days, n];
        dayB.setAttribute('aria-pressed', String(f.repeat_days.includes(n)));
        summary();
        return;
      }
      const sw = e.target.closest('[data-sw]');
      if (sw) {
        f[sw.dataset.sw] = !f[sw.dataset.sw];
        if (sw.dataset.sw === 'repeats') paint(true);
        else { sw.setAttribute('aria-checked', String(f[sw.dataset.sw])); summary(); }
        return;
      }
      if (e.target.closest('[data-save]')) { save(e.target.closest('[data-save]')); return; }
      if (e.target.closest('[data-dup]')) {
        if (JSON.stringify(f) !== was) { msg('Save your changes first, then duplicate it.'); return; }
        await panel.close(true);
        openEvent(ev, { copy: true });
        return;
      }
      if (e.target.closest('[data-del]')) {
        const enc = encoderOf(ev.encoder_id);
        const yes = await hudConfirm({ title: 'Remove this event?', where: `${enc?.name || 'Encoder'} · ${ev.name}`, yes: 'Remove', no: 'Cancel', showChange: false, danger: true,
          note: 'It comes off this app only. Studio keeps it until it’s removed there too.' });
        if (!yes) return;
        try { await ctx.store.resiScheduleRemove(ev.id); saving = true; ctx.toast(`Removed ${ev.name}`); panel.close(true); } catch (err) { msg(err.message); }
      }
    });

    function take(t) {
      if (!t?.name || !(t.name in f)) return;
      if (t.type === 'radio') { if (t.checked) f[t.name] = t.value; } else f[t.name] = t.value;
      if (t.name === 'name') { const h = $('.hp-head h2', panel.el); if (h) h.textContent = f.name.trim() || 'New event'; }
      if (t.name === 'prebuffer_min') markChips();
    }

    function paint(keep = false) {
      const encs = encoders();
      const enc = encoderOf(f.encoder_id);
      const v = (k) => esc(f[k] ?? '');
      const months = R.monthChoices(f.start_date);
      panel.render(`
        <header class="hp-head">
          <p class="hp-crumb">${esc(enc ? `${enc.name} encoder` : 'Resi Studio')} · ${isNew ? 'New event' : 'Scheduled event'}</p>
          <h2>${esc(f.name.trim() || 'New event')}</h2>
          <button type="button" class="hp-x" data-close aria-label="Close">${icon('close')}</button>
        </header>
        <div class="rs-sum" id="rs-sum" aria-live="polite"></div>
        <div class="hp-body rs-form">
          <fieldset class="rs-fs"><legend>Event details</legend>
            <label class="rs-f"><span>Event name</span><input name="name" maxlength="120" autocomplete="off" placeholder="8:15 AM Vintage" value="${v('name')}"></label>
            <label class="rs-f"><span>Description <i>optional</i></span><textarea name="description" rows="2" maxlength="1000" placeholder="Your team sees this in Studio; viewers don’t">${v('description')}</textarea></label>
          </fieldset>
          <fieldset class="rs-fs"><legend>Content source <i>Live encoder</i></legend>
            <label class="rs-f"><span>Encoder</span><select name="encoder_id">${encs.map((x) => `<option value="${esc(x.id)}" ${x.id === f.encoder_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
            <div class="rs-two">
              <label class="rs-f"><span>Encoder preset <i>optional</i></span><input name="encoder_preset" maxlength="120" autocomplete="off" value="${v('encoder_preset')}"></label>
              <label class="rs-f"><span>Encoder channel <i>optional</i></span><input name="encoder_channel" maxlength="120" autocomplete="off" value="${v('encoder_channel')}"></label>
            </div>
            <div class="rs-f"><span id="rs-pre-l">Pre-buffer <i>how early the encoder starts</i></span>
              <div class="rs-pre" role="group" aria-labelledby="rs-pre-l">
                ${PRE_CHIPS.map((n) => `<button type="button" class="rs-chip" data-pre="${n}" aria-pressed="false">${n ? `${n}` : 'None'}</button>`).join('')}
                <label class="rs-num"><input name="prebuffer_min" type="number" inputmode="numeric" min="0" max="720" step="1" value="${v('prebuffer_min')}" aria-label="Pre-buffer in minutes"><span>min</span></label>
              </div></div>
          </fieldset>
          <fieldset class="rs-fs"><legend>Schedule</legend>
            <div class="rs-three">
              <label class="rs-f"><span>Start date</span><input name="start_date" type="date" value="${v('start_date')}"></label>
              <label class="rs-f"><span>Start time</span><input name="start_time" type="time" value="${v('start_time')}"></label>
              <div class="rs-f"><span id="rs-dur-l">Duration</span><div class="rs-dur" role="group" aria-labelledby="rs-dur-l">
                <label class="rs-num"><input name="dur_h" type="number" inputmode="numeric" min="0" max="24" placeholder="1" value="${v('dur_h')}" aria-label="Hours"><span>h</span></label>
                <label class="rs-num"><input name="dur_m" type="number" inputmode="numeric" min="0" max="59" placeholder="10" value="${v('dur_m')}" aria-label="Minutes"><span>m</span></label>
              </div></div>
            </div>
            <label class="rs-f rs-zone"><span>Timezone</span><select name="timezone">${R.ZONES.map(([id, label]) => `<option value="${id}" ${id === f.timezone ? 'selected' : ''}>${label}</option>`).join('')}${R.ZONES.some(([id]) => id === f.timezone) ? '' : `<option value="${v('timezone')}" selected>${v('timezone')}</option>`}</select></label>
            <button type="button" class="rs-switch" role="switch" data-sw="repeats" aria-checked="${f.repeats}"><i aria-hidden="true"></i>Repeats</button>
            ${f.repeats ? `<div class="rs-rep">
              <div class="rs-f"><span id="rs-every-l">Every</span><div class="rs-every" role="group" aria-labelledby="rs-every-l">
                <input name="repeat_every" type="number" inputmode="numeric" min="1" max="999" value="${v('repeat_every')}" aria-label="How many">
                <select name="repeat_unit" aria-label="Hours, days, weeks or months">${UNITS.map(([id, label]) => `<option value="${id}" ${id === f.repeat_unit ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
              ${f.repeat_unit === 'week' ? `<div class="rs-f"><span id="rs-on-l">On</span><div class="rs-days" role="group" aria-labelledby="rs-on-l">
                ${R.DAY1.map((l, i) => `<button type="button" class="rs-day-b" data-day="${i}" aria-pressed="${f.repeat_days.includes(i)}" aria-label="${R.DAY[i]}">${l}</button>`).join('')}</div></div>` : ''}
              ${f.repeat_unit === 'month' ? `<div class="rs-f"><span>On</span><div class="rs-radios">
                <label class="rs-radio"><input type="radio" name="repeat_month" value="date" ${f.repeat_month === 'date' ? 'checked' : ''}><span>${esc(months[0])}</span></label>
                <label class="rs-radio"><input type="radio" name="repeat_month" value="weekday" ${f.repeat_month === 'weekday' ? 'checked' : ''}><span>${esc(months[1])}</span></label></div></div>` : ''}
              <div class="rs-f"><span>Ending</span><div class="rs-radios rs-ends">
                <label class="rs-radio"><input type="radio" name="ends" value="never" ${f.ends === 'never' ? 'checked' : ''}><span>Never</span></label>
                <label class="rs-radio"><input type="radio" name="ends" value="on" ${f.ends === 'on' ? 'checked' : ''}><span>On</span><input name="ends_on" type="date" value="${v('ends_on')}" aria-label="End date"></label>
                <label class="rs-radio"><input type="radio" name="ends" value="after" ${f.ends === 'after' ? 'checked' : ''}><span>After</span><input name="ends_after" type="number" inputmode="numeric" min="1" value="${v('ends_after')}" aria-label="How many times"><span>times</span></label>
              </div></div>
            </div>` : ''}
          </fieldset>
          <fieldset class="rs-fs"><legend>Content destinations</legend>
            <label class="rs-f"><span>Where it streams <i>optional</i></span><textarea name="destinations" rows="2" maxlength="1000" placeholder="The destination group, or each web channel, YouTube or Facebook destination">${v('destinations')}</textarea></label>
          </fieldset>
          <fieldset class="rs-fs"><legend>In this app <i>not in Studio</i></legend>
            <button type="button" class="rs-switch" role="switch" data-sw="paused" aria-checked="${f.paused}"><i aria-hidden="true"></i>Paused <small>“Pause Event” is on in Studio: it’s kept, but doesn’t run</small></button>
            <label class="rs-f"><span>Notes <i>optional</i></span><textarea name="notes" rows="2" maxlength="2000">${v('notes')}</textarea></label>
          </fieldset>
          ${!isNew && ev ? `<p class="rs-by">${esc([ev.who?.full_name || ev.updated_by_name ? `Last changed by ${ev.who?.full_name || ev.updated_by_name}` : '', ev.updated_at ? timeAgo(ev.updated_at) : ''].filter(Boolean).join(', '))}</p>` : ''}
        </div>
        <footer class="hp-foot"><p class="rs-msg" role="status"></p>
          ${!isNew ? `<button type="button" class="rs-btn is-bad" data-del>${icon('trash')}<span>Remove</span></button><button type="button" class="rs-btn" data-dup>${icon('copy')}<span>Duplicate</span></button>` : ''}
          <span class="spacer"></span>
          <button type="button" class="rs-btn" data-close>Cancel</button>
          <button type="button" class="rs-btn is-main" data-save>${icon('check')}<span>${isNew ? 'Add event' : 'Save'}</span></button>
        </footer>`, { keepScroll: keep });
      markChips();
      syncEnds();
      summary();
    }

    function markChips() {
      for (const c of $$('[data-pre]', panel.el)) c.setAttribute('aria-pressed', String(String(Number(f.prebuffer_min) || 0) === c.dataset.pre && String(f.prebuffer_min).trim() !== ''));
    }
    function syncEnds() {
      const on = $('[name="ends_on"]', panel.el);
      const after = $('[name="ends_after"]', panel.el);
      if (on) on.disabled = f.ends !== 'on';
      if (after) after.disabled = f.ends !== 'after';
    }
    function msg(text) { const m = $('.rs-msg', panel.el); if (m) m.textContent = text; }

    /** The strip under the title, drawn as it's typed: the next run next to what Planning
     *  Center has at the encoder's location then (the service or rehearsal as a clear box above,
     *  Resi below), when the encoder comes on, starts and ends, and how far it runs before and
     *  after Planning Center's time. */
    function summary() {
      const box = $('#rs-sum', panel.el);
      if (!box) return;
      const { row } = toRow({ ...f, name: f.name || 'x', encoder_id: f.encoder_id || 'x' });
      const start = R.mins(f.start_time);
      const dur = (Number(f.dur_h) || 0) * 60 + (Number(f.dur_m) || 0);
      if (start == null || !(dur > 0)) { box.innerHTML = '<p class="rs-sum-empty">Set the start time and duration to see when it runs, next to Planning Center.</p>'; return; }
      const pre = Number(f.prebuffer_min) || 0;
      const on = start - pre;
      const end = start + dur;
      const next = row ? R.firstRun(row, R.today()) : null;
      const campus = campusOf(encoderOf(f.encoder_id));
      const vs = row && next && campus ? vsPco({ ...row, id: 'x' }, campus, next) : null;
      const m = vs?.match;
      const lo = Math.min(on, m ? m.first : on);
      const hi = Math.max(end, m ? m.last : end);
      const w = Math.max(1, hi - lo);
      const at = (x) => `${(((x - lo) / w) * 100).toFixed(2)}%`;
      const len = (a, b) => `${(((b - a) / w) * 100).toFixed(2)}%`;
      const cells = [
        pre ? ['Encoder on', R.clock(on)] : null,
        ['Starts', R.clock(start)],
        ['Ends', R.clock(end)],
        ['Duration', R.dur(dur)],
        m ? [m.kind === 'service' ? 'Service (PCO)' : 'Rehearsal (PCO)', `${R.clock(m.first)}–${m.noEnd ? '?' : R.clock(m.last)}`] : null,
      ].filter(Boolean);
      const offs = m ? [m.lead >= 0 ? `starts ${m.lead} min before` : `starts ${-m.lead} min after`, m.noEnd ? '' : m.tail >= 0 ? `ends ${m.tail} min after` : `ends ${-m.tail} min before`].filter(Boolean).join(', ') : '';
      box.innerHTML = `<div class="rs-sum-bars">
          ${m ? m.items.map((y) => `<i class="rs-sum-p" style="left:${at(y.start)};width:${len(y.start, y.end)}"></i>`).join('') : ''}
          <span class="rs-sum-bar" style="left:${at(on)};width:${len(on, end)}">${pre ? `<i class="rs-buf" style="width:${((pre / (end - on)) * 100).toFixed(2)}%"></i>` : ''}<i class="rs-sum-ev"></i></span>
        </div>
        <dl class="rs-sum-t">${cells.map(([k, x]) => `<div><dt>${k}</dt><dd>${esc(x)}</dd></div>`).join('')}</dl>
        <p class="rs-sum-r">${esc(row ? `${R.repeatText(row)} · ${R.endText(row)}` : '')}${row?.paused ? ' · paused' : ''}${next ? ` · next ${R.dateText(next)}` : row && !row.paused ? ' · no more runs' : ''}</p>
        ${m ? `<p class="rs-sum-vs ${vs.bad ? 'is-bad' : ''}">${esc(`Against ${m.kind === 'service' ? `the ${R.clock(m.first)} ${names(m.items)} service` : names(m.items)} in Planning Center: ${offs}.`)}</p>`
          : vs ? `<p class="rs-sum-vs">${esc(vs.text)}.</p>` : campus ? '' : '<p class="rs-sum-vs">This encoder isn’t at a location, so there’s nothing in Planning Center to compare with.</p>'}`;
    }

    async function save(btn) {
      const out = toRow(f);
      if (out.error) { msg(out.error); return; }
      btn.disabled = true;
      msg('');
      try {
        const id = await ctx.store.resiScheduleSave(out.row);
        saving = true;
        s.flash = id || out.row.id || null;
        // show it on the board: its day, if it doesn't run on the one showing
        const saved = { ...out.row, id };
        if (!runs(saved, s.date).length) { const d = R.firstRun(saved, R.today()); if (d) s.date = d; }
        ctx.toast(isNew ? `Added ${out.row.name}` : `Saved ${out.row.name}`);
        panel.close(true);
        await load();
      } catch (err) { msg(err.message); btn.disabled = false; }
    }
  }

  // -------------------------------------------------------------- encoders ---
  function openEncoders() {
    if (!canEdit) return;
    let rows = encoders().map((e) => ({ id: e.id, name: e.name, campus_id: e.campus_id || '', installed: e.installed !== false }));
    const was = JSON.stringify(rows);
    let saving = false;
    const panel = hudPanel({
      label: 'Encoders', className: 'rs-panel rs-encp',
      beforeClose: async () => saving || JSON.stringify(rows) === was || hudConfirm({ title: 'Leave without saving?', where: 'Encoders', yes: 'Leave', no: 'Keep editing', showChange: false }),
    });
    const count = (id) => schedules().filter((x) => x.encoder_id === id).length;
    const paint = () => {
      panel.render(`
        <header class="hp-head"><p class="hp-crumb">Resi Studio · Settings</p><h2>Encoders</h2>
          <button type="button" class="hp-x" data-close aria-label="Close">${icon('close')}</button></header>
        <div class="hp-body">
          <p class="rs-hint">Name each one as it is in Studio › Settings › Encoders, and where it is. One that isn’t installed yet is on the board, but its location isn’t checked for services without a Resi event.</p>
          <ul class="rs-encs">${rows.map((r, i) => `<li data-i="${i}">
            <input name="name" maxlength="80" autocomplete="off" value="${esc(r.name)}" placeholder="Encoder name" aria-label="Encoder name">
            <select name="campus_id" aria-label="Location"><option value="">No location</option>${ctx.campuses.map((c) => `<option value="${esc(c.id)}" ${c.id === r.campus_id ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select>
            <button type="button" class="rs-switch rs-inst" role="switch" data-inst="${i}" aria-checked="${r.installed}"><i aria-hidden="true"></i>Installed</button>
            <span class="rs-en">${r.id ? `${count(r.id)} event${count(r.id) === 1 ? '' : 's'}` : 'New'}</span>
            <button type="button" class="rs-x" data-rm="${i}" aria-label="Remove ${esc(r.name || 'this encoder')}">${icon('trash')}</button></li>`).join('')}</ul>
          <button type="button" class="rs-btn" data-new>${icon('plus')}<span>Add an encoder</span></button>
        </div>
        <footer class="hp-foot"><p class="rs-msg" role="status"></p><span class="spacer"></span>
          <button type="button" class="rs-btn" data-close>Cancel</button>
          <button type="button" class="rs-btn is-main" data-save>${icon('check')}<span>Save</span></button></footer>`, { keepScroll: true });
    };
    paint();
    const msg = (t) => { const m = $('.rs-msg', panel.el); if (m) m.textContent = t; };
    panel.el.addEventListener('input', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li && e.target.name) rows[Number(li.dataset.i)][e.target.name] = e.target.value;
    });
    panel.el.addEventListener('change', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li && e.target.name) rows[Number(li.dataset.i)][e.target.name] = e.target.value;
    });
    panel.el.addEventListener('click', async (e) => {
      const inst = e.target.closest('[data-inst]');
      if (inst) { const r = rows[Number(inst.dataset.inst)]; r.installed = !r.installed; inst.setAttribute('aria-checked', String(r.installed)); return; }
      if (e.target.closest('[data-new]')) {
        rows.push({ id: null, name: '', campus_id: '', installed: true });
        paint();
        $$('.rs-encs input[name="name"]', panel.el).pop()?.focus();
        return;
      }
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        const r = rows[Number(rm.dataset.rm)];
        if (r.id) {
          const n = count(r.id);
          const yes = await hudConfirm({ title: 'Remove this encoder?', where: r.name, yes: 'Remove', no: 'Cancel', showChange: false, danger: true,
            note: n ? `Its ${n} scheduled event${n === 1 ? '' : 's'} come off this app with it. Studio keeps everything until it’s changed there.` : 'Studio keeps it until it’s removed there too.' });
          if (!yes) return;
          try { await ctx.store.resiEncoderRemove(r.id); ctx.toast(`Removed ${r.name}`); } catch (err) { msg(err.message); return; }
        }
        rows = rows.filter((x) => x !== r);
        paint();
        return;
      }
      const save = e.target.closest('[data-save]');
      if (save) {
        const names = rows.map((r) => r.name.trim().toLowerCase());
        if (rows.some((r) => !r.name.trim())) { msg('Every encoder needs a name.'); return; }
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup) { msg(`Two encoders are called ${rows[names.indexOf(dup)].name.trim()}.`); return; }
        save.disabled = true;
        const before = new Map(encoders().map((x) => [x.id, x]));
        try {
          for (const r of rows) {
            const b = r.id && before.get(r.id);
            const row = { name: r.name.trim(), campus_id: r.campus_id || null, installed: !!r.installed };
            if (!r.id) await ctx.store.resiEncoderSave(row);
            else if (b && (b.name !== row.name || (b.campus_id || null) !== row.campus_id || (b.installed !== false) !== row.installed)) await ctx.store.resiEncoderSave({ id: r.id, ...row });
          }
          saving = true;
          ctx.toast('Encoders saved');
          panel.close(true);
          await load();
        } catch (err) { msg(err.message); save.disabled = false; }
      }
    });
  }
}
