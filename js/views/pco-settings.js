// Settings › Planning Center: connect once for the whole church, then choose
// which services the team sees and which teams' rosters show on them.
// Admins change things here; staff can see the status and ask for an update.

import { esc, icon, $, $$, debounce, plural, timeAgo } from '../util.js';
import { PCO_TOKENS_URL, ACCESS, teamKey, teamServices } from '../pco.js';

const WEEKS = [2, 4, 6, 8, 12];

export function mountPcoSettings(box, ctx) {
  let alive = true;
  const isAdmin = ctx.me.role === 'admin';
  let status;        // undefined loading · null not connected · object
  let data = null;
  let error = null;
  let timer = null;
  let syncAgain = false;   // a change came in while a sync was running
  const opened = new Set();

  box.addEventListener('click', onClick);
  box.addEventListener('submit', onSubmit);
  box.addEventListener('change', onChange);
  // Remember which folders are open across redraws.
  box.addEventListener('toggle', (e) => {
    const g = e.target.closest?.('.pc-group');
    if (g) { if (g.open) opened.add(g.dataset.group); else opened.delete(g.dataset.group); }
  }, true);
  const syncSoon = debounce(() => requestSync(true), 1500);
  load();
  return { unmount() { alive = false; clearTimeout(timer); } };

  async function load() {
    try {
      [status, data] = await Promise.all([ctx.store.pcoStatus(), ctx.store.pcoData()]);
      error = null;
    } catch (e) { error = e.message; }
    if (!alive) return;
    render();
    poll();
  }

  function poll() {
    clearTimeout(timer);
    if (!alive || !status) return;
    timer = setTimeout(async () => {
      try {
        const st = await ctx.store.pcoStatus();
        const done = status?.syncing && !st?.syncing;
        status = st;
        if (done) {
          data = await ctx.store.pcoData();
          if (syncAgain) { syncAgain = false; requestSync(); }
          render();
        } else paintSync();
      } catch { /* next time */ }
      poll();
    }, status.syncing ? 3000 : 30000);
  }

  // ------------------------------------------------------------ render ---

  function render() {
    if (!alive) return;
    if (error) { box.innerHTML = `${head(null)}<p class="form-msg bad">${esc(error)}</p>`; return; }
    if (status === undefined) { box.innerHTML = `${head(null)}<div class="sk"></div>`; return; }
    if (!status) { box.innerHTML = isAdmin ? connectForm() : `${head(false)}<p>Not connected yet. An admin connects it once, and everyone sees the services they’re allowed to.</p>`; return; }
    box.innerHTML = `${head(true)}
      <p class="pc-who">${status.org_name ? `<b>${esc(status.org_name)}</b>` : 'Connected'}${status.connected_as ? ` <i>·</i> token from <b>${esc(status.connected_as)}</b>` : ''} <i>·</i> since ${esc(new Date(status.connected_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</p>
      <div class="pc-sync" id="pc-sync">${syncLine()}</div>
      ${isAdmin ? adminControls() : ''}`;
  }

  function head(on) {
    return `<div class="panel-head"><h2>Planning Center</h2>${on == null ? '' : `<span class="pc-state ${on ? 'on' : ''}">${on ? 'Connected' : 'Not connected'}</span>`}</div>`;
  }

  function syncLine() {
    const when = status.syncing
      ? `<span class="svc-sync">${icon('refresh')}Updating from Planning Center…</span>`
      : status.last_sync_at ? `Updated ${esc(timeAgo(status.last_sync_at))}. It updates every 15 minutes.` : 'Waiting for the first update.';
    return `<p>${when}${status.syncing ? '' : ` <button class="btn link" data-pc="sync">Update now</button>`}</p>
      ${status.last_sync_error ? `<p class="svc-err">${icon('warn')}Last update didn’t finish: ${esc(status.last_sync_error)}</p>` : ''}
      ${status.people_note ? `<p class="fine">${esc(status.people_note)}</p>` : ''}`;
  }
  function paintSync() { const el = $('#pc-sync', box); if (el) el.innerHTML = syncLine(); }

  function connectForm() {
    return `${head(false)}
      <p>Connect once for the whole church. People sign in here with their own account and see the services you share with them. Nobody needs their own Planning Center login or the right permissions there.</p>
      <ol class="pc-steps">
        <li>Sign in to Planning Center with an account that can see every service. A shared production login is best, so this keeps working when people come and go.</li>
        <li>Open <a href="${PCO_TOKENS_URL}" target="_blank" rel="noopener">api.planningcenteronline.com/oauth/applications</a>. Under <b>Personal Access Tokens</b>, create one and name it “Upstate Production”.</li>
        <li>Copy its <b>Application ID</b> and <b>Secret</b> into the boxes below.</li>
      </ol>
      <form class="form pc-form" novalidate>
        <label class="field"><span>Application ID</span><input id="pc-app" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Secret</span><input id="pc-secret" class="mono" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <p class="fine">Planning Center checks the token first. The secret is stored encrypted on the server and never sent back to anyone’s phone or computer.</p>
        <div class="row-end"><p class="form-msg" role="status"></p><button class="btn primary" type="submit">${icon('link')}Connect</button></div>
      </form>`;
  }

  function adminControls() {
    const types = data?.types || [];
    const teams = data?.teams || [];
    const shared = new Set(types.filter((t) => t.access !== 'hidden').map((t) => t.id));

    // Teams, by name, from shared services (all services if none are shared yet).
    const pool = teams.filter((t) => !shared.size || teamServices(t).some((id) => shared.has(id)));
    const byName = new Map();
    for (const t of pool) {
      const k = teamKey(t.name);
      const cur = byName.get(k) || { name: t.name, n: 0, shown: false };
      cur.n++; cur.shown = cur.shown || t.shown;
      byName.set(k, cur);
    }
    const teamList = [...byName.values()].sort((a, b) => b.shown - a.shown || b.n - a.n || a.name.localeCompare(b.name));

    // Services, by the folder they're filed in.
    const groups = new Map();
    for (const t of types) {
      const g = t.path?.[0] || 'Not in a folder';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    const order = [...groups.keys()].sort((a, b) => /archive/i.test(a) - /archive/i.test(b) || a.localeCompare(b, undefined, { numeric: true }));

    return `
      <div class="pc-row">
        <label for="pc-weeks">Show the next</label>
        <select id="pc-weeks">${WEEKS.map((w) => `<option value="${w}" ${w === status.weeks_ahead ? 'selected' : ''}>${w} weeks</option>`).join('')}${WEEKS.includes(status.weeks_ahead) ? '' : `<option selected value="${status.weeks_ahead}">${status.weeks_ahead} weeks</option>`}</select>
      </div>

      <h3 class="pc-h">Teams that show</h3>
      <p class="fine">Only these teams’ rosters are copied in and shown. Everything else stays in Planning Center.</p>
      ${teamList.length ? `<div class="pc-teams">${teamList.map((t) => `<button type="button" class="chip" data-pc="team" data-name="${esc(t.name)}" aria-pressed="${t.shown}">${t.shown ? icon('check') : ''}${esc(t.name)}<small>${t.n}</small></button>`).join('')}</div>`
        : `<p class="fine">${status.syncing ? 'Teams show up here after the first update.' : 'No teams found yet.'}</p>`}

      <h3 class="pc-h">Who sees each service</h3>
      <p class="fine"><b>Everyone</b> includes volunteers. <b>Staff</b> is staff and admins. <b>Off</b> keeps it out of the app. <b>Roster</b> puts a shared service on Services › Roster; turn it off to keep a service in the list but off the grid.</p>
      <div class="pc-groups">${order.map((g) => {
        const list = groups.get(g).sort((a, b) => (a.path.length - b.path.length) || (a.sequence ?? 99) - (b.sequence ?? 99) || a.name.localeCompare(b.name));
        const on = list.filter((t) => t.access !== 'hidden').length;
        const isOpen = opened.has(g);
        return `<details class="pc-group" data-group="${esc(g)}" ${isOpen ? 'open' : ''}>
          <summary><span class="pc-group-name">${esc(g.replace(/^\s*\d+\s+/, ''))}</span><small>${on ? `${on} of ${list.length} shared` : plural(list.length, 'service')}</small>${icon('down', 'pc-caret')}</summary>
          <ul class="pc-list">${list.map((t) => serviceRow(t)).join('')}</ul>
        </details>`;
      }).join('')}</div>

      <div class="pc-danger">
        <button type="button" class="btn ghost danger-text" data-pc="disconnect">${icon('close')}<span>Disconnect Planning Center</span></button>
      </div>`;
  }

  function serviceRow(t) {
    const where = [t.campus_id ? ctx.campusById.get(t.campus_id)?.short_name : 'No location', ...(t.path || []).slice(1)].filter(Boolean).join(' · ');
    return `<li class="pc-svc">
      <span class="pc-name"><b>${esc(t.name)}</b><small>${esc(where)}</small></span>
      ${rosterChip(t)}
      <div class="seg pc-access" role="radiogroup" aria-label="Who sees ${esc(t.name)}">
        ${ACCESS.map(([v, label, hint]) => `<button type="button" role="radio" data-pc="access" data-id="${esc(t.id)}" data-v="${v}" title="${hint}" aria-checked="${t.access === v}" aria-selected="${t.access === v}">${label}</button>`).join('')}
      </div>
    </li>`;
  }

  function rosterChip(t) {
    const on = t.on_roster !== false;
    return `<button type="button" class="chip pc-roster" data-pc="roster" data-id="${esc(t.id)}" aria-pressed="${on}" title="${on ? 'On' : 'Off'} Services › Roster" ${t.access === 'hidden' ? 'hidden' : ''}>${on ? icon('check') : ''}Roster</button>`;
  }

  // ----------------------------------------------------------- actions ---

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target.closest('.pc-form');
    if (!form) return;
    const msg = $('.form-msg', form);
    const btn = $('button[type=submit]', form);
    const app_id = $('#pc-app', form).value.trim();
    const secret = $('#pc-secret', form).value.trim();
    if (!app_id || !secret) { msg.textContent = 'Paste both the Application ID and the Secret.'; msg.classList.add('bad'); return; }
    btn.disabled = true; msg.classList.remove('bad'); msg.textContent = 'Checking with Planning Center…';
    try {
      const r = await ctx.store.pco('connect', { app_id, secret });
      ctx.toast(`Connected${r.org_name ? ` to ${r.org_name}` : ''}`);
      await load();
    } catch (err) {
      msg.textContent = err.message; msg.classList.add('bad'); btn.disabled = false;
    }
  }

  async function onClick(e) {
    const b = e.target.closest('[data-pc]');
    if (!b) return;
    const a = b.dataset.pc;
    if (a === 'sync') { requestSync(true); return; }
    if (a === 'access') {
      const t = data.types.find((x) => x.id === b.dataset.id);
      const v = b.dataset.v;
      if (!t || t.access === v) return;
      const before = t.access;
      t.access = v;
      $$(`[data-pc="access"][data-id="${CSS.escape(t.id)}"]`, box).forEach((x) => { const on = x.dataset.v === v; x.setAttribute('aria-checked', on); x.setAttribute('aria-selected', on); });
      paintGroupCount(b.closest('.pc-group'));
      const chip = $(`[data-pc="roster"][data-id="${CSS.escape(t.id)}"]`, box);
      if (chip) chip.hidden = v === 'hidden';
      try { await ctx.store.pcoSetAccess(t.id, v); requestSync(); }
      catch (err) { t.access = before; ctx.toast(err.message); render(); }
      return;
    }
    if (a === 'roster') {
      const t = data.types.find((x) => x.id === b.dataset.id);
      if (!t) return;
      const before = t.on_roster !== false;
      t.on_roster = !before;
      b.outerHTML = rosterChip(t);
      try {
        await ctx.store.pcoSetRoster(t.id, t.on_roster);
        ctx.toast(t.on_roster ? `${t.name} is on the roster` : `${t.name} is off the roster`);
      } catch (err) { t.on_roster = before; ctx.toast(err.message); render(); }
      return;
    }
    if (a === 'team') {
      const name = b.dataset.name;
      const shown = b.getAttribute('aria-pressed') !== 'true';
      try {
        await ctx.store.pcoShowTeam(name, shown);
        for (const t of data.teams) if (teamKey(t.name) === teamKey(name)) t.shown = shown;
        render();
        ctx.toast(shown ? `${name} shows on every shared service` : `${name} is hidden`);
        requestSync();
      } catch (err) { ctx.toast(err.message); }
      return;
    }
    if (a === 'disconnect') {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.querySelector('span').textContent = 'Tap again to disconnect'; return; }
      b.disabled = true;
      try { await ctx.store.pco('disconnect'); ctx.toast('Planning Center disconnected'); await load(); }
      catch (err) { ctx.toast(err.message); b.disabled = false; }
    }
  }

  async function onChange(e) {
    if (e.target.id === 'pc-weeks') {
      try { await ctx.store.pcoSetWeeks(Number(e.target.value)); status.weeks_ahead = Number(e.target.value); requestSync(); }
      catch (err) { ctx.toast(err.message); }
    }
  }

  function paintGroupCount(group) {
    if (!group) return;
    const list = data.types.filter((t) => (t.path?.[0] || 'Not in a folder') === group.dataset.group);
    const on = list.filter((t) => t.access !== 'hidden').length;
    $('summary small', group).textContent = on ? `${on} of ${list.length} shared` : plural(list.length, 'service');
  }

  // Changes take effect at the next update; ask for one now (once things settle).
  function requestSync(now = false) {
    if (!now) { syncSoon(); return; }
    (async () => {
      try {
        const r = await ctx.store.pco('sync');
        if (r?.already) syncAgain = true;
        status = { ...status, syncing: true };
        paintSync();
        poll();
      } catch (err) { ctx.toast(err.message); }
    })();
  }
}
