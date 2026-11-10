// A person, full screen (Scheduling: a name on the grid, or someone in the Team column).
// In the console look, and it comes in like a screen powering up: a scan line runs down,
// the name tears in with its colours split, the photo resolves in steps, the badge drops in
// on its lanyard, then each panel boots in turn. Closing collapses it to a line.
//
// What it shows: their photo and name, where they serve, their lanyard (the badge they have,
// and a dropdown to change it: staff only), the spot that was tapped (each service that day
// and its answer, and the invite still to send), everything coming up, their teams in
// Planning Center, and their notes.
//
// host.get() builds what to show (services.js, from Planning Center and People), so it's
// drawn again after a change without replaying the entrance:
//   { name, photo, isMe, where, canLanyard, lanyard, lanyardNote, spot, upcoming, teams,
//     tags, notes (null: can't see), pcoUrl }
// host.goto(planId), host.setLanyard(kind|null), host.saveNotes(text), host.takeOff()

import { esc, icon, $, initials } from '../util.js';
import { badgeArt, noBadgeArt, microBadge } from '../lanyard.js';

const KINDS = [[null, 'None'], ['volunteer', 'Production Volunteer'], ['coach', 'Production Coach'], ['staff', 'Staff']];
const STATUS = { C: 'Confirmed', U: 'Requested', D: 'Declined' };

export function openPersonFull(ctx, host) {
  const back = document.activeElement;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ddOpen = false;
  let notesDraft = null;
  let sure = false;    // "Take off" asked once
  let closing = false;

  const root = document.createElement('div');
  root.className = `pv-root${still ? ' is-still' : ''}`;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  document.body.appendChild(root);
  document.documentElement.classList.add('pv-on');

  const vm0 = host.get();
  root.setAttribute('aria-label', vm0?.name || 'Person');
  root.innerHTML = `<div class="pv-fx" aria-hidden="true"><i class="pv-scan"></i></div><div class="pv-page"></div>`;
  const page = $('.pv-page', root);
  paint(true);
  $('[data-pv="close"]', root)?.focus({ preventScroll: true });
  // The entrance plays once; after that it's plain redraws.
  setTimeout(() => root.classList.add('is-in'), still ? 0 : 1400);

  root.addEventListener('click', onClick);
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'pv-notes') return;
    notesDraft = e.target.value;
    const b = $('[data-pv="notes"]', root);
    if (b) b.disabled = false;
  });
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (ddOpen) { toggleDd(false); $('.pv-dd-btn', root)?.focus(); return; }
    close();
  };
  document.addEventListener('keydown', onKey, true);

  return { close, refresh: () => paint(false) };

  function close() {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKey, true);
    const done = () => {
      root.remove();
      document.documentElement.classList.remove('pv-on');
      back?.focus?.({ preventScroll: true });
    };
    if (still) { done(); return; }
    root.classList.add('is-out');
    setTimeout(done, 260);
  }

  async function onClick(e) {
    const t = e.target.closest('[data-pv]');
    if (!t) {
      if (ddOpen && !e.target.closest('.pv-dd')) toggleDd(false);
      return;
    }
    const a = t.dataset.pv;
    if (a === 'close') { close(); return; }
    if (a === 'goto') { close(); host.goto(t.dataset.id); return; }
    if (a === 'dd') { toggleDd(!ddOpen); return; }
    if (a === 'lan') {
      const k = t.dataset.k || null;
      toggleDd(false);
      const vm = host.get();
      if ((vm.lanyard || null) === k) { $('.pv-dd-btn', root)?.focus(); return; }
      await host.setLanyard(k);
      paint(false);
      // the new badge glitches in
      const art = $('.pv-badge', root);
      if (art && !still) { art.classList.remove('is-swap'); void art.offsetWidth; art.classList.add('is-swap'); }
      $('.pv-dd-btn', root)?.focus();
      return;
    }
    if (a === 'notes') {
      const text = $('#pv-notes', root)?.value ?? '';
      t.disabled = true;
      try { await host.saveNotes(text.trim() || null); notesDraft = null; ctx.toast('Notes saved'); } catch (err) { ctx.toast(err.message, 'bad'); t.disabled = false; return; }
      paint(false);
      return;
    }
    if (a === 'takeoff') {
      if (!sure) { sure = true; paint(false); return; }
      t.disabled = true;
      try { await host.takeOff(); close(); } catch (err) { ctx.toast(err.message, 'bad'); t.disabled = false; }
    }
  }

  function toggleDd(on) {
    ddOpen = on;
    const dd = $('.pv-dd', root);
    if (!dd) return;
    dd.classList.toggle('is-open', on);
    $('.pv-dd-btn', dd)?.setAttribute('aria-expanded', String(on));
    if (on) ($('.pv-dd-list [aria-selected="true"]', dd) || $('.pv-dd-list button', dd))?.focus();
  }

  function paint(first) {
    const vm = host.get();
    if (!vm) { close(); return; }
    const keepScroll = page.scrollTop;
    const n = (i) => `style="--i:${i}"`;
    const statusChip = (st) => `<span class="pv-st st-${esc(st)}">${esc(STATUS[st] || STATUS.U)}</span>`;
    const lan = vm.lanyard || null;
    let i = 0;
    page.innerHTML = `
      <header class="pv-top">
        <span class="pv-crumb">${esc(vm.where || '')}</span>
        <button type="button" class="pv-x" data-pv="close" aria-label="Close">${icon('close')}</button>
      </header>

      <section class="pv-id">
        <div class="pv-photo pv-in" ${n(i++)}>
          ${vm.photo ? `<img src="${esc(vm.photo)}" alt="" referrerpolicy="no-referrer">` : `<span>${esc(initials(vm.name || '?'))}</span>`}
          <i class="pv-br tl"></i><i class="pv-br br"></i>
        </div>
        <div class="pv-who">
          <h1 class="pv-name" data-text="${esc(vm.name || 'Someone')}">${esc(vm.name || 'Someone')}${vm.isMe ? ' <em class="pv-you">You</em>' : ''}</h1>
          <p class="pv-places pv-in" ${n(i++)}>${esc(vm.places || 'No location yet')}</p>
        </div>
        ${vm.canLanyard ? `<div class="pv-lan pv-in" ${n(i++)}>
          <div class="pv-badge">${lan ? badgeArt(lan) : noBadgeArt()}</div>
          <div class="pv-dd ${ddOpen ? 'is-open' : ''}">
            <button type="button" class="pv-dd-btn" data-pv="dd" aria-haspopup="listbox" aria-expanded="${ddOpen}" aria-label="Lanyard: ${esc(KINDS.find(([k]) => k === lan)?.[1] || 'None')}. Change">
              ${lan ? microBadge(lan) : '<i class="pv-none-x" aria-hidden="true"></i>'}<span>${esc(KINDS.find(([k]) => k === lan)?.[1] || 'None')}</span>${icon('down')}
            </button>
            <div class="pv-dd-list" role="listbox" aria-label="Lanyard">
              ${KINDS.map(([k, label]) => `<button type="button" role="option" data-pv="lan" data-k="${k || ''}" aria-selected="${(lan || null) === k}">
                ${k ? microBadge(k) : '<i class="pv-none-x" aria-hidden="true"></i>'}<span>${esc(label)}</span>${(lan || null) === k ? icon('check') : ''}</button>`).join('')}
            </div>
          </div>
          <p class="pv-fine">${esc(vm.lanyardNote || '')}</p>
        </div>` : ''}
      </section>

      <div class="pv-grid ${vm.spot ? 'has-spot' : ''}">
        ${vm.spot ? `<div class="pv-col"><section class="pv-block pv-in is-spot" ${n(i++)}>
          <h2>${esc(vm.spot.title)}</h2>
          <p class="pv-sum is-${esc(vm.spot.status)}">${esc(vm.spot.summary)}</p>
          <ul class="pv-rows">${vm.spot.entries.map((x) => `<li><button type="button" class="pv-row" data-pv="goto" data-id="${esc(x.planId)}">
            <span class="pv-l st-${esc(x.status)}">${esc(x.letter || '•')}</span>
            <span class="pv-what"><b>${esc(x.kind)}</b><small>${esc(x.time)}</small></span>
            ${statusChip(x.status)}${icon('chevron', 'pv-go')}
          </button></li>`).join('')}</ul>
          ${vm.spot.invite ? `<div class="pv-invite">
            <p><b>Invite not sent yet.</b> Planning Center hasn’t emailed them, so it isn’t on their schedule. Open the plan, tap the ✉️ by their name, keep Email checked, and hit Send.</p>
            <div class="pv-acts">${vm.spot.invite.links.map((l) => `<a class="pv-btn" href="${esc(l.href)}" target="_blank" rel="noopener">${icon('open')}${esc(l.label)}</a>`).join('')}
              ${vm.spot.invite.canTakeOff ? `<button type="button" class="pv-btn is-bad" data-pv="takeoff">${icon('trash')}${sure ? `Tap again to take ${esc((vm.name || '').split(/\s+/)[0] || 'them')} off` : 'Take off'}</button>` : ''}</div>
          </div>` : ''}
        </section></div>` : ''}

        <div class="pv-col"><section class="pv-block pv-in" ${n(i++)}>
          <h2>Coming up</h2>
          ${vm.upcoming.length ? `<ul class="pv-rows">${vm.upcoming.map((u) => `<li><button type="button" class="pv-row" data-pv="goto" data-id="${esc(u.planId)}">
            <span class="pv-date"><b>${esc(u.day)}</b><small>${esc(u.date)}</small></span>
            <span class="pv-what"><b>${esc(u.what)}</b><small>${esc(u.detail)}</small></span>
            ${statusChip(u.status)}${icon('chevron', 'pv-go')}
          </button></li>`).join('')}</ul>` : '<p class="pv-empty">Not on the schedule in the coming weeks.</p>'}
        </section></div>

        <div class="pv-col"><section class="pv-block pv-in" ${n(i++)}>
          <h2>Teams in Planning Center</h2>
          ${vm.teams.length ? `<div class="pv-chips">${vm.teams.map((t) => `<span class="pv-chip"><b>${esc(t.team)}</b>${esc(t.place)}</span>`).join('')}</div>` : '<p class="pv-empty">Not on a production team.</p>'}
          ${vm.tags?.length ? `<div class="pv-chips is-tags">${vm.tags.map((t) => `<span class="pv-chip">${esc(t)}</span>`).join('')}</div>` : ''}
        </section>

        ${vm.notes !== null && vm.notes !== undefined ? `<section class="pv-block pv-in" ${n(i++)}>
          <h2>Notes</h2>
          <textarea id="pv-notes" rows="4" placeholder="Anything the team should know: what they’re learning, when they like to serve…">${esc(notesDraft ?? vm.notes ?? '')}</textarea>
          <div class="pv-acts"><button type="button" class="pv-btn" data-pv="notes" ${notesDraft == null ? 'disabled' : ''}>Save notes</button></div>
        </section>` : ''}</div>
      </div>

      ${vm.pcoUrl ? `<footer class="pv-foot pv-in" ${n(i++)}><a href="${esc(vm.pcoUrl)}" target="_blank" rel="noopener">${icon('open')}Open in Planning Center</a></footer>` : ''}`;
    if (!first) page.scrollTop = keepScroll;
  }
}
