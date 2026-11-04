// Filter dropdowns (Location, Section, Category, Brand…): a pill that shows the
// current choice and opens the app's own menu, a popover on iPad and computers,
// a sheet on phones, instead of the device's built-in list.
//
// On phones a toolbar can trade its row of pills for one Filters button
// (wireFilterButton): it opens a full page with the view tabs and every filter
// as taps, and Done goes back to the list.

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

/** An option, or one of a group's (a room group holds its rooms as `children`). */
export function findOption(list, v) {
  for (const o of list) {
    if (o.value === v) return o;
    const c = o.children?.find((x) => x.value === v);
    if (c) return { ...c, label: `${o.label} › ${c.label}` };
  }
  return null;
}

/**
 * Makes a pill work.
 *   label      what it filters, for the menu heading and screen readers
 *   options()  [{ value, label, count?, dep?, dot?, hint?, children? }] (the first is usually "All")
 *   get()      the current value;  set(value) when someone picks one
 *   unit       optional ['model', 'models'] (or a function returning it) to print beside counts
 * Returns { update() } to refresh the pill after the value or options change.
 */
export function wireDropdown(btn, { label, options, get, set, unit = null }) {
  const update = () => {
    const v = get();
    const opt = findOption(options(), v);
    $('.dd-value', btn).textContent = opt ? opt.label : 'All';
    btn.classList.toggle('is-set', v !== ALL && v != null);
    btn.setAttribute('aria-label', `${label}: ${opt ? opt.label : 'All'}. Change ${label.toLowerCase()}`);
  };
  btn.addEventListener('click', () => open());
  // The phone filter page reads the same choices.
  btn._dd = { label, options, get, unit, pick: (v) => { if (v !== get()) { set(v); update(); } } };
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
    const optHtml = (o, i, kid = false) => `<button type="button" class="dd-opt ${i === 0 && o.value === ALL ? 'is-first' : ''} ${kid ? 'is-kid' : ''}" role="option" data-v="${esc(o.value)}" aria-selected="${o.value === value}">
            ${o.dep ? `<i class="tag" data-dep="${esc(o.dep)}">${esc(o.label[0])}</i>` : ''}${o.dot ? `<i class="st-dot st-${esc(o.dot)}"></i>` : ''}
            <span class="dd-opt-name">${esc(o.label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span>
            ${o.count != null ? `<span class="dd-opt-count">${o.count}${u(o.count)}</span>` : '<span></span>'}
            <span class="dd-check">${o.value === value ? icon('check') : ''}</span>
          </button>`;
    const groupHtml = (o, i) => {
      const open = o.value === value || o.children.some((c) => c.value === value);
      return `<div class="dd-grp" data-open="${open}">
        <div class="dd-grp-row">${optHtml(o, i)}<button type="button" class="dd-grp-toggle" aria-expanded="${open}" aria-label="Rooms in ${esc(o.label)}">${icon('down')}</button></div>
        <div class="dd-kids">${o.children.map((c) => optHtml(c, -1, true)).join('')}</div>
      </div>`;
    };
    const root = document.createElement('div');
    root.className = `dd-menu-root ${phone ? 'as-sheet' : 'as-pop'}`;
    root.innerHTML = `
      <div class="dd-backdrop" data-close></div>
      <div class="dd-menu ${caps ? 'caps' : ''}" role="listbox" aria-label="${esc(label)}">
        <div class="dd-menu-head"><span>${esc(label)}</span>${phone ? `<button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button>` : ''}</div>
        <div class="dd-options">
          ${list.map((o, i) => (o.children ? groupHtml(o, i) : optHtml(o, i))).join('')}
        </div>
      </div>`;
    document.body.appendChild(root);
    const menu = $('.dd-menu', root);
    if (!phone) place(menu);
    btn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => root.classList.add('in'));
    const opts = () => $$('.dd-opt', root).filter((o) => o.offsetParent !== null); // rooms in a closed group are skipped
    (opts().find((o) => o.getAttribute('aria-selected') === 'true') || opts()[0]).focus();

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
      const all = opts();
      const i = all.indexOf(document.activeElement);
      const grp = document.activeElement?.closest?.('.dd-grp');
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); all[Math.min(all.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); all[Math.max(0, i - 1)].focus(); }
      else if (e.key === 'ArrowRight' && grp) { e.preventDefault(); toggle(grp, true); }
      else if (e.key === 'ArrowLeft' && grp) { e.preventDefault(); toggle(grp, false); $('.dd-grp-row .dd-opt', grp).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); all[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); all[all.length - 1].focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); close(); }
    };
    const toggle = (grp, on = grp.dataset.open !== 'true') => {
      grp.dataset.open = String(on);
      $('.dd-grp-toggle', grp).setAttribute('aria-expanded', String(on));
    };
    const onMove = () => { if (!phone) place(menu); };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, { passive: true });
    root.addEventListener('click', (e) => {
      const g = e.target.closest('.dd-grp-toggle');
      if (g) { toggle(g.closest('.dd-grp')); return; }
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

/**
 * Phones: one Filters button in the toolbar instead of the row of pills.
 *   bar     the .toolbar holding .search and .filters (pills wired with wireDropdown)
 *   page    the page element (its .mode-seg tabs show up as "Show", its .tally on Done)
 *   clear() puts every filter back (the page's own Clear)
 * The button counts the filters in use; the page lists the pills that are showing.
 */
export function wireFilterButton(bar, { page, clear = null }) {
  const filters = $('.filters', bar);
  bar.classList.add('has-fp');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fp-btn';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = `${icon('filter')}<span>Filters</span><b class="fp-n" hidden></b>`;
  filters.before(btn);

  const pills = () => $$('.dd', filters).filter((d) => !d.hidden && d._dd);
  const count = () => pills().filter((d) => d.classList.contains('is-set')).length;
  const refresh = () => {
    const n = count();
    const b = $('.fp-n', btn);
    b.hidden = !n;
    b.textContent = n;
    btn.classList.toggle('is-set', n > 0);
    btn.setAttribute('aria-label', n ? `Filters, ${n} in use` : 'Filters');
    btn.hidden = !pills().length && !$('.mode-seg', page);
  };
  new MutationObserver(refresh).observe(filters, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  refresh();
  btn.addEventListener('click', () => openPage());
  return { refresh };

  function openPage() {
    if ($('.fp-root')) return;
    const root = document.createElement('div');
    root.className = 'fp-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Filters');
    root.innerHTML = `
      <header class="fp-head">
        <h2>Filters</h2>
        <button type="button" class="btn link fp-clear" data-fp="clear">Clear all</button>
        <button type="button" class="icon-btn" data-fp="done" aria-label="Done">${icon('close')}</button>
      </header>
      <div class="fp-body"></div>
      <footer class="fp-foot"><button type="button" class="btn primary fp-done" data-fp="done"></button></footer>`;
    document.body.appendChild(root);
    document.documentElement.classList.add('fp-open');
    const body = $('.fp-body', root);
    let openKey = null; // the one filter that's open, by its label; the rest are closed pills
    draw();
    requestAnimationFrame(() => root.classList.add('in'));
    $('.fp-done', root).focus({ preventScroll: true });

    function chip(o, value, extra = '') {
      const on = o.value === value;
      const n = o.count != null ? `<small>${o.count}</small>` : '';
      return `<button type="button" class="fp-chip ${extra}" data-fv="${esc(o.value)}" aria-pressed="${on}">${o.dep ? `<i class="tag" data-dep="${esc(o.dep)}">${esc(o.label[0])}</i>` : ''}<span>${esc(o.label)}</span>${n}${extra.includes('is-group') ? icon('down') : ''}</button>`;
    }
    function draw() {
      const y = body.scrollTop;
      const seg = $('.mode-seg', page);
      const tabs = seg ? $$('[role="tab"]', seg).filter((t) => !t.hidden) : [];
      const sections = [];
      if (tabs.length > 1) {
        sections.push(`<section class="fp-sec"><h3>Show</h3><div class="fp-seg" role="tablist">${tabs.map((t, i) =>
          `<button type="button" role="tab" data-ft="${i}" aria-selected="${t.getAttribute('aria-selected') === 'true'}">${esc(t.textContent.trim())}</button>`).join('')}</div></section>`);
      }
      // Each filter is a pill showing its choice; tap it to open its choices (one open at a time).
      pills().forEach((d, i) => {
        const { label, options, get } = d._dd;
        const value = get();
        const list = options();
        const cur = findOption(list, value);
        const open = openKey === label;
        const chips = open ? list.map((o) => {
          if (!o.children) return chip(o, value);
          const inside = o.value === value || o.children.some((c) => c.value === value);
          return chip(o, value, `is-group ${inside ? 'is-open' : ''}`) + (inside
            ? `<div class="fp-kids" aria-label="Rooms in ${esc(o.label)}">${o.children.map((c) => chip(c, value)).join('')}</div>` : '');
        }).join('') : '';
        sections.push(`<section class="fp-sec fp-acc ${open ? 'is-open' : ''}" data-fd="${i}">
          <button type="button" class="dd fp-pill ${d.classList.contains('is-set') ? 'is-set' : ''}" data-fo="${esc(label)}" aria-expanded="${open}">
            <span class="dd-text"><span class="dd-label">${esc(label)}</span><span class="dd-value">${esc(cur?.label || 'All')}</span></span>
            ${cur?.count != null && value !== ALL ? `<span class="fp-pill-n">${cur.count}</span>` : ''}
            <span class="dd-caret">${icon('down')}</span></button>
          ${open ? `<div class="fp-chips">${chips}</div>` : ''}
        </section>`);
      });
      body.innerHTML = sections.join('') || '<p class="muted">Nothing to filter here.</p>';
      body.scrollTop = y;
      const shown = $('.tally b', page)?.textContent;
      const what = $('.tally > span', page)?.textContent;
      $('.fp-done', root).textContent = shown ? `Show ${shown} ${what || ''}`.trim() : 'Done';
      $('.fp-clear', root).hidden = !count();
    }
    const close = () => {
      root.classList.remove('in');
      root.classList.add('leaving');
      document.documentElement.classList.remove('fp-open');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => root.remove(), 200);
      btn.focus({ preventScroll: true });
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-fp]')?.dataset.fp;
      if (act === 'done') return close();
      if (act === 'clear') { clear?.(); draw(); return; }
      const tab = e.target.closest('[data-ft]');
      if (tab) {
        const seg = $('.mode-seg', page);
        $$('[role="tab"]', seg).filter((t) => !t.hidden)[Number(tab.dataset.ft)]?.click();
        draw();
        return;
      }
      const pill = e.target.closest('[data-fo]');
      if (pill) {
        openKey = openKey === pill.dataset.fo ? null : pill.dataset.fo;
        draw();
        if (openKey) $(`[data-fo="${CSS.escape(openKey)}"]`, root)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const c = e.target.closest('[data-fv]');
      if (!c) return;
      const d = pills()[Number(c.closest('[data-fd]').dataset.fd)];
      if (!d) return;
      d._dd.pick(c.dataset.fv);
      // A room group stays open to show its rooms; any other choice closes the pill.
      if (!c.classList.contains('is-group')) openKey = null;
      draw();
    });
  }
}
