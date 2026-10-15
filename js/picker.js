// The location picker: a pill showing the current location that opens the
// app's own menu (a popover on iPad and computers, a sheet on phones)
// instead of the device's built-in list.

import { esc, icon, $, $$ } from './util.js';

export const ALL_LABEL = 'All locations';

export function locationName(ctx, id) {
  return id === 'all' ? ALL_LABEL : ctx.campusById.get(id)?.short_name || ALL_LABEL;
}

/** The pill. Put it in the page head; call wireLocationPicker once it's in the page. */
export function locationPill(id) {
  return `<button type="button" class="loc-pick" id="${id}" aria-haspopup="listbox" aria-expanded="false">
    <span class="loc-name"></span>
    <span class="loc-caret">${icon('down')}</span>
  </button>`;
}

/**
 * Makes the pill work.
 *   get()        current value ('all' or a campus id)
 *   set(value)   called when someone picks a location
 *   counts()     optional: { [campusId|'all']: number } and a unit, e.g. { counts, unit: 'models' }
 * Returns { update() } to refresh the pill's text.
 */
export function wireLocationPicker(ctx, btn, { get, set, counts }) {
  const update = () => {
    const v = get();
    $('.loc-name', btn).textContent = locationName(ctx, v);
    btn.setAttribute('aria-label', `Location: ${locationName(ctx, v)}. Change location`);
  };
  btn.addEventListener('click', () => openMenu());
  update();
  return { update };

  function openMenu() {
    if (document.querySelector('.loc-menu-root')) return;
    const value = get();
    const c = counts?.() || null;
    const options = [{ value: 'all', label: ALL_LABEL }, ...ctx.campuses.map((x) => ({ value: x.id, label: x.short_name }))];
    const phone = matchMedia('(max-width: 599px)').matches;
    const root = document.createElement('div');
    root.className = `loc-menu-root ${phone ? 'as-sheet' : 'as-pop'}`;
    root.innerHTML = `
      <div class="loc-backdrop" data-close></div>
      <div class="loc-menu" role="listbox" aria-label="Location" tabindex="-1">
        ${phone ? '<div class="loc-menu-head"><span>Location</span><button type="button" class="icon-btn" data-close aria-label="Close">' + icon('close') + '</button></div>' : ''}
        <div class="loc-options">
          ${options.map((o) => `<button type="button" class="loc-opt" role="option" data-v="${esc(o.value)}" aria-selected="${o.value === value}">
            <span class="loc-opt-name">${esc(o.label)}</span>
            ${c?.counts && c.counts[o.value] != null ? `<span class="loc-opt-count">${c.counts[o.value]} ${esc(c.counts[o.value] === 1 ? c.one || c.unit : c.unit)}</span>` : ''}
            <span class="loc-check">${o.value === value ? icon('check') : ''}</span>
          </button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(root);
    const menu = $('.loc-menu', root);
    if (!phone) place(menu);
    btn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => root.classList.add('in'));
    const opts = $$('.loc-opt', root);
    (opts.find((o) => o.getAttribute('aria-selected') === 'true') || opts[0]).focus({ preventScroll: false });

    const close = (refocus = true) => {
      root.classList.remove('in');
      root.classList.add('leaving');
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize);
      btn.setAttribute('aria-expanded', 'false');
      setTimeout(() => root.remove(), 160);
      if (refocus) btn.focus({ preventScroll: true });
    };
    const onKey = (e) => {
      const i = opts.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(opts.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); opts[Math.max(0, i - 1)].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); opts[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1].focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); close(); }
    };
    const onResize = () => { if (!phone) place(menu); };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, { passive: true });
    root.addEventListener('click', (e) => {
      const o = e.target.closest('.loc-opt');
      if (o) { const v = o.dataset.v; close(); if (v !== get()) { set(v); update(); } return; }
      if (e.target.closest('[data-close]')) close();
    });
  }

  // Under the pill, kept on screen.
  function place(menu) {
    const r = btn.getBoundingClientRect();
    const w = Math.max(280, Math.min(360, window.innerWidth - 24));
    const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    const top = r.bottom + 8;
    menu.style.width = `${w}px`;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.maxHeight = `${Math.max(240, window.innerHeight - top - 16)}px`;
  }
}
