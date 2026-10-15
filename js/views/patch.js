// Gear › Patch: the patch sheet for each room's console, universe by universe.
//
//   One location   pick a room; each universe in use shows a bar of its 512
//                  addresses and the fixtures on it, then what isn't patched yet.
//                  "Edit numbers" opens a table of every fixture by model, with
//                  fill-in helpers (fixture IDs from 401, patch from 2.001…).
//   All locations  every room's rig at a glance; pick a universe to see what's
//                  on it everywhere ("universe 1 across all campuses").

import { esc, icon, $, $$, plural } from '../util.js';
import { typeLabel } from './types.js';
import {
  takesPatch, parsePatch, fmtPatch, patchOf, footprint, rigKey, rigProblems, problemText, isProblem, usedChannels,
  rangeText, nameNumber, patchPoint, covers, MAX_UNIVERSE, SLOTS,
} from '../lighting.js';

const ALL = 'all';
const HUES = [212, 32, 280, 150, 190, 48, 255, 120, 300, 170, 232, 88]; // no reds: red means a problem

/**
 * host: { s, ctx, typeOf, matches(d), openModel(id), load(quiet), setCampus(id), campusName(id) }
 * Returns { draw(box), tally(), click(e), input(e), change(e), busy() }.
 */
export function patchView(host) {
  const { s, ctx } = host;
  const typeOf = host.typeOf;
  const roomName = (id) => (id ? s.ix.room.get(id)?.name || 'Room' : 'No room');
  const hue = (typeId) => HUES[[...typeId].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
  s.prig = s.prig || {};          // campus id → chosen room key
  s.puni = s.puni ?? ALL;         // universe filter
  let edit = null;                // { key, rows: Map(id → {stage_no, fixture_id, patch, dmx_channels}), fill: {} }
  let saving = false;

  // ------------------------------------------------------------- data ----

  const fixtures = () => s.data.devices.filter((d) => takesPatch(d, typeOf(d)));

  /** Rigs (location + room) that have fixtures, in a sensible order. */
  function rigsAt(campusId) {
    const list = fixtures().filter((d) => d.campus_id === campusId);
    const keys = [...new Set(list.map(rigKey))];
    const rank = (key) => {
      const rid = key.split('|')[1];
      const name = roomName(rid);
      return [!rid || /storage/i.test(name) ? 2 : /^worship/i.test(name) ? 0 : 1, s.ix.room.get(rid)?.sort_order ?? 99, name];
    };
    return keys.sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
    }).map((key) => rigInfo(key, list.filter((d) => rigKey(d) === key)));
  }

  function rigInfo(key, items) {
    const [campusId, roomId] = key.split('|');
    const problems = rigProblems(items, typeOf);
    const unis = [...new Set(items.filter((d) => d.patch_universe != null).map((d) => d.patch_universe))].sort((a, b) => a - b);
    const consoles = s.data.devices.filter((d) => rigKey(d) === key && d.departments.includes('lighting') && /console|wing/i.test(typeOf(d)?.category || ''));
    return {
      key, campusId, roomId: roomId || null, items, problems, unis, consoles,
      patched: items.filter((d) => d.patch_universe != null).length,
      flagged: [...problems.values()].filter((l) => l.some(isProblem)).length,
    };
  }

  function chosenRig(rigs) {
    const want = s.prig[s.campus];
    return rigs.find((r) => r.key === want) || rigs[0] || null;
  }

  // ---------------------------------------------------------- drawing ----

  function draw(box) {
    if (edit) return drawEdit(box);
    const pt = patchPoint(s.q);
    if (s.campus === ALL) return drawAll(box, pt);
    const rigs = rigsAt(s.campus);
    if (!rigs.length) {
      box.innerHTML = `<div class="empty"><h3>No fixtures at ${esc(host.campusName(s.campus))}</h3>
        <p>Lighting fixtures added here show up on this patch sheet, room by room.</p></div>`;
      return tally(0, 0);
    }
    const rig = chosenRig(rigs);
    if (s.puni !== ALL && !rig.unis.includes(s.puni)) s.puni = ALL;
    box.innerHTML = `
      <div class="px-head">
        ${rigs.length > 1 ? `<div class="seg px-rooms" role="tablist" aria-label="Room">${rigs.map((r) => `<button type="button" role="tab" data-px-rig="${esc(r.key)}" aria-selected="${r.key === rig.key}">${esc(roomName(r.roomId))}<small>${r.items.length}</small></button>`).join('')}</div>` : `<h3 class="px-room">${esc(roomName(rig.roomId))}</h3>`}
        <button type="button" class="btn" data-px="edit">${icon('edit')}Edit numbers</button>
      </div>
      ${summaryLine(rig)}
      ${uniChips(rig.unis, (u) => rig.items.filter((d) => d.patch_universe === u).length)}
      ${problemList(rig)}
      ${rig.unis.filter((u) => s.puni === ALL || u === s.puni).map((u) => uniSection(rig, u, pt)).join('') || ''}
      ${s.puni === ALL ? unpatchedSection(rig) : ''}`;
    tally(rig.patched, rig.items.length);
  }

  function summaryLine(rig) {
    const left = rig.items.length - rig.patched;
    const bits = [
      `<b>${rig.patched}</b> of ${plural(rig.items.length, 'fixture')} patched${rig.unis.length ? ` on ${plural(rig.unis.length, 'universe')}` : ''}`,
      left ? `${left} not patched` : null,
      rig.consoles.length ? `Console: ${rig.consoles.map((c) => esc(typeLabel(typeOf(c)) || c.name)).join(', ')}` : null,
    ].filter(Boolean);
    return `<p class="px-sum">${bits.join('<i>·</i>')}</p>`;
  }

  function uniChips(unis, count) {
    if (unis.length < 2) return '';
    return `<div class="px-unis" role="group" aria-label="Universe">
      <button type="button" class="chip" data-px-uni="all" aria-pressed="${s.puni === ALL}">All universes</button>
      ${unis.map((u) => `<button type="button" class="chip" data-px-uni="${u}" aria-pressed="${s.puni === u}">U${u}<small>${count(u)}</small></button>`).join('')}
    </div>`;
  }

  function problemList(rig) {
    const lines = [];
    for (const d of rig.items) {
      const probs = (rig.problems.get(d.id) || []).filter(isProblem);
      if (probs.length) lines.push(`<li><button class="btn link" data-model="${d.id}">${esc(d.name)}</button> ${esc(problemText(probs, (o) => o.name).join('. '))}</li>`);
    }
    if (!lines.length) return '';
    return `<details class="px-problems"><summary>${icon('warn')}${plural(lines.length, 'fixture needs', 'fixtures need')} a look</summary><ul>${lines.join('')}</ul></details>`;
  }

  /** One universe: the 512-address bar, then its fixtures in address order. */
  function uniSection(rig, u, pt, heading = `Universe ${u}`) {
    const on = rig.items.filter((d) => d.patch_universe === u).sort((a, b) => a.patch_address - b.patch_address || a.name.localeCompare(b.name));
    const used = usedChannels(on, typeOf);
    const shown = on.filter((d) => host.matches(d) || covers(d, typeOf(d), pt));
    if (!shown.length && (s.q || s.cat !== ALL || s.brand !== ALL)) return '';
    const bar = on.map((d) => {
      const ch = footprint(d, typeOf(d)) || 1;
      const bad = (rig.problems.get(d.id) || []).some((p) => p.kind === 'overlap');
      const hit = covers(d, typeOf(d), pt);
      return `<i class="${bad ? 'bad' : ''} ${hit ? 'hit' : ''}" style="left:${((d.patch_address - 1) / SLOTS) * 100}%;width:${Math.max(0.35, (ch / SLOTS) * 100)}%;--h:${hue(d.type_id)}" title="${esc(`${d.name} · ${rangeText(d, ch)}`)}"></i>`;
    }).join('');
    return `<section class="px-uni">
      <header class="px-uni-head"><h3>${esc(heading)}</h3><span class="px-use"><b>${used}</b> of 512 used<i>·</i>${SLOTS - used} free</span></header>
      <div class="px-bar" role="img" aria-label="${used} of 512 addresses used">${bar}</div>
      <table class="px-table">
        <thead><tr><th>Patch</th><th class="px-ch">Ch</th><th>Fixture ID</th><th>Fixture</th><th class="px-st">Stage #</th></tr></thead>
        <tbody>${shown.map((d) => fixtureRow(d, rig)).join('')}</tbody>
      </table>
    </section>`;
  }

  function fixtureRow(d, rig, withPatch = true) {
    const t = typeOf(d);
    const ch = footprint(d, t);
    const probs = rig.problems.get(d.id) || [];
    const bad = probs.some(isProblem);
    const shared = probs.some((p) => p.kind === 'shared');
    return `<tr class="${bad ? 'is-bad' : ''}" data-model="${d.id}" tabindex="0">
      ${withPatch ? `<td class="mono px-addr">${esc(rangeText(d, ch))}${shared ? `<span class="px-link" title="On the same addresses as another fixture">${icon('link')}</span>` : ''}</td>
      <td class="px-ch mono">${ch || '<span class="muted">?</span>'}</td>` : ''}
      <td class="mono px-fid">${d.fixture_id ?? '<span class="muted">—</span>'}</td>
      <td class="px-name"><div class="px-nm"><i class="px-dot" style="--h:${hue(d.type_id)}"></i><span><b>${esc(d.name)}</b><small>${esc((t?.name && !d.name.startsWith(t.name) ? t.name : d.location) || '')}${bad ? ` · ${esc(problemText(probs.filter(isProblem), (o) => o.name)[0])}` : ''}</small></span></div></td>
      <td class="px-st mono">${d.stage_no ?? ''}</td>
    </tr>`;
  }

  function unpatchedSection(rig) {
    const left = rig.items.filter((d) => d.patch_universe == null && host.matches(d))
      .sort((a, b) => (typeOf(a)?.name || '').localeCompare(typeOf(b)?.name || '') || (a.stage_no ?? 1e9) - (b.stage_no ?? 1e9) || nameNumber(a.name) - nameNumber(b.name));
    if (!left.length) return rig.items.length && rig.patched === rig.items.length ? '<p class="px-done">' + icon('check') + 'Every fixture here is patched.</p>' : '';
    return `<section class="px-uni is-unpatched">
      <header class="px-uni-head"><h3>Not patched</h3><span class="px-use">${plural(left.length, 'fixture')}</span></header>
      <table class="px-table">
        <thead><tr><th>Fixture ID</th><th>Fixture</th><th class="px-st">Stage #</th></tr></thead>
        <tbody>${left.map((d) => fixtureRow(d, rig, false)).join('')}</tbody>
      </table>
    </section>`;
  }

  // All locations: every rig at a glance, or one universe everywhere.
  function drawAll(box, pt) {
    const rigs = ctx.campuses.flatMap((c) => rigsAt(c.id));
    const unis = [...new Set(rigs.flatMap((r) => r.unis))].sort((a, b) => a - b);
    if (s.puni !== ALL && !unis.includes(s.puni)) s.puni = ALL;
    const total = rigs.reduce((n, r) => n + r.items.length, 0);
    const patched = rigs.reduce((n, r) => n + r.patched, 0);
    tally(patched, total);
    if (!rigs.length) {
      box.innerHTML = `<div class="empty"><h3>No lighting fixtures yet</h3><p>Fixtures added in Gear show up here, on each room’s patch sheet.</p></div>`;
      return;
    }
    const where = (r) => `${host.campusName(r.campusId)} · ${roomName(r.roomId)}`;
    const chips = `<div class="px-unis" role="group" aria-label="Universe">
      <button type="button" class="chip" data-px-uni="all" aria-pressed="${s.puni === ALL}">Every room</button>
      ${unis.map((u) => `<button type="button" class="chip" data-px-uni="${u}" aria-pressed="${s.puni === u}">U${u}<small>${rigs.filter((r) => r.unis.includes(u)).length}</small></button>`).join('')}
    </div>`;

    if (s.puni !== ALL || pt) {
      const u = pt ? pt.universe : s.puni;
      const withU = rigs.filter((r) => r.unis.includes(u));
      const fx = withU.flatMap((r) => r.items.filter((d) => d.patch_universe === u));
      const ch = withU.reduce((n, r) => n + usedChannels(r.items.filter((d) => d.patch_universe === u), typeOf), 0);
      box.innerHTML = `${chips}
        <p class="px-sum">Universe ${u} is used in <b>${plural(withU.length, 'room')}</b> at ${plural(new Set(withU.map((r) => r.campusId)).size, 'location')}<i>·</i>${plural(fx.length, 'fixture')}<i>·</i>${ch.toLocaleString()} of ${(withU.length * SLOTS).toLocaleString()} addresses</p>
        ${withU.map((r) => uniSection(r, u, pt, where(r))).join('') || `<p class="muted">Nothing on universe ${u} matches.</p>`}`;
      return;
    }

    box.innerHTML = `${chips}
      <p class="px-sum"><b>${patched}</b> of ${plural(total, 'fixture')} patched in ${plural(rigs.length, 'room')}${unis.length ? `<i>·</i>universes ${esc(compactRange(unis))} in use` : ''}</p>
      <div class="px-cards">${rigs.map((r) => {
        const shown = r.items.filter(host.matches).length;
        if (!shown) return '';
        return `<button type="button" class="px-card" data-px-go="${esc(r.key)}">
          <span class="px-card-head"><small>${esc(host.campusName(r.campusId))}</small><b>${esc(roomName(r.roomId))}</b></span>
          <span class="px-card-count"><b>${r.patched}</b>/${r.items.length} patched${r.flagged ? `<em>${icon('warn')}${r.flagged}</em>` : ''}</span>
          <span class="px-minis">${r.unis.map((u) => {
            const used = usedChannels(r.items.filter((d) => d.patch_universe === u), typeOf);
            return `<span class="px-mini"><small>U${u}</small><span class="px-mini-bar"><i style="width:${(used / SLOTS) * 100}%"></i></span></span>`;
          }).join('') || '<span class="muted">Nothing patched yet</span>'}</span>
          ${r.consoles.length ? `<span class="px-card-console">${esc(r.consoles.map((c) => typeOf(c)?.name || c.name).join(', '))}</span>` : ''}
        </button>`;
      }).join('')}</div>`;
  }

  function tally(patched, total) {
    $('#g-tally').innerHTML = `<b>${patched}</b><span>patched</span><small>of ${plural(total, 'fixture')}</small>`;
  }

  // ------------------------------------------------------------- edit ----

  function startEdit() {
    const rig = chosenRig(rigsAt(s.campus));
    if (!rig) return;
    const rows = new Map(rig.items.map((d) => [d.id, {
      stage_no: d.stage_no == null ? '' : String(d.stage_no),
      fixture_id: d.fixture_id == null ? '' : String(d.fixture_id),
      patch: patchOf(d),
      dmx_channels: d.dmx_channels == null ? '' : String(d.dmx_channels),
    }]));
    edit = { key: rig.key, rows, fill: {} };
    redraw();
  }

  function editItems() {
    return s.data.devices.filter((d) => rigKey(d) === edit.key && takesPatch(d, typeOf(d)));
  }

  /** The rig as it would be after saving: for the live overlap and duplicate checks. */
  function staged() {
    return editItems().map((d) => {
      const r = edit.rows.get(d.id);
      if (!r) return d;
      const p = parsePatch(r.patch);
      return { ...d, stage_no: toInt(r.stage_no), fixture_id: toInt(r.fixture_id), dmx_channels: toInt(r.dmx_channels),
        patch_universe: p.universe ?? null, patch_address: p.address ?? null };
    });
  }

  function drawEdit(box) {
    const items = editItems();
    const [campusId, roomId] = edit.key.split('|');
    const groups = new Map();
    for (const d of items) {
      if (!groups.has(d.type_id)) groups.set(d.type_id, []);
      groups.get(d.type_id).push(d);
    }
    const order = [...groups.keys()].sort((a, b) => typeLabel(typeOf({ type_id: a })).localeCompare(typeLabel(typeOf({ type_id: b }))));
    box.innerHTML = `
      <div class="px-edit-bar">
        <div><span class="eyebrow">Editing numbers</span><b>${esc(host.campusName(campusId))} · ${esc(roomName(roomId || null))}</b></div>
        <span class="spacer"></span>
        <p class="form-msg" id="px-msg" role="status"></p>
        <button type="button" class="btn" data-px="cancel">Cancel</button>
        <button type="button" class="btn primary" data-px="save">Save</button>
      </div>
      <p class="fine px-howto">Type a patch as universe.address, like 1.333. Each model has a quick fill: give the first fixture ID and patch and it numbers the rest in stage order. Enter moves down a column.</p>
      ${order.map((tid) => groupHtml(tid, groups.get(tid).sort(byStage))).join('')}
      <div class="px-edit-foot"><button type="button" class="btn" data-px="cancel">Cancel</button><button type="button" class="btn primary" data-px="save">Save</button></div>`;
    refreshMarks();
  }

  const byStage = (a, b) => (a.stage_no ?? 1e9) - (b.stage_no ?? 1e9) || nameNumber(a.name) - nameNumber(b.name) || a.name.localeCompare(b.name);

  function groupHtml(typeId, list) {
    const t = typeOf({ type_id: typeId }) || {};
    const ch = footprint({}, t);
    const f = edit.fill[typeId] || (edit.fill[typeId] = suggestFill(typeId, list));
    return `<section class="px-group" data-type-group="${typeId}">
      <header class="px-group-head">
        <i class="px-dot" style="--h:${hue(typeId)}"></i>
        <span><b>${esc(t.name || 'Model')}</b><small>${esc([t.manufacturer, t.part_number, `${list.length} here`, ch ? `${ch} ch` : null].filter(Boolean).join(' · '))}</small></span>
      </header>
      <div class="px-fill">
        <label class="field"><span>Fixture IDs from</span><input class="mono" data-fill="fid" data-t="${typeId}" value="${esc(f.fid)}" inputmode="numeric" placeholder="401"></label>
        <label class="field"><span>Patch from</span><input class="mono" data-fill="patch" data-t="${typeId}" value="${esc(f.patch)}" inputmode="decimal" placeholder="1.001" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Channels each</span><input class="mono" data-fill="ch" data-t="${typeId}" value="${esc(f.ch)}" inputmode="numeric" placeholder="${ch || '?'}"></label>
        <div class="px-fill-btns">
          <button type="button" class="btn" data-px="fill" data-t="${typeId}">${icon('wand')}Fill ${list.length > 1 ? `all ${list.length}` : ''}</button>
          ${list.length > 1 ? `<button type="button" class="btn ghost" data-px="restage" data-t="${typeId}">Stage # 1–${list.length}</button>` : ''}
        </div>
      </div>
      <div class="px-escroll"><table class="px-etable">
        <thead><tr><th>Stage #</th><th>Fixture</th><th>Fixture ID</th><th>Patch</th><th>Ch</th></tr></thead>
        <tbody>${list.map((d) => {
          const r = edit.rows.get(d.id);
          const cell = (k, cls, ph, mode = 'numeric') => `<td><input class="mono ${cls}" data-row="${d.id}" data-k="${k}" value="${esc(r[k])}" inputmode="${mode}" placeholder="${esc(ph)}" aria-label="${esc(d.name)} ${k.replace('_', ' ')}" autocomplete="off"></td>`;
          return `<tr data-erow="${d.id}">
            ${cell('stage_no', 'px-in-st', '')}
            <td class="px-name"><b>${esc(d.name)}</b><small class="px-row-msg" id="pxm-${d.id}"></small></td>
            ${cell('fixture_id', 'px-in-fid', '')}
            ${cell('patch', 'px-in-patch', '1.001', 'decimal')}
            ${cell('dmx_channels', 'px-in-ch', ch ? String(ch) : '')}
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>`;
  }

  /** Starting numbers for a model's quick fill: what it has now, or the next free spot. */
  function suggestFill(typeId, list) {
    const t = typeOf({ type_id: typeId });
    const ch = footprint({}, t) || Math.max(0, ...list.map((d) => d.dmx_channels || 0)) || '';
    const fids = list.map((d) => d.fixture_id).filter((x) => x != null);
    const others = editItems().filter((d) => d.type_id !== typeId);
    let fid = fids.length ? Math.min(...fids) : '';
    if (fid === '') {
      const top = Math.max(0, ...others.map((d) => d.fixture_id || 0));
      fid = top ? (Math.floor(top / 100) + 1) * 100 + 1 : 101;
    }
    const first = list.find((d) => d.patch_universe != null); // list is in stage order
    let patch = first ? fmtPatch(first.patch_universe, first.patch_address) : '';
    if (!patch && ch) patch = firstRoom(others, list.length * ch, ch);
    return { fid: String(fid), patch, ch: ch ? String(ch) : '' };
  }

  /** First place `need` addresses fit in a row on one universe (or the first empty universe). */
  function firstRoom(others, need, ch) {
    for (let u = 1; u <= MAX_UNIVERSE; u++) {
      const taken = new Uint8Array(SLOTS + 2);
      for (const d of others) {
        if (d.patch_universe !== u) continue;
        const n = footprint(d, typeOf(d)) || 1;
        for (let a = d.patch_address; a < d.patch_address + n && a <= SLOTS; a++) taken[a] = 1;
      }
      const run = Math.min(need, SLOTS - (SLOTS % ch));
      for (let a = 1; a + run - 1 <= SLOTS; a++) {
        let ok = true;
        for (let k = a; k < a + run; k++) if (taken[k]) { ok = false; a = k; break; }
        if (ok) return fmtPatch(u, a);
      }
    }
    return '';
  }

  function fill(typeId) {
    const f = readFill(typeId);
    const list = editItems().filter((d) => d.type_id === typeId).sort(byStage);
    const msg = $('#px-msg');
    const p = f.patch ? parsePatch(f.patch) : { empty: true };
    if (p.error) { msg.textContent = `Patch from: ${p.error}`; msg.className = 'form-msg bad'; return; }
    const step = toInt(f.ch) || footprint({}, typeOf({ type_id: typeId }));
    if (!p.empty && !step) { msg.textContent = 'Set the channels each one takes, so the patch can step along.'; msg.className = 'form-msg bad'; return; }
    let fid = toInt(f.fid);
    let u = p.universe, a = p.address;
    for (const d of list) {
      const r = edit.rows.get(d.id);
      if (fid != null) r.fixture_id = String(fid++);
      if (!p.empty) {
        if (a + step - 1 > SLOTS) { u += 1; a = 1; }        // won't fit: start the next universe
        if (u > MAX_UNIVERSE) break;
        r.patch = fmtPatch(u, a);
        a += step;
      }
      if (toInt(f.ch) && toInt(f.ch) !== footprint({}, typeOf(d))) r.dmx_channels = String(toInt(f.ch));
    }
    msg.textContent = ''; msg.className = 'form-msg';
    redraw();
  }

  function restage(typeId) {
    editItems().filter((d) => d.type_id === typeId).sort(byStage).forEach((d, i) => { edit.rows.get(d.id).stage_no = String(i + 1); });
    redraw();
  }

  function readFill(typeId) {
    const f = edit.fill[typeId];
    for (const el of $$(`[data-fill][data-t="${typeId}"]`)) f[el.dataset.fill] = el.value.trim();
    return f;
  }

  /** Marks bad cells and fixtures that collide, and counts what will change. */
  function refreshMarks() {
    const rig = staged();
    const probs = rigProblems(rig, typeOf);
    let changes = 0;
    let errors = 0;
    for (const d of editItems()) {
      const r = edit.rows.get(d.id);
      const row = $(`[data-erow="${d.id}"]`);
      if (!row) continue;
      const bad = {};
      const p = parsePatch(r.patch);
      if (p.error) bad.patch = p.error;
      for (const k of ['stage_no', 'fixture_id', 'dmx_channels']) if (r[k] && !(toInt(r[k]) >= 1)) bad[k] = 'Use a whole number';
      if (toInt(r.dmx_channels) > SLOTS) bad.dmx_channels = 'Up to 512';
      const now = rig.find((x) => x.id === d.id);
      const ch = footprint(now, typeOf(d)) || 1;
      if (!p.error && !p.empty && p.address + ch - 1 > SLOTS) bad.patch = `Runs past 512 with ${ch} ch`;
      for (const el of $$('input', row)) {
        el.classList.toggle('is-bad', !!bad[el.dataset.k]);
        el.title = bad[el.dataset.k] || '';
      }
      const lines = [...Object.values(bad), ...problemText((probs.get(d.id) || []).filter(isProblem), (o) => o.name)];
      const msgEl = $(`#pxm-${d.id}`);
      if (msgEl) msgEl.textContent = lines.join('. ');
      row.classList.toggle('is-bad', lines.length > 0);
      if (Object.keys(bad).length) errors++;
      if (Object.keys(diffRow(d, r)).length) changes++;
    }
    for (const btn of $$('[data-px="save"]')) {
      btn.disabled = saving || !changes || errors > 0;
      btn.textContent = saving ? 'Saving…' : errors ? `Fix ${plural(errors, 'fixture')} first` : changes ? `Save ${plural(changes, 'fixture')}` : 'No changes';
    }
  }

  function diffRow(d, r) {
    const out = {};
    const p = parsePatch(r.patch);
    const want = { stage_no: toInt(r.stage_no), fixture_id: toInt(r.fixture_id), dmx_channels: toInt(r.dmx_channels),
      patch_universe: p.universe ?? null, patch_address: p.address ?? null };
    for (const [k, v] of Object.entries(want)) if (v !== (d[k] ?? null)) out[k] = v;
    if ('patch_universe' in out || 'patch_address' in out) Object.assign(out, { patch_universe: want.patch_universe, patch_address: want.patch_address });
    return out;
  }

  async function save() {
    if (saving) return;
    const rows = editItems().map((d) => ({ id: d.id, ...diffRow(d, edit.rows.get(d.id)) })).filter((r) => Object.keys(r).length > 1);
    if (!rows.length) { edit = null; redraw(); return; }
    saving = true; refreshMarks();
    try {
      await ctx.store.setDeviceNumbers(rows);
      ctx.toast(`Saved numbers for ${plural(rows.length, 'fixture')}`);
      edit = null;
      saving = false;
      await host.load(true);
    } catch (e) {
      saving = false;
      refreshMarks();
      const msg = $('#px-msg');
      if (msg) { msg.textContent = e.message; msg.className = 'form-msg bad'; }
    }
  }

  function redraw() { draw($('#g-results')); }

  // ----------------------------------------------------------- events ----

  function click(e) {
    const t = e.target.closest('[data-px], [data-px-rig], [data-px-uni], [data-px-go]');
    if (!t) return;
    if (t.dataset.pxRig) { s.prig[s.campus] = t.dataset.pxRig; s.puni = ALL; redraw(); }
    else if (t.dataset.pxUni) { s.puni = t.dataset.pxUni === ALL ? ALL : Number(t.dataset.pxUni); redraw(); }
    else if (t.dataset.pxGo) {
      const [campusId] = t.dataset.pxGo.split('|');
      s.prig[campusId] = t.dataset.pxGo;
      s.puni = ALL;
      host.setCampus(campusId);
    } else {
      const a = t.dataset.px;
      if (a === 'edit') startEdit();
      else if (a === 'cancel') { edit = null; redraw(); }
      else if (a === 'save') save();
      else if (a === 'fill') fill(t.dataset.t);
      else if (a === 'restage') restage(t.dataset.t);
    }
  }

  function input(e) {
    if (!edit) return;
    const el = e.target;
    if (el.dataset.row) { edit.rows.get(el.dataset.row)[el.dataset.k] = el.value.trim(); refreshMarks(); }
    else if (el.dataset.fill) readFill(el.dataset.t);
  }

  function keydown(e) {
    // Enter moves down the column, like a spreadsheet.
    const el = e.target;
    if (!edit || e.key !== 'Enter' || !el.dataset?.row) return;
    e.preventDefault();
    const col = $$(`input[data-k="${el.dataset.k}"]`);
    col[col.indexOf(el) + 1]?.focus();
  }

  return { draw, click, input, keydown, editing: () => !!edit, cancel: () => { edit = null; } };
}

const toInt = (v) => (v === '' || v == null || !/^\d+$/.test(String(v)) ? null : Number(v));

/** [1,2,3,5,7,8] → "1–3, 5, 7–8" */
function compactRange(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}–${nums[j]}` : String(nums[i]));
    i = j;
  }
  return out.join(', ');
}
