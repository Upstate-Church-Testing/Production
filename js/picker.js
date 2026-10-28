// Filter dropdowns (Location, Section, Category, Brand…): a pill that shows the
// current choice and opens the app's own menu, a popover on iPad and computers,
// a sheet on phones, instead of the device's built-in list.

import { esc, icon, $, $$ } from './util.js';

export const ALL = 'all';
export const ALL_LOCATIONS = 'All locations';

export function locationName(ctx, id) {
  return id === ALL ? ALL_LOCATIONS : ctx.campusById.get(id)?.short_name || ALL_LOCATIONS;
}

/** The pill. `label` is the small heading inside it ("Location", "Section"…). */
export function dropdownHtml(id, label, cls = '') {
  return `<button type="button" class="dd ${cls}" id="${id}" aria-haspopup="listbox" aria-expanded="false">
    <span class="dd-text"><span class="dd-label">${esc(label)}</span><span class="dd-value"></span></span>
    <span class="dd-caret">${icon('down')}</span>
  </button>`;
}

/**
 * Makes a pill work.
 *   label      what it filters, for the menu heading and screen readers
 *   options()  [{ value, label, count?, dep?, dot?, hint? }] (the first is usually "All")
 *   get()      the current value;  set(value) when someone picks one
 *   unit       optional ['model', 'models'] (or a function returning it) to print beside counts
 * Returns { update() } to refresh the pill after the value or options change.
 */
export function wireDropdown(btn, { label, options, get, set, unit = null }) {
  const update = () => {
    const v = get();
    const opt = options().find((o) => o.value === v);
    $('.dd-value', btn).textContent = opt ? opt.label : 'All';
    btn.classList.toggle('is-set', v !== ALL && v != null);
    btn.setAttribute('aria-label', `${label}: ${opt ? opt.label : 'All'}. Change ${label.toLowerCase()}`);
  };
  btn.addEventListener('click', () => open());
  update();
  return { update };

  function open() {
    if (document.querySelector('.dd-menu-root')) return;
    const value = get();
    const list = options();
    const phone = matchMedia('(max-width: 599px)').matches;
    const caps = btn.classList.contains('caps');
    const words = typeof unit === 'function' ? unit() : unit;
    const u = (n) => (words ? ` ${n === 1 ? words[0] : words[1]}` : '');
    const root = document.createElement('div');
    root.className = `dd-menu-root ${phone ? 'as-sheet' : 'as-pop'}`;
    root.innerHTML = `
      <div class="dd-backdrop" data-close></div>
      <div class="dd-menu ${caps ? 'caps' : ''}" role="listbox" aria-label="${esc(label)}">
        <div class="dd-menu-head"><span>${esc(label)}</span>${phone ? `<button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button>` : ''}</div>
        <div class="dd-options">
          ${list.map((o, i) => `<button type="button" class="dd-opt ${i === 0 && o.value === ALL ? 'is-first' : ''}" role="option" data-v="${esc(o.value)}" aria-selected="${o.value === value}">
            ${o.dep ? `<i class="tag" data-dep="${esc(o.dep)}">${esc(o.label[0])}</i>` : ''}${o.dot ? `<i class="st-dot st-${esc(o.dot)}"></i>` : ''}
            <span class="dd-opt-name">${esc(o.label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span>
            ${o.count != null ? `<span class="dd-opt-count">${o.count}${u(o.count)}</span>` : '<span></span>'}
            <span class="dd-check">${o.value === value ? icon('check') : ''}</span>
          </button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(root);
    const menu = $('.dd-menu', root);
    if (!phone) place(menu);
    btn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => root.classList.add('in'));
    const opts = $$('.dd-opt', root);
    (opts.find((o) => o.getAttribute('aria-selected') === 'true') || opts[0]).focus();

    const close = (refocus = true) => {
      root.classList.remove('in');
      root.classList.add('leaving');
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove);
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
    const onMove = () => { if (!phone) place(menu); };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, { passive: true });
    root.addEventListener('click', (e) => {
      const o = e.target.closest('.dd-opt');
      if (o) { const v = o.dataset.v; close(); if (v !== get()) { set(v); update(); } return; }
      if (e.target.closest('[data-close]')) close();
    });
  }

  // Under the pill, kept on screen.
  function place(menu) {
    const r = btn.getBoundingClientRect();
    const w = Math.max(r.width, 280, Math.min(340, window.innerWidth - 24));
    const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    const below = window.innerHeight - r.bottom - 16;
    const above = r.top - 16;
    menu.style.width = `${w}px`;
    menu.style.left = `${left}px`;
    if (below >= 260 || below >= above) {
      menu.style.top = `${r.bottom + 8}px`; menu.style.bottom = '';
      menu.style.maxHeight = `${Math.max(200, below)}px`;
    } else {
      menu.style.top = ''; menu.style.bottom = `${window.innerHeight - r.top + 8}px`;
      menu.style.maxHeight = `${Math.max(200, above)}px`;
    }
  }
}

/** The location pill, wired. counts(): { [campusId|'all']: n } (optional). */
export function locationDropdown(ctx, btn, { get, set, counts = null, unit = null }) {
  return wireDropdown(btn, {
    label: 'Location',
    unit,
    get,
    set,
    options: () => {
      const c = counts?.() || {};
      return [{ value: ALL, label: ALL_LOCATIONS, count: c[ALL] }, ...ctx.campuses.map((x) => ({ value: x.id, label: x.short_name, count: c[x.id] }))];
    },
  });
}
