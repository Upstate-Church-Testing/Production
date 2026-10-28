// Cables: what kinds of cable we have, and how many of each length and label.
//
// Cables aren't tracked one by one like gear. A cable type is a signal and two
// ends (DMX · XLR 5-pin male → XLR 5-pin female). Under it, each row is one
// length and label at one place with a count: 25 ft, Elite Core blue, ×6,
// Simpsonville · Storage.
//   Types   every kind of cable with its lengths and a total
//   Cables  every length and label, with + and − for the count
// Search like you'd say it: "5-pin 25", "3-pin to 5-pin", "powercon 10".

import { esc, icon, $, $$, debounce, storage, store, plural } from '../util.js';
import { ALL, dropdownHtml, wireDropdown, locationDropdown } from '../picker.js';

export const SIGNALS = ['DMX', 'Audio', 'SDI', 'HDMI', 'Ethernet', 'Power', 'Other'];
export const ENDS = ['XLR 3-pin male', 'XLR 3-pin female', 'XLR 5-pin male', 'XLR 5-pin female', 'PowerCon blue (in)', 'PowerCon white (out)',
  'PowerCon TRUE1', 'Edison male', 'Edison female', 'BNC', 'etherCON', 'RJ45', 'HDMI', 'USB', '¼″ TRS', 'Speakon', 'Socapex'];
const DEFAULT_ENDS = { DMX: ['XLR 5-pin male', 'XLR 5-pin female'], Audio: ['XLR 3-pin male', 'XLR 3-pin female'], SDI: ['BNC', 'BNC'],
  HDMI: ['HDMI', 'HDMI'], Ethernet: ['RJ45', 'RJ45'], Power: ['Edison male', 'PowerCon blue (in)'], Other: ['', ''] };
export const LENGTHS = [3, 5, 10, 15, 20, 25, 30, 35, 50, 100];
export const LABEL_COLORS = { Purple: '#a78bfa', Blue: '#4da3ff', Green: '#3dd68c', Orange: '#ff9f43', Red: '#ff6b6b', Yellow: '#f5d544',
  Pink: '#f472b6', White: '#f2f4f5', Gray: '#959ca5', Brown: '#a0703c', Black: '#26292e' };
const NO_ROOM = '__none';
const NO_LABEL = '__plain';
const STOP = new Set(['to', '→', '->', '>', 'cable', 'cables', 'x', 'of', 'and']);

/** "XLR 5-pin male" → "5-pin", "PowerCon blue (in)" → "PowerCon blue", "Edison male" → "Edison". */
const shortEnd = (e) => String(e || '').replace(/^XLR\s+/i, '').replace(/\s*\([^)]*\)/g, '').replace(/\s+(male|female)$/i, '').trim();
/** What people call it: "DMX 5-pin", "DMX 3-pin → 5-pin", "Edison → PowerCon blue", or its nickname. */
export function cableName(t) {
  if (!t) return 'Cable';
  if (t.name) return t.name;
  const a = shortEnd(t.end_a), b = shortEnd(t.end_b);
  if (a.toLowerCase() === b.toLowerCase()) return `${t.signal} ${a}`;
  return /^xlr/i.test(t.end_a) && /^xlr/i.test(t.end_b) ? `${t.signal} ${a} → ${b}` : `${a} → ${b}`;
}
export const lengthText = (n) => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })} ft`;
const labelText = (c) => (c.labeled ? `Elite Core${c.label_color ? ` ${c.label_color.toLowerCase()}` : ''}` : 'No label');
const swatch = (c) => (c.labeled ? `<i class="cb-sw" style="--lc:${esc(LABEL_COLORS[c.label_color] || 'var(--muted)')}" title="${esc(labelText(c))}"></i>` : '<i class="cb-sw is-plain" title="No label"></i>');
const norm = (x) => String(x || '').toLowerCase().replace(/(\d+)\s*-?\s*pins?\b/g, '$1-pin').replace(/(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|'|’|′)/g, '$1ft');

export function mount(el, ctx) {
  let alive = true;
  const s = {
    mode: storage('ucp.cablemode', 'types'),
    q: '',
    campus: ctx.campus,
    room: ALL,
    signal: ALL,
    label: ALL,
    data: null,
    error: null,
  };
  if (s.campus !== ALL && !ctx.campusById.has(s.campus)) s.campus = ALL;
  const pending = new Map(); // count saves in flight, per row, so quick taps land in order

  el.innerHTML = `
    <div class="page-head">
      <div class="mode-row">
        <div class="seg mode-seg" role="tablist" aria-label="Show">
          <button type="button" role="tab" data-cmode="types">Types</button>
          <button type="button" role="tab" data-cmode="lines">Cables</button>
        </div>
        <p class="tally" id="c-tally" aria-live="polite"></p>
        <button class="btn primary add-desktop" data-act="add">${icon('plus')}<span>Add cables</span></button>
      </div>
    </div>
    <div class="toolbar filter-bar">
      <div class="search">${icon('search')}<input id="c-q" type="search" placeholder="Search like “5-pin 25” or “3-pin to 5-pin”" autocomplete="off" enterkeyhint="search" aria-label="Search cables"></div>
      <div class="filters">
        ${dropdownHtml('c-loc', 'Location', 'caps')}
        ${dropdownHtml('c-room', 'Room')}
        ${dropdownHtml('c-sig', 'Signal')}
        ${dropdownHtml('c-lab', 'Label')}
      </div>
    </div>
    <div id="c-results" class="results" aria-live="polite"></div>
    <button class="fab" data-act="add" aria-label="Add cables">${icon('plus')}</button>`;

  const total = (list) => list.reduce((n, c) => n + c.quantity, 0);
  const loc = locationDropdown(ctx, $('#c-loc', el), {
    unit: ['cable', 'cables'],
    get: () => s.campus,
    set: (v) => { s.campus = ctx.campus = v; draw(); },
    counts: () => {
      if (!s.data) return {};
      const out = { [ALL]: total(s.data.cables) };
      for (const c of ctx.campuses) out[c.id] = total(s.data.cables.filter((x) => x.campus_id === c.id));
      return out;
    },
  });
  const roomDd = wireDropdown($('#c-room', el), {
    label: 'Room', unit: ['cable', 'cables'], get: () => s.room, set: (v) => { s.room = v; draw(); }, options: () => roomOptions(),
  });
  function roomOptions() {
      const here = s.data ? s.data.cables.filter(inCampus) : [];
      const by = new Map();
      for (const c of here) {
        const k = roomKey(c);
        const o = by.get(k) || { value: k, label: k === NO_ROOM ? 'No room' : roomOf(c.room_id)?.name.trim(), count: 0 };
        o.count += c.quantity; by.set(k, o);
      }
      return [{ value: ALL, label: 'All rooms', count: total(here) }, ...[...by.values()].sort((a, b) => (a.value === NO_ROOM) - (b.value === NO_ROOM) || a.label.localeCompare(b.label))];
  }
  const sigDd = wireDropdown($('#c-sig', el), {
    label: 'Signal', unit: ['cable', 'cables'], get: () => s.signal, set: (v) => { s.signal = v; draw(); }, options: () => sigOptions(),
  });
  function sigOptions() {
      const here = s.data ? s.data.cables.filter((c) => inCampus(c) && inRoom(c)) : [];
      const sigs = [...new Set([...(s.data?.types || []).map((t) => t.signal)])].sort((a, b) => sigOrder(a) - sigOrder(b) || a.localeCompare(b));
      return [{ value: ALL, label: 'All', count: total(here) }, ...sigs.map((g) => ({ value: g, label: g, count: total(here.filter((c) => typeOf(c)?.signal === g)) }))];
  }
  const labDd = wireDropdown($('#c-lab', el), {
    label: 'Label', unit: ['cable', 'cables'], get: () => s.label, set: (v) => { s.label = v; draw(); }, options: () => labOptions(),
  });
  function labOptions() {
      const here = s.data ? s.data.cables.filter((c) => inCampus(c) && inRoom(c) && inSignal(c)) : [];
      const colors = [...new Set(here.filter((c) => c.labeled).map((c) => c.label_color || 'No color'))].sort();
      return [{ value: ALL, label: 'All', count: total(here) },
        ...colors.map((k) => ({ value: k, label: `Elite Core ${k.toLowerCase()}`, count: total(here.filter((c) => c.labeled && (c.label_color || 'No color') === k)) })),
        { value: NO_LABEL, label: 'No label', count: total(here.filter((c) => !c.labeled)) }];
  }

  const q = $('#c-q', el);
  q.addEventListener('input', debounce(() => { s.q = q.value.trim(); draw(); }, 120));
  el.addEventListener('click', onClick);
  const unsubscribe = ctx.store.subscribe(debounce((table) => { if (!table || table === 'cables' || table === 'rooms') load(true); }, 300));
  // ---------------------------------------------------------------- data --

  async function load(quiet = false) {
    if (!alive) return;
    if (!quiet) $('#c-results', el).innerHTML = `<div class="loading">${'<div class="sk"></div>'.repeat(4)}</div>`;
    try { s.data = await ctx.store.cables(); s.error = null; } catch (e) { s.error = e.message; }
    if (!alive) return;
    draw();
  }
  function typeOf(c) { return s.data.types.find((t) => t.id === c.type_id); }
  function roomOf(id) { return s.data.rooms.find((r) => r.id === id); }
  function roomKey(c) { const r = c.room_id && roomOf(c.room_id); return r ? r.name.trim().toLowerCase() : NO_ROOM; }
  function campusName(id) { return ctx.campusById.get(id)?.short_name || 'Unknown location'; }
  function inCampus(c) { return s.campus === ALL || c.campus_id === s.campus; }
  function inRoom(c) { return s.room === ALL || roomKey(c) === s.room; }
  function inSignal(c) { return s.signal === ALL || typeOf(c)?.signal === s.signal; }
  function inLabel(c) { return s.label === ALL || (s.label === NO_LABEL ? !c.labeled : c.labeled && (c.label_color || 'No color') === s.label); }
  function sigOrder(g) { const i = SIGNALS.indexOf(g); return i < 0 ? SIGNALS.length : i; }
  function where(c) { return [s.campus === ALL ? campusName(c.campus_id) : null, roomOf(c.room_id)?.name].filter(Boolean).join(' · ') || campusName(c.campus_id); }

  /** "5-pin 25": every word has to match; a bare number is a length or a pin count; "3-pin to 5-pin" keeps the order. */
  function matches(c) {
    if (!s.q) return true;
    const t = typeOf(c);
    const text = norm(s.q);
    const dir = /(\S+)\s+(?:to|→|->|>)\s+(\S+)/.exec(text);
    if (dir && !(norm(t.end_a).includes(dir[1]) && norm(t.end_b).includes(dir[2]))) return false;
    const hay = norm([t.signal, t.end_a, t.end_b, t.name, cableName(t), labelText(c), c.labeled ? 'elite core label labeled' : 'no label unlabeled plain',
      c.notes, t.notes, campusName(c.campus_id), ctx.campusById.get(c.campus_id)?.name, roomOf(c.room_id)?.name, `${Number(c.length_ft)}ft`].filter(Boolean).join(' '));
    return text.split(/\s+/).filter((w) => w && !STOP.has(w)).every((w) => {
      if (/^\d+(\.\d+)?$/.test(w)) return Number(w) === Number(c.length_ft) || hay.includes(`${w}-pin`);
      if (/^\d+(\.\d+)?ft$/.test(w)) return Number(w.slice(0, -2)) === Number(c.length_ft);
      return hay.includes(w);
    });
  }
  function shownLines() { return s.data.cables.filter((c) => inCampus(c) && inRoom(c) && inSignal(c) && inLabel(c) && matches(c)); }
  function filtering() { return !!(s.q || s.room !== ALL || s.signal !== ALL || s.label !== ALL); }

  // ------------------------------------------------------------- drawing --

  function draw() {
    $$('[data-cmode]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cmode === s.mode)));
    const box = $('#c-results', el);
    if (s.error) {
      $('#c-tally', el).innerHTML = '';
      box.innerHTML = `<div class="empty"><h3>Couldn’t load cables</h3><p>${esc(s.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
      return;
    }
    if (!s.data) return;
    // Each filter stays valid for the ones before it.
    if (!roomOptions().some((o) => o.value === s.room)) s.room = ALL;
    if (!sigOptions().some((o) => o.value === s.signal)) s.signal = ALL;
    if (!labOptions().some((o) => o.value === s.label)) s.label = ALL;
    loc.update(); roomDd.update(); sigDd.update(); labDd.update();
    const lines = shownLines();
    const n = total(lines);
    const all = total(s.data.cables.filter(inCampus));
    $('#c-tally', el).innerHTML = `<b>${n}</b><span>${n === 1 ? 'cable' : 'cables'}</span>${filtering() && n !== all ? `<small>of ${all} · <button class="btn link" data-act="clear">Clear</button></small>` : ''}`;
    if (!s.data.types.length) {
      box.innerHTML = `<div class="empty"><h3>No cables yet</h3><p>Add a kind of cable, like DMX 5-pin, then how many of each length you have.</p>
        <div class="empty-actions"><button class="btn primary" data-act="add">${icon('plus')}Add cables</button></div></div>`;
      return;
    }
    if (!lines.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `No cable matches “${esc(s.q)}”` : 'No cable matches these filters'}${s.campus !== ALL ? ` at ${esc(campusName(s.campus))}` : ''}.</p>
        <div class="empty-actions">${filtering() ? '<button class="btn" data-act="clear">Clear search and filters</button>' : ''}<button class="btn" data-act="add">${icon('plus')}Add cables</button></div></div>`;
      return;
    }
    box.innerHTML = s.mode === 'lines' ? drawLines(lines) : drawTypes(lines);
  }

  const byLength = (a, b) => Number(a.length_ft) - Number(b.length_ft) || Number(b.labeled) - Number(a.labeled) || (a.label_color || '').localeCompare(b.label_color || '');

  function drawTypes(lines) {
    const types = s.data.types.filter((t) => lines.some((c) => c.type_id === t.id));
    const groups = new Map();
    for (const t of types.sort((a, b) => cableName(a).localeCompare(cableName(b), undefined, { numeric: true }))) {
      if (!groups.has(t.signal)) groups.set(t.signal, []);
      groups.get(t.signal).push(t);
    }
    return [...groups.keys()].sort((a, b) => sigOrder(a) - sigOrder(b) || a.localeCompare(b)).map((g) => `<section class="net">
      <header class="net-head"><div class="net-title"><h3>${esc(g)}</h3><span class="count">${total(lines.filter((c) => typeOf(c).signal === g))}</span></div></header>
      <ul class="gear-list">${groups.get(g).map((t) => {
        const mine = lines.filter((c) => c.type_id === t.id).sort(byLength);
        // One chip per length and label; the same length at two places adds up.
        const chips = new Map();
        for (const c of mine) {
          const k = `${Number(c.length_ft)}|${c.labeled}|${c.label_color || ''}`;
          const o = chips.get(k) || { c, n: 0 }; o.n += c.quantity; chips.set(k, o);
        }
        return `<li class="gear-row cb-type">
          <button class="row-hit" data-cb-type="${t.id}" aria-label="Open ${esc(cableName(t))}"></button>
          <span class="cb-ends" aria-hidden="true"><span>${esc(shortEnd(t.end_a).split(' ')[0])}</span><i></i><span>${esc(shortEnd(t.end_b).split(' ')[0])}</span></span>
          <span class="g-text">
            <b class="g-name">${esc(cableName(t))}</b>
            <span class="g-sub">${esc(`${t.end_a} → ${t.end_b}`)}</span>
            <span class="cb-chips">${[...chips.values()].map(({ c, n }) => `<span class="cb-chip">${swatch(c)}${esc(lengthText(c.length_ft))}<small>×${n}</small></span>`).join('')}</span>
          </span>
          <span class="g-count"><b>${total(mine)}</b><small>${total(mine) === 1 ? 'cable' : 'cables'}</small></span>
        </li>`;
      }).join('')}</ul>
    </section>`).join('');
  }

  function drawLines(lines) {
    const sorted = [...lines].sort((a, b) => sigOrder(typeOf(a).signal) - sigOrder(typeOf(b).signal) || cableName(typeOf(a)).localeCompare(cableName(typeOf(b))) || byLength(a, b));
    return `<section class="net"><ul class="gear-list">${sorted.map((c) => {
      const t = typeOf(c);
      return `<li class="gear-row cb-line ${c.quantity ? '' : 'is-out'}">
        <button class="row-hit" data-cb-line="${c.id}" aria-label="Open ${esc(cableName(t))} ${esc(lengthText(c.length_ft))}"></button>
        <span class="cb-len"><b>${esc(String(Number(c.length_ft)))}</b><small>ft</small></span>
        <span class="g-text">
          <span class="g-brand"><span>${esc(t.signal)}</span></span>
          <b class="g-name">${esc(cableName(t))}</b>
          <span class="g-sub">${swatch(c)}${esc([labelText(c), where(c)].join(' · '))}</span>
        </span>
        ${stepper(c)}
      </li>`;
    }).join('')}</ul></section>`;
  }

  const stepper = (c) => `<span class="cb-step" role="group" aria-label="How many">
      <button type="button" class="icon-btn" data-cb-step="${c.id}" data-d="-1" aria-label="One fewer" ${c.quantity ? '' : 'disabled'}>${icon('minus')}</button>
      <b>${c.quantity}</b>
      <button type="button" class="icon-btn" data-cb-step="${c.id}" data-d="1" aria-label="One more">${icon('plus')}</button>
    </span>`;

  // -------------------------------------------------------------- clicks --

  function onClick(e) {
    const t = e.target.closest('[data-act], [data-cmode], [data-cb-type], [data-cb-line], [data-cb-step]');
    if (!t) return;
    if (t.dataset.cmode) { s.mode = t.dataset.cmode; store('ucp.cablemode', s.mode); draw(); }
    else if (t.dataset.cbStep) step(t.dataset.cbStep, Number(t.dataset.d));
    else if (t.dataset.cbType) typeSheet(t.dataset.cbType);
    else if (t.dataset.cbLine) lineSheet(s.data.cables.find((c) => c.id === t.dataset.cbLine));
    else if (t.dataset.act === 'add') addSheet();
    else if (t.dataset.act === 'retry') load();
    else if (t.dataset.act === 'clear') { s.q = ''; q.value = ''; s.room = ALL; s.signal = ALL; s.label = ALL; draw(); }
  }

  /** + and − on a count: shows right away, saves in order. */
  function step(id, d, redraw = draw) {
    const c = s.data.cables.find((x) => x.id === id);
    if (!c) return;
    const next = Math.max(0, Math.min(9999, c.quantity + d));
    if (next === c.quantity) return;
    c.quantity = next;
    redraw();
    const chain = (pending.get(id) || Promise.resolve()).then(() => ctx.store.saveCableRow('cables', { id, quantity: c.quantity }).catch((err) => { ctx.toast(err.message, 'bad'); }));
    pending.set(id, chain);
    chain.finally(() => { if (pending.get(id) === chain) { pending.delete(id); load(true); } });
  }

  // -------------------------------------------------------------- sheets --

  const head = (eyebrow, title, sub = '') => `<header class="sh-head"><div class="sh-top"><span class="eyebrow">${esc(eyebrow)}</span><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div><h2>${esc(title)}</h2>${sub ? `<p class="sh-sub">${esc(sub)}</p>` : ''}</header>`;
  const fail = (sheet, err, btn) => { const m = $('.form-msg', sheet.el); m.textContent = err.message || err; m.classList.add('bad'); if (btn) btn.disabled = false; };
  const roomsAt = (campusId) => s.data.rooms.filter((r) => r.campus_id === campusId).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name));
  const defaultCampus = () => (s.campus !== ALL ? s.campus : ctx.me?.home_campus_id || ctx.campuses[0]?.id);

  /** Where + label fields, shared by Add and Edit. */
  function placeFields(v) {
    return `<div class="grid2">
        <label class="field"><span>Location</span><select id="cb-campus">${ctx.campuses.map((c) => `<option value="${c.id}" ${c.id === v.campus_id ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select></label>
        <label class="field"><span>Room</span><select id="cb-room"><option value="">No room</option>${roomsAt(v.campus_id).map((r) => `<option value="${r.id}" ${r.id === v.room_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      </div>
      <div class="field"><span>Label</span>
        <button type="button" class="switch" role="switch" id="cb-labeled" aria-checked="${!!v.labeled}"><span class="switch-track"><i></i></span>Elite Core label</button>
        <div class="cb-colors" ${v.labeled ? '' : 'hidden'}>${Object.entries(LABEL_COLORS).map(([k, hex]) => `<button type="button" class="chip cb-color" data-color="${k}" aria-pressed="${k === v.label_color}"><i class="cb-sw" style="--lc:${hex}"></i>${k}</button>`).join('')}</div>
      </div>`;
  }
  function wirePlace(sheet, v) {
    sheet.el.addEventListener('change', (e) => {
      if (e.target.id !== 'cb-campus') return;
      v.campus_id = e.target.value; v.room_id = '';
      $('#cb-room', sheet.el).innerHTML = `<option value="">No room</option>${roomsAt(v.campus_id).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}`;
    });
    sheet.el.addEventListener('click', (e) => {
      if (e.target.closest('#cb-labeled')) {
        v.labeled = !v.labeled;
        $('#cb-labeled', sheet.el).setAttribute('aria-checked', String(v.labeled));
        $('.cb-colors', sheet.el).hidden = !v.labeled;
      }
      const col = e.target.closest('[data-color]');
      if (col) { v.label_color = v.label_color === col.dataset.color ? null : col.dataset.color; $$('[data-color]', sheet.el).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === v.label_color))); }
    });
  }
  const readPlace = (sheet, v) => ({ campus_id: $('#cb-campus', sheet.el).value, room_id: $('#cb-room', sheet.el).value || null, labeled: !!v.labeled, label_color: v.labeled ? v.label_color || null : null });

  /** Type fields: signal, ends, nickname. */
  function typeFields(t) {
    return `<div class="field"><span>Signal</span><div class="cb-sigs">${SIGNALS.map((g) => `<button type="button" class="chip" data-sig="${g}" aria-pressed="${g === t.signal}">${g}</button>`).join('')}</div></div>
      <div class="grid2">
        <label class="field"><span>One end</span><input id="ct-a" list="ct-ends" maxlength="60" value="${esc(t.end_a || '')}" placeholder="XLR 5-pin male"></label>
        <label class="field"><span>Other end</span><input id="ct-b" list="ct-ends" maxlength="60" value="${esc(t.end_b || '')}" placeholder="XLR 5-pin female"></label>
      </div>
      <datalist id="ct-ends">${ENDS.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <label class="field"><span>Nickname</span><input id="ct-name" maxlength="80" value="${esc(t.name || '')}" placeholder="Optional, like “PowerCon link”"><small class="hint" id="ct-preview"></small></label>`;
  }
  function wireType(sheet, t) {
    const preview = () => { const p = $('#ct-preview', sheet.el); if (p) p.textContent = `Shows as “${cableName({ ...t, end_a: $('#ct-a', sheet.el).value, end_b: $('#ct-b', sheet.el).value, name: $('#ct-name', sheet.el).value.trim() })}”`; };
    sheet.el.addEventListener('input', (e) => { if (/^ct-/.test(e.target.id)) preview(); });
    sheet.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sig]');
      if (!b) return;
      const was = t.signal;
      t.signal = b.dataset.sig;
      $$('[data-sig]', sheet.el).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sig === t.signal)));
      const [a, z] = DEFAULT_ENDS[t.signal] || ['', ''];
      const [wa, wz] = DEFAULT_ENDS[was] || ['', ''];
      const A = $('#ct-a', sheet.el), B = $('#ct-b', sheet.el);
      if (!A.value || A.value === wa) A.value = a; // follow the signal unless typed by hand
      if (!B.value || B.value === wz) B.value = z;
      preview();
    });
    preview();
  }
  const readType = (sheet, t) => ({ signal: t.signal, end_a: $('#ct-a', sheet.el).value.trim(), end_b: $('#ct-b', sheet.el).value.trim(), name: $('#ct-name', sheet.el).value.trim() || null });

  /** Add cables: a type (or a new one), the lengths you have, label, where, and how many of each. */
  function addSheet(presetType = null) {
    const v = { campus_id: defaultCampus(), room_id: '', labeled: false, label_color: null };
    const t = { signal: 'DMX', end_a: DEFAULT_ENDS.DMX[0], end_b: DEFAULT_ENDS.DMX[1], name: '' };
    let typeId = presetType || s.data.types[0]?.id || '__new';
    const picked = new Set();
    const sheet = ctx.openSheet({ label: 'Add cables', className: 'cb-sheet' });
    const typeOpts = () => [...s.data.types].sort((a, b) => sigOrder(a.signal) - sigOrder(b.signal) || cableName(a).localeCompare(cableName(b)))
      .map((x) => `<option value="${x.id}" ${x.id === typeId ? 'selected' : ''}>${esc(x.signal)} · ${esc(cableName(x))}</option>`).join('');
    sheet.render(`${head('Cables', 'Add cables')}
      <form class="sh-body form" novalidate>
        <label class="field"><span>Kind of cable</span><select id="cb-type">${typeOpts()}<option value="__new" ${typeId === '__new' ? 'selected' : ''}>＋ New kind of cable…</option></select></label>
        <div id="cb-newtype" class="cb-newtype" ${typeId === '__new' ? '' : 'hidden'}>${typeFields(t)}</div>
        <div class="field"><span>Lengths <b class="req">pick one or more</b></span>
          <div class="cb-lengths">${LENGTHS.map((n) => `<button type="button" class="chip" data-len="${n}" aria-pressed="false">${n} ft</button>`).join('')}</div>
          <div class="inline-add"><input id="cb-other" inputmode="decimal" placeholder="Other length in feet" aria-label="Other length in feet"><button type="button" class="btn" data-addlen>Add length</button></div>
        </div>
        ${placeFields(v)}
        <label class="field"><span>How many of each length</span><input id="cb-qty" inputmode="numeric" value="1"></label>
        <label class="field"><span>Notes</span><input id="cb-notes" maxlength="1000"></label>
      </form>
      <footer class="sh-foot"><p class="form-msg" role="status"></p><span class="spacer"></span><button type="button" class="btn primary" data-save>Add</button></footer>`);
    wirePlace(sheet, v);
    wireType(sheet, t);
    sheet.el.addEventListener('change', (e) => { if (e.target.id === 'cb-type') { typeId = e.target.value; $('#cb-newtype', sheet.el).hidden = typeId !== '__new'; } });
    sheet.el.addEventListener('click', async (e) => {
      const len = e.target.closest('[data-len]');
      if (len) { const n = Number(len.dataset.len); picked.has(n) ? picked.delete(n) : picked.add(n); len.setAttribute('aria-pressed', String(picked.has(n))); return; }
      if (e.target.closest('[data-addlen]')) {
        const n = Number($('#cb-other', sheet.el).value.replace(',', '.').replace(/\s*(ft|feet|foot|')$/i, ''));
        if (!(n > 0 && n <= 1000)) return fail(sheet, 'Type a length in feet, like 75.');
        picked.add(n);
        if (!$(`[data-len="${n}"]`, sheet.el)) $('.cb-lengths', sheet.el).insertAdjacentHTML('beforeend', `<button type="button" class="chip" data-len="${n}" aria-pressed="true">${n} ft</button>`);
        else $(`[data-len="${n}"]`, sheet.el).setAttribute('aria-pressed', 'true');
        $('#cb-other', sheet.el).value = '';
        return;
      }
      const save = e.target.closest('[data-save]');
      if (!save) return;
      if (!picked.size) return fail(sheet, 'Pick at least one length.');
      const qty = Math.max(0, Math.min(9999, parseInt($('#cb-qty', sheet.el).value, 10) || 0));
      const place = readPlace(sheet, v);
      save.disabled = true;
      try {
        let id = typeId;
        if (id === '__new') {
          const nt = readType(sheet, t);
          if (!nt.end_a || !nt.end_b) return fail(sheet, 'Fill in both ends, like XLR 5-pin male and XLR 5-pin female.', save);
          const same = s.data.types.find((x) => x.signal === nt.signal && x.end_a.toLowerCase() === nt.end_a.toLowerCase() && x.end_b.toLowerCase() === nt.end_b.toLowerCase());
          id = same ? same.id : await ctx.store.saveCableRow('cable_types', nt);
        }
        const notes = $('#cb-notes', sheet.el).value.trim() || null;
        for (const n of picked) {
          const have = s.data.cables.find((c) => c.type_id === id && c.campus_id === place.campus_id && (c.room_id || null) === place.room_id
            && Number(c.length_ft) === n && c.labeled === place.labeled && (c.label_color || null) === place.label_color);
          if (have) await ctx.store.saveCableRow('cables', { id: have.id, quantity: Math.min(9999, have.quantity + qty) });
          else await ctx.store.saveCableRow('cables', { type_id: id, ...place, length_ft: n, quantity: qty, notes });
        }
        ctx.toast(`Added ${plural(picked.size, 'length')}`);
        sheet.close(true);
        await load(true);
      } catch (err) { fail(sheet, err, save); }
    });
  }

  /** One kind of cable: every length and label, with counts, and its ends. */
  function typeSheet(id) {
    const t = s.data.types.find((x) => x.id === id);
    if (!t) return;
    let editing = false;
    const sheet = ctx.openSheet({ label: cableName(t), className: 'cb-sheet' });
    const render = () => {
      const tt = s.data.types.find((x) => x.id === id);
      if (!tt) return sheet.close(true);
      const mine = s.data.cables.filter((c) => c.type_id === id && inCampus(c));
      const places = new Map();
      for (const c of mine.sort(byLength)) {
        const k = `${c.campus_id}|${c.room_id || ''}`;
        if (!places.has(k)) places.set(k, []);
        places.get(k).push(c);
      }
      if (editing) {
        const draft = { ...tt };
        sheet.render(`${head(`${tt.signal} cable`, 'Edit cable type')}
          <form class="sh-body form" novalidate>${typeFields(draft)}<label class="field"><span>Notes</span><input id="ct-notes" maxlength="1000" value="${esc(tt.notes || '')}"></label></form>
          <footer class="sh-foot"><p class="form-msg" role="status"></p>
            <button type="button" class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete type</span></button>
            <span class="spacer"></span><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn primary" data-save>Save</button></footer>`);
        wireType(sheet, draft);
        sheet.el.onclick = async (e) => {
          if (e.target.closest('[data-cancel]')) { editing = false; return render(); }
          const del = e.target.closest('[data-del]');
          if (del) {
            const n = total(s.data.cables.filter((c) => c.type_id === id));
            if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.querySelector('span').textContent = n ? `Tap again: deletes ${plural(n, 'cable')} too` : 'Tap again to delete'; return; }
            del.disabled = true;
            try { await ctx.store.deleteCableRow('cable_types', id); ctx.toast('Cable type deleted'); sheet.close(true); await load(true); } catch (err) { fail(sheet, err, del); }
            return;
          }
          const save = e.target.closest('[data-save]');
          if (!save) return;
          const row = readType(sheet, draft);
          if (!row.end_a || !row.end_b) return fail(sheet, 'Fill in both ends.');
          save.disabled = true;
          try {
            await ctx.store.saveCableRow('cable_types', { id, ...row, notes: $('#ct-notes', sheet.el).value.trim() || null });
            ctx.toast('Saved'); editing = false; await load(true); render();
          } catch (err) { fail(sheet, err, save); }
        };
        return;
      }
      sheet.render(`${head(`${tt.signal} cable`, cableName(tt), `${tt.end_a} → ${tt.end_b}`)}
        <div class="sh-body">
          ${tt.notes ? `<p class="lede">${esc(tt.notes)}</p>` : ''}
          ${places.size ? [...places.entries()].map(([k, list]) => `<section class="block"><h3>${esc(where({ ...list[0] }) || campusName(list[0].campus_id))} <span class="count">${total(list)}</span></h3>
            <ul class="cb-list">${list.map((c) => `<li>
              <button type="button" class="cb-list-hit" data-edit-line="${c.id}"><span class="cb-len"><b>${esc(String(Number(c.length_ft)))}</b><small>ft</small></span><span>${swatch(c)}${esc(labelText(c))}${c.notes ? `<small>${esc(c.notes)}</small>` : ''}</span></button>
              ${stepper(c)}</li>`).join('')}</ul></section>`).join('')
            : `<p class="muted">None of these${s.campus !== ALL ? ` at ${esc(campusName(s.campus))}` : ''} yet.</p>`}
        </div>
        <footer class="sh-foot"><button type="button" class="btn ghost" data-edit>${icon('edit')}Edit type</button><span class="spacer"></span>
          <button type="button" class="btn primary" data-add>${icon('plus')}Add lengths</button></footer>`);
      sheet.el.onclick = (e) => {
        const st = e.target.closest('[data-cb-step]');
        if (st) return step(st.dataset.cbStep, Number(st.dataset.d), () => { draw(); render(); });
        const ln = e.target.closest('[data-edit-line]');
        if (ln) return lineSheet(s.data.cables.find((c) => c.id === ln.dataset.editLine));
        if (e.target.closest('[data-edit]')) { editing = true; return render(); }
        if (e.target.closest('[data-add]')) return addSheet(id);
      };
    };
    render();
  }

  /** One length and label at one place: change any of it, or delete it. */
  function lineSheet(c) {
    if (!c) return;
    const t = typeOf(c);
    const v = { ...c };
    const sheet = ctx.openSheet({ label: `${cableName(t)} ${lengthText(c.length_ft)}`, className: 'cb-sheet' });
    sheet.render(`${head(t.signal, `${cableName(t)} · ${lengthText(c.length_ft)}`, `${t.end_a} → ${t.end_b}`)}
      <form class="sh-body form" novalidate>
        <label class="field"><span>Kind of cable</span><select id="cl-type">${[...s.data.types].sort((a, b) => cableName(a).localeCompare(cableName(b))).map((x) => `<option value="${x.id}" ${x.id === c.type_id ? 'selected' : ''}>${esc(x.signal)} · ${esc(cableName(x))}</option>`).join('')}</select></label>
        <div class="field"><span>Length</span>
          <div class="cb-lengths">${[...new Set([...LENGTHS, Number(c.length_ft)])].sort((a, b) => a - b).map((n) => `<button type="button" class="chip" data-one="${n}" aria-pressed="${n === Number(c.length_ft)}">${n} ft</button>`).join('')}</div>
          <div class="inline-add"><input id="cl-other" inputmode="decimal" placeholder="Other length in feet" aria-label="Other length in feet"></div>
        </div>
        ${placeFields(v)}
        <div class="field"><span>How many</span><div class="stepper"><button type="button" class="icon-btn" data-q="-1" aria-label="One fewer">${icon('minus')}</button><input id="cl-qty" class="mono" inputmode="numeric" value="${c.quantity}" aria-label="How many"><button type="button" class="icon-btn" data-q="1" aria-label="One more">${icon('plus')}</button></div></div>
        <label class="field"><span>Notes</span><input id="cl-notes" maxlength="1000" value="${esc(c.notes || '')}"></label>
      </form>
      <footer class="sh-foot"><p class="form-msg" role="status"></p>
        <button type="button" class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete</span></button>
        <span class="spacer"></span><button type="button" class="btn primary" data-save>Save</button></footer>`);
    wirePlace(sheet, v);
    let len = Number(c.length_ft);
    sheet.el.addEventListener('click', async (e) => {
      const one = e.target.closest('[data-one]');
      if (one) { len = Number(one.dataset.one); $('#cl-other', sheet.el).value = ''; $$('[data-one]', sheet.el).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.one) === len))); return; }
      const qb = e.target.closest('[data-q]');
      if (qb) { const i = $('#cl-qty', sheet.el); i.value = Math.max(0, Math.min(9999, (parseInt(i.value, 10) || 0) + Number(qb.dataset.q))); return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.querySelector('span').textContent = 'Tap again to delete'; return; }
        del.disabled = true;
        try { await ctx.store.deleteCableRow('cables', c.id); ctx.toast('Deleted'); sheet.close(true); await load(true); } catch (err) { fail(sheet, err, del); }
        return;
      }
      const save = e.target.closest('[data-save]');
      if (!save) return;
      const other = $('#cl-other', sheet.el).value.trim();
      const length_ft = other ? Number(other.replace(',', '.').replace(/\s*(ft|feet|foot|')$/i, '')) : len;
      if (!(length_ft > 0 && length_ft <= 1000)) return fail(sheet, 'Type a length in feet, like 75.');
      save.disabled = true;
      try {
        await ctx.store.saveCableRow('cables', { id: c.id, type_id: $('#cl-type', sheet.el).value, length_ft, ...readPlace(sheet, v),
          quantity: Math.max(0, Math.min(9999, parseInt($('#cl-qty', sheet.el).value, 10) || 0)), notes: $('#cl-notes', sheet.el).value.trim() || null });
        ctx.toast('Saved'); sheet.close(true); await load(true);
      } catch (err) { fail(sheet, err, save); }
    });
  }

  load();
  return { unmount: () => { alive = false; unsubscribe(); } };
}
