// Lighting › House lights: what the house lights are at in each part of a service, as a
// sheet in the console look (like PCO › Scheduling). One row per room on the sheet (rooms
// with house_lights: the Worship Centers where Sunday services happen, not Laurens or Union),
// one column group per part of the service (Pre-service, Worship, Host, Video, Message), and
// inside each group a column per service: Vintage and Modern on Sundays, Midweek on
// Wednesdays. So a column read down compares every location's Vintage (or Modern), and a
// pair side by side compares one location's Vintage and Modern; the Modern level shows how
// far it is from Vintage (+10). Which services a room has comes from Planning Center (its
// location's shared Vintage / Modern / Midweek services, not one in another room like
// "[North Auditorium]"); a service it doesn't have is hatched out.
// Levels are percent (0-100). Tap one to type a new level; Enter asks "Are you sure?" and
// only Yes saves it (clearing it and Enter removes it, asked the same way). A phone's number
// pad has no Enter: its ✓ (Done) only closes the keyboard, so leaving a level you changed
// (the ✓, or tapping away) asks the same way. Leaving it as it was, or Esc, puts it back.
// Changes from anyone show up live, flashing in.
// Sundays | Wednesdays switches like Scheduling: both are laid out, what's on the sheet goes
// out top left to bottom right and the other comes in. Staff and up.

import { esc, icon, $, $$, debounce, timeAgo, pageTitle } from '../util.js';
import { hudConfirm } from '../hud.js';

export const SEGMENTS = [['pre', 'Pre-service'], ['worship', 'Worship'], ['host', 'Host'], ['video', 'Video'], ['message', 'Message']];
const SERVICES = {
  sun: [['vintage', 'Vintage', 'V'], ['modern', 'Modern', 'M']],
  mid: [['midweek', 'Midweek', 'W']],
};
const WEEK_KEY = 'ucp.house.week';
/** A phone shows a location's code, as Scheduling does (AN, FF, GCC, MLN, SVL…). */
const SHORT = { AND: 'AN', MAU: 'MLN' };
const both = (full, short) => (short && short !== full ? `<span class="lf">${esc(full)}</span><span class="ls">${esc(short)}</span>` : esc(full));

export function mount(el, ctx) {
  let alive = true;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canEdit = ['staff', 'admin'].includes(ctx.me.role);
  const s = {
    data: null, error: null,
    levels: new Map(),      // "room|service|segment" -> { level, updated_at, who }
    week: (() => { try { return sessionStorage.getItem(WEEK_KEY) === 'mid' ? 'mid' : 'sun'; } catch { return 'sun'; } })(),
    edit: null,             // { td, key } while typing
    asking: false,          // the "Are you sure?" is up
    busy: false,            // switching weeks
  };

  el.innerHTML = `<div class="hl" id="hl">
      <div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}
        <div class="seg hl-week" role="tablist" aria-label="Which services">
          <button type="button" role="tab" data-week="sun">Sundays</button><button type="button" role="tab" data-week="mid">Wednesdays</button>
        </div></div></div>
      <div class="results hl-body" id="hl-body"><div class="loading"><div class="sk tall"></div></div></div>
    </div>`;
  const body = $('#hl-body', el);
  markWeek();

  el.addEventListener('click', (e) => {
    const w = e.target.closest('[data-week]');
    if (w) { switchWeek(w.dataset.week); return; }
    const v = e.target.closest('.hl-v');
    if (v && canEdit && !s.busy) startEdit(v.closest('td'));
  });
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'house' || table === 'pco') load(true); }, 250));
  const onResize = debounce(() => fitStage(), 120);
  window.addEventListener('resize', onResize);

  load(false);
  return {
    unmount() {
      alive = false;
      unsubscribe();
      window.removeEventListener('resize', onResize);
    },
  };

  // ------------------------------------------------------------------ data ---
  async function load(live) {
    let data;
    try { data = await ctx.store.houseLights(); } catch (e) {
      if (!alive) return;
      if (!s.data) { body.innerHTML = `<div class="empty"><p>Couldn’t load house lights: ${esc(e.message)}</p></div>`; }
      return;
    }
    if (!alive) return;
    const before = s.levels;
    s.data = data;
    s.levels = new Map((data.levels || []).map((r) => [key(r.room_id, r.service, r.segment), { level: r.level, updated_at: r.updated_at, who: r.who?.full_name || r.updated_by_name || '' }]));
    if (!live || !$('.hl-stage', body)) { draw(true); return; }
    // Live: only the levels that changed, flashing in (not one being typed in).
    for (const td of $$('td[data-k]', body)) {
      const k = td.dataset.k;
      const a = before.get(k)?.level ?? null;
      const b = s.levels.get(k)?.level ?? null;
      if (a === b || s.edit?.key === k) continue;
      paintCell(td, { from: a, flash: true });
      paintPartner(td);
    }
  }

  function key(room, service, segment) { return `${room}|${service}|${segment}`; }

  /** Which services a room has: its location's shared Planning Center services. With no
   *  Planning Center to go by, Sundays show both and there are no Wednesdays. */
  function servicesOf(room) {
    const types = (s.data?.types || []).filter((t) => t.campus_id === room.campus_id && t.on_roster && !t.is_event && t.access !== 'hidden'
      && !/\[[^\]]+\]/.test(t.name)); // "[North Auditorium]": another room
    if (!(s.data?.types || []).length) return new Set(['vintage', 'modern']);
    const has = new Set();
    for (const t of types) {
      if (/vintage/i.test(t.name)) has.add('vintage');
      if (/modern/i.test(t.name)) has.add('modern');
      if (/mid\s*week/i.test(t.name)) has.add('midweek');
    }
    return has;
  }

  function rowsFor(week) {
    const rank = new Map(ctx.campuses.map((c, i) => [c.id, i]));
    return (s.data?.rooms || [])
      .map((room) => ({ room, campus: ctx.campusById.get(room.campus_id), has: servicesOf(room) }))
      .filter((x) => x.campus && SERVICES[week].some(([id]) => x.has.has(id)))
      .sort((a, b) => (rank.get(a.room.campus_id) ?? 99) - (rank.get(b.room.campus_id) ?? 99) || a.room.name.localeCompare(b.room.name));
  }

  // ------------------------------------------------------------------ draw ---
  function draw(first) {
    if (!alive || !s.data) return;
    const keep = new Map($$('.hl-wrap', body).map((w) => [w.dataset.wk, w.scrollLeft]));
    body.innerHTML = `<div class="hl-stage">${['sun', 'mid'].map((w) => sheet(w)).join('')}</div>
      ${canEdit ? '<p class="hl-hint">Percent. Tap a level to change it.</p>' : ''}`;
    for (const w of $$('.hl-wrap', body)) w.scrollLeft = keep.get(w.dataset.wk) || 0;
    fitStage();
    if (first && !still()) {
      // The levels come up like faders, top left to bottom right (once).
      const t = $('.hl-wrap.is-active .hl-t', body);
      if (t) {
        const n = (v) => Number(t.style.getPropertyValue(v)) || 0;
        t.classList.add('hl-boot');
        setTimeout(() => t.classList.remove('hl-boot'), n('--rows') * 35 + n('--cols') * 22 + 1000);
      }
    }
    if (first) document.fonts?.ready.then(() => { if (alive) fitStage(); });
  }

  function sheet(week) {
    const rows = rowsFor(week);
    const svcs = SERVICES[week];
    const active = week === s.week ? 'is-active' : '';
    if (!rows.length) {
      return `<div class="hl-wrap ${active}" data-wk="${week}"><div class="empty"><h3>No ${week === 'mid' ? 'Wednesday' : 'Sunday'} rooms</h3>
        <p>None of the rooms on this sheet has a ${week === 'mid' ? 'Midweek' : 'Vintage or Modern'} service in Planning Center.</p></div></div>`;
    }
    let c = 0;
    const head1 = SEGMENTS.map(([, label]) => `<th class="hl-seg" colspan="${svcs.length}" scope="colgroup" style="--r:0;--c:${1 + c++ * svcs.length}"><span>${esc(label)}</span></th>`).join('');
    const head2 = SEGMENTS.map((_, si) => svcs.map(([id, label, letter], k) => `<th class="hl-svc is-${id} ${k === 0 ? 'is-seg' : ''}" scope="col" style="--r:1;--c:${1 + si * svcs.length + k}">
        <span><i>${letter}</i><b>${esc(label)}</b></span></th>`).join('')).join('');
    const rowsHtml = rows.map((x, ri) => {
      const r = ri + 2;
      const cells = SEGMENTS.map(([seg], si) => svcs.map(([id, label], k) => {
        const col = 1 + si * svcs.length + k;
        const cls = `hl-c is-${id}${k === 0 ? ' is-seg' : ''}`;
        if (!x.has.has(id)) return `<td class="${cls} is-na" style="--r:${r};--c:${col}" title="${esc(`${x.campus.short_name} has no ${label} service`)}"><span class="hl-na">No ${esc(label)}</span></td>`;
        return `<td class="${cls}" style="--r:${r};--c:${col}" data-k="${esc(key(x.room.id, id, seg))}">${cellInner(x, id, seg)}</td>`;
      }).join('')).join('');
      return `<tr><th class="hl-loc" scope="row" style="--r:${r};--c:0"><span><b>${both(x.campus.short_name, SHORT[x.campus.code] || x.campus.code)}</b><small>${esc(x.room.name)}</small></span></th>${cells}</tr>`;
    }).join('');
    return `<div class="hl-wrap ${active}" data-wk="${week}">
      <table class="hl-t is-${week}" style="--rows:${rows.length + 2};--cols:${1 + SEGMENTS.length * svcs.length}">
        <thead><tr><th class="hl-corner" rowspan="2" scope="col" style="--r:0;--c:0"><span>${both('Location', 'Loc')}</span></th>${head1}</tr><tr>${head2}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>`;
  }

  /** A level: the number, the cell lit as bright as the house lights are up (warm, from
   *  dark at 0 to full at 100), a bar along the bottom as long as the level, and on Modern
   *  how far it is from Vintage. --lv is the level as a length, --la as a brightness. */
  function cellInner(x, service, seg, shown = null) {
    const lv = s.levels.get(key(x.room.id, service, seg));
    const label = `${x.campus.short_name} ${SEGMENTS.find(([id]) => id === seg)[1]}, ${service}`;
    if (!lv) return `<button type="button" class="hl-v is-empty" ${canEdit ? '' : 'disabled'} aria-label="${esc(`${label}: not set${canEdit ? '. Set it' : ''}`)}"><span class="hl-dash">—</span></button>`;
    const n = shown ?? lv.level;
    let delta = '';
    if (service === 'modern') {
      const v = s.levels.get(key(x.room.id, 'vintage', seg));
      if (v && v.level !== lv.level) { const d = lv.level - v.level; delta = `<em class="hl-d" title="${esc(`${Math.abs(d)} ${d > 0 ? 'up' : 'down'} from Vintage`)}">${d > 0 ? '+' : '−'}${Math.abs(d)}</em>`; }
    }
    const by = [lv.who, lv.updated_at ? timeAgo(lv.updated_at) : ''].filter(Boolean).join(', ');
    return `<button type="button" class="hl-v" style="${lit(n)}" ${canEdit ? '' : 'disabled'} title="${esc(by ? `Set by ${by}` : '')}" aria-label="${esc(`${label}: ${lv.level}%${canEdit ? '. Change it' : ''}`)}">
      <span class="hl-fill"></span><span class="hl-bar"></span><span class="hl-n"><b>${n}</b><small>%</small></span>${delta}</button>`;
  }

  function lit(n) { return `--lv:${n}%;--la:${(n / 100).toFixed(2)}`; }

  function rowOf(td) {
    const [roomId, service, seg] = td.dataset.k.split('|');
    const room = s.data.rooms.find((r) => r.id === roomId);
    return { x: { room, campus: ctx.campusById.get(room?.campus_id) }, service, seg };
  }

  /** Draw one level again; from: the level it was (it counts there), flash: changed by someone. */
  function paintCell(td, { from = null, flash = false } = {}) {
    const { x, service, seg } = rowOf(td);
    if (!x.room || !x.campus) return;
    const to = s.levels.get(td.dataset.k)?.level ?? null;
    const animate = !still() && from != null && to != null && from !== to;
    td.classList.remove('is-edit', 'is-bad');
    td.innerHTML = cellInner(x, service, seg, animate ? from : null);
    if (animate) countTo(td, from, to);
    if ((flash || to !== from) && !still()) {
      td.classList.remove('is-flash');
      void td.offsetWidth;
      td.classList.add('is-flash');
      setTimeout(() => td.classList.remove('is-flash'), 900);
    }
  }

  /** Vintage changed: Modern's "+10" beside it changes too. */
  function paintPartner(td) {
    const [roomId, service, seg] = td.dataset.k.split('|');
    if (service !== 'vintage') return;
    const m = $(`td[data-k="${CSS.escape(key(roomId, 'modern', seg))}"]`, td.closest('table'));
    if (m && s.edit?.td !== m) paintCell(m);
  }

  function countTo(td, from, to) {
    const b = $('.hl-n b', td);
    const v = $('.hl-v', td);
    if (!b || !v) return;
    requestAnimationFrame(() => { v.setAttribute('style', lit(to)); });
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 520);
      const e = 1 - (1 - p) ** 3;
      b.textContent = String(Math.round(from + (to - from) * e));
      if (p < 1 && b.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ edit ---
  function startEdit(td) {
    if (!td?.dataset.k || s.asking) return;
    if (s.edit) stopEdit();
    const { x, service, seg } = rowOf(td);
    const lv = s.levels.get(td.dataset.k);
    s.edit = { td, key: td.dataset.k };
    td.classList.add('is-edit');
    td.innerHTML = `<label class="hl-ed"><input class="hl-input" type="text" inputmode="numeric" autocomplete="off" maxlength="4" value="${lv ? lv.level : ''}"
      aria-label="${esc(`${x.campus.short_name} ${SEGMENTS.find(([id]) => id === seg)[1]}, ${service}: level, 0 to 100. Enter to save, Esc to cancel`)}"><span>%</span></label>`;
    const input = $('input', td);
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(td, input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); stopEdit(); }
    });
    // Leaving it: the ✓ over a phone's keyboard, tapping away, the Tab key. A new level asks
    // "Are you sure?" just like Enter; the same level (or switching away from the app) puts it back.
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!alive || s.edit?.td !== td || s.asking || !td.isConnected) return;
        if (document.visibilityState === 'hidden') { stopEdit(); return; }
        submit(td, input.value, { leaving: true });
      }, 0);
    });
  }

  function stopEdit() {
    const ed = s.edit;
    s.edit = null;
    if (ed?.td.isConnected) paintCell(ed.td, { from: s.levels.get(ed.key)?.level ?? null });
  }

  async function submit(td, raw, { leaving = false } = {}) {
    const text = String(raw).trim().replace(/\s*%$/, '');
    let next = null;
    if (text !== '') {
      if (!/^\d{1,3}$/.test(text) || Number(text) > 100) {
        td.classList.remove('is-bad'); void td.offsetWidth; td.classList.add('is-bad');
        ctx.toast('Type a level from 0 to 100.');
        if (leaving) stopEdit(); // the keyboard's gone: put it back rather than leave it red
        return;
      }
      next = Number(text);
    }
    const k = td.dataset.k;
    const was = s.levels.get(k) || null;
    if ((was?.level ?? null) === next) { stopEdit(); return; }
    const { x, service, seg } = rowOf(td);
    s.asking = true;
    const yes = await hudConfirm({
      title: 'Are you sure you want to confirm this change?',
      where: `${x.campus.short_name} · ${x.room.name} · ${SEGMENTS.find(([id]) => id === seg)[1]} · ${SERVICES[s.week].find(([id]) => id === service)?.[1] || service}`,
      from: was ? `${was.level}%` : '',
      to: next == null ? '' : `${next}%`,
      note: was ? `Set by ${[was.who, was.updated_at ? timeAgo(was.updated_at) : ''].filter(Boolean).join(', ')}` : '',
      yes: 'Yes',
      no: 'Cancel',
    });
    s.asking = false;
    if (!alive) return;
    if (!yes) { stopEdit(); return; }
    s.edit = null;
    // Show it now; put it back if it doesn't save.
    if (next == null) s.levels.delete(k);
    else s.levels.set(k, { level: next, updated_at: new Date().toISOString(), who: ctx.me.full_name || '' });
    paintCell(td, { from: was?.level ?? null });
    paintPartner(td);
    try {
      const [roomId, svc, sg] = k.split('|');
      await ctx.store.houseLightSet(roomId, svc, sg, next);
    } catch (e) {
      if (was) s.levels.set(k, was); else s.levels.delete(k);
      if (td.isConnected) { paintCell(td, { from: next }); paintPartner(td); }
      ctx.toast(e.message, 'bad');
    }
  }

  // ---------------------------------------------------- Sundays ⇄ Wednesdays ---
  function markWeek() {
    $$('.hl-week [data-week]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.week === s.week)));
  }

  function fitStage() {
    const stage = $('.hl-stage', body);
    const wrap = stage && $('.hl-wrap.is-active', stage);
    if (!stage || !wrap) return;
    stage.style.height = `${wrap.offsetHeight + (stage.offsetHeight - stage.clientHeight)}px`;
  }

  /** What's on the sheet goes out (top left to bottom right), the frame eases to the other's
   *  height as their lines cross over, then the other's comes in the same way. */
  function switchWeek(w) {
    if (w === s.week || s.busy || s.asking) return;
    if (s.edit) stopEdit();
    s.week = w;
    try { sessionStorage.setItem(WEEK_KEY, w); } catch { /* private mode */ }
    markWeek();
    const stage = $('.hl-stage', body);
    const from = stage && $('.hl-wrap.is-active', stage);
    const to = stage && $(`.hl-wrap[data-wk="${w}"]`, stage);
    if (!from || !to || still()) {
      from?.classList.remove('is-active'); to?.classList.add('is-active'); fitStage();
      return;
    }
    s.busy = true;
    const span = (wrap) => { const t = $('.hl-t', wrap); return { t, rows: Number(t?.style.getPropertyValue('--rows')) || 4, cols: Number(t?.style.getPropertyValue('--cols')) || 6 }; };
    const a = span(from);
    const b = span(to);
    a.t?.classList.add('hl-out');
    setTimeout(() => {
      if (!alive) return;
      b.t?.classList.add('hl-hide');
      to.classList.add('is-active', 'is-entering');
      from.classList.remove('is-active');
      from.classList.add('is-leaving');
      stage.classList.add('is-moving');
      void stage.offsetWidth;
      to.classList.remove('is-entering');
      fitStage();
      setTimeout(() => {
        if (!alive) return;
        from.classList.remove('is-leaving');
        a.t?.classList.remove('hl-out');
        stage.classList.remove('is-moving');
        if (b.t) { b.t.classList.add('hl-in'); void b.t.offsetWidth; b.t.classList.remove('hl-hide'); }
        setTimeout(() => { b.t?.classList.remove('hl-in'); s.busy = false; }, b.rows * 30 + b.cols * 22 + 420);
      }, 380);
    }, a.rows * 16 + a.cols * 12 + 180);
  }
}
