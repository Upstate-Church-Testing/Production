// CG uploads: is each campus's CG uploaded for Sunday? One row per campus: Not started,
// Working on it, or Done, with who set it and when. Always the coming Sunday (today if it's
// Sunday): on Monday it moves on to the next one, where everything starts at Not started
// (cg_uploads is keyed by the Sunday; last week's stay as they were). Changes from anyone
// show up live. Home shows how many are done. Staff and up.

import { esc, icon, $, debounce, pageTitle } from '../util.js';
import { clock, comingSunday } from '../pco.js';

export const CG_STATES = [
  { id: 'not_started', label: 'Not started', short: 'Not started' },
  { id: 'working', label: 'Working on it', short: 'Working' },
  { id: 'done', label: 'Done', short: 'Done' },
];

export function mount(el, ctx) {
  let alive = true;
  const s = { tz: 'America/New_York', sunday: null, rows: new Map(), error: null, loaded: false, saving: new Set() };
  let timer = null;

  el.innerHTML = `<div class="cgu" id="cgu"><div class="loading">${'<div class="sk"></div>'.repeat(4)}</div></div>`;
  const root = $('#cgu', el);

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cg][data-st]');
    if (!b || b.disabled) return;
    const campus = b.dataset.cg;
    const status = b.dataset.st;
    const was = s.rows.get(campus);
    if ((was?.status || 'not_started') === status) return;
    // Show it right away; put it back if it doesn't save.
    s.rows.set(campus, { ...(was || {}), campus_id: campus, status, updated_at: new Date().toISOString(), who: { full_name: ctx.me.full_name } });
    s.saving.add(campus);
    draw();
    try {
      await ctx.store.cgSetUpload(s.sunday, campus, status);
    } catch (err) {
      if (was) s.rows.set(campus, was); else s.rows.delete(campus);
      ctx.toast(err.message);
    }
    s.saving.delete(campus);
    draw();
  });
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'cg') load(); }, 250));
  const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
  document.addEventListener('visibilitychange', onVisible);

  start();
  return {
    unmount() {
      alive = false;
      clearInterval(timer);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };

  async function start() {
    try { s.tz = (await ctx.store.pcoStatus())?.time_zone || s.tz; } catch { /* the default */ }
    s.sunday = comingSunday(s.tz);
    await load();
    timer = setInterval(tick, 60000);
  }

  /** Monday moves it on to the next Sunday. */
  function tick() {
    const next = comingSunday(s.tz);
    if (next !== s.sunday) { s.sunday = next; s.rows = new Map(); load(); }
  }

  async function load() {
    const sunday = s.sunday;
    try {
      const rows = (await ctx.store.cgUploads(sunday)) || [];
      if (!alive || sunday !== s.sunday) return;
      s.rows = new Map(rows.map((r) => [r.campus_id, r]));
      s.error = null;
    } catch (e) {
      s.error = e.message;
    }
    s.loaded = true;
    draw();
  }

  function draw() {
    if (!alive || !s.loaded) return;
    const c = clock(s.tz);
    const day = Date.parse(`${s.sunday}T16:00:00Z`);
    const campuses = ctx.campuses;
    const statusOf = (id) => s.rows.get(id)?.status || 'not_started';
    const done = campuses.filter((cp) => statusOf(cp.id) === 'done').length;
    const isToday = c.day(Date.now()) === s.sunday;
    const tally = `<p class="tally"><b>${done}</b><span>of ${campuses.length} uploaded</span></p>`;
    const stamp = (r) => {
      if (!r?.updated_at) return '';
      const who = r.who?.full_name || r.updated_by_name || '';
      const at = c.day(Date.now()) === c.day(r.updated_at) ? c.time(r.updated_at) : `${c.weekday(r.updated_at).slice(0, 3)} ${c.time(r.updated_at)}`;
      return [who, at].filter(Boolean).join(' · ');
    };
    root.innerHTML = `<div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}${tally}</div>
        <p class="cgu-when">For ${isToday ? 'today' : `Sunday, ${esc(c.date(day))}`}. Starts over on Monday for the next Sunday.</p></div>
      ${s.error ? `<p class="lv-warn">${icon('warn')}Couldn’t load: ${esc(s.error)}</p>` : ''}
      <ul class="cgu-list">${campuses.map((cp) => {
        const st = statusOf(cp.id);
        const r = s.rows.get(cp.id);
        const busy = s.saving.has(cp.id);
        return `<li class="cgu-row is-${st}">
          <div class="cgu-name"><b>${esc(cp.short_name)}</b><small>${esc(CG_STATES.find((x) => x.id === st).label)}${r?.updated_at ? ` · ${esc(stamp(r))}` : ''}</small></div>
          <div class="cgu-seg" role="group" aria-label="${esc(cp.short_name)} CG">${CG_STATES.map((x) => `<button type="button" data-cg="${esc(cp.id)}" data-st="${x.id}" class="is-${x.id}" aria-pressed="${st === x.id}" ${busy ? 'disabled' : ''}>${x.id === 'done' ? icon('check') : ''}<span>${esc(x.short)}</span></button>`).join('')}</div>
        </li>`;
      }).join('')}</ul>`;
  }
}
