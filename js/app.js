// App shell: picks the data source, handles accounts, draws the sidebar and
// hosts each page (Gear, Software, Audio, Video, Lighting, Network, Logistics, Settings).

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, APP_NAME, ORG_NAME } from './config.js';
import { esc, icon, $, $$, storage, store as save } from './util.js';
import { createDemoStore } from './store-demo.js';
import * as NetworkView from './views/network.js';
import * as GearView from './views/gear.js';
import * as TeamView from './views/team.js';
import * as ResiView from './views/resi.js';
import * as ServicesView from './views/services.js';
import * as MeetingsView from './views/meetings.js';
import * as CablesView from './views/cables.js';
import * as StatsView from './views/stats.js';
import * as AccountView from './views/account.js';

const ROLE_ORDER = ['pending', 'volunteer', 'contractor', 'staff', 'admin'];
export const roleAtLeast = (role, min) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
export const ROLE_LABEL = { pending: 'Waiting for approval', volunteer: 'Volunteer', contractor: 'Contractor', staff: 'Staff', admin: 'Admin' };

// The sidebar. Each group is a page of its own (Gear, Audio…) with pages
// under it in a dropdown, or just a folder of pages (PCO, Logistics). The id is the
// address (#fixtures). Gear pages are the Gear view opened on one section,
// category or tab: `scope` says which, and the Section/Category filters it
// locks are hidden there. Pages show for anyone at or above `minRole`.
// Grid is built (gear.js drawGrid) but not offered for now: Models and Items only.
// Software is the Gear view over computers: what runs on them and which version (and a tab on every gear page).
const GEAR_TABS = ['types', 'models', 'software'];
const NAV = [
  { id: 'gear', label: 'Gear', short: 'Gear', icon: 'box', minRole: 'staff', view: GearView, title: 'Gear',
    scope: null, // the whole Gear view, filters and all
    children: [
      { id: 'cables', label: 'Cables', minRole: 'staff', view: CablesView },
    ] },
  { id: 'software', label: 'Software', icon: 'app', minRole: 'staff', view: GearView, title: 'Software', scope: { modes: ['software'] } },
  { id: 'audio', label: 'Audio', menuLabel: 'All audio', icon: 'sound', minRole: 'staff', view: GearView,
    scope: { dep: 'audio', modes: GEAR_TABS } },
  { id: 'video', label: 'Video', menuLabel: 'All video', icon: 'video', minRole: 'staff', view: GearView,
    scope: { dep: 'video', modes: GEAR_TABS },
    children: [
      { id: 'cameras', label: 'Cameras', minRole: 'staff', view: GearView, scope: { modes: ['cameras'] } },
    ] },
  { id: 'lighting', label: 'Lighting', menuLabel: 'All lighting', icon: 'bulb', minRole: 'staff', view: GearView,
    scope: { dep: 'lighting', modes: GEAR_TABS },
    children: [
      // Fixtures: the sheet of every light, location and room only (its grid is built, just not offered yet: add 'grid').
      { id: 'fixtures', label: 'Fixtures', minRole: 'staff', view: GearView, scope: { dep: 'lighting', cat: 'Fixture', modes: ['fixtures'] } },
      { id: 'hazers', label: 'Hazers', minRole: 'staff', view: GearView, scope: { modes: ['haze'] } },
      { id: 'patch', label: 'Patch', minRole: 'staff', view: GearView, scope: { modes: ['patch'] } },
      // Rigging: each room's battens and trusses, front to back, and the lights on each.
      { id: 'rigging', label: 'Rigging', minRole: 'staff', view: GearView, scope: { modes: ['rig'] } },
    ] },
  { id: 'network-gear', label: 'Network', menuLabel: 'All network', icon: 'network', minRole: 'staff', view: GearView,
    scope: { dep: 'network', modes: GEAR_TABS },
    children: [
      { id: 'network', label: 'IP sheet', minRole: 'staff', view: NetworkView },
    ] },
  // PCO: Planning Center, one page per view of it. They all share the Services view;
  // `scope.mode` says which one it opens on (the tabs it used to have are these pages).
  { id: 'pco', label: 'PCO', icon: 'calendar', folder: true,
    children: [
      { id: 'services', label: 'Services', icon: 'calendar', minRole: 'volunteer', view: ServicesView, scope: { mode: 'services' } },
      { id: 'scheduling', label: 'Scheduling', icon: 'list', minRole: 'volunteer', view: ServicesView, scope: { mode: 'roster' } },
      { id: 'people', label: 'People', icon: 'team', minRole: 'staff', view: ServicesView, scope: { mode: 'people' } },
      { id: 'my-schedule', label: 'My schedule', icon: 'me', minRole: 'volunteer', view: ServicesView, scope: { mode: 'mine' } },
    ] },
  { id: 'logistics', label: 'Logistics', icon: 'clipboard', folder: true,
    children: [
      { id: 'meetings', label: 'Meetings', icon: 'chat', minRole: 'staff', view: MeetingsView },
      { id: 'resi', label: 'Resi', icon: 'live', minRole: 'volunteer', view: ResiView },
      { id: 'stats', label: 'Statistics', icon: 'chart', minRole: 'staff', view: StatsView },
      // Systems: gear that works together (an intercom). The Gear view on its one tab.
      { id: 'systems', label: 'Systems', icon: 'link', minRole: 'staff', view: GearView, scope: { modes: ['systems'] } },
      { id: 'team', label: 'Team', icon: 'team', minRole: 'staff', view: TeamView },
    ] },
];
const SETTINGS = { id: 'account', label: 'Settings', icon: 'settings', minRole: 'volunteer', view: AccountView };

const ctx = {
  appName: APP_NAME,
  orgName: ORG_NAME,
  store: null,
  me: null,
  campuses: [],
  departments: [],
  dep: {},
  campusById: new Map(),
  people: new Map(),
  roleAtLeast,
  roleLabel: ROLE_LABEL,
  roles: ROLE_ORDER,
  toast,
  openSheet,
  go: (id) => { location.hash = id; },
  // Cross-section jumps: the target section picks these up once its data loads.
  pending: null,
  openDevice: (id) => goWith('network', { open: id }),
  newDevice: (preset) => goWith('network', { newDevice: preset }),
  openType: (id) => goWith('gear', { type: id }),
  openSettings: (section) => goWith('account', { section }),
  openNetworkFlag: (flag) => goWith('network', { flag }),
  openGear: (filters) => goWith('gear', { filters }),
  openPatch: (universe) => goWith('patch', { patch: { universe } }),
  // Filters last only while the app is open: every launch starts at All, all locations.
  campus: 'all',
  gearFilters: { dep: 'all', cat: 'all', brand: 'all' },
  netFilters: { dep: 'all', flag: 'all' },
  reloadMe,
  setTheme,
};

let current = null;       // { id, instance }
let shellUserId = null;   // whose shell is on screen
let recovering = /type=recovery/.test(location.hash);
const appEl = () => $('#app');

// ------------------------------------------------------------------ boot --

// No zooming: pinch and double-tap zoom are off (CSS handles double-tap;
// Safari also needs its gesture events stopped to keep pinch from zooming).
function blockZoom() {
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
}

async function boot() {
  blockZoom();
  applyTheme();
  // Filters used to be remembered between launches; they now reset every time.
  for (const k of ['ucp.campus', 'ucp.geardep', 'ucp.geartags', 'ucp.gearcat', 'ucp.gearbrand', 'ucp.netdep', 'ucp.tags']) {
    try { localStorage.removeItem(k); } catch { /* private mode */ }
  }
  try {
    if (SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && !window.UCP_PREVIEW) {
      const { createSupabaseStore } = await import('./store-supabase.js');
      ctx.store = await createSupabaseStore(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    } else {
      ctx.store = createDemoStore();
    }
  } catch (e) {
    return fatal('Couldn’t load the app. Check your connection and reload.', e);
  }
  document.documentElement.dataset.mode = ctx.store.mode;

  ctx.store.onAuth((event) => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; renderSetPassword(); }
    else if (event === 'SIGNED_OUT') { teardown(); renderAuth(); }
    else if (event === 'SIGNED_IN' && !recovering) start();
  });
  window.addEventListener('hashchange', onHash);
  watchForUpdates();
  start();
}

// One start at a time. Supabase can report a sign-in while the first start is
// still loading; running two at once left Gear drawn into a page that was then
// replaced, so it looked empty until you switched tabs.
let starting = null;
function start() {
  if (!starting) starting = startOnce().finally(() => { starting = null; });
  return starting;
}

async function startOnce() {
  let session;
  try { session = await ctx.store.session(); } catch (e) { return fatal('Couldn’t check your sign-in.', e); }
  if (!session) { teardown(); return renderAuth(); }
  if (recovering) return renderSetPassword();

  let me;
  try { me = await ctx.store.me(); } catch (e) { return fatal('Couldn’t load your account.', e); }
  if (!me) { teardown(); return renderAuth('Your account isn’t set up yet. Try signing in again.'); }
  if (shellUserId === me.id && current) { ctx.me = me; return; }
  ctx.me = me;

  if (me.role === 'pending') { teardown(); return renderPending(); }

  try {
    const ref = await ctx.store.reference();
    ctx.campuses = ref.campuses;
    ctx.departments = ref.departments;
    ctx.dep = Object.fromEntries(ref.departments.map((d) => [d.slug, d]));
    ctx.campusById = new Map(ref.campuses.map((c) => [c.id, c]));
    for (const d of ref.departments) document.documentElement.style.setProperty(`--dep-${d.slug}`, d.color);
    // Each section's color for tags and dots, including sections added later (like Network).
    let depCss = document.getElementById('dep-css');
    if (!depCss) { depCss = document.createElement('style'); depCss.id = 'dep-css'; document.head.appendChild(depCss); }
    depCss.textContent = ref.departments.map((d) => `[data-dep="${CSS.escape(d.slug)}"]{--c:var(--dep-${CSS.escape(d.slug)})}`).join('');
    if (roleAtLeast(me.role, 'staff')) {
      const people = await ctx.store.profiles();
      ctx.people = new Map(people.map((p) => [p.id, p]));
    } else {
      ctx.people = new Map([[me.id, me]]);
    }
  } catch (e) {
    return fatal('Couldn’t load campuses.', e);
  }

  teardown(); // a fresh shell always gets a freshly mounted section
  renderShell();
  shellUserId = me.id;
  onHash();
}

async function reloadMe() {
  ctx.me = await ctx.store.me();
  if (roleAtLeast(ctx.me.role, 'staff')) {
    const people = await ctx.store.profiles();
    ctx.people = new Map(people.map((p) => [p.id, p]));
  }
  renderNav();
}

function teardown() {
  current?.instance?.unmount?.();
  current = null;
  shellUserId = null;
}

// ----------------------------------------------------------------- shell --

const canSee = (p) => roleAtLeast(ctx.me.role, p.minRole);

/** The sidebar for this person: the groups they can see, each with the pages under it they can see.
 *  Someone who can only see one folder (a volunteer: Services and Resi) gets its pages on their own. */
function visibleNav() {
  let groups = NAV.map((g) => {
    const children = (g.children || []).filter(canSee);
    const self = !g.folder && canSee(g);
    if (!self && !children.length) return null;
    return { ...g, folder: g.folder || !self, children };
  }).filter(Boolean);
  if (groups.length === 1 && groups[0].folder) groups = groups[0].children.map((c) => ({ ...c, children: [] }));
  return groups;
}

/** Every page this person can open, with the group it sits in (for the title and the sidebar). */
function visiblePages() {
  const out = [];
  for (const g of visibleNav()) {
    if (!g.folder) out.push({ ...g, group: g.id, parent: null });
    for (const c of g.children) out.push({ ...c, group: g.id, parent: g.short || g.label });
  }
  if (canSee(SETTINGS)) out.push({ ...SETTINGS, group: SETTINGS.id, parent: null });
  return out;
}

function renderShell() {
  appEl().innerHTML = `
    ${ctx.store.mode === 'demo' ? `<div class="demo-bar" role="note">Preview with example data. Nothing is saved.</div>` : ''}
    <div class="shell">
      <nav class="nav" id="app-nav" aria-label="Sections"></nav>
      <div class="nav-scrim" hidden></div>
      <div class="main">
        <header class="topbar">
          <button type="button" class="brand menu-btn" aria-controls="app-nav" aria-expanded="false" aria-label="Menu">${brandMark()}<span class="brand-name">${esc(APP_NAME)}</span></button>
        </header>
        <main id="view" tabindex="-1"></main>
      </div>
    </div>`;
  renderNav();
  // Phones and small iPads: Tally (top left) slides the sidebar in.
  $('.menu-btn').addEventListener('click', (e) => {
    lastPointer = e.pointerType || (e.detail === 0 ? 'keyboard' : 'touch');
    setRail(!$('.nav').classList.contains('is-open'));
    if (e.detail === 0) $('.nav a.on, .nav .nav-item')?.focus({ preventScroll: true }); // from the keyboard: into the menu
  });
}

// The sidebar's open dropdown: one at a time, so the list stays short. It's the
// group you're in unless you open another, and goes back to it when the rail closes.
const openGroups = new Set();

function renderNav() {
  const nav = $('.nav');
  if (!nav) return;
  const groups = visibleNav();
  nav.innerHTML = `
    <div class="nav-brand">${brandMark()}<div class="nav-label"><div class="brand-name">${esc(APP_NAME)}</div><div class="brand-org">${esc(ORG_NAME)}</div></div></div>
    <div class="nav-items">
      ${groups.map(groupHtml).join('')}
      ${canSee(SETTINGS) ? groupHtml({ ...SETTINGS, children: [], settings: true }) : ''}
    </div>
    ${canSee(SETTINGS) ? `<div class="nav-foot">${groupHtml({ ...SETTINGS, children: [], settings: true })}</div>` : ''}
    <a class="nav-user" href="#account" tabindex="-1">
      <span class="avatar">${esc((ctx.me.full_name || ctx.me.email)[0]?.toUpperCase() || '?')}</span>
      <span class="nav-user-text nav-label"><b>${esc(ctx.me.full_name || ctx.me.email)}</b><small>${esc(ROLE_LABEL[ctx.me.role])}</small></span>
    </a>`;
  wireNav(nav);
  markNav();
}

function groupHtml(g) {
  const kids = g.children || [];
  const open = openGroups.has(g.id);
  const labels = `${icon(g.icon)}<span class="nav-label">${esc(g.label)}</span><span class="nav-short">${esc(g.short || g.label)}</span>`;
  const head = g.folder
    ? `<button type="button" class="nav-item nav-folder" data-toggle="${g.id}" aria-expanded="${open}" aria-controls="sub-${g.id}">${labels}${icon('down', 'nav-caret')}</button>`
    : `<a class="nav-item" href="#${g.id}" data-mod="${g.id}">${labels}</a>${kids.length
      ? `<button type="button" class="nav-toggle" data-toggle="${g.id}" aria-expanded="${open}" aria-controls="sub-${g.id}" aria-label="${esc(g.label)} pages">${icon('down', 'nav-caret')}</button>` : ''}`;
  return `<div class="nav-group ${g.settings ? 'is-settings' : ''} ${kids.length ? 'has-kids' : ''}" data-group="${g.id}" data-open="${open}">
    <div class="nav-head">${head}</div>
    ${kids.length ? `<div class="nav-sub" id="sub-${g.id}">${kids.map((k) => `<a class="nav-sub-item" href="#${k.id}" data-mod="${k.id}">${esc(k.label)}</a>`).join('')}</div>` : ''}
  </div>`;
}

function setGroupOpen(id, open) {
  if (open) openGroups.clear();
  if (open) openGroups.add(id); else openGroups.delete(id);
  $$('.nav-group').forEach((g) => {
    const on = openGroups.has(g.dataset.group);
    g.dataset.open = String(on);
    $$('[data-toggle]', g).forEach((b) => b.setAttribute('aria-expanded', String(on)));
  });
}
/** Back to just the group you're in. */
function resetGroups() {
  const page = current && visiblePages().find((p) => p.id === current.id);
  if (page && $(`.nav-group[data-group="${CSS.escape(page.group)}"].has-kids`)) setGroupOpen(page.group, true);
  else { openGroups.clear(); setGroupOpen('', false); }
}

function markNav() {
  const page = current && visiblePages().find((p) => p.id === current.id);
  $$('.nav [data-mod]').forEach((a) => {
    const on = a.dataset.mod === current?.id;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $$('.nav-group').forEach((g) => g.classList.toggle('is-current', g.dataset.group === page?.group));
  resetGroups();
}

// ------------------------------------------------------ sidebar: rail and panel --
// From 860px wide the sidebar is a rail of icons. With a mouse it opens while
// the pointer is over it and closes when it leaves; on a touchscreen (iPad) the
// first tap opens it, picking a page closes it. Narrower than that it's hidden:
// Tally at the top left slides it in, and picking a page (or tapping beside it)
// slides it away.

const railMQ = matchMedia('(min-width: 860px)');
let railTimer = null;
let lastPointer = 'mouse';

function setRail(open) {
  clearTimeout(railTimer);
  const nav = $('.nav');
  if (!nav || nav.classList.contains('is-open') === open) return;
  nav.classList.toggle('is-open', open);
  const dim = open && (!railMQ.matches || lastPointer !== 'mouse');
  document.documentElement.classList.toggle('rail-open', dim);
  const scrim = $('.nav-scrim');
  if (scrim) scrim.hidden = !dim;
  $('.menu-btn')?.setAttribute('aria-expanded', String(open));
  if (!open) { $('.nav-items', nav)?.scrollTo({ top: 0 }); resetGroups(); }
}

function wireNav(nav) {
  if (nav.dataset.wired) return; // renderNav redraws the inside; the listeners stay
  nav.dataset.wired = '1';
  nav.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);
  nav.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || !railMQ.matches) return;
    clearTimeout(railTimer);
    railTimer = setTimeout(() => setRail(true), 60);
  });
  nav.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse' || !railMQ.matches) return;
    clearTimeout(railTimer);
    railTimer = setTimeout(() => setRail(false), 220);
  });
  // Tabbing into the sidebar opens it too.
  nav.addEventListener('focusin', () => { if (railMQ.matches && lastPointer === 'mouse') setRail(true); });
  nav.addEventListener('focusout', (e) => { if (railMQ.matches && !nav.contains(e.relatedTarget) && !nav.matches(':hover')) setRail(false); });

  nav.addEventListener('click', (e) => {
    const t = e.target.closest('a, button');
    if (!t) return;
    const group = t.closest('.nav-group');
    // A tap on the closed rail just opens it, with that group's pages showing.
    if (railMQ.matches && !nav.classList.contains('is-open') && lastPointer !== 'mouse') {
      e.preventDefault();
      setRail(true);
      if (group?.classList.contains('has-kids')) setGroupOpen(group.dataset.group, true);
      return;
    }
    if (t.dataset.toggle) {
      e.preventDefault();
      setGroupOpen(t.dataset.toggle, !openGroups.has(t.dataset.toggle));
      return;
    }
    // Picking a page closes the panel (and the rail after a tap).
    if (t.matches('a') && (!railMQ.matches || lastPointer !== 'mouse')) setTimeout(() => setRail(false), 0);
  });
  if (!wireNav.once) {
    wireNav.once = true; // these are on the page, so only once ever
    // Tapping the page beside an opened rail closes it.
    // Tapping beside an open panel or rail closes it.
    document.addEventListener('pointerdown', (e) => {
      const n = $('.nav');
      if (n?.classList.contains('is-open') && !n.contains(e.target) && !e.target.closest('.menu-btn')) setRail(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !$('.nav')?.classList.contains('is-open')) return;
      setRail(false);
      if (!railMQ.matches) $('.menu-btn')?.focus({ preventScroll: true });
    });
    railMQ.addEventListener?.('change', () => setRail(false));
  }
}

function goWith(mod, pending) {
  ctx.pending = pending;
  if (current?.id === mod) { current.instance?.unmount?.(); current = null; onHash(); }
  else location.hash = mod;
}

function onHash() {
  if (!ctx.me || !$('#view')) return;
  if (/access_token|type=/.test(location.hash)) return;
  if (updateReady && current && takeUpdate()) return; // going to another page: a good moment for the new version
  if (!railMQ.matches) setRail(false);
  const pages = visiblePages();
  const want = location.hash.replace('#', '');
  const page = pages.find((m) => m.id === want) || pages[0];
  if (current?.id === page.id && current.el?.isConnected) return;
  openSheetApi?.close(true); // leaving a section closes whatever was open on it
  current?.instance?.unmount?.();
  // A fresh container per section, so the last section's listeners go with it.
  const view = document.createElement('main');
  view.id = 'view';
  view.tabIndex = -1;
  $('#view').replaceWith(view);
  // Gear pages (Audio, Fixtures…) share the Gear view's look; each knows which page it is.
  const viewId = page.view === GearView ? 'gear' : page.view === NetworkView ? 'network' : page.view === ServicesView ? 'services' : page.id;
  view.className = `view view-${viewId} page-${page.id}`;
  ctx.page = { id: page.id, title: page.title || page.label, parent: page.parent, scope: page.scope || null };
  current = { id: page.id, el: view, instance: page.view.mount(view, ctx) };
  document.title = `${page.title || page.label} · ${APP_NAME}`;
  markNav();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------- accounts --

function authFrame(inner) {
  return `
    ${ctx.store.mode === 'demo' ? `<div class="demo-bar" role="note">Preview with example data. Any email and password signs in.</div>` : ''}
    <div class="auth">
      <div class="auth-card">
        <div class="auth-brand">${brandMark('lg')}<div><div class="brand-name">${esc(APP_NAME)}</div><div class="brand-org">${esc(ORG_NAME)} production team</div></div></div>
        ${inner}
      </div>
    </div>`;
}

function renderAuth(notice = '', tab = 'in') {
  document.title = `Sign in · ${APP_NAME}`;
  appEl().innerHTML = authFrame(`
    <div class="seg auth-tabs" role="tablist">
      <button type="button" role="tab" data-tab="in" aria-selected="${tab === 'in'}">Sign in</button>
      <button type="button" role="tab" data-tab="up" aria-selected="${tab === 'up'}">Create account</button>
    </div>
    <form id="auth-form" class="form" novalidate>
      ${tab === 'up' ? `<label class="field"><span>Your name</span><input id="a-name" name="name" autocomplete="name" required placeholder="First and last name"></label>` : ''}
      <label class="field"><span>Email</span><input id="a-email" name="email" type="email" autocomplete="email" inputmode="email" required placeholder="you@upstatechurch.org"></label>
      <label class="field"><span>Password</span><input id="a-pass" name="password" type="password" autocomplete="${tab === 'up' ? 'new-password' : 'current-password'}" required minlength="8" placeholder="${tab === 'up' ? 'At least 8 characters' : ''}"></label>
      <p class="form-msg" role="status">${esc(notice)}</p>
      <button class="btn primary block" type="submit">${tab === 'up' ? 'Create account' : 'Sign in'}</button>
      ${tab === 'in' ? `<button class="btn link" type="button" id="forgot">Forgot your password?</button>` : `<p class="fine">New accounts start with no access. An admin approves you and sets what you can see.</p>`}
    </form>`);

  $$('.auth-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => renderAuth('', b.dataset.tab)));
  $('#forgot')?.addEventListener('click', renderForgot);
  const form = $('#auth-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('.form-msg', form);
    const btn = $('button[type=submit]', form);
    // Read inputs by id: a form's own `name` property hides an input called "name".
    const email = $('#a-email', form).value.trim();
    const pass = $('#a-pass', form).value;
    const name = $('#a-name', form)?.value.trim() || '';
    if (tab === 'up' && !name) return (msg.textContent = 'Add your name so the team knows who you are.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return (msg.textContent = 'Enter your email address.');
    if (pass.length < 8) return (msg.textContent = 'Passwords are at least 8 characters.');
    btn.disabled = true; msg.textContent = tab === 'up' ? 'Creating your account…' : 'Signing in…';
    try {
      if (tab === 'up') {
        const { needsConfirm } = await ctx.store.signUp(name, email, pass);
        if (needsConfirm) {
          appEl().innerHTML = authFrame(`<div class="auth-note"><h2>Check your email</h2><p>We sent a confirmation link to <b>${esc(email)}</b>. Open it on this device, then sign in.</p><button class="btn block" id="back">Back to sign in</button></div>`);
          $('#back').addEventListener('click', () => renderAuth());
        }
      } else {
        await ctx.store.signIn(email, pass);
      }
    } catch (err) {
      msg.textContent = err.message; btn.disabled = false;
    }
  });
}

function renderForgot() {
  appEl().innerHTML = authFrame(`
    <form id="f-form" class="form" novalidate>
      <h2>Reset your password</h2>
      <p class="muted">Enter your email and we’ll send a link to set a new password.</p>
      <label class="field"><span>Email</span><input id="f-email" name="email" type="email" autocomplete="email" required></label>
      <p class="form-msg" role="status"></p>
      <button class="btn primary block" type="submit">Send reset link</button>
      <button class="btn link" type="button" id="back">Back to sign in</button>
    </form>`);
  $('#back').addEventListener('click', () => renderAuth());
  $('#f-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('.form-msg'); const email = $('#f-email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return (msg.textContent = 'Enter your email address.');
    msg.textContent = 'Sending…';
    try { await ctx.store.sendReset(email); msg.textContent = `If there’s an account for ${email}, a reset link is on its way.`; }
    catch (err) { msg.textContent = err.message; }
  });
}

function renderSetPassword() {
  teardown();
  appEl().innerHTML = authFrame(`
    <form id="p-form" class="form" novalidate>
      <h2>Set a new password</h2>
      <label class="field"><span>New password</span><input id="p-new" name="password" type="password" autocomplete="new-password" minlength="8" required placeholder="At least 8 characters"></label>
      <p class="form-msg" role="status"></p>
      <button class="btn primary block" type="submit">Save password</button>
    </form>`);
  $('#p-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('.form-msg'); const pass = $('#p-new').value;
    if (pass.length < 8) return (msg.textContent = 'Use at least 8 characters.');
    msg.textContent = 'Saving…';
    try {
      await ctx.store.setPassword(pass);
      recovering = false;
      history.replaceState(null, '', location.pathname);
      toast('Password saved');
      start();
    } catch (err) { msg.textContent = err.message; }
  });
}

function renderPending() {
  document.title = `Almost there · ${APP_NAME}`;
  appEl().innerHTML = authFrame(`
    <div class="auth-note">
      <h2>You’re signed up, ${esc((ctx.me.full_name || '').split(' ')[0] || 'friend')}</h2>
      <p>An admin needs to approve your account before you can see anything. Let your production lead know you’ve signed up as <b>${esc(ctx.me.email)}</b>.</p>
      <button class="btn primary block" id="again">Check again</button>
      <button class="btn link" id="out">Sign out</button>
    </div>`);
  $('#again').addEventListener('click', start);
  $('#out').addEventListener('click', () => ctx.store.signOut());
}

function fatal(text, err) {
  console.error(err);
  appEl().innerHTML = `<div class="auth"><div class="auth-card auth-note"><h2>Something went wrong</h2><p>${esc(text)}</p><p class="fine mono">${esc(err?.message || '')}</p><button class="btn primary block" onclick="location.reload()">Reload</button></div></div>`;
}

// ---------------------------------------------------------------- sheets --
// A panel that slides up on phones and in from the right on desktops.

let openSheetApi = null;

export function openSheet({ label = 'Details', className = '', render, beforeClose } = {}) {
  openSheetApi?.close(true);
  const root = document.createElement('div');
  root.className = 'sheet-root';
  root.innerHTML = `<div class="sheet-backdrop" data-close></div>
    <section class="sheet ${className}" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1"></section>`;
  document.body.appendChild(root);
  document.body.classList.add('sheet-open');
  const el = $('.sheet', root);
  const lastFocus = document.activeElement;

  const api = {
    el,
    /** keepScroll: the same screen drawn again (new data, a form opened in place), so its
     *  scrolling parts stay where they were instead of jumping back to the top. */
    render(html, { keepScroll = false } = {}) {
      const boxes = () => [...el.querySelectorAll('.sh-body, [data-keep-scroll]')];
      const at = keepScroll ? boxes().map((b) => b.scrollTop) : null;
      el.innerHTML = html;
      if (at) boxes().forEach((b, i) => { if (at[i]) b.scrollTop = at[i]; });
    },
    async close(force = false) {
      if (!force && beforeClose && (await beforeClose()) === false) return;
      root.classList.add('leaving');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { root.remove(); if (!$('.sheet-root')) document.body.classList.remove('sheet-open'); }, 180);
      if (openSheetApi === api) openSheetApi = null;
      lastFocus?.focus?.({ preventScroll: true });
    },
  };
  const onKey = (e) => { if (e.key === 'Escape') api.close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) api.close(); });
  openSheetApi = api;
  render?.(api);
  requestAnimationFrame(() => { root.classList.add('in'); el.focus({ preventScroll: true }); });
  return api;
}

// ----------------------------------------------------------------- toast --

let toastTimer;
export function toast(text, kind = '') {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = `toast show ${kind}`;
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ----------------------------------------------------------------- theme --

function applyTheme() {
  const t = storage('ucp.theme', 'dark');
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
function setTheme(t) { save('ucp.theme', t); applyTheme(); }

// -------------------------------------------------------- auto-updating --
// Open copies notice a new version and take it at a quiet moment, never under
// someone who's looking at the page: when they go to another page, when the app
// has sat untouched for 10 minutes, or when they come back after half an hour
// away. Not while a panel, menu or the filters are open, something is being typed,
// or a video is full screen (reloading would knock it out of full screen, and the
// browser window back to its old size).

let updateReady = false;
const QUIET_MS = 10 * 60 * 1000;
const AWAY_MS = 30 * 60 * 1000;
let lastTouch = Date.now();

function busyForUpdate() {
  return !!document.querySelector('.sheet-root, .dd-menu-root, .fp-root')
    || !!(document.fullscreenElement || document.webkitFullscreenElement)
    || !!document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]');
}
/** Reloads into the new version if one is waiting and nothing would be lost. */
function takeUpdate() {
  if (!updateReady || busyForUpdate()) return false;
  location.reload();
  return true;
}

function watchForUpdates() {
  if (ctx.store.mode !== 'live') return;
  let loaded = null;
  let hiddenAt = null;
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true });
  }
  const check = async () => {
    try {
      const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      const { v } = await r.json();
      if (loaded == null) loaded = v;
      else if (v !== loaded) updateReady = true;
    } catch { /* offline */ }
    if (updateReady && Date.now() - lastTouch > QUIET_MS) takeUpdate(); // left alone (a screen on the wall)
  };
  check();
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const away = hiddenAt && Date.now() - hiddenAt > AWAY_MS;
    hiddenAt = null;
    if (away && takeUpdate()) return; // back after a while: start fresh
    check();
  });
}

// ------------------------------------------------------------------ misc --

function brandMark(size = '') {
  return `<span class="mark ${size}" aria-hidden="true"><i></i><i></i><i></i></span>`;
}

boot();
