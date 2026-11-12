// CG Live (a pilot): what each location's ProPresenter has on screen, as it changes. One
// sheet that fits the screen, in the console look, a line per location: the presentation's
// name (large), the text of the slide that's live, which slide it is, what's showing
// (slide, media, or cleared), and when that Mac was last heard from.
//
// Where it comes from: a small listener on the CG Mac (tools/cg-live) keeps a connection
// open to ProPresenter 7's own network API and passes each change to the cg-live function,
// which writes that location's row in cg_live. This page is handed each new row by the
// database the moment it lands (store.subscribeCgLive), so nothing here polls.
// A location with no listener yet says "Not set up"; one that's gone quiet for over two and
// a half minutes (the listener says "still here" every minute while ProPresenter is open)
// says "Not reporting" and dims, so an old slide is never taken for the live one.
// Staff and up.

import { esc, $, pageTitle } from '../util.js';
import { fitBoard, unlockPage, watchHeight } from '../fit.js';

const QUIET_MS = 150 * 1000;
const SHORT = { AND: 'AN', MAU: 'MLN' };
const both = (full, short) => (short && short !== full ? `<span class="lf">${esc(full)}</span><span class="ls">${esc(short)}</span>` : esc(full));
const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'Now';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export function mount(el, ctx) {
  let alive = true;
  const rows = new Map(); // campus id → its row
  let loaded = false;
  let offset = 0; // the server's clock minus this device's (from the newest row heard), so "2s ago" is right on any phone

  el.innerHTML = `<div class="cl" id="cl">
      <div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}<p class="cl-count" id="cl-count" role="status"></p></div></div>
      <div class="results cl-body" id="cl-body"><div class="loading"><div class="sk tall"></div></div></div>
    </div>`;
  const body = $('#cl-body', el);

  const unsubscribe = ctx.store.subscribeCgLive((row) => {
    if (!alive) return;
    const t = Date.parse(row.seen_at);
    if (Number.isFinite(t) && t - Date.now() > offset) offset = t - Date.now(); // heard just now: it can't be from the future
    const had = rows.get(row.campus_id);
    rows.set(row.campus_id, { ...had, ...row });
    if (loaded) paint(row.campus_id, !had || had.slide_text !== row.slide_text || had.presentation !== row.presentation);
  });
  const unwatch = watchHeight(() => fit());
  const ticker = setInterval(() => tick(), 1000);
  const onVisible = () => { if (document.visibilityState === 'visible') load(); };
  document.addEventListener('visibilitychange', onVisible);

  load();
  return {
    unmount() {
      alive = false;
      clearInterval(ticker);
      unwatch();
      unlockPage();
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };

  async function load() {
    try {
      const list = await ctx.store.cgLive();
      if (!alive) return;
      for (const r of list) {
        const had = rows.get(r.campus_id);
        if (!had || Date.parse(r.seen_at) >= Date.parse(had.seen_at)) rows.set(r.campus_id, r);
      }
    } catch (e) {
      if (alive && !loaded) body.innerHTML = `<div class="empty"><p>Couldn’t load CG Live: ${esc(e.message)}</p></div>`;
      return;
    }
    loaded = true;
    draw();
  }

  function now() { return Date.now() + offset; }
  function quiet(r) { return now() - Date.parse(r.seen_at) > QUIET_MS; }

  function draw() {
    body.innerHTML = `<div class="cl-board" style="--n:${ctx.campuses.length}">
        <div class="cl-r cl-hd" role="row"><span>${both('Location', 'Loc')}</span><span>On screen</span><span>Slide</span><span>Showing</span><span>Heard</span></div>
        ${ctx.campuses.map((c) => `<div class="cl-r" role="row" data-c="${c.id}">${line(c)}</div>`).join('')}
      </div>`;
    count();
    fit();
    document.fonts?.ready.then(() => { if (alive) fit(); });
  }

  function line(c) {
    const r = rows.get(c.id);
    const loc = `<span class="cl-loc"><b>${both(c.short_name, SHORT[c.code] || c.code)}</b></span>`;
    if (!r) return `${loc}<span class="cl-none">Not set up</span>`;
    const off = quiet(r);
    const showing = r.cleared ? ['Cleared', 'is-clear'] : r.media_playing ? ['Media', 'is-media'] : ['Slide', 'is-slide'];
    const text = (r.slide_text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
    return `${loc}
      <span class="cl-now"><b>${esc(r.presentation || 'Nothing selected')}</b>${text.length ? `<span class="cl-text">${text.map(esc).join('<i> / </i>')}</span>` : `<span class="cl-text is-none">${r.cleared ? 'Nothing on screen' : 'No text on this slide'}</span>`}</span>
      <span class="cl-ix">${r.slide_index ? `<b>${r.slide_index}</b>${r.slide_count ? `<i>/</i>${r.slide_count}` : ''}` : '<span class="cl-nil">—</span>'}</span>
      <span class="cl-st"><em class="${showing[1]}">${showing[0]}</em></span>
      <span class="cl-seen${off ? ' is-off' : ''}"><i></i><b data-seen="${esc(r.seen_at)}">${off ? 'Not reporting' : ago(now() - Date.parse(r.seen_at))}</b>${off ? `<small data-seen-ago="${esc(r.seen_at)}">${ago(now() - Date.parse(r.seen_at))}</small>` : ''}</span>`;
  }

  /** One location's line, drawn again (flash: what's on screen just changed). */
  function paint(campusId, flash) {
    const c = ctx.campusById.get(campusId);
    const row = c && $(`.cl-r[data-c="${CSS.escape(campusId)}"]`, body);
    if (!row) { if (c) draw(); return; }
    row.innerHTML = line(c);
    row.classList.toggle('is-quiet', quiet(rows.get(campusId)));
    if (flash && !matchMedia('(prefers-reduced-motion: reduce)').matches) { row.classList.remove('is-new'); void row.offsetWidth; row.classList.add('is-new'); }
    count();
  }

  /** Every second: the "heard" times move on, and a line that's gone quiet says so. */
  function tick() {
    if (!loaded) return;
    for (const [id, r] of rows) {
      const row = $(`.cl-r[data-c="${CSS.escape(id)}"]`, body);
      if (!row) continue;
      const off = quiet(r);
      if (off !== row.classList.contains('is-quiet')) { paint(id, false); continue; }
      const b = $('[data-seen]', row);
      const text = off ? 'Not reporting' : ago(now() - Date.parse(r.seen_at));
      if (b && b.textContent !== text) b.textContent = text;
      const sm = $('[data-seen-ago]', row);
      if (sm) sm.textContent = ago(now() - Date.parse(r.seen_at));
    }
  }

  function count() {
    const live = [...rows.values()].filter((r) => !quiet(r)).length;
    $('#cl-count', el).innerHTML = `<b>${live}</b> reporting <i>·</i> ${rows.size} set up`;
  }

  function fit() {
    const board = $('.cl-board', body);
    if (!board) return;
    fitBoard(board);
    for (const [id, r] of rows) $(`.cl-r[data-c="${CSS.escape(id)}"]`, body)?.classList.toggle('is-quiet', quiet(r));
  }
}
