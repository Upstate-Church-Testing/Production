// Lighting › Patch, in the console look (like Scheduling and Haze). Two screens:
//
//   Every room   one sheet that fits the screen (no scrolling): a line per room that has
//                lights, by location. Across: the location, the room, how many fixtures
//                are patched (a bar), each universe in use and how full it is (of 512), and
//                how many need a look. Picking a universe at the top dims the rooms that
//                don't use it. Tapping a line opens that room.
//   One room     its patch list, which is the one place that scrolls: figures at the top
//                (patched, universes, addresses, console), then universe by universe a bar
//                of its 512 addresses and its fixtures in address order, then what isn't
//                patched. Search finds a fixture, fixture ID or address (2.041). Tapping a
//                fixture opens it. "Edit numbers" is the numbering table from views/patch.js.
//
// The numbers and their rules are in lighting.js. Staff and up.

import { esc, icon, $, $$, debounce, pageTitle, plural } from '../util.js';
import { buildIndex, openDeviceSheet } from './devices.js';
import { patchView } from './patch.js';
import {
  takesPatch, footprint, rigKey, rigProblems, problemText, isProblem, usedChannels, rangeText, patchPoint, covers,
  SLOTS, assetTag, itemLabel, nameNumber,
} from '../lighting.js';
import { fitBoard, unlockPage, watchHeight } from '../fit.js';

const ALL = 'all';
/** A phone shows a location's code, as Scheduling does. */
const SHORT = { AND: 'AN', MAU: 'MLN' };
const both = (full, short) => (short && short !== full ? `<span class="lf">${esc(full)}</span><span class="ls">${esc(short)}</span>` : esc(full));
const HUES = [212, 32, 280, 150, 190, 48, 255, 120, 300, 170, 232, 88]; // no reds: red means a problem
const hue = (typeId) => HUES[[...String(typeId)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

export function mount(el, ctx) {
  let alive = true;
  let openDev = null;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // (campus, prig, puni, q, cat, brand: what views/patch.js reads for its numbering table.)
  const s = { data: null, ix: null, campus: ALL, prig: {}, puni: ALL, q: '', cat: ALL, brand: ALL, rig: null, editing: false, first: true };
  if (ctx.pending?.patch) { s.puni = ctx.pending.patch.universe ?? ALL; ctx.pending = null; } // Statistics opens it on a universe

  el.innerHTML = `<div class="pb" id="pb">
      <div class="page-head"><div class="mode-row">${pageTitle(ctx.page)}<p class="pb-count" id="pb-count" role="status"></p></div></div>
      <div class="results pb-body" id="pb-body"><div class="loading"><div class="sk tall"></div></div></div>
      <span id="g-tally" hidden></span>
    </div>`;
  const body = $('#pb-body', el);

  const old = patchView({
    s, ctx,
    typeOf: (d) => typeOf(d),
    matches: () => true,
    openModel: (id) => openItem(id),
    load: (quiet) => load(quiet),
    setCampus() {},
    campusName: (id) => ctx.campusById.get(id)?.short_name || '',
  });

  el.addEventListener('click', (e) => {
    if (s.editing) {
      old.click(e);
      if (!old.editing()) { s.editing = false; draw(); }
      return;
    }
    const t = e.target.closest('[data-rig], [data-back], [data-uni], [data-edit], [data-model]');
    if (!t) return;
    if (t.dataset.rig) { s.rig = t.dataset.rig; s.q = ''; if (!t.closest('.pb-tabs')) s.puni = ALL; s.first = true; draw(); window.scrollTo(0, 0); }
    else if (t.dataset.back != null) { s.rig = null; s.q = ''; s.puni = ALL; s.first = true; draw(); window.scrollTo(0, 0); }
    else if (t.dataset.uni) { s.puni = t.dataset.uni === ALL ? ALL : Number(t.dataset.uni); draw(); }
    else if (t.dataset.edit != null) startEdit();
    else if (t.dataset.model) openItem(t.dataset.model);
  });
  el.addEventListener('keydown', (e) => {
    if (s.editing) { old.keydown(e); return; }
    if (e.key === 'Enter' && e.target.matches?.('tr[data-model]')) openItem(e.target.dataset.model);
  });
  el.addEventListener('input', (e) => {
    if (s.editing) { old.input(e); return; }
    if (e.target.id === 'pb-q') { s.q = e.target.value; drawList(); }
  });
  const WATCH = new Set(['devices', 'device_types', 'rooms']);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (!table || WATCH.has(table)) load(true); }, 300));
  const unwatch = watchHeight(() => { if (!s.rig) fit(); });

  load(false);
  return {
    unmount() {
      alive = false;
      unwatch();
      unlockPage();
      unsubscribe();
    },
  };

  // ------------------------------------------------------------------ data ---
  async function load(quiet) {
    try {
      const data = await ctx.store.networkData();
      if (!alive) return;
      s.data = data;
      s.ix = buildIndex(data);
    } catch (e) {
      if (alive && !s.data) body.innerHTML = `<div class="empty"><p>Couldn’t load the patch: ${esc(e.message)}</p></div>`;
      return;
    }
    if (quiet && s.editing && old.editing()) { openDev?.refresh?.(); return; } // keep what's being typed
    if (s.editing && !old.editing()) s.editing = false; // saved
    if (quiet && document.activeElement?.id === 'pb-q') { drawList(); return; } // keep the search box as it is
    draw();
    openDev?.refresh?.();
  }

  function typeOf(d) { return s.ix.type.get(d.type_id) || null; }
  function roomName(id) { return id ? s.ix.room.get(id)?.name || 'Room' : 'No room'; }
  function openItem(id) {
    openDeviceSheet(ctx, { s, load: (quiet) => load(quiet), setOpen: (t) => { openDev = t; } }, id);
  }

  /** Every room with lights, by location; in a location the Worship Center first, storage last. */
  function rigs() {
    const fx = s.data.devices.filter((d) => d.status !== 'retired' && takesPatch(d, typeOf(d)));
    const out = [];
    for (const c of ctx.campuses) {
      const here = fx.filter((d) => d.campus_id === c.id);
      const rank = (key) => {
        const rid = key.split('|')[1];
        const name = roomName(rid);
        return [!rid || /storage/i.test(name) ? 2 : /^worship/i.test(name) ? 0 : 1, s.ix.room.get(rid)?.sort_order ?? 99, name];
      };
      const keys = [...new Set(here.map(rigKey))].sort((a, b) => {
        const [x, y] = [rank(a), rank(b)];
        return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
      });
      keys.forEach((key, i) => out.push(rigInfo(c, key, here.filter((d) => rigKey(d) === key), i === 0)));
    }
    return out;
  }

  function rigInfo(c, key, items, first) {
    const roomId = key.split('|')[1] || null;
    const problems = rigProblems(items, typeOf);
    const unis = [...new Set(items.filter((d) => d.patch_universe != null).map((d) => d.patch_universe))].sort((a, b) => a - b);
    const used = new Map(unis.map((u) => [u, usedChannels(items.filter((d) => d.patch_universe === u), typeOf)]));
    const consoles = s.data.devices.filter((d) => rigKey(d) === key && d.status !== 'retired' && d.departments.includes('lighting') && /console|wing/i.test(typeOf(d)?.category || ''));
    return {
      c, key, roomId, items, problems, unis, used, consoles, first,
      patched: items.filter((d) => d.patch_universe != null).length,
      flagged: [...problems.values()].filter((l) => l.some(isProblem)).length,
    };
  }

  // ------------------------------------------------------------------ draw ---
  function draw() {
    if (!alive || !s.data) return;
    const all = rigs();
    const rig = s.rig ? all.find((r) => r.key === s.rig) : null;
    if (s.rig && !rig) s.rig = null;
    el.firstElementChild.classList.toggle('is-doc', !!rig);
    if (rig) drawRoom(rig, all); else drawAll(all);
  }

  /** A universe as a small block: its number, and a bar of how much of its 512 is used. */
  function uniBlock(u, used) {
    const p = pct(used, SLOTS);
    return `<span class="pb-u${s.puni === u ? ' is-on' : ''}${used > SLOTS ? ' is-over' : ''}" title="${esc(`Universe ${u}: ${used} of 512 used`)}"><b>U${u}</b><span class="pb-ubar"><i style="--w:${Math.min(100, p)}%"></i></span><small>${p}%</small></span>`;
  }

  function uniPick(unis, label) {
    if (unis.length < 2 && s.puni === ALL) return '';
    return `<div class="pb-unis" role="group" aria-label="Universe">
      <button type="button" data-uni="all" aria-pressed="${s.puni === ALL}">${label}</button>
      ${unis.map((u) => `<button type="button" data-uni="${u}" aria-pressed="${s.puni === u}">U${u}</button>`).join('')}
    </div>`;
  }

  // Every room, on one sheet.
  function drawAll(all) {
    const total = all.reduce((n, r) => n + r.items.length, 0);
    const patched = all.reduce((n, r) => n + r.patched, 0);
    const flagged = all.reduce((n, r) => n + r.flagged, 0);
    const unis = [...new Set(all.flatMap((r) => r.unis))].sort((a, b) => a - b);
    if (s.puni !== ALL && !unis.includes(s.puni)) s.puni = ALL;
    $('#pb-count', el).innerHTML = `<b>${patched}</b> of ${total} patched <i>·</i> ${plural(all.length, 'room')}${flagged ? ` <i>·</i> <em>${flagged} to look at</em>` : ''}`;
    if (!all.length) {
      unlockPage();
      body.innerHTML = `<div class="pb-none"><h3>No lighting fixtures yet</h3><p>Fixtures added in Gear show up here, room by room.</p></div>`;
      return;
    }
    body.innerHTML = `${uniPick(unis, 'Every universe')}
      <div class="pb-board${s.first && !still() ? ' pb-boot' : ''}" style="--n:${all.length}">
        <div class="pb-r pb-hd" role="row"><span>${both('Location', 'Loc')}</span><span>Room</span><span>Patched</span><span>Universes</span><span class="pb-con">Console</span></div>
        ${all.map(line).join('')}
      </div>`;
    fit();
    if (s.first) {
      s.first = false;
      if (!still()) setTimeout(() => $('.pb-board', body)?.classList.remove('pb-boot'), 700);
      document.fonts?.ready.then(() => { if (alive && !s.rig) fit(); });
    }
  }

  function line(r) {
    const off = s.puni !== ALL && !r.unis.includes(s.puni);
    const left = r.items.length - r.patched;
    const p = pct(r.patched, r.items.length);
    const said = `${r.c.short_name} ${roomName(r.roomId)}: ${r.patched} of ${plural(r.items.length, 'fixture')} patched${r.flagged ? `, ${r.flagged} to look at` : ''}. Open its patch list`;
    return `<button type="button" class="pb-r${r.first ? ' is-first' : ''}${off ? ' is-off' : ''}" role="row" data-rig="${esc(r.key)}" style="--j:${Math.random().toFixed(2)}" aria-label="${esc(said)}">
      <span class="pb-loc">${r.first ? `<b>${both(r.c.short_name, SHORT[r.c.code] || r.c.code)}</b>` : ''}</span>
      <span class="pb-room"><b>${esc(roomName(r.roomId))}</b><small>${plural(r.items.length, 'fixture')}${r.flagged ? `<em>${icon('warn')}${r.flagged}</em>` : ''}</small></span>
      <span class="pb-pat${!r.patched ? ' is-zero' : left ? '' : ' is-full'}"><span class="pb-frac"><b>${r.patched}</b><i>/</i>${r.items.length}</span><span class="pb-bar"><i style="--w:${p}%"></i></span></span>
      <span class="pb-us">${r.unis.length ? r.unis.map((u) => uniBlock(u, r.used.get(u))).join('') : '<span class="pb-nil">Not patched yet</span>'}</span>
      <span class="pb-con">${r.consoles.length ? esc(r.consoles.map((c) => typeOf(c)?.name || c.name).join(', ')) : '<span class="pb-nil">—</span>'}</span>
    </button>`;
  }

  /** The sheet is as tall as the screen has left, its lines sharing that evenly. */
  function fit() {
    const board = $('.pb-board', body);
    if (board) fitBoard(board);
  }

  // One room: its patch list.
  function drawRoom(rig, all) {
    unlockPage();
    const here = all.filter((r) => r.c.id === rig.c.id);
    if (s.puni !== ALL && !rig.unis.includes(s.puni)) s.puni = ALL;
    const left = rig.items.length - rig.patched;
    const used = [...rig.used.values()].reduce((a, b) => a + b, 0);
    $('#pb-count', el).innerHTML = `<b>${rig.patched}</b> of ${rig.items.length} patched${rig.flagged ? ` <i>·</i> <em>${rig.flagged} to look at</em>` : ''}`;
    const stat = (label, big, small, cls = '') => `<div class="pb-stat ${cls}"><small>${label}</small><b>${big}</b><span>${small}</span></div>`;
    body.innerHTML = `<div class="pb-doc${s.first && !still() ? ' pb-boot' : ''}">
      <div class="pb-top">
        <button type="button" class="pb-back" data-back>${icon('chevron')}<span>Every room</span></button>
        <div class="pb-where"><small>${esc(rig.c.short_name)}</small><h2>${esc(roomName(rig.roomId))}</h2></div>
        <button type="button" class="pb-btn" data-edit>${icon('edit')}<span>Edit numbers</span></button>
      </div>
      ${here.length > 1 ? `<div class="pb-tabs" role="tablist" aria-label="Room">${here.map((r) => `<button type="button" role="tab" data-rig="${esc(r.key)}" aria-selected="${r.key === rig.key}">${esc(roomName(r.roomId))}<small>${r.items.length}</small></button>`).join('')}</div>` : ''}
      <div class="pb-stats">
        ${stat('Patched', `${rig.patched}<i>/${rig.items.length}</i>`, left ? `${left} not patched` : 'Every fixture', left ? '' : 'is-ok')}
        ${stat('Universes', rig.unis.length || '—', rig.unis.length ? `U${rig.unis.join(' · U')}` : 'None in use')}
        ${stat('Addresses', used.toLocaleString(), rig.unis.length ? `of ${(rig.unis.length * SLOTS).toLocaleString()} · ${pct(used, rig.unis.length * SLOTS)}%` : 'None in use')}
        ${stat('Console', rig.consoles.length ? esc(rig.consoles.map((c) => typeOf(c)?.name || c.name).join(', ')) : '—', rig.consoles.length ? esc(rig.consoles.map((c) => typeOf(c)?.manufacturer).filter(Boolean)[0] || '') : 'None on record', 'is-text')}
      </div>
      <div class="pb-tools">
        <label class="pb-search">${icon('search')}<input id="pb-q" type="search" inputmode="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Fixture, fixture ID or patch (2.041)" value="${esc(s.q)}" aria-label="Search this patch list"></label>
        ${uniPick(rig.unis, 'All')}
      </div>
      <div id="pb-list"></div>
    </div>`;
    drawList(rig);
    if (s.first) { s.first = false; if (!still()) setTimeout(() => $('.pb-doc', body)?.classList.remove('pb-boot'), 600); }
  }

  /** The list under the figures: what needs a look, each universe, what isn't patched. */
  function drawList(rig = rigs().find((r) => r.key === s.rig)) {
    const box = $('#pb-list', body);
    if (!box || !rig) return;
    const q = s.q.trim().toLowerCase();
    const pt = patchPoint(s.q);
    const match = (d) => {
      if (!q) return true;
      const t = typeOf(d);
      if (covers(d, t, pt)) return true;
      return [d.name, t?.name, t?.manufacturer, d.location, d.fixture_id, assetTag(d.asset_no), rangeText(d, footprint(d, t))].some((v) => v != null && String(v).toLowerCase().includes(q));
    };
    const flagged = rig.items.filter((d) => (rig.problems.get(d.id) || []).some(isProblem));
    const unis = rig.unis.filter((u) => s.puni === ALL || u === s.puni);
    const sections = unis.map((u) => uniSection(rig, u, pt, match)).join('');
    const rest = s.puni === ALL ? unpatched(rig, match) : '';
    box.innerHTML = `${flagged.length && !q ? `<details class="pb-flags"><summary>${icon('warn')}${plural(flagged.length, 'fixture needs', 'fixtures need')} a look</summary><ul>${flagged.map((d) => `<li><button type="button" data-model="${d.id}">${esc(itemLabel(d))}</button><span>${esc(problemText(rig.problems.get(d.id).filter(isProblem), itemLabel).join('. '))}</span></li>`).join('')}</ul></details>` : ''}
      ${sections}${rest}
      ${!sections && !rest ? `<p class="pb-nomatch">${q ? 'Nothing here matches that.' : 'Nothing to show.'}</p>` : ''}`;
  }

  /** One universe: the 512-address bar, then its fixtures in address order. */
  function uniSection(rig, u, pt, match) {
    const on = rig.items.filter((d) => d.patch_universe === u).sort((a, b) => a.patch_address - b.patch_address || a.name.localeCompare(b.name));
    const shown = on.filter(match);
    if (!shown.length) return '';
    const used = rig.used.get(u);
    const bar = on.map((d) => {
      const ch = footprint(d, typeOf(d)) || 1;
      const bad = (rig.problems.get(d.id) || []).some((p) => p.kind === 'overlap');
      return `<i class="${bad ? 'bad' : ''}${covers(d, typeOf(d), pt) ? ' hit' : ''}" style="left:${((d.patch_address - 1) / SLOTS) * 100}%;width:${Math.max(0.35, (ch / SLOTS) * 100)}%;--h:${hue(d.type_id)}" title="${esc(`${d.name} · ${rangeText(d, ch)}`)}"></i>`;
    }).join('');
    return `<section class="pb-uni">
      <header><h3>Universe ${u}</h3><p><b>${used}</b> of 512 used <i>·</i> ${Math.max(0, SLOTS - used)} free</p></header>
      <div class="pb-addr" role="img" aria-label="${used} of 512 addresses used">${bar}<span class="pb-ticks" aria-hidden="true"><u></u><u></u><u></u></span></div>
      <div class="pb-scale" aria-hidden="true"><span>1</span><span>128</span><span>256</span><span>384</span><span>512</span></div>
      <table class="pb-t">
        <thead><tr><th>Patch</th><th class="pb-ch">Ch</th><th>FID</th><th>Fixture</th><th class="pb-as">Asset #</th></tr></thead>
        <tbody>${shown.map((d) => row(d, rig, true)).join('')}</tbody>
      </table>
    </section>`;
  }

  function row(d, rig, withPatch) {
    const t = typeOf(d);
    const ch = footprint(d, t);
    const probs = rig.problems.get(d.id) || [];
    const bad = probs.some(isProblem);
    const sub = [t?.name && !d.name.startsWith(t.name) ? t.name : d.location, bad ? problemText(probs.filter(isProblem), itemLabel)[0] : null].filter(Boolean).join(' · ');
    return `<tr class="${bad ? 'is-bad' : ''}" data-model="${d.id}" tabindex="0">
      ${withPatch ? `<td class="pb-pa">${esc(rangeText(d, ch))}${probs.some((p) => p.kind === 'shared') ? `<span title="On the same addresses as another fixture">${icon('link')}</span>` : ''}</td>
      <td class="pb-ch">${ch || '<span class="pb-nil">?</span>'}</td>` : ''}
      <td class="pb-fid">${d.fixture_id ?? '<span class="pb-nil">—</span>'}</td>
      <td class="pb-nm"><i style="--h:${hue(d.type_id)}"></i><span><b>${esc(d.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></td>
      <td class="pb-as">${esc(assetTag(d.asset_no)) || '<span class="pb-nil">—</span>'}</td>
    </tr>`;
  }

  function unpatched(rig, match) {
    const left = rig.items.filter((d) => d.patch_universe == null && match(d))
      .sort((a, b) => (typeOf(a)?.name || '').localeCompare(typeOf(b)?.name || '') || (a.asset_no ?? 1e9) - (b.asset_no ?? 1e9) || nameNumber(a.name) - nameNumber(b.name) || a.name.localeCompare(b.name));
    if (!left.length) return '';
    return `<section class="pb-uni is-un">
      <header><h3>Not patched</h3><p>${plural(left.length, 'fixture')}</p></header>
      <table class="pb-t">
        <thead><tr><th>FID</th><th>Fixture</th><th class="pb-as">Asset #</th></tr></thead>
        <tbody>${left.map((d) => row(d, rig, false)).join('')}</tbody>
      </table>
    </section>`;
  }

  // ------------------------------------------------------------------ edit ---
  /** The numbering table (views/patch.js), for the room that's open. */
  function startEdit() {
    const rig = rigs().find((r) => r.key === s.rig);
    if (!rig) return;
    s.campus = rig.c.id;
    s.prig[rig.c.id] = rig.key;
    s.editing = true;
    unlockPage();
    $('#pb-count', el).textContent = '';
    body.innerHTML = '<div class="pb-edit" id="g-results"></div>';
    old.startEdit();
    if (!old.editing()) { s.editing = false; draw(); }
    window.scrollTo(0, 0);
  }
}

