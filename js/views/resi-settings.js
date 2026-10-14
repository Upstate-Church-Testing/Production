// Settings › Resi players: paste each campus's Resi web player.

import { esc, icon, $, debounce } from '../util.js';
import { parsePlayer, playerStatus, linkFor, shortId, EMBED_TYPES, STATE_LABEL } from '../resi.js';

export function mountResiSettings(box, ctx) {
  let alive = true;
  let streams = [];
  let error = null;
  let editing = null;   // { id?, campus_id, text, name, parsed, check }
  let ctrl = null;
  const status = new Map(); // stream id -> state, for the little pill on each row
  const recheck = debounce(() => runCheck(), 350);

  box.addEventListener('click', onClick);
  box.addEventListener('input', onInput);
  box.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'streams' && !editing) load(); }, 300));
  load();
  return { unmount() { alive = false; ctrl?.abort(); unsubscribe(); } };

  async function load() {
    try { streams = await ctx.store.streams(); error = null; } catch (e) { error = e.message; }
    if (!alive) return;
    render();
    // Show what each player is doing, quietly.
    const ask = ctx.store.resiStatus ? (st) => ctx.store.resiStatus(st) : (st) => playerStatus(st);
    await Promise.allSettled(streams.map(async (st) => { status.set(st.id, (await ask(st)).state); }));
    if (alive && !editing) render();
  }

  function render() {
    const byCampus = new Map(ctx.campuses.map((c) => [c.id, []]));
    for (const st of streams) byCampus.get(st.campus_id)?.push(st);
    const count = streams.length;
    box.innerHTML = `
      <div class="panel-head"><h2>Resi players</h2><span class="count">${count}</span></div>
      <p>Paste each campus’s Resi web player: the player link, the embed code, or just its ID. The Resi tab shows what every campus is streaming.</p>
      <p class="fine">In Resi Studio, open the web event profile (or web channel) and copy its embed code.</p>
      ${error ? `<p class="form-msg">${esc(error)}</p>` : ''}
      <ul class="rp-list">
        ${ctx.campuses.map((c) => {
          const list = byCampus.get(c.id) || [];
          const formHere = editing && editing.campus_id === c.id;
          return `<li class="rp-campus ${list.length ? '' : 'is-empty'}">
            <div class="rp-head">
              <b>${esc(c.short_name)}</b>
              ${!list.length && !formHere ? `<span class="muted">No player</span>` : ''}
              ${formHere ? '' : `<button type="button" class="btn small ${list.length ? 'ghost' : ''}" data-rp="add" data-campus="${c.id}">${icon('plus')}${list.length ? 'Another' : 'Add'}</button>`}
            </div>
            ${list.map((st) => (formHere && editing.id === st.id) ? '' : `<div class="rp-stream">
              <span class="rp-what"><b>${esc(st.name)}</b><small class="mono">${esc(shortId(st.embed_id))}${st.embed_type !== 'webchannel' ? ` · ${esc(EMBED_TYPES[st.embed_type])}` : ''}</small></span>
              ${status.has(st.id) ? `<span class="onair" data-state="${status.get(st.id)}">${esc(STATE_LABEL[status.get(st.id)] || '')}</span>` : ''}
              <button type="button" class="icon-btn" data-rp="edit" data-id="${st.id}" aria-label="Edit the ${esc(c.short_name)} player">${icon('edit')}</button>
            </div>`).join('')}
            ${formHere ? formHtml(c) : ''}
          </li>`;
        }).join('')}
      </ul>`;
    if (editing) $('#rp-paste', box)?.focus({ preventScroll: true });
  }

  function formHtml(c) {
    const e = editing;
    const p = e.parsed;
    const parsedLine = !e.text.trim() ? ''
      : p ? `<p class="rp-found">${icon('check')}<span>Player <span class="mono">${esc(shortId(p.embed_id))}</span>${p.embed_type !== 'webchannel' ? ` · ${esc(EMBED_TYPES[p.embed_type])}` : ''}</span></p>`
        : `<p class="rp-found bad">${icon('warn')}<span>No player ID in that. Paste the link or embed code from Resi.</span></p>`;
    return `<form class="rp-form" novalidate>
      <label class="field"><span>${esc(c.short_name)} player</span>
        <textarea id="rp-paste" rows="3" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="https://control.resi.io/webplayer/video.html?id=…">${esc(e.text)}</textarea></label>
      <div id="rp-parsed">${parsedLine}</div>
      <p class="rp-check" id="rp-check">${checkHtml()}</p>
      <label class="field"><span>Name</span><input id="rp-name" value="${esc(e.name)}" placeholder="Online" maxlength="80">
        <small class="hint">Only matters when a campus has more than one player, like Kids or Overflow.</small></label>
      <p class="form-msg" role="status"></p>
      <div class="rp-actions">
        ${e.id ? `<button type="button" class="btn ghost danger-text" data-rp="remove">${icon('trash')}Remove</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-rp="cancel">Cancel</button>
        <button type="submit" class="btn primary" ${p ? '' : 'disabled'}>Save</button>
      </div>
    </form>`;
  }

  function checkHtml() {
    const c = editing?.check;
    if (!editing?.parsed || !c) return '';
    if (c === 'checking') return 'Checking Resi…';
    if (c.state === 'live' || c.state === 'simlive') return `<b class="live-text">Live now</b>${c.title ? `: ${esc(c.title)}` : ''}`;
    if (c.state === 'replay' || c.state === 'ondemand' || c.state === 'on') return `Showing${c.title ? ` “${esc(c.title)}”` : ' a recording'} right now.`;
    if (c.state === 'offline') return 'Offline right now. That’s fine; it shows up when you go live.';
    if (c.state === 'missing') return '<span class="bad">Resi doesn’t recognize this player. Check that you copied the whole thing.</span>';
    return esc(c.message || 'Couldn’t check Resi just now. You can still save it.');
  }

  function onClick(e) {
    const b = e.target.closest('[data-rp]');
    if (!b) return;
    const a = b.dataset.rp;
    if (a === 'add') { editing = { campus_id: b.dataset.campus, text: '', name: '', parsed: null, check: null }; render(); }
    else if (a === 'edit') {
      const st = streams.find((x) => x.id === b.dataset.id);
      editing = { id: st.id, campus_id: st.campus_id, text: linkFor(st), name: st.name === 'Online' ? '' : st.name, parsed: { embed_id: st.embed_id, embed_type: st.embed_type }, check: null };
      render(); runCheck();
    }
    else if (a === 'cancel') { editing = null; ctrl?.abort(); render(); }
    else if (a === 'remove') remove();
  }

  function onInput(e) {
    if (!editing) return;
    if (e.target.id === 'rp-name') { editing.name = e.target.value; return; }
    if (e.target.id !== 'rp-paste') return;
    editing.text = e.target.value;
    const p = parsePlayer(editing.text);
    const same = p && editing.parsed && p.embed_id === editing.parsed.embed_id && p.embed_type === editing.parsed.embed_type;
    editing.parsed = p;
    // Update the hints without redrawing the textarea (keeps the cursor where it is).
    const c = ctx.campusById.get(editing.campus_id);
    const tmp = document.createElement('div');
    tmp.innerHTML = formHtml(c);
    $('#rp-parsed', box).innerHTML = $('#rp-parsed', tmp).innerHTML;
    $('button[type=submit]', box).disabled = !p;
    if (!same) { editing.check = null; $('#rp-check', box).innerHTML = ''; if (p) recheck(); }
  }

  async function runCheck() {
    if (!editing?.parsed) return;
    ctrl?.abort();
    const mine = (ctrl = new AbortController());
    const target = editing.parsed;
    editing.check = 'checking';
    paintCheck();
    try {
      const res = ctx.store.resiStatus ? await ctx.store.resiStatus(target) : await playerStatus(target, { signal: mine.signal });
      if (mine.signal.aborted || !editing || editing.parsed !== target) return;
      editing.check = res;
    } catch (e) {
      if (e.name === 'AbortError') return;
      editing.check = { state: 'error' };
    }
    paintCheck();
  }
  function paintCheck() { const p = $('#rp-check', box); if (p) p.innerHTML = checkHtml(); }

  async function save() {
    if (!editing?.parsed) return;
    const msg = $('.rp-form .form-msg', box);
    const btn = $('.rp-form button[type=submit]', box);
    btn.disabled = true; msg.textContent = 'Saving…';
    try {
      await ctx.store.saveStream({ id: editing.id, campus_id: editing.campus_id, name: editing.name, ...editing.parsed });
      const c = ctx.campusById.get(editing.campus_id);
      ctx.toast(`Saved the ${c?.short_name || ''} player`);
      editing = null;
      await load();
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  }

  async function remove() {
    const msg = $('.rp-form .form-msg', box);
    const b = $('[data-rp=remove]', box);
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.lastChild.textContent = 'Tap again to remove'; return; }
    try {
      await ctx.store.deleteStream(editing.id);
      ctx.toast('Player removed');
      editing = null;
      await load();
    } catch (err) { msg.textContent = err.message; }
  }
}
