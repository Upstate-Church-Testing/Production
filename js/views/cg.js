// CG uploads: is each campus's CG uploaded for Sunday? One row per campus: Not started,
// Working on it, or Done, with who set it and when. Always the coming Sunday (today if it's
// Sunday): on Monday it moves on to the next one, where everything starts at Not started
// (cg_uploads is keyed by the Sunday; last week's stay as they were). Changes from anyone
// show up live. Home shows how many are done. Staff and up.
// Beside each campus, its CG computer's macOS, ProPresenter and Desktop Video versions, from
// Gear (the OS from the computer's Firmware / OS field, the rest from its software). The CG
// computer is the campus's computer at CG (location CG or CG1, or "(CG)" / "(CG1)" in its name),
// CG1's or the Worship Center's when there's more than one. A campus with another CG computer
// (Simpsonville's CG2 in A Control) gets a row for it too, uploaded on its own (js/cg-rows.js).
// A version Gear doesn't have is left blank.
// Each version is a pill that opens a list to pick from: the released versions on record
// (software_versions) and any other in use on a computer, newest first, plus "Another
// version" to type one (which joins the list). Picking one is saved to Gear: the OS into the
// computer's Firmware / OS field, the others as that title's version on it, seen today.

import { esc, icon, $, $$, debounce, pageTitle } from '../util.js';
import { wireDropdown } from '../picker.js';
import { clock, comingSunday } from '../pco.js';
import { osOf, logoHtml, installsByDevice, cmpVersion, asOf, MAC_RELEASE } from '../software.js';
import { cgRows, cgKey, cgStation } from '../cg-rows.js';

/** The three columns: logo on top, outlined in the logo's color. */
const COLS = [
  { id: 'mac', name: 'macOS', logo: 'apple.svg' }, // (its versions are under product 'macOS')
  { id: 'pp', name: 'ProPresenter', logo: 'propresenter.svg', sw: /^propresenter$/i },
  { id: 'dv', name: 'Desktop Video', logo: 'blackmagic.svg', sw: /^desktop video$/i },
];

/** The "Another version…" line on a version pill's list. */
const OTHER = '__other';

export const CG_STATES = [
  { id: 'not_started', label: 'Not started', short: 'Not started' },
  { id: 'working', label: 'Working on it', short: 'Working' },
  { id: 'done', label: 'Done', short: 'Done' },
];

export function mount(el, ctx) {
  let alive = true;
  const s = { tz: 'America/New_York', sunday: null, rows: new Map(), error: null, loaded: false, saving: new Set(), gear: null, computers: [], versions: [], inUse: new Map(), software: [] };
  let timer = null;

  el.innerHTML = `<div class="cgu" id="cgu"><div class="loading">${'<div class="sk"></div>'.repeat(4)}</div></div>`;
  const root = $('#cgu', el);

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cg][data-st]');
    if (!b || b.disabled) return;
    const campus = b.dataset.cg;
    const station = b.dataset.station || '';
    const key = cgKey(campus, station);
    const status = b.dataset.st;
    const was = s.rows.get(key);
    if ((was?.status || 'not_started') === status) return;
    // Show it right away; put it back if it doesn't save.
    s.rows.set(key, { ...(was || {}), campus_id: campus, station, status, updated_at: new Date().toISOString(), who: { full_name: ctx.me.full_name } });
    s.saving.add(key);
    draw();
    try {
      await ctx.store.cgSetUpload(s.sunday, campus, status, station);
    } catch (err) {
      if (was) s.rows.set(key, was); else s.rows.delete(key);
      ctx.toast(err.message);
    }
    s.saving.delete(key);
    draw();
  });
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (table === 'cg') load(); else if (/device|software/.test(table)) loadGear(); }, 250));
  const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
  document.addEventListener('visibilitychange', onVisible);

  start();
  return {
    unmount() {
      alive = false;
      clearInterval(timer);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };

  async function start() {
    try { s.tz = (await ctx.store.pcoStatus())?.time_zone || s.tz; } catch { /* the default */ }
    s.sunday = comingSunday(s.tz);
    await Promise.all([load(false), loadGear(false)]);
    draw();
    timer = setInterval(tick, 60000);
  }

  /** Gear: each campus's CG computer and what's on it. */
  async function loadGear(redraw = true) {
    try {
      const [data, versions] = await Promise.all([ctx.store.networkData(), ctx.store.softwareVersions().catch(() => [])]);
      s.versions = versions || [];
      s.software = data.software || [];
      const rooms = new Map(data.rooms.map((r) => [r.id, r]));
      const types = new Map(data.types.map((t) => [t.id, t]));
      const installs = installsByDevice(data);
      const computers = data.devices.filter((d) => types.get(d.type_id)?.category === 'Computer');
      s.computers = computers;
      // Every version in use on any computer, per column (so each is on the list to pick).
      s.inUse = new Map(COLS.map((col) => [col.id, new Set()]));
      for (const d of computers) {
        const os = osOf(d);
        if (os?.family === 'macOS' && os.version) s.inUse.get('mac').add(os.version);
        for (const i of installs.get(d.id) || []) for (const col of COLS) if (col.sw?.test(i.sw.name)) s.inUse.get(col.id).add(i.version);
      }
      // Each row's computer: for a campus's main CG, CG1 first, then the Worship Center's, then any other.
      const rank = (x) => (/^cg\s*1$/i.test(String(x.location || '').trim()) || /\(cg\s*1\)/i.test(x.name || '') ? 0
        : /worship center/i.test(rooms.get(x.room_id)?.name || '') ? 1 : 2);
      const byRow = new Map();
      for (const d of computers) {
        const st = cgStation(d);
        if (st == null) continue;
        const key = cgKey(d.campus_id, st);
        const was = byRow.get(key);
        if (!was || rank(d) < rank(was)) byRow.set(key, d);
      }
      s.gear = new Map([...byRow].map(([key, d]) => {
        const os = osOf(d);
        const app = (re) => (installs.get(d.id) || []).find((i) => re.test(i.sw.name));
        const pp = app(COLS[1].sw);
        const dv = app(COLS[2].sw);
        return [key, {
          d,
          mac: os?.family === 'macOS' ? { v: os.version || '', title: os.label } : null,
          pp: pp ? { v: pp.version, title: `ProPresenter ${pp.version}${pp.build ? ` (${pp.build})` : ''}`, install: pp } : null,
          dv: dv ? { v: dv.version, title: `Desktop Video ${dv.version}`, install: dv } : null,
        }];
      }));
    } catch { if (!s.gear) s.gear = new Map(); }
    if (redraw && alive) draw();
  }

  /** Monday moves it on to the next Sunday. */
  function tick() {
    const next = comingSunday(s.tz);
    if (next !== s.sunday) { s.sunday = next; s.rows = new Map(); load(); }
  }

  async function load(redraw = true) {
    const sunday = s.sunday;
    try {
      const rows = (await ctx.store.cgUploads(sunday)) || [];
      if (!alive || sunday !== s.sunday) return;
      s.rows = new Map(rows.map((r) => [cgKey(r.campus_id, r.station), r]));
      s.error = null;
    } catch (e) {
      s.error = e.message;
    }
    s.loaded = true;
    if (redraw) draw();
  }

  function draw() {
    if (!alive || !s.loaded) return;
    const c = clock(s.tz);
    const day = Date.parse(`${s.sunday}T16:00:00Z`);
    const list = cgRows(ctx.campuses, s.computers);
    const statusOf = (key) => s.rows.get(key)?.status || 'not_started';
    const done = list.filter((x) => statusOf(x.key) === 'done').length;
    const isToday = c.day(Date.now()) === s.sunday;
    const tally = `<p class="tally"><b>${done}</b><span>of ${list.length} uploaded</span></p>`;
    const stamp = (r) => {
      if (!r?.updated_at) return '';
      const who = r.who?.full_name || r.updated_by_name || '';
      const at = c.day(Date.now()) === c.day(r.updated_at) ? c.time(r.updated_at) : `${c.weekday(r.updated_at).slice(0, 3)} ${c.time(r.updated_at)}`;
      return [who, at].filter(Boolean).join(' · ');
    };
    root.innerHTML = `<div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}${tally}</div>
        <p class="cgu-when">For ${isToday ? 'today' : `Sunday, ${esc(c.date(day))}`}. Starts over on Monday for the next Sunday.</p></div>
      <div class="results cgu-body">
      ${s.error ? `<p class="lv-warn">${icon('warn')}Couldn’t load: ${esc(s.error)}</p>` : ''}
      <table class="cgu-t">
        <thead><tr>
          <th class="cgu-h-name" scope="col">Campus</th>
          <th class="cgu-h-st" scope="col">CG for Sunday</th>
          ${COLS.map((col) => `<th class="cgu-v is-${col.id}" scope="col"><span class="cgu-vh">${logoHtml(col.name, col.logo)}<span>${esc(col.name)}</span></span></th>`).join('')}
        </tr></thead>
        <tbody>${list.map((row) => {
          const cp = row.campus;
          const st = statusOf(row.key);
          const r = s.rows.get(row.key);
          const busy = s.saving.has(row.key);
          const g = s.gear?.get(row.key);
          const what = `${cp.short_name} ${row.tag || 'CG'}`;
          return `<tr class="cgu-row is-${st}${row.station ? ' is-extra' : ''}">
            <th class="cgu-name" scope="row"><b>${esc(cp.short_name)}${row.tag ? ` <em class="cgu-tag">${esc(row.tag)}</em>` : ''}</b><small>${esc(CG_STATES.find((x) => x.id === st).label)}${r?.updated_at ? ` · ${esc(stamp(r))}` : ''}</small></th>
            <td class="cgu-st"><div class="cgu-seg" role="group" aria-label="${esc(what)}">${CG_STATES.map((x) => `<button type="button" data-cg="${esc(cp.id)}" data-station="${esc(row.station)}" data-st="${x.id}" class="is-${x.id}" aria-pressed="${st === x.id}" ${busy ? 'disabled' : ''}>${x.id === 'done' ? icon('check') : ''}<span>${esc(x.short)}</span></button>`).join('')}</div></td>
            ${COLS.map((col) => {
              const v = g?.[col.id];
              // A pill to pick the version from, wherever there's a computer to put it on.
              if (!g?.d) return `<td class="cgu-v is-${col.id} is-none"></td>`;
              return `<td class="cgu-v is-${col.id} ${v?.v ? '' : 'is-unset'}" ${v?.title ? `title="${esc(`${what}: ${v.title}`)}"` : ''}><button type="button" class="cgu-vchip" data-ver="${col.id}" data-key="${esc(row.key)}" data-what="${esc(what)}" aria-haspopup="listbox" aria-expanded="false">${logoHtml(col.name, col.logo, 'xs')}<b class="dd-value">${esc(v?.v || 'Set')}</b>${icon('down')}</button></td>`;
            }).join('')}
          </tr>`;
        }).join('')}</tbody>
      </table>
      </div>`;
    for (const btn of $$('.cgu-vchip[data-ver]', root)) wirePill(btn);
  }

  // --------------------------------------------------------------- versions ---
  function productOf(col) { return col.id === 'mac' ? 'macOS' : col.name; }

  /** The versions to pick from for a column: on record or in use, newest first. */
  function choices(col) {
    const known = new Map(s.versions.filter((x) => x.product === productOf(col)).map((x) => [x.version, x]));
    const all = [...new Set([...known.keys(), ...(s.inUse.get(col.id) || [])])].sort((a, b) => cmpVersion(b, a));
    return all.map((version) => {
      const k = known.get(version);
      const n = s.computers.filter((d) => versionOn(d, col) === version).length;
      const hint = [col.id === 'mac' ? MAC_RELEASE[parseInt(version, 10)] : null, k?.released_on ? asOf(k.released_on) : null].filter(Boolean).join(' · ');
      return { value: version, label: version, hint: hint || null, count: n || null, build: k?.build || null };
    });
  }
  function versionOn(d, col) {
    if (col.id === 'mac') { const os = osOf(d); return os?.family === 'macOS' ? os.version : null; }
    const g = [...(s.gear?.values() || [])].find((x) => x.d.id === d.id);
    return g?.[col.id]?.v ?? null;
  }

  function wirePill(btn) {
    const col = COLS.find((x) => x.id === btn.dataset.ver);
    const g = s.gear?.get(btn.dataset.key);
    if (!col || !g) return;
    const current = () => s.gear?.get(btn.dataset.key)?.[col.id]?.v || '';
    wireDropdown(btn, {
      label: `${btn.dataset.what} · ${col.name}`,
      unit: ['computer', 'computers'],
      options: () => [...choices(col), { value: OTHER, label: 'Another version…', hint: 'Type one that isn’t listed' }],
      get: current,
      set: (v) => { if (v === OTHER) askOther(col, btn.dataset.key, btn.dataset.what); else saveVersion(col, btn.dataset.key, btn.dataset.what, v); },
    });
    $('.dd-value', btn).textContent = current() || 'Set';
    btn.setAttribute('aria-label', `${btn.dataset.what} ${col.name}: ${current() || 'not set'}. Change it`);
  }

  /** Saves a version to Gear for a row's computer, and shows it at once. */
  async function saveVersion(col, key, what, version) {
    const g = s.gear?.get(key);
    version = String(version || '').trim();
    if (!g || !version) { draw(); return; }
    const was = g[col.id];
    g[col.id] = { ...(was || {}), v: version, title: `${col.name} ${version}` };
    draw();
    const today = new Date().toLocaleDateString('en-CA');
    try {
      if (col.id === 'mac') {
        const rel = MAC_RELEASE[parseInt(version, 10)];
        await ctx.store.setDeviceFirmware(g.d.id, `macOS ${rel ? `${rel} ` : ''}${version}`);
      } else {
        const sw = s.software.find((x) => col.sw.test(x.name));
        if (!sw) throw new Error(`${col.name} isn’t a title in Gear › Software yet. Add it there first.`);
        const known = s.versions.find((x) => x.product === productOf(col) && x.version === version);
        const i = was?.install;
        await ctx.store.saveInstall({ ...(i ? { id: i.id, notes: i.notes ?? null } : {}), software_id: sw.id, device_id: g.d.id, version, build: known?.build || null, seen_on: today });
      }
      ctx.toast(`${what} ${col.name}: ${version}`);
      loadGear();
    } catch (err) {
      g[col.id] = was;
      draw();
      ctx.toast(err.message, 'bad');
    }
  }

  /** "Another version": type one; it's saved and joins the list. */
  function askOther(col, key, what) {
    draw(); // the pill goes back to what it said
    const sheet = ctx.openSheet({ label: `${what} ${col.name} version` });
    sheet.render(`<header class="sh-head"><div class="sh-top"><span class="eyebrow">${esc(what)}</span><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div><h2>${esc(col.name)} version</h2></header>
      <div class="sh-body form"><label class="field"><span>Version</span><input id="cgu-other" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" placeholder="${col.id === 'mac' ? '27.1' : col.id === 'pp' ? '22.1' : '16.6'}"></label>
        <p class="fine">Just the number. It’s added to the list for next time.</p></div>
      <footer class="sh-foot"><p class="form-msg" role="status"></p><span class="spacer"></span><button type="button" class="btn primary" data-save>Save</button></footer>`);
    const input = $('#cgu-other', sheet.el);
    input.focus();
    const go = async () => {
      const v = input.value.trim().replace(/^v/i, '');
      if (!/^\d[\w.\- ()]{0,39}$/.test(v)) { $('.form-msg', sheet.el).textContent = 'Type the version number, like 22.0.1.'; return; }
      sheet.close(true);
      try { await ctx.store.addSoftwareVersion(productOf(col), v); } catch { /* still saved to the computer below */ }
      saveVersion(col, key, what, v);
    };
    sheet.el.addEventListener('click', (e) => { if (e.target.closest('[data-save]')) go(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }
}
