// Resi: what each campus's web player is showing right now.
// Players are set up in Settings; this checks Resi every 30 seconds.

import { esc, icon, $, storage, store, plural, timeAgo, debounce } from '../util.js';
import { playerStatus, playerUrl, linkFor, ON_AIR, STATE_LABEL, spanText } from '../resi.js';

const POLL_MS = 30000;

export function mount(el, ctx) {
  let alive = true;
  const canEdit = ctx.roleAtLeast(ctx.me.role, 'staff');
  const demo = ctx.store.mode === 'demo';
  const s = {
    streams: null,
    error: null,
    status: new Map(),   // stream id -> what Resi says is on
    checkedAt: null,
    checking: false,
    // Phones start with posters (tap to play) to save data; bigger screens play everything.
    video: storage('ucp.resivideo', matchMedia('(min-width: 860px)').matches ? 'on' : 'off'),
    playing: new Set(),  // players started by hand while video is off
  };
  const tiles = new Map(); // stream id -> element, reused so players don't restart
  let timer = null;
  let ctrl = null;

  el.innerHTML = `
    <div class="page-head">
      <div class="head-row">
        <h1 class="h1" id="r-h1">Checking…</h1>
        ${canEdit ? `<button class="btn add-desktop" data-act="settings">${icon('settings')}<span>Players</span></button>` : ''}
      </div>
      <p class="head-meta" id="r-meta"></p>
      <div class="resi-tools">
        <button type="button" class="switch" role="switch" id="r-video" aria-checked="${s.video === 'on'}"><span class="switch-track"><i></i></span>Play video</button>
        <button type="button" class="btn small ghost" data-act="refresh">${icon('history')}<span>Check now</span></button>
      </div>
    </div>
    <div class="results resi" id="r-body">
      <div class="loading" id="r-loading">${'<div class="sk tall"></div>'.repeat(2)}</div>
      <section class="resi-group" id="r-on-wrap" hidden>
        <h2 class="resi-h">On now <span class="count" id="r-on-count"></span></h2>
        <div class="tv-grid" id="r-on"></div>
      </section>
      <section class="resi-group" id="r-off-wrap" hidden>
        <h2 class="resi-h">Not streaming <span class="count" id="r-off-count"></span></h2>
        <ul class="off-list" id="r-off"></ul>
      </section>
      <div id="r-extra"></div>
    </div>`;

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-play]');
    if (!t) return;
    if (t.dataset.play) { s.playing.add(t.dataset.play); sync(); }
    else if (t.dataset.act === 'settings') ctx.openSettings('resi');
    else if (t.dataset.act === 'refresh') checkAll(true);
    else if (t.dataset.act === 'retry') load();
  });
  $('#r-video', el).addEventListener('click', (e) => {
    s.video = s.video === 'on' ? 'off' : 'on';
    store('ucp.resivideo', s.video);
    s.playing.clear();
    e.currentTarget.setAttribute('aria-checked', String(s.video === 'on'));
    sync();
  });

  const onVisible = () => {
    if (document.visibilityState === 'visible') { checkAll(); schedule(); }
    else { clearInterval(timer); timer = null; }
  };
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (!table || table === 'streams') load(true); }, 300));
  const clock = setInterval(drawHead, 15000); // keeps "checked 20 sec ago" and live times fresh

  load();
  return {
    unmount() {
      alive = false;
      clearInterval(timer); clearInterval(clock); ctrl?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
    },
  };

  // ------------------------------------------------------------- data ---

  async function load(quiet = false) {
    try {
      s.streams = await ctx.store.streams();
      s.error = null;
    } catch (e) { s.error = e.message; }
    if (!alive) return;
    if (s.error) return drawError();
    if (!quiet) { await checkAll(); schedule(); }
    else { sync(); checkAll(); }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => checkAll(), POLL_MS);
  }

  async function checkAll(byHand = false) {
    if (!s.streams || !alive) return;
    ctrl?.abort();
    const mine = (ctrl = new AbortController());
    s.checking = true;
    drawHead();
    const ask = ctx.store.resiStatus ? (st) => ctx.store.resiStatus(st) : (st) => playerStatus(st, { signal: mine.signal });
    const results = await Promise.allSettled(s.streams.map(async (st) => [st.id, await ask(st)]));
    if (mine.signal.aborted || !alive) return;
    for (const r of results) if (r.status === 'fulfilled') s.status.set(r.value[0], r.value[1]);
    s.checkedAt = new Date();
    s.checking = false;
    sync();
    if (byHand) ctx.toast('Checked Resi');
  }

  // ---------------------------------------------------------- drawing ---

  function sorted() {
    const order = ctx.campuses.map((c) => c.id);
    return [...s.streams].sort((a, b) => order.indexOf(a.campus_id) - order.indexOf(b.campus_id)
      || (a.sort_order || 0) - (b.sort_order || 0) || String(a.created_at).localeCompare(String(b.created_at)));
  }

  function drawError() {
    $('#r-loading', el).hidden = true;
    $('#r-h1', el).textContent = 'Resi';
    $('#r-extra', el).innerHTML = `<div class="empty"><h3>Couldn’t load the players</h3><p>${esc(s.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
  }

  function sync() {
    if (!s.streams || !alive) return;
    if (s.streams.length && !s.checkedAt) return; // wait for the first check
    $('#r-loading', el).hidden = true;
    const list = sorted();
    const perCampus = new Map();
    for (const st of list) perCampus.set(st.campus_id, (perCampus.get(st.campus_id) || 0) + 1);

    // Drop tiles for players that were removed or pointed somewhere else.
    for (const [id, t] of tiles) {
      const st = list.find((x) => x.id === id);
      if (!st || t.dataset.embed !== `${st.embed_type}:${st.embed_id}`) { t.remove(); tiles.delete(id); }
    }
    const on = [];
    const off = [];
    for (const st of list) {
      const stat = s.status.get(st.id) || { state: 'loading' };
      (ON_AIR.has(stat.state) ? on : off).push([st, stat]);
    }
    const rank = (x) => (x[1].state === 'live' || x[1].state === 'simlive' ? 0 : 1); // live first, then campus order
    on.sort((a, b) => rank(a) - rank(b));
    place($('#r-on', el), on, 'on', perCampus);
    place($('#r-off', el), off, 'off', perCampus);
    $('#r-on-wrap', el).hidden = !on.length;
    $('#r-off-wrap', el).hidden = !off.length;
    $('#r-on-count', el).textContent = on.length;
    $('#r-off-count', el).textContent = off.length;
    drawExtra();
    drawHead();
  }

  /** Puts each tile in its list in order, moving as little as possible (moving a player restarts it). */
  function place(box, items, group, perCampus) {
    for (const [st, stat] of items) {
      let t = tiles.get(st.id);
      if (t && t.dataset.group !== group) { t.remove(); tiles.delete(st.id); t = null; }
      if (!t) {
        t = document.createElement(group === 'on' ? 'article' : 'li');
        t.className = group === 'on' ? 'tv' : 'off-row';
        t.dataset.group = group;
        t.dataset.embed = `${st.embed_type}:${st.embed_id}`;
        t.dataset.id = st.id;
        tiles.set(st.id, t);
      }
      if (group === 'on') fillTv(t, st, stat, perCampus); else fillOff(t, st, stat, perCampus);
    }
    let cursor = box.firstElementChild;
    for (const [st] of items) {
      const t = tiles.get(st.id);
      if (t === cursor) cursor = cursor.nextElementSibling;
      else box.insertBefore(t, cursor);
    }
  }

  function label(st, perCampus) {
    const campus = ctx.campusById.get(st.campus_id)?.short_name || 'Unknown campus';
    const sub = perCampus.get(st.campus_id) > 1 || (st.name && st.name !== 'Online') ? st.name : '';
    return { campus, sub };
  }

  function timeLine(stat) {
    if (stat.state === 'live' || stat.state === 'simlive') return stat.startedAt ? `Live for ${spanText((Date.now() - stat.startedAt) / 1000)}` : 'Live now';
    if (stat.state === 'replay') return stat.duration ? `Last service · ${spanText(stat.duration)}` : 'Last service';
    if (stat.state === 'ondemand') return 'On demand';
    return 'Playing';
  }

  function fillTv(t, st, stat, perCampus) {
    const { campus, sub } = label(st, perCampus);
    const wantVideo = s.video === 'on' || s.playing.has(st.id);
    if (!t.firstElementChild) {
      t.innerHTML = `
        <div class="tv-screen"></div>
        <div class="tv-info">
          <div class="tv-top"><span class="onair"></span><span class="tv-time"></span></div>
          <h3 class="tv-campus"><b></b><small></small></h3>
          <p class="tv-title"></p>
        </div>
        <a class="icon-btn tv-open" target="_blank" rel="noopener" aria-label="Open the player in a new tab">${icon('open')}</a>`;
    }
    const badge = $('.onair', t);
    badge.dataset.state = stat.state;
    badge.textContent = STATE_LABEL[stat.state] || stat.state;
    $('.tv-time', t).textContent = timeLine(stat);
    $('.tv-campus b', t).textContent = campus;
    $('.tv-campus small', t).textContent = sub;
    $('.tv-title', t).textContent = stat.title || 'Untitled event';
    $('.tv-open', t).href = linkFor(st);
    t.dataset.state = stat.state;

    const scr = $('.tv-screen', t);
    const player = scr.querySelector('iframe, .tv-fake');
    if (wantVideo && !player) {
      const muted = s.video === 'on';
      scr.innerHTML = demo
        ? `<div class="tv-fake"><span>Example video</span><small>The real Resi player plays here</small></div>`
        : `<iframe src="${esc(playerUrl(st, { autoplay: true, muted }))}" title="${esc(`${campus} Resi player`)}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen loading="lazy"></iframe>`;
    } else if (!wantVideo && (player || !scr.firstElementChild || scr.dataset.thumb !== (stat.thumb || ''))) {
      scr.dataset.thumb = stat.thumb || '';
      scr.innerHTML = `<button type="button" class="tv-poster" data-play="${st.id}" aria-label="Play ${esc(campus)}">
        ${stat.thumb ? `<img src="${esc(stat.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <span class="tv-play">${icon('play')}</span>
      </button>`;
    }
  }

  function fillOff(t, st, stat, perCampus) {
    const { campus, sub } = label(st, perCampus);
    const problem = stat.state === 'missing' || stat.state === 'error';
    const why = stat.state === 'missing' ? 'Resi doesn’t recognize this player'
      : stat.state === 'error' ? (stat.message || 'Couldn’t check Resi')
      : stat.state === 'loading' ? 'Checking…' : 'Offline';
    t.dataset.state = stat.state;
    t.innerHTML = `
      <span class="off-dot" aria-hidden="true"></span>
      <span class="off-name"><b>${esc(campus)}</b>${sub ? `<em>${esc(sub)}</em>` : ''}<small>${esc(why)}</small></span>
      ${problem && canEdit ? `<button class="btn small" data-act="settings">Fix</button>` : ''}
      <a class="icon-btn" href="${esc(linkFor(st))}" target="_blank" rel="noopener" aria-label="Open the ${esc(campus)} player in a new tab">${icon('open')}</a>`;
  }

  function drawExtra() {
    const box = $('#r-extra', el);
    if (!s.streams.length) {
      box.innerHTML = `<div class="empty">
        <h3>No Resi players yet</h3>
        <p>${canEdit ? 'Paste each campus’s Resi web player in Settings. Once it’s in, this shows what every campus is streaming.' : 'Once staff add each campus’s Resi player, you’ll see what every campus is streaming here.'}</p>
        ${canEdit ? `<div class="empty-actions"><button class="btn primary" data-act="settings">${icon('plus')}Add players</button></div>` : ''}
      </div>`;
      return;
    }
    const without = ctx.campuses.filter((c) => !s.streams.some((st) => st.campus_id === c.id));
    box.innerHTML = without.length && canEdit
      ? `<p class="result-note">No player yet for ${esc(without.map((c) => c.short_name).join(', '))}. <button class="btn link" data-act="settings">Add in Settings</button></p>`
      : '';
  }

  function drawHead() {
    if (!alive) return;
    const h1 = $('#r-h1', el);
    const meta = $('#r-meta', el);
    if (!s.streams) return;
    // Live times tick along between checks.
    for (const [id, t] of tiles) {
      const stat = s.status.get(id);
      if (stat && t.dataset.group === 'on') $('.tv-time', t).textContent = timeLine(stat);
    }
    if (!s.streams.length) { h1.textContent = 'Resi'; meta.textContent = ''; return; }
    if (!s.checkedAt) { h1.textContent = 'Checking…'; meta.textContent = `${plural(s.streams.length, 'player')}`; return; }
    const states = s.streams.map((st) => s.status.get(st.id)?.state);
    const live = states.filter((x) => x === 'live' || x === 'simlive').length;
    const other = states.filter((x) => ON_AIR.has(x) && x !== 'live' && x !== 'simlive').length;
    const off = states.length - live - other;
    h1.textContent = live ? `${live} live` : 'Nothing live';
    meta.innerHTML = [other ? `${other} replaying` : null, off ? `${off} offline` : null,
      s.checking ? 'checking…' : `checked ${timeAgo(s.checkedAt)}`].filter(Boolean).map(esc).join(' <i>·</i> ')
      + (demo ? ' <i>·</i> example data' : '');
  }
}
