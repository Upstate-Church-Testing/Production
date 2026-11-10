// Small pieces in the console look, shared by pages that use it.
//
// hudConfirm({ title, where, from, to, note, yes, no }): "Are you sure?" in a box over the page
//   (dimmed and blurred behind it), opening out from a line. Resolves true for Yes; false for
//   Cancel, Esc or a tap outside it. `from` and `to` show what changes (40% → 55%).

import { esc, icon } from './util.js';

export function hudConfirm({ title = 'Confirm this change?', where = '', from = '', to = '', note = '', yes = 'Yes, change it', no = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = document.createElement('div');
    root.className = `hc-root${still ? ' is-still' : ''}`;
    root.innerHTML = `<div class="hc-box" role="alertdialog" aria-modal="true" aria-labelledby="hc-t" aria-describedby="hc-d">
        <i class="hc-scan" aria-hidden="true"></i>
        <p class="hc-where">${esc(where)}</p>
        <h2 id="hc-t">${esc(title)}</h2>
        <div class="hc-change" id="hc-d">
          <span class="hc-from ${from ? '' : 'is-none'}">${esc(from || 'Not set')}</span>
          ${icon('chevron')}
          <span class="hc-to ${to ? '' : 'is-none'}">${esc(to || 'Removed')}</span>
        </div>
        ${note ? `<p class="hc-note">${esc(note)}</p>` : ''}
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
