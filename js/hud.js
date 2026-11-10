// Small pieces in the console look, shared by pages that use it.
//
// hudConfirm({ title, where, from, to, note, yes, no, showChange, danger }): "Are you sure?" in a
//   box over the page (dimmed and blurred behind it), opening out from a line. Resolves true for
//   Yes; false for Cancel, Esc or a tap outside it. `from` and `to` show what changes
//   (40% → 55%); showChange: false leaves that out (Remove, Leave without saving). danger: Yes
//   in red.

import { esc, icon } from './util.js';

export function hudConfirm({ title = 'Confirm this change?', where = '', from = '', to = '', note = '', yes = 'Yes, change it', no = 'Cancel', showChange = true, danger = false } = {}) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = document.createElement('div');
    root.className = `hc-root${still ? ' is-still' : ''}${danger ? ' is-danger' : ''}`;
    root.innerHTML = `<div class="hc-box" role="alertdialog" aria-modal="true" aria-labelledby="hc-t" aria-describedby="hc-d">
        <i class="hc-scan" aria-hidden="true"></i>
        <p class="hc-where">${esc(where)}</p>
        <h2 id="hc-t">${esc(title)}</h2>
        ${showChange ? `<div class="hc-change" id="hc-d">
          <span class="hc-from ${from ? '' : 'is-none'}">${esc(from || 'Not set')}</span>
          ${icon('chevron')}
          <span class="hc-to ${to ? '' : 'is-none'}">${esc(to || 'Removed')}</span>
        </div>` : ''}
        ${note ? `<p class="hc-note" ${showChange ? '' : 'id="hc-d"'}>${esc(note)}</p>` : ''}
        <div class="hc-acts">
          <button type="button" class="hc-no" data-hc="no">${esc(no)}</button>
          <button type="button" class="hc-yes" data-hc="yes">${icon('check')}${esc(yes)}</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    document.documentElement.classList.add('hc-on');
    // Not the Enter that opened it: only a fresh press says yes.
    let armed = false;
    setTimeout(() => { armed = true; }, 180);
    root.querySelector('.hc-yes').focus({ preventScroll: true });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      const gone = () => { root.remove(); if (!document.querySelector('.hc-root')) document.documentElement.classList.remove('hc-on'); back?.focus?.({ preventScroll: true }); };
      if (still) gone(); else { root.classList.add('is-out'); setTimeout(gone, 200); }
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && !armed) { e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Tab') { // keep focus in the box
        const bs = [...root.querySelectorAll('button')];
        const i = bs.indexOf(document.activeElement);
        e.preventDefault();
        bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-hc]');
      if (b) { if (b.dataset.hc === 'yes' && !armed) return; finish(b.dataset.hc === 'yes'); return; }
      if (!e.target.closest('.hc-box')) finish(false);
    });
  });
}

// hudPanel({ label, className, beforeClose }): a larger box in the same look, for a form or
// details: over the page (dimmed and blurred), opening out from a line. Fill it with
// render(html): usually a .hp-head (crumb, h2, a [data-close] button), a .hp-body that
// scrolls, and a .hp-foot. Esc, a tap outside it or a [data-close] closes it; beforeClose
// can say no (unsaved changes). Returns { el, box, render, close(force) }.
export function hudPanel({ label = '', className = '', beforeClose } = {}) {
  const back = document.activeElement;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.createElement('div');
  root.className = `hp-root${still ? ' is-still' : ''}`;
  root.innerHTML = `<div class="hp-box ${className}" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1">
      <i class="hc-scan" aria-hidden="true"></i><div class="hp-in"></div></div>`;
  document.body.appendChild(root);
  document.documentElement.classList.add('hp-on');
  const box = root.querySelector('.hp-box');
  const el = root.querySelector('.hp-in');
  let closing = false;
  const api = {
    el, box,
    /** keepScroll: the same form drawn again; its body stays where it was. */
    render(html, { keepScroll = false } = {}) {
      const at = keepScroll ? el.querySelector('.hp-body')?.scrollTop : 0;
      el.innerHTML = html;
      if (at) { const b = el.querySelector('.hp-body'); if (b) b.scrollTop = at; }
    },
    async close(force = false) {
      if (closing) return;
      if (!force && beforeClose && (await beforeClose()) === false) return;
      closing = true;
      document.removeEventListener('keydown', onKey);
      const gone = () => { root.remove(); if (!document.querySelector('.hp-root')) document.documentElement.classList.remove('hp-on'); back?.focus?.({ preventScroll: true }); };
      if (still) gone(); else { root.classList.add('is-out'); setTimeout(gone, 220); }
    },
  };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.hc-root')) { e.preventDefault(); api.close(); } };
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { api.close(); return; }
    if (!e.target.closest('.hp-box')) api.close();
  });
  box.focus({ preventScroll: true });
  return api;
}
