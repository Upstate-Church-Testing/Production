// Resi › Studio: Resi Studio's schedule, kept in Tally so it can be read without opening Studio.
// Resi's API can't list or change scheduled events (only start or stop one right now), so the
// team types each event in here from Studio, with the same fields as Studio's event form.
//
// The board: one day at a time, a row per encoder (A to Z), each event drawn where it runs:
// the pre-buffer (the encoder starting early) hatched, then the event itself, with a mark at
// the service's own start when it's known. Events that run into each other on one encoder are
// flagged (Studio won't run both, so one of them was copied over wrong). ‹ › go to the
// previous and next day with something on it.
// Every event: under each encoder, what it is, how it repeats and ends, the pre-buffer, when the
// encoder comes on, the start, the duration and the end. Tap one to change it.
// Encoders: as named in Studio › Settings › Encoders, each at its location. Staff and up.

import { esc, icon, $, $$, debounce, timeAgo, pageTitle } from '../util.js';
import { hudConfirm, hudPanel } from '../hud.js';
import * as R from '../resi-sched.js';

const PRE_CHIPS = [0, 5, 10, 15, 30, 60];
const UNITS = [['hour', 'Hours'], ['day', 'Days'], ['week', 'Weeks'], ['month', 'Months']];
const MAX_RUN = 720; // Resi: an encoder can't run more than 12 hours straight
/** A phone shows a location's code, as Scheduling does. */
const SHORT = { AND: 'AN', MAU: 'MLN' };
const both = (full, short) => (short && short !== full ? `<span class="lf">${esc(full)}</span><span class="ls">${esc(short)}</span>` : esc(full));

export function mount(el, ctx) {
  let alive = true;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canEdit = ctx.roleAtLeast(ctx.me.role, 'staff');
  const s = { data: null, date: null, moving: false, flash: null };

  el.innerHTML = `<div class="rs">
      <div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}
        ${canEdit ? `<div class="rs-acts">
          <button type="button" class="rs-btn" data-act="encoders" aria-label="Encoders">${icon('settings')}<span>Encoders</span></button>
          <button type="button" class="rs-btn is-main" data-act="add" aria-label="Add an event">${icon('plus')}<span>Event</span></button></div>` : ''}
        </div>
        <p class="rs-note">Copied over from Resi Studio by hand, since Resi’s API can’t read scheduled events. Change something in Studio, change it here too.</p>
      </div>
      <div class="results rs-body" id="rs-body"><div class="loading"><div class="sk tall"></div></div></div>
    </div>`;
  const body = $('#rs-body', el);

  el.addEventListener('click', onClick);
  el.addEventListener('keydown', (e) => { // a row in Every event opens like a button
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('tr[data-ev]')) { e.preventDefault(); e.target.click(); }
  });
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'resi_studio') load(); }, 250));
  load(true);
  return { unmount() { alive = false; unsubscribe(); } };

  // ------------------------------------------------------------------ data ---
  async function load(first = false) {
    let data;
    try { data = await ctx.store.resiStudio(); } catch (e) {
      if (alive && !s.data) body.innerHTML = `<div class="empty"><h3>Couldn’t load the schedule</h3><p>${esc(e.message)}</p></div>`;
      return;
    }
    if (!alive) return;
    s.data = data;
    if (!s.date) s.date = startDate();
    draw(first);
  }

  function encoders() {
    return [...(s.data?.encoders || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }
  function schedules() { return s.data?.schedules || []; }
  function encoderOf(id) { return (s.data?.encoders || []).find((e) => e.id === id); }
  function campusOf(enc) { return enc?.campus_id ? ctx.campusById.get(enc.campus_id) : null; }

  /** Today, if anything still runs today; otherwise the next day something does. */
  function startDate() {
    const t = R.today();
    const now = new Date().getHours() * 60 + new Date().getMinutes();
    const live = schedules().filter((ev) => !ev.paused);
    if (live.some((ev) => runs(ev, t).some((r) => r.end > now))) return t;
    return R.nextDate(live, t) || t;
  }

  /** An event's runs on a date, moved onto Eastern time when it's set in another zone. */
  function runs(ev, date) {
    const shift = R.zoneShift(ev.timezone, date);
    return R.runsOn(ev, date).map((r) => ({ ...r, on: r.on + shift, start: r.start + shift, end: r.end + shift, service: r.service == null ? null : r.service + shift }));
  }

  // ------------------------------------------------------------------ draw ---
  function draw(first = false) {
    if (!alive || !s.data) return;
    const encs = encoders();
    if (!encs.length) {
      body.innerHTML = `<div class="empty rs-empty"><h3>No encoders yet</h3><p>Add each encoder as it’s named in Resi Studio › Settings › Encoders.</p>
        ${canEdit ? `<button type="button" class="rs-btn is-main" data-act="encoders">${icon('plus')}<span>Add encoders</span></button>` : ''}</div>`;
      return;
    }
    body.innerHTML = `<section class="rs-day" aria-label="The schedule, day by day">${boardHtml(encs)}</section>
      <section class="rs-all" aria-labelledby="rs-all-h"><h2 class="rs-h" id="rs-all-h">Every event</h2>${listHtml(encs)}</section>`;
    const board = $('.rs-board', body);
    if (first && board && !still()) {
      board.classList.add('rs-boot');
      setTimeout(() => board.classList.remove('rs-boot'), encs.length * 45 + 1100);
    }
    if (s.flash) {
      for (const n of $$(`[data-ev="${CSS.escape(s.flash)}"]`, body)) { n.classList.add('is-flash'); setTimeout(() => n.classList.remove('is-flash'), 1200); }
      s.flash = null;
    }
  }

  function boardHtml(encs) {
    const date = s.date;
    const t = R.today();
    const prev = R.nextDate(schedules(), date, -1);
    const next = R.nextDate(schedules(), date, 1);
    const rows = encs.map((enc) => {
      const list = schedules().filter((ev) => ev.encoder_id === enc.id)
        .flatMap((ev) => runs(ev, date).map((r) => ({ ev, r })))
        .sort((a, b) => a.r.on - b.r.on);
      // two on one encoder that run into each other (pre-buffer included); paused ones don't run
      const live = list.filter((x) => !x.ev.paused);
      for (let i = 1; i < live.length; i += 1) {
        if (live[i].r.on < live[i - 1].r.end) { live[i].clash = live[i - 1]; live[i - 1].clashed = true; }
      }
      return { enc, list };
    });
    const all = rows.flatMap((x) => x.list);
    const running = all.filter((x) => !x.ev.paused);
    const relative = date === t ? 'Today' : date === R.addDays(t, 1) ? 'Tomorrow' : date === R.addDays(t, -1) ? 'Yesterday' : '';
    const d = R.day(date);
    const head = `<div class="rs-bhead">
        <button type="button" class="rs-nav" data-go="prev" ${prev ? '' : 'disabled'} aria-label="${prev ? `Back to ${R.dateText(prev)}` : 'Nothing earlier'}">${icon('chevron')}</button>
        <h2 class="rs-date" aria-live="polite"><b>${esc(R.DAY3[d.getDay()])}</b><span>${esc(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</span>${relative ? `<em>${relative}</em>` : ''}</h2>
        <button type="button" class="rs-nav is-next" data-go="next" ${next ? '' : 'disabled'} aria-label="${next ? `On to ${R.dateText(next)}` : 'Nothing later'}">${icon('chevron')}</button>
        ${date !== t ? '<button type="button" class="rs-today" data-go="today">Today</button>' : ''}
        <p class="rs-count">${running.length ? `${running.length} event${running.length === 1 ? '' : 's'}` : 'Nothing scheduled'}${all.length > running.length ? ` · ${all.length - running.length} paused` : ''}</p>
      </div>`;
    if (!all.length) {
      return `${head}<div class="rs-board is-empty"><p>${schedules().length ? 'Nothing runs on this day.' : 'Nothing scheduled yet.'}${canEdit ? ' Add an event with <b>Event</b> at the top, or under an encoder below.' : ''}</p></div>`;
    }
    // the hours shown: from just before the first encoder comes on to just after the last ends
    let t0 = Math.floor((Math.min(...all.map((x) => x.r.on)) - 20) / 60) * 60;
    let t1 = Math.ceil((Math.max(...all.map((x) => x.r.end)) + 20) / 60) * 60;
    if (t1 - t0 < 240) { const pad = 240 - (t1 - t0); t0 -= Math.floor(pad / 120) * 60; t1 = t0 + 240; }
    t0 = Math.max(0, t0); t1 = Math.min(1440, Math.max(t1, t0 + 60));
    const span = t1 - t0;
    const step = span > 720 ? 120 : 60;
    const pct = (m) => `${(((m - t0) / span) * 100).toFixed(3)}%`;
    const ticks = [];
    for (let m = t0; m <= t1; m += step) ticks.push(`<span class="rs-tick ${m === t0 ? 'is-first' : ''} ${m === t1 ? 'is-last' : ''}" style="left:${pct(m)}">${esc(R.clock(m).replace(':00', ''))}</span>`);
    const nowM = new Date().getHours() * 60 + new Date().getMinutes();
    const showNow = date === t && nowM >= t0 && nowM <= t1;
    const body2 = rows.map(({ enc, list }, ri) => {
      const cp = campusOf(enc);
      const blocks = list.map(({ ev, r, clash, clashed }) => {
        const w = Math.max(1, r.end - r.on);
        const pre = Math.max(0, r.start - r.on);
        const svc = r.service != null && r.service >= r.on && r.service <= r.end ? ((r.service - r.on) / w) * 100 : null;
        const tip = [`${ev.name}`, pre ? `Encoder on ${R.clock(r.on)} (${pre} min pre-buffer)` : '', `Starts ${R.clock(r.start)}`, r.service != null ? `Service ${R.clock(r.service)}` : '', `Ends ${R.clock(r.end)} (${R.dur(ev.duration_min)})`, ev.paused ? 'Paused in Studio' : '', clash || clashed ? 'Runs into another event on this encoder' : ''].filter(Boolean).join('\n');
        return `<button type="button" class="rs-blk ${ev.paused ? 'is-paused' : ''} ${clash || clashed ? 'is-clash' : ''}" data-ev="${esc(ev.id)}" ${canEdit ? '' : 'disabled'}
            style="left:${pct(r.on)};width:${((w / span) * 100).toFixed(3)}%;--pre:${((pre / w) * 100).toFixed(3)}%" title="${esc(tip)}">
            ${pre ? '<i class="rs-buf" aria-hidden="true"></i>' : ''}
            <span class="rs-ev"><b>${esc(ev.name)}</b><small>${esc(`${R.clockShort(r.start, true)}–${R.clockShort(r.end, true)}`)}${ev.paused ? ' · Paused' : ''}</small></span>
            ${svc != null ? `<i class="rs-svc" style="left:${svc.toFixed(3)}%" aria-hidden="true"></i>` : ''}
          </button>`;
      }).join('');
      return `<div class="rs-row" style="--r:${ri}">
          <div class="rs-enc"><b>${both(enc.name, cp ? SHORT[cp.code] || cp.code : '')}</b></div>
          <div class="rs-track">${blocks || '<span class="rs-none">—</span>'}${showNow ? `<i class="rs-now" style="left:${pct(nowM)}"></i>` : ''}</div>
        </div>`;
    }).join('');
    const clashes = rows.flatMap(({ enc, list }) => list.filter((x) => x.clash).map((x) => `<li><b>${esc(enc.name)}</b>: ${esc(x.clash.ev.name)} and ${esc(x.ev.name)} run into each other (pre-buffer included). Studio won’t run both, so one of them is copied over wrong.</li>`));
    const hours = span / 60;
    return `${head}
      <div class="rs-scroll"><div class="rs-board" style="--hrs:${hours}">
        <div class="rs-row rs-axis"><div class="rs-enc rs-corner">${both('Encoder', 'Enc')}</div><div class="rs-track">${ticks.join('')}${showNow ? `<span class="rs-nowl" style="left:${pct(nowM)}">Now</span>` : ''}</div></div>
        ${body2}
      </div></div>
      <ul class="rs-legend" aria-label="Key"><li><i class="k-buf"></i>Pre-buffer: the encoder on early</li><li><i class="k-ev"></i>The event</li><li><i class="k-svc"></i>The service starts</li></ul>
      ${clashes.length ? `<ul class="rs-clash" role="alert">${clashes.join('')}</ul>` : ''}`;
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
        const svc = R.mins(ev.service_time);
        const by = [ev.who?.full_name || ev.updated_by_name, ev.updated_at ? timeAgo(ev.updated_at) : ''].filter(Boolean).join(', ');
        return `<tr class="rs-tr ${over ? 'is-over' : ''} ${ev.paused ? 'is-paused' : ''}" data-ev="${esc(ev.id)}" ${canEdit ? 'tabindex="0" role="button"' : ''} title="${esc(by ? `Last changed by ${by}` : '')}">
          <th scope="row" class="rs-c-ev"><b>${esc(ev.name)}</b>${tags}${svc != null ? `<small>For the ${esc(R.clock(svc))} service</small>` : ev.description ? `<small>${esc(ev.description)}</small>` : ''}</th>
          <td class="rs-c-rep" data-l="Repeats"><b>${esc(R.repeatText(ev))}</b><small>${esc(R.endText(ev))}</small></td>
          <td class="rs-c-n" data-l="Pre-buffer">${pre ? `${pre}<small> min</small>` : '<span class="rs-dim">None</span>'}</td>
          <td class="rs-c-n" data-l="Encoder on">${esc(R.clock(start - pre))}</td>
          <td class="rs-c-n is-key" data-l="Starts">${esc(R.clock(start))}${zone}</td>
          <td class="rs-c-n" data-l="Duration" title="${esc(R.durWords(ev.duration_min))}">${esc(R.dur(ev.duration_min))}</td>
          <td class="rs-c-n" data-l="Ends">${esc(R.clock(start + Number(ev.duration_min || 0)))}</td>
        </tr>`;
      }).join('');
      return `<div class="rs-grp">
          <div class="rs-ghead"><h3>${esc(enc.name)}</h3>${cp && cp.short_name !== enc.name ? `<span class="rs-loc">${esc(cp.short_name)}</span>` : ''}
            <span class="rs-gn">${list.length ? `${list.length} event${list.length === 1 ? '' : 's'}` : 'Nothing scheduled'}</span>
            ${canEdit ? `<button type="button" class="rs-add" data-add="${esc(enc.id)}" aria-label="Add an event on ${esc(enc.name)}">${icon('plus')}<span>Event</span></button>` : ''}</div>
          ${list.length ? `<table class="rs-t"><thead><tr><th scope="col">Event</th><th scope="col">Repeats</th><th scope="col">Pre-buffer</th><th scope="col">Encoder on</th><th scope="col">Starts</th><th scope="col">Duration</th><th scope="col">Ends</th></tr></thead>
            <tbody>${rows}</tbody></table>` : ''}
        </div>`;
    }).join('');
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
    const to = where === 'today' ? R.today() : R.nextDate(schedules(), s.date, where === 'prev' ? -1 : 1);
    if (!to || to === s.date) return;
    const dir = to > s.date ? 1 : -1;
    const sec = $('.rs-day', body);
    if (!sec || still()) { s.date = to; draw(); return; }
    s.moving = true;
    sec.classList.add(dir > 0 ? 'rs-out-l' : 'rs-out-r');
    setTimeout(() => {
      if (!alive) return;
      s.date = to;
      sec.innerHTML = boardHtml(encoders());
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
        ends: 'never', ends_on: '', ends_after: '', destinations: '', paused: false, service_time: '', notes: '',
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
      destinations: ev.destinations || '', paused: !!ev.paused, service_time: R.hhmm(ev.service_time), notes: ev.notes || '',
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
      destinations: f.destinations.trim() || null, paused: !!f.paused, service_time: f.service_time || null, notes: f.notes.trim() || null,
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
          note: 'It comes off Tally only. Studio keeps it until it’s removed there too.' });
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
          <fieldset class="rs-fs"><legend>In Tally <i>not in Studio</i></legend>
            <label class="rs-f"><span>The service starts <i>optional, in the building</i></span><input name="service_time" type="time" value="${v('service_time')}"></label>
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

    /** The strip under the title: when the encoder comes on, starts, the service, ends; how it
     *  repeats; the next time it runs. Drawn as it's typed. */
    function summary() {
      const box = $('#rs-sum', panel.el);
      if (!box) return;
      const { row } = toRow({ ...f, name: f.name || 'x', encoder_id: f.encoder_id || 'x' });
      const start = R.mins(f.start_time);
      const dur = (Number(f.dur_h) || 0) * 60 + (Number(f.dur_m) || 0);
      if (start == null || !(dur > 0)) { box.innerHTML = '<p class="rs-sum-empty">Set the start time and duration to see when it runs.</p>'; return; }
      const pre = Number(f.prebuffer_min) || 0;
      const svc = R.mins(f.service_time);
      const on = start - pre;
      const end = start + dur;
      const w = end - on;
      const next = row ? R.firstRun(row, R.today()) : null;
      const cells = [
        pre ? ['Encoder on', R.clock(on)] : null,
        ['Starts', R.clock(start)],
        svc != null ? ['Service', R.clock(svc)] : null,
        ['Ends', R.clock(end)],
      ].filter(Boolean);
      const early = svc != null ? svc - start : null;
      box.innerHTML = `<div class="rs-sum-bar">${pre ? `<i class="rs-buf" style="width:${((pre / w) * 100).toFixed(2)}%"></i>` : ''}<i class="rs-sum-ev"></i>
          ${svc != null && svc >= on && svc <= end ? `<i class="rs-svc" style="left:${(((svc - on) / w) * 100).toFixed(2)}%"></i>` : ''}</div>
        <dl class="rs-sum-t">${cells.map(([k, x]) => `<div><dt>${k}</dt><dd>${esc(x)}</dd></div>`).join('')}<div><dt>Duration</dt><dd>${esc(R.dur(dur))}</dd></div></dl>
        <p class="rs-sum-r">${esc(row ? `${R.repeatText(row)} · ${R.endText(row)}` : '')}${early != null && early > 0 ? ` · starts ${early} min before the service` : early != null && early < 0 ? ` · starts ${-early} min after the service` : ''}${row?.paused ? ' · paused' : ''}${next ? ` · next ${R.dateText(next)}` : row && !row.paused ? ' · no more runs' : ''}</p>`;
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
    let rows = encoders().map((e) => ({ id: e.id, name: e.name, campus_id: e.campus_id || '' }));
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
          <p class="rs-hint">Name each one as it is in Studio › Settings › Encoders, and where it is.</p>
          <ul class="rs-encs">${rows.map((r, i) => `<li data-i="${i}">
            <input name="name" maxlength="80" autocomplete="off" value="${esc(r.name)}" placeholder="Encoder name" aria-label="Encoder name">
            <select name="campus_id" aria-label="Location"><option value="">No location</option>${ctx.campuses.map((c) => `<option value="${esc(c.id)}" ${c.id === r.campus_id ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select>
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
      if (e.target.closest('[data-new]')) {
        rows.push({ id: null, name: '', campus_id: '' });
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
            note: n ? `Its ${n} scheduled event${n === 1 ? '' : 's'} come off Tally with it. Studio keeps everything until it’s changed there.` : 'Studio keeps it until it’s removed there too.' });
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
            const row = { name: r.name.trim(), campus_id: r.campus_id || null };
            if (!r.id) await ctx.store.resiEncoderSave(row);
            else if (b && (b.name !== row.name || (b.campus_id || null) !== row.campus_id)) await ctx.store.resiEncoderSave({ id: r.id, ...row });
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
