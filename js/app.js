// App shell: picks the data source, handles accounts, and hosts each module
// (Gear, Network, Resi, Statistics, Team and Settings; schedules, training and more later).

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, APP_NAME, ORG_NAME } from './config.js';
import { esc, icon, $, $$, storage, store as save } from './util.js';
import { createDemoStore } from './store-demo.js';
import * as NetworkView from './views/network.js';
import * as GearView from './views/gear.js';
import * as TeamView from './views/team.js';
import * as ResiView from './views/resi.js';
import * as StatsView from './views/stats.js';
import * as AccountView from './views/account.js';

const ROLE_ORDER = ['pending', 'volunteer', 'contractor', 'staff', 'admin'];
export const roleAtLeast = (role, min) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
export const ROLE_LABEL = { pending: 'Waiting for approval', volunteer: 'Volunteer', contractor: 'Contractor', staff: 'Staff', admin: 'Admin' };

// Modules appear in the nav for anyone at or above `minRole`.
// New sections (Gear, Schedule, Training, Service flow…) get added here.
const MODULES = [
  { id: 'gear', label: 'Gear', icon: 'box', minRole: 'staff', view: GearView },
  { id: 'network', label: 'Network', icon: 'network', minRole: 'staff', view: NetworkView },
  { id: 'resi', label: 'Resi', icon: 'live', minRole: 'volunteer', view: ResiView },
  { id: 'stats', label: 'Statistics', icon: 'chart', minRole: 'staff', view: StatsView },
  { id: 'team', label: 'Team', icon: 'team', minRole: 'staff', view: TeamView },
  { id: 'account', label: 'Settings', icon: 'settings', minRole: 'volunteer', view: AccountView },
];

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

async function boot() {
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

const visibleModules = () => MODULES.filter((m) => roleAtLeast(ctx.me.role, m.minRole));

function renderShell() {
  appEl().innerHTML = `
    ${ctx.store.mode === 'demo' ? `<div class="demo-bar" role="note">Preview with example data. Nothing is saved.</div>` : ''}
    <div class="shell">
      <nav class="nav" aria-label="Sections"></nav>
      <div class="main">
        <header class="topbar">
          <span class="brand">${brandMark()}<span class="brand-name">${esc(APP_NAME)}</span></span>
        </header>
        <main id="view" tabindex="-1"></main>
      </div>
    </div>`;
  renderNav();
}

function renderNav() {
  const nav = $('.nav');
  if (!nav) return;
  const mods = visibleModules();
  nav.innerHTML = `
    <div class="nav-brand">${brandMark()}<div><div class="brand-name">${esc(APP_NAME)}</div><div class="brand-org">${esc(ORG_NAME)}</div></div></div>
    <div class="nav-items">
      ${mods.map((m) => `<a class="nav-item" href="#${m.id}" data-mod="${m.id}">${icon(m.icon)}<span>${esc(m.label)}</span></a>`).join('')}
    </div>
    <a class="nav-user" href="#account">
      <span class="avatar">${esc((ctx.me.full_name || ctx.me.email)[0]?.toUpperCase() || '?')}</span>
      <span class="nav-user-text"><b>${esc(ctx.me.full_name || ctx.me.email)}</b><small>${esc(ROLE_LABEL[ctx.me.role])}</small></span>
    </a>`;
  markNav();
}

function markNav() {
  $$('.nav-item').forEach((a) => a.classList.toggle('on', a.dataset.mod === current?.id));
}

function goWith(mod, pending) {
  ctx.pending = pending;
  if (current?.id === mod) { current.instance?.unmount?.(); current = null; onHash(); }
  else location.hash = mod;
}

function onHash() {
  if (!ctx.me || !$('#view')) return;
  if (/access_token|type=/.test(location.hash)) return;
  const mods = visibleModules();
  const want = location.hash.replace('#', '');
  const mod = mods.find((m) => m.id === want) || mods[0];
  if (current?.id === mod.id && current.el?.isConnected) return;
  openSheetApi?.close(true); // leaving a section closes whatever was open on it
  current?.instance?.unmount?.();
  // A fresh container per section, so the last section's listeners go with it.
  const view = document.createElement('main');
  view.id = 'view';
  view.tabIndex = -1;
  $('#view').replaceWith(view);
  view.className = `view view-${mod.id}`;
  current = { id: mod.id, el: view, instance: mod.view.mount(view, ctx) };
  document.title = `${mod.label} · ${APP_NAME}`;
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
    render(html) { el.innerHTML = html; },
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
// Open copies notice a new version and reload themselves when nothing is
// being edited.

function watchForUpdates() {
  if (ctx.store.mode !== 'live') return;
  let loaded = null;
  const check = async () => {
    try {
      const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      const { v } = await r.json();
      if (loaded == null) loaded = v;
      else if (v !== loaded && !document.querySelector('.sheet-root')) location.reload();
    } catch { /* offline */ }
  };
  check();
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
}

// ------------------------------------------------------------------ misc --

function brandMark(size = '') {
  return `<span class="mark ${size}" aria-hidden="true"><i></i><i></i><i></i></span>`;
}

boot();
