// Home: what Tally opens on. Are we ready for Sunday? One card per thing to check:
//   Volunteers: the people on PCO › Scheduling for the next Sunday morning (every location,
//     the same people that grid shows, worked out by the same code: roster.js). Open spots
//     aren't counted, only the people scheduled. Everyone confirmed says so plainly; otherwise
//     who has declined or not answered yet. Then CG, lighting and broadcast on their own
//     (confirmed of scheduled). A tap goes to Scheduling with those people marked.
//   CG uploads: how many CGs are uploaded for the coming Sunday (views/cg.js): one per campus,
//     plus Simpsonville's CG2 (the same rows as CG uploads, js/cg-rows.js), each one's state in
//     a row of chips. A tap goes to CG uploads.
// Staff and up.

import { esc, icon, $, debounce } from '../util.js';
import { ALL } from '../picker.js';
import { pcoModel, rosterData } from '../roster.js';
import { comingSunday } from '../pco.js';
import { cgRows, cgKey } from '../cg-rows.js';

const CHECK_MS = 30000; // has Planning Center changed? (the live push does most of it)
/** The Volunteers card's breakdown: Broadcast by team (cameras, director, switcher…), CG and
 *  Lighting by position, as Planning Center names them. */
const GROUPS = [
  { id: 'cg', label: 'CG', unit: 'spots' },
  { id: 'lighting', label: 'Lighting', unit: 'spots' },
  { id: 'broadcast', label: 'Broadcast', unit: 'positions' },
];
const groupOf = (row) => (/broadcast/i.test(row.team) ? 'broadcast' : /\bcg\b/i.test(row.position) ? 'cg' : /light|\blx\b/i.test(row.position) ? 'lighting' : null);
/** AN, FF, FI, GCC, GVL, HB, LAU, MLN, SVL, UN: as the team says them. */
const CAMPUS_SHORT = { AND: 'AN', MAU: 'MLN' };

export function mount(el, ctx) {
  let alive = true;
  const s = { status: undefined, data: null, error: null, cg: null, cgFor: null, computers: [] };
  let timer = null;

  el.innerHTML = `<div class="home" id="home"><div class="loading"><div class="sk tall"></div></div></div>`;
  const root = $('#home', el);

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (!t) return;
    if (t.dataset.go !== 'scheduling') { ctx.go(t.dataset.go); return; }
    const sun = sunday();
    if (!sun?.day) { ctx.go('scheduling'); return; }
    // Scheduling marks who needs something that day: declined first, else not answered yet.
    const statuses = sun.D ? ['D'] : sun.U ? ['U'] : [];
    ctx.goTo('scheduling', statuses.length ? { attention: { day: sun.day, statuses } } : null);
  });
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'pco') load(true); else if (table === 'cg') loadCg(); }, 300));
  const onVisible = () => { if (document.visibilityState === 'visible') check(); };
  document.addEventListener('visibilitychange', onVisible);

  load();
  return {
    unmount() {
      alive = false;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };

  async function load(quiet = false) {
    try {
      const [status, data] = await Promise.all([ctx.store.pcoStatus(), ctx.store.pcoData()]);
      s.status = status; s.data = data; s.error = null;
    } catch (e) {
      if (!quiet || !s.data) s.error = e.message;
    }
    if (!alive) return;
    await loadCg(false);
    draw();
    clearTimeout(timer);
    timer = setTimeout(check, CHECK_MS);
  }

  async function check() {
    clearTimeout(timer);
    if (!alive) return;
    if (document.visibilityState !== 'hidden') {
      if (comingSunday(tz()) !== s.cgFor) await loadCg(); // Monday: on to the next Sunday
      try {
        const st = await ctx.store.pcoStatus();
        const changed = (x) => x?.changed_at ?? x?.last_sync_at;
        if (changed(st) !== changed(s.status)) return load(true);
      } catch { /* next time */ }
    }
    timer = setTimeout(check, CHECK_MS);
  }

  function tz() { return s.status?.time_zone || 'America/New_York'; }

  /** CG uploads for the coming Sunday. */
  async function loadCg(redraw = true) {
    const sunday = comingSunday(tz());
    try {
      const [rows, computers] = await Promise.all([ctx.store.cgUploads?.(sunday), ctx.store.cgComputers?.().catch(() => null)]);
      s.cg = new Map((rows || []).map((r) => [cgKey(r.campus_id, r.station), r.status]));
      if (computers) s.computers = computers;
      s.cgFor = sunday;
    } catch { if (s.cgFor !== sunday) s.cg = null; }
    if (redraw && alive) draw();
  }

  /** The next Sunday morning on Scheduling (today, if it's Sunday) and who's on it. */
  function sunday() {
    const m = s.data && s.status ? pcoModel(s.data, s.status, ctx, 'sun') : null;
    if (!m) return null;
    const { days, rows } = rosterData(m, 'sun', ALL, ctx.campuses);
    const day = days.find((d) => d >= m.today);
    if (!day) return { day: null };
    const people = [];
    for (const row of rows) {
      const cell = row.cells.get(day);
      if (!cell) continue;
      for (const pill of cell.people.values()) {
        people.push({ name: pill.name || 'Someone', status: pill.status, position: row.position, campus: ctx.campusById.get(row.campusId), group: groupOf(row) });
      }
    }
    const count = (st) => people.filter((x) => x.status === st).length;
    const plan = m.plans.find((p) => p._day === day);
    // CG, lighting and broadcast on their own: confirmed of scheduled.
    const groups = GROUPS.map((g) => {
      const list = people.filter((x) => x.group === g.id);
      return { ...g, C: list.filter((x) => x.status === 'C').length, D: list.filter((x) => x.status === 'D').length, total: list.length };
    }).filter((g) => g.total);
    return { m, day, plan, people, groups, C: count('C'), U: count('U'), D: count('D'), total: people.length, isToday: day === m.today };
  }

  function draw() {
    if (!alive) return;
    if (s.error && !s.data) {
      root.innerHTML = `${head()}<div class="empty"><p>Couldn’t load Planning Center: ${esc(s.error)}</p></div>`;
      return;
    }
    if (s.status === undefined) return;
    if (s.status === null) {
      root.innerHTML = `${head()}<div class="empty"><p>Planning Center isn’t connected, so there’s nothing to check yet.</p></div>`;
      return;
    }
    const sun = sunday();
    if (!sun?.day) {
      root.innerHTML = `${head()}<section class="home-card"><p class="home-msg">No Sunday morning on Scheduling yet.</p></section>`;
      return;
    }
    const { m, plan, C, U, D, total } = sun;
    const when = `${sun.isToday ? 'Today' : m.c.weekday(plan.sort_date)}, ${m.c.date(plan.sort_date)}`;
    const tone = D ? 'is-bad' : U ? 'is-wait' : 'is-good';
    const headline = !total ? 'No one is scheduled yet'
      : D ? `${D} ${D === 1 ? 'person' : 'people'} declined`
        : U ? `${U} ${U === 1 ? 'person hasn’t' : 'people haven’t'} confirmed yet`
          : 'Everyone’s confirmed';
    const sub = !total ? 'Nobody is on the shared teams for this Sunday.'
      : !D && !U ? `${C} of ${total} spots filled`
        : [`${C} of ${total} confirmed`, D && U ? `${U} not answered yet` : ''].filter(Boolean).join(' · ');
    // Who needs something: declined first, then not answered yet.
    const needs = sun.people.filter((x) => x.status !== 'C').sort((a, b) => (a.status === 'D' ? 0 : 1) - (b.status === 'D' ? 0 : 1) || a.name.localeCompare(b.name));
    const mark = (st) => (st === 'C' ? icon('check') : st === 'D' ? icon('close') : '<i aria-hidden="true">?</i>');
    root.innerHTML = `${head(when)}
      <div class="home-grid">
        <button type="button" class="home-card ${tone}" data-go="scheduling" aria-label="Volunteers: ${esc(headline)}. Open Scheduling">
          <span class="home-k">${icon('team')}Volunteers</span>
          <span class="home-status"><span class="home-mark">${mark(D ? 'D' : U ? 'U' : 'C')}</span><b class="home-msg">${esc(headline)}</b></span>
          <span class="home-sub">${esc(sub)}</span>
          ${sun.groups.length ? `<span class="home-split">${sun.groups.map((g) => `<span class="${g.D ? 'is-D' : g.C < g.total ? 'is-U' : ''}"><small>${esc(g.label)}</small><b>${g.C} of ${g.total}</b><em>${esc(g.unit)}</em></span>`).join('')}</span>` : ''}
          ${needs.length ? `<ul class="home-who">${needs.map((x) => `<li class="is-${x.status}">
              <span class="home-dot" aria-hidden="true"></span><b>${esc(x.name)}</b>
              <small>${esc([x.position, x.campus?.short_name].filter(Boolean).join(' · '))}${x.status === 'D' ? ' · declined' : ' · not answered'}</small>
            </li>`).join('')}</ul>` : ''}
          <span class="home-go">Scheduling ${icon('chevron')}</span>
        </button>
        ${cgCard()}
      </div>`;
  }

  /** CG uploads: how many are done for the coming Sunday, each one a chip. */
  function cgCard() {
    if (!s.cg) return '';
    const list = cgRows(ctx.campuses, s.computers);
    const st = (key) => s.cg.get(key) || 'not_started';
    const done = list.filter((x) => st(x.key) === 'done').length;
    const working = list.filter((x) => st(x.key) === 'working').length;
    const rest = list.length - done - working;
    const all = done === list.length;
    const msg = all ? `All ${list.length} uploaded` : `${done} of ${list.length} uploaded`;
    const sub = all ? 'CG is ready everywhere.' : [working ? `${working} working on it` : '', rest ? `${rest} not started` : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="home-card ${all ? 'is-good' : 'is-wait'}" data-go="cg-uploads" aria-label="CG uploads: ${esc(msg)}. Open CG uploads">
        <span class="home-k">${icon('upload')}CG uploads</span>
        <span class="home-status"><span class="home-mark">${all ? icon('check') : `<i aria-hidden="true">${done}</i>`}</span><b class="home-msg">${esc(msg)}</b></span>
        <span class="home-sub">${esc(sub)}</span>
        <span class="home-chips">${list.map((x) => {
          const c = x.campus;
          const v = st(x.key);
          return `<span class="is-${v}" title="${esc(`${c.short_name}${x.tag ? ` ${x.tag}` : ''}: ${v === 'done' ? 'done' : v === 'working' ? 'working on it' : 'not started'}`)}">${esc(CAMPUS_SHORT[c.code] || c.code || c.short_name)}${x.station ? ` ${esc(x.station)}` : ''}</span>`;
        }).join('')}</span>
        <span class="home-go">CG uploads ${icon('chevron')}</span>
      </button>`;
  }

  function head(when = '') {
    return `<div class="page-head home-head">
      <h1 class="home-title">Ready for Sunday?</h1>
      ${when ? `<p class="home-when">${esc(when)}</p>` : ''}
    </div>`;
  }
}
