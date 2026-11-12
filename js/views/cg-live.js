// CG Live (a pilot): what each location's ProPresenter has on screen, as it changes. One
// sheet that fits the screen, in the console look, a line per location: a picture of the
// slide that's live (ProPresenter's own thumbnail of it; tap it to see it large), the
// presentation's name (large) and which slide it's on, what's showing (slide, media, or
// cleared), and when that Mac was last heard from. (The slide's words are collected too,
// but not shown for now.)
//
// Where it comes from: a small listener on the CG Mac (tools/cg-live) keeps a connection
// open to ProPresenter 7's own network API and passes each change to the cg-live function,
// which writes that location's row in cg_live, and its picture in cg_live_thumbs a moment
// later. This page is handed each new row by the database the moment it lands
// (store.subscribeCgLive), so nothing here polls. A picture that isn't of the slide the
// line says is live (the new one is still on its way) is dimmed until it is.
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
  const thumbs = new Map(); // campus id → its picture's row
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
    if (loaded) paint(row.campus_id, !had || had.slide_index !== row.slide_index || had.presentation !== row.presentation);
  }, (t) => {
    if (!alive) return;
    const had = thumbs.get(t.campus_id);
    if (had && Date.parse(had.req_at) > Date.parse(t.req_at)) return; // an older one, late
    thumbs.set(t.campus_id, t);
    if (loaded) paint(t.campus_id, false);
  });
  el.addEventListener('click', (e) => {
    const z = e.target.closest('.cl-zoom');
    if (z) { z.remove(); return; }
    const pic = e.target.closest('.cl-pic[data-c]');
    const t = pic && thumbs.get(pic.dataset.c);
    if (!t?.jpeg) return;
    const c = ctx.campusById.get(pic.dataset.c);
    const big = document.createElement('button');
    big.type = 'button';
    big.className = 'cl-zoom';
    big.setAttribute('aria-label', 'Close the picture');
    big.innerHTML = `<img src="data:image/jpeg;base64,${t.jpeg}" alt=""><span>${esc(c?.short_name || '')} · ${esc(rows.get(pic.dataset.c)?.presentation || '')} · tap to close</span>`;
    el.firstElementChild.append(big);
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
      const [list, pics] = await Promise.all([ctx.store.cgLive(), ctx.store.cgLiveThumbs()]);
      if (!alive) return;
      for (const t of pics) {
        const had = thumbs.get(t.campus_id);
        if (!had || Date.parse(t.req_at) >= Date.parse(had.req_at)) thumbs.set(t.campus_id, t);
      }
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
        <div class="cl-r cl-hd" role="row"><span>${both('Location', 'Loc')}</span><span>Slide</span><span>On screen</span><span>Showing</span><span>Heard</span></div>
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
    // (jpeg is base64 from our own function: only ever letters, digits, + / =)
    const off = quiet(r);
    const showing = r.cleared ? ['Cleared', 'is-clear'] : r.media_playing ? ['Media', 'is-media'] : ['Slide', 'is-slide'];
    const t = thumbs.get(c.id);
    const mine = t && t.jpeg && (!t.presentation_uuid || !r.presentation_uuid || t.presentation_uuid === r.presentation_uuid) && (t.slide_index == null || r.slide_index == null || t.slide_index === r.slide_index);
    const where = r.slide_index ? `Slide <b>${r.slide_index}</b>${r.slide_count ? ` of ${r.slide_count}` : ''}` : (r.cleared ? 'Nothing on screen' : 'No slide selected');
    return `${loc}
      <span class="cl-pic${t?.jpeg ? '' : ' is-none'}${mine && !r.cleared ? '' : ' is-old'}" ${t?.jpeg ? `data-c="${c.id}" role="button" tabindex="0" aria-label="${esc(`${c.short_name}: see the slide large`)}"` : ''}>${t?.jpeg ? `<img src="data:image/jpeg;base64,${t.jpeg}" alt="">` : '<i>No picture yet</i>'}</span>
      <span class="cl-now"><b>${esc(r.presentation || 'Nothing selected')}</b><span class="cl-text">${where}</span></span>
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
    const first = $('.cl-r:not(.cl-hd)', board);
    if (first) board.style.setProperty('--rowh', `${Math.floor(first.getBoundingClientRect().height)}px`); // the pictures are sized to their line
    for (const [id, r] of rows) $(`.cl-r[data-c="${CSS.escape(id)}"]`, body)?.classList.toggle('is-quiet', quiet(r));
  }
}
