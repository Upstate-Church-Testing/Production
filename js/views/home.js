// Home: what Tally opens on. Are we ready for Sunday?
// For now, the volunteers: the people on PCO › Scheduling for the next Sunday morning (every
// location, the same people that grid shows, worked out by the same code: roster.js). Open
// spots aren't counted here, only the people scheduled. Everyone confirmed says so plainly;
// otherwise it says who has declined or not answered yet, and a tap goes to Scheduling with
// those people marked. Staff and up.

import { esc, icon, $, debounce } from '../util.js';
import { ALL } from '../picker.js';
import { pcoModel, rosterData } from '../roster.js';

const CHECK_MS = 30000; // has Planning Center changed? (the live push does most of it)

export function mount(el, ctx) {
  let alive = true;
  const s = { status: undefined, data: null, error: null };
  let timer = null;

  el.innerHTML = `<div class="home" id="home"><div class="loading"><div class="sk tall"></div></div></div>`;
  const root = $('#home', el);

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (!t) return;
    const sun = sunday();
    if (!sun?.day) { ctx.go('scheduling'); return; }
    // Scheduling marks who needs something that day: declined first, else not answered yet.
    const statuses = sun.D ? ['D'] : sun.U ? ['U'] : [];
    ctx.goTo('scheduling', statuses.length ? { attention: { day: sun.day, statuses } } : null);
  });
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'pco') load(true); }, 300));
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
    draw();
    clearTimeout(timer);
    timer = setTimeout(check, CHECK_MS);
  }

  async function check() {
    clearTimeout(timer);
    if (!alive) return;
    if (document.visibilityState !== 'hidden') {
      try {
        const st = await ctx.store.pcoStatus();
        const changed = (x) => x?.changed_at ?? x?.last_sync_at;
        if (changed(st) !== changed(s.status)) return load(true);
      } catch { /* next time */ }
    }
    timer = setTimeout(check, CHECK_MS);
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
        people.push({ name: pill.name || 'Someone', status: pill.status, position: row.position, campus: ctx.campusById.get(row.campusId) });
      }
    }
    const count = (st) => people.filter((x) => x.status === st).length;
    const plan = m.plans.find((p) => p._day === day);
    return { m, day, plan, people, C: count('C'), U: count('U'), D: count('D'), total: people.length, isToday: day === m.today };
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
          ${needs.length ? `<ul class="home-who">${needs.map((x) => `<li class="is-${x.status}">
              <span class="home-dot" aria-hidden="true"></span><b>${esc(x.name)}</b>
              <small>${esc([x.position, x.campus?.short_name].filter(Boolean).join(' · '))}${x.status === 'D' ? ' · declined' : ' · not answered'}</small>
            </li>`).join('')}</ul>` : ''}
          <span class="home-go">Scheduling ${icon('chevron')}</span>
        </button>
      </div>`;
  }

  function head(when = '') {
    return `<div class="page-head home-head">
      <h1 class="home-title">Ready for Sunday?</h1>
      ${when ? `<p class="home-when">${esc(when)}</p>` : ''}
    </div>`;
  }
}
