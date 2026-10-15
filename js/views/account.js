// Settings: your profile, Resi players (staff), appearance, and signing out.

import { esc, icon, $, $$, storage } from '../util.js';
import { mountResiSettings } from './resi-settings.js';

export function mount(el, ctx) {
  const me = ctx.me;
  const theme = storage('ucp.theme', 'dark');
  const isStaff = ctx.roleAtLeast(me.role, 'staff');

  el.innerHTML = `
    <div class="page-head">
      <div class="head-row"><h1 class="h1">${esc(me.full_name || 'Your account')}</h1></div>
      <p class="head-meta">${esc(me.email)} <i>·</i> ${esc(ctx.roleLabel[me.role])}</p>
    </div>
    ${!isStaff ? `<section class="panel welcome"><h2>Welcome to ${esc(ctx.appName)}</h2><p>Service flows and training videos for volunteers are on the way. You’ll find them here as they’re added.</p></section>` : ''}
    <form class="panel form" id="me-form" novalidate>
      <h2>Profile</h2>
      <label class="field"><span>Name</span><input id="m-name" value="${esc(me.full_name)}" autocomplete="name"></label>
      <label class="field"><span>Home location</span>
        <select id="m-campus"><option value="">None</option>${ctx.campuses.map((c) => `<option value="${c.id}" ${c.id === me.home_campus_id ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select>
        <small class="hint">New items you add start at this location.</small></label>
      <div class="row-end"><p class="form-msg" role="status"></p><button class="btn primary" type="submit">Save</button></div>
    </form>
    ${isStaff ? '<section class="panel" id="resi-players"></section>' : ''}
    <section class="panel">
      <h2>Appearance</h2>
      <div class="seg" role="radiogroup" aria-label="Theme">
        ${[['dark', 'Dark'], ['light', 'Light'], ['system', 'Match device']].map(([v, l]) => `<button type="button" role="radio" data-theme-pick="${v}" aria-checked="${theme === v}" aria-selected="${theme === v}">${l}</button>`).join('')}
      </div>
    </section>
    <section class="panel">
      <h2>Put it on your home screen</h2>
      <p><b>iPhone:</b> open this page in Safari, tap the Share button, then <b>Add to Home Screen</b>.</p>
      <p><b>Android:</b> open it in Chrome, tap the ⋮ menu, then <b>Add to Home screen</b>.</p>
      <p class="fine">It opens full screen like an app and updates itself.</p>
    </section>
    <section class="panel">
      <button class="btn danger-text" id="signout">${icon('out')}Sign out</button>
      ${ctx.store.mode === 'demo' ? '<p class="fine">This is the preview. Sign-in goes live once the database is connected.</p>' : ''}
    </section>`;

  $('#me-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('.form-msg', el);
    const name = $('#m-name', el).value.trim();
    if (!name) { msg.textContent = 'Add your name.'; return; }
    msg.textContent = 'Saving…';
    try {
      await ctx.store.updateMe(me.id, { full_name: name, home_campus_id: $('#m-campus', el).value || null });
      await ctx.reloadMe();
      $('.h1', el).textContent = name;
      msg.textContent = '';
      ctx.toast('Saved');
    } catch (err) { msg.textContent = err.message; }
  });

  $$('[data-theme-pick]', el).forEach((b) => b.addEventListener('click', () => {
    ctx.setTheme(b.dataset.themePick);
    $$('[data-theme-pick]', el).forEach((x) => { const on = x === b; x.setAttribute('aria-checked', on); x.setAttribute('aria-selected', on); });
  }));

  $('#signout', el).addEventListener('click', () => ctx.store.signOut());

  const resi = isStaff ? mountResiSettings($('#resi-players', el), ctx) : null;
  if (ctx.pending?.section === 'resi') {
    ctx.pending = null;
    requestAnimationFrame(() => $('#resi-players', el)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
  return { unmount() { resi?.unmount(); } };
}
