// Device types: shared helpers and the type editor, used by Gear and by the
// model editor ("＋ New type…").

import { esc, icon, $, $$ } from '../util.js';
import { parseModes } from '../lighting.js';

export const CATEGORIES = ['Console', 'Switcher', 'Control Panel', 'Router', 'Converter', 'Camera', 'PTZ Controller',
  'Projector', 'Display', 'Monitor', 'LED Processor', 'LED Driver', 'Computer', 'Recorder', 'Encoder / Decoder',
  'Node / Gateway', 'Switch', 'Access Point', 'Wall Station', 'Amplifier', 'Stagebox', 'Wireless Receiver',
  'Microphone', 'Speaker', 'Intercom', 'Fixture', 'Dimmer', 'Cable', 'Other'];
export const SIGNALS = ['Ethernet', 'Dante', 'DMX', 'Art-Net / sACN', 'HDMI', 'SDI', 'NDI', 'DisplayPort', 'Analog audio',
  'AES', 'MADI', 'Fiber', 'USB', 'Thunderbolt', 'Power', 'Serial / RS-232', 'GPIO', 'Timecode', 'Other'];
export const CONNECTORS = ['RJ45', 'etherCON', 'XLR3', 'XLR5', 'BNC', 'HDMI', 'Mini HDMI', 'DisplayPort', 'USB-C', 'USB-A',
  'TRS ¼"', 'TRS 3.5mm', 'Phoenix', 'powerCON', 'IEC', 'Edison', 'SFP', 'LC fiber', 'opticalCON', 'DB9', 'Other'];
export const DIRECTIONS = { in: 'In', out: 'Out', io: 'In / Out' };

export const typeLabel = (t) => (t ? [t.manufacturer, t.name].filter(Boolean).join(' ') + (t.unknown ? ' (model unknown)' : '') : 'No model');
export const sortPorts = (ports = []) => [...ports].sort((a, b) => a.sort_order - b.sort_order);

/** Brands group regardless of capitals or stray spaces: "ETC" and "etc " are one brand. */
export const brandKey = (name) => (name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Small square product photo for lists; a quiet placeholder when there isn't one. */
export function typeThumb(ctx, t, cls = '') {
  const url = t?.photo_path ? ctx.store.photoUrl(t.photo_path, true) : null;
  return url
    ? `<span class="thumb ${cls}"><img src="${esc(url)}" alt="" loading="lazy" decoding="async"></span>`
    : `<span class="thumb is-empty ${cls}">${icon('box')}</span>`;
}

/** "Ethernet · RJ45 · In / Out" */
export const portMeta = (p) => [p.signal, p.connector, p.direction !== 'io' ? DIRECTIONS[p.direction] : null].filter(Boolean).join(' · ');

/**
 * Renders the type editor into an open sheet. Calls onDone(typeId) after a
 * save, or onCancel() when the person backs out. Returns { cancel() }.
 */
export function typeEditor({ ctx, sheet, type = null, types = [], onDone, onCancel, defaults = {} }) {
  const d = type
    ? { ...type, departments: [...type.departments], specs: (type.specs || []).map((x) => ({ ...x })),
        ports: sortPorts(type.ports).map((p) => ({ ...p })), modesText: (type.dmx_modes || []).join(', '), footText: type.dmx_footprint ? String(type.dmx_footprint) : '' }
    : { id: '', name: '', manufacturer: '', part_number: '', category: '', departments: [], description: '',
        specs: [], ports: [], manual_url: '', notes: '', networked: true, modesText: '', footText: '', ...defaults };
  const originalPortIds = new Set((type?.ports || []).map((p) => p.id));
  let dirty = false;
  let busy = false;
  let bulk = false;
  let confirmRemove = false;
  let discard = false;

  const uniq = (k) => [...new Set(types.map((t) => t[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  function render(msg = '') {
    const scroll = $('.sh-body', sheet.el)?.scrollTop || 0;
    const removed = [...originalPortIds].filter((pid) => !d.ports.some((p) => p.id === pid)).length;
    sheet.render(`
      <header class="sh-head">
        <div class="sh-top"><span class="eyebrow">${type ? 'Edit model' : 'New model'}</span>
          <button class="icon-btn" data-ta="cancel" aria-label="Close">${icon('close')}</button></div>
        <h2>${esc(d.name || 'New model')}</h2>
        <p class="sh-sub">Everything here is shared by every item of this model, at every location.</p>
      </header>
      <form class="sh-body form" id="type-form" novalidate autocomplete="off">
        <label class="field"><span>Name <b class="req">required</b></span><input id="t-name" value="${esc(d.name)}" placeholder="Hoglet 4, Decimator MD-HX, SG350-10…"></label>
        <div class="grid2">
          <label class="field"><span>Brand</span><input id="t-manufacturer" value="${esc(d.manufacturer || '')}" list="dl-t-mfr" placeholder="High End Systems, Blackmagic…"></label>
          <label class="field"><span>Category</span><input id="t-category" value="${esc(d.category || '')}" list="dl-t-cat" placeholder="Console, Converter…"></label>
          <label class="field"><span>Model number</span><input id="t-part_number" class="mono" value="${esc(d.part_number || '')}" autocapitalize="characters" spellcheck="false" placeholder="JOL299, ROGUER2XWASH…"><small class="hint">The maker’s exact model or part number, from the label or spec sheet</small></label>
          <label class="field"><span>Manual or product page</span><input id="t-manual_url" value="${esc(d.manual_url || '')}" inputmode="url" placeholder="https://…" autocapitalize="off" spellcheck="false"></label>
        </div>
        <div class="field"><span>Sections <b class="req">at least one</b></span>
          <div class="tag-picker">${ctx.departments.map((t) => `<button type="button" class="chip dep big" data-ta="tag" data-tag="${t.slug}" data-dep="${t.slug}" aria-pressed="${d.departments.includes(t.slug)}"><i class="dot"></i>${esc(t.name)}</button>`).join('')}</div>
          <small class="hint">New items start with these tags. Each item can change its own.</small>
        </div>
        <label class="check"><input type="checkbox" id="t-networked" ${d.networked !== false ? 'checked' : ''}><span>Connects to a network and gets an IP address<small class="hint">Turn off for things like fixtures. Their items stay off the IP sheet unless one is given an IP.</small></span></label>
        <label class="field"><span>Description</span><textarea id="t-description" rows="2" placeholder="What it is and what it does">${esc(d.description || '')}</textarea></label>

        ${d.departments.includes('lighting') ? dmxBlock() : ''}

        <fieldset class="group"><legend>Specs</legend>
          <div class="spec-edit">${d.specs.map((sp, i) => `<div class="spec-row" data-i="${i}">
            <input id="sp-${i}-label" value="${esc(sp.label)}" placeholder="DMX universes" aria-label="Spec name">
            <input id="sp-${i}-value" value="${esc(sp.value)}" placeholder="4" aria-label="Value">
            <button type="button" class="icon-btn" data-ta="rm-spec" data-i="${i}" aria-label="Remove spec">${icon('close')}</button>
          </div>`).join('')}</div>
          <button type="button" class="btn" data-ta="add-spec">${icon('plus')}Add a spec</button>
        </fieldset>

        <fieldset class="group"><legend>Ports <span class="count">${d.ports.length}</span></legend>
          <p class="fine">The port layout every item shares. What's plugged into each port is recorded on each item.</p>
          <div class="port-edit">${d.ports.map((p, i) => `<div class="port-card" data-i="${i}">
            <div class="port-row">
              <input id="po-${i}-name" class="port-name" value="${esc(p.name)}" placeholder="Port name" aria-label="Port name">
              <button type="button" class="icon-btn" data-ta="rm-port" data-i="${i}" aria-label="Remove ${esc(p.name || 'port')}">${icon('close')}</button>
            </div>
            <div class="grid3">
              <label class="field"><span>Signal</span><input id="po-${i}-signal" value="${esc(p.signal || '')}" list="dl-t-sig"></label>
              <label class="field"><span>Connector</span><input id="po-${i}-connector" value="${esc(p.connector || '')}" list="dl-t-con"></label>
              <label class="field"><span>Direction</span><select id="po-${i}-direction">${Object.entries(DIRECTIONS).map(([k, v]) => `<option value="${k}" ${k === (p.direction || 'io') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            </div>
          </div>`).join('')}</div>
          ${bulk ? `<div class="bulk">
            <p class="bulk-title">Add several numbered ports</p>
            <div class="bulk-grid">
              <label class="field"><span>Name</span><input id="b-prefix" value="DMX " placeholder="DMX "></label>
              <label class="field"><span>From</span><input id="b-from" value="1" inputmode="numeric"></label>
              <label class="field"><span>To</span><input id="b-to" value="4" inputmode="numeric"></label>
              <label class="field"><span>Signal</span><input id="b-signal" value="DMX" list="dl-t-sig"></label>
              <label class="field"><span>Connector</span><input id="b-connector" value="XLR5" list="dl-t-con"></label>
              <label class="field"><span>Direction</span><select id="b-direction">${Object.entries(DIRECTIONS).map(([k, v]) => `<option value="${k}" ${k === 'out' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            </div>
            <div class="bulk-actions"><button type="button" class="btn" data-ta="bulk-cancel">Cancel</button><button type="button" class="btn primary" data-ta="bulk-add">Add ports</button></div>
          </div>` : `<div class="btn-row"><button type="button" class="btn" data-ta="add-port">${icon('plus')}Add a port</button><button type="button" class="btn" data-ta="bulk">${icon('plus')}Add several</button></div>`}
        </fieldset>

        <label class="field"><span>Notes</span><textarea id="t-notes" rows="2">${esc(d.notes || '')}</textarea></label>

        <datalist id="dl-t-mfr">${uniq('manufacturer').map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
        <datalist id="dl-t-cat">${[...new Set([...CATEGORIES, ...uniq('category')])].map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
        <datalist id="dl-t-sig">${SIGNALS.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
        <datalist id="dl-t-con">${CONNECTORS.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
      </form>
      <footer class="sh-foot">
        ${discard ? `<div class="discard"><span>Discard this model?</span><button class="btn" data-ta="keep">Keep editing</button><button class="btn danger" data-ta="discard">Discard</button></div>` : ''}
        ${confirmRemove
          ? `<span class="confirm-text">Remove ${removed} port${removed === 1 ? '' : 's'}? Anything recorded on ${removed === 1 ? 'it' : 'them'} at each location is cleared too.</span><button class="btn" data-ta="keep-ports">Keep editing</button><button class="btn danger" data-ta="save-anyway">Remove and save</button>`
          : `<p class="form-msg ${msg ? 'bad' : ''}" role="status">${esc(msg)}</p><span class="spacer"></span>
             <button class="btn" data-ta="cancel">Cancel</button>
             <button class="btn primary" data-ta="save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : type ? 'Save model' : 'Add model'}</button>`}
      </footer>`);
    $('#type-form', sheet.el).addEventListener('submit', (e) => { e.preventDefault(); save(); });
    const body = $('.sh-body', sheet.el);
    if (body) body.scrollTop = scroll;
  }

  function dmxBlock() {
    const modes = parseModes(d.modesText);
    return `<fieldset class="group"><legend>DMX</legend>
      <label class="field"><span>DMX modes</span><input id="t-modes" class="mono" value="${esc(d.modesText)}" inputmode="numeric" placeholder="6, 9, 13, 18, 20" autocomplete="off">
        <small class="hint">The channel counts it offers, from the manual. Leave blank for consoles and other gear that isn’t patched.</small></label>
      <div class="field"><label for="t-foot">Mode you use</label>
        <div class="mode-pick"><input id="t-foot" class="mono short" value="${esc(d.footText)}" inputmode="numeric" autocomplete="off" placeholder="${modes.length === 1 ? modes[0] : ''}">
          ${modes.length > 1 ? `<span class="mode-chips">${modes.map((n) => `<button type="button" class="chip small" data-ta="foot" data-n="${n}" aria-pressed="${String(n) === d.footText}">${n}</button>`).join('')}</span>` : ''}</div>
        <small class="hint">Every item of this model is patched with this many channels unless one is set differently. Leave blank if it varies.</small></div>
    </fieldset>`;
  }

  function collect() {
    const v = (id) => $(`#${id}`, sheet.el)?.value ?? '';
    if (!$('#t-name', sheet.el)) return;
    if ($('#t-modes', sheet.el)) { d.modesText = v('t-modes'); d.footText = v('t-foot').trim(); }
    for (const k of ['name', 'manufacturer', 'category', 'part_number', 'manual_url', 'description', 'notes']) d[k] = v('t-' + k);
    d.networked = $('#t-networked', sheet.el)?.checked ?? d.networked;
    d.specs.forEach((sp, i) => { sp.label = v(`sp-${i}-label`); sp.value = v(`sp-${i}-value`); });
    d.ports.forEach((p, i) => {
      p.name = v(`po-${i}-name`); p.signal = v(`po-${i}-signal`); p.connector = v(`po-${i}-connector`); p.direction = v(`po-${i}-direction`) || 'io';
    });
  }

  async function save(force = false) {
    if (busy) return;
    collect();
    if (!d.name.trim()) { render('Give the model a name.'); $('#t-name', sheet.el)?.focus(); return; }
    if (!d.departments.length) return render('Pick at least one section: Audio, Video, Lighting or Network.');
    const ports = d.ports.filter((p) => p.name.trim() || p.id);
    const names = ports.map((p) => p.name.trim().toLowerCase());
    if (ports.some((p) => !p.name.trim())) return render('Every port needs a name.');
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return render(`Two ports are named “${ports[names.indexOf(dup)].name.trim()}”. Port names must be different.`);
    if (d.manual_url && !/^https?:\/\//i.test(d.manual_url.trim())) d.manual_url = 'https://' + d.manual_url.trim();
    const foot = d.footText ? Number(d.footText) : null;
    if (d.footText && !(Number.isInteger(foot) && foot >= 1 && foot <= 512)) { render('The mode you use should be a channel count from 1 to 512.'); $('#t-foot', sheet.el)?.focus(); return; }
    const removed = [...originalPortIds].filter((pid) => !ports.some((p) => p.id === pid)).length;
    if (removed && !force) { confirmRemove = true; return render(); }
    confirmRemove = false;
    busy = true; render();
    try {
      const id = await ctx.store.saveType({
        type: {
          id: d.id || '', name: d.name, manufacturer: d.manufacturer, part_number: d.part_number, category: d.category,
          departments: d.departments, description: d.description, manual_url: d.manual_url, notes: d.notes, networked: d.networked !== false,
          dmx_modes: parseModes(d.modesText), dmx_footprint: foot,
          specs: d.specs.filter((sp) => sp.label.trim() || sp.value.trim()).map((sp) => ({ label: sp.label.trim(), value: sp.value.trim() })),
        },
        ports: ports.map((p) => ({ id: p.id || '', name: p.name.trim(), signal: p.signal, connector: p.connector, direction: p.direction || 'io', notes: p.notes || '' })),
      });
      busy = false; dirty = false;
      detach();
      ctx.toast(`Saved ${d.name.trim()}`);
      onDone?.(id);
    } catch (e) {
      busy = false; render(e.message);
    }
  }

  function bulkAdd() {
    const v = (id) => $(`#${id}`, sheet.el)?.value ?? '';
    const from = parseInt(v('b-from'), 10), to = parseInt(v('b-to'), 10);
    if (!(from >= 0 && to >= from && to - from < 200)) { ctx.toast('Check the From and To numbers', 'bad'); return; }
    collect();
    const prefix = v('b-prefix');
    for (let n = from; n <= to; n++) {
      d.ports.push({ id: '', name: `${prefix}${n}`, signal: v('b-signal'), connector: v('b-connector'), direction: v('b-direction') || 'io' });
    }
    bulk = false; dirty = true; render();
  }

  function cancel() {
    if (dirty && !discard) { collect(); discard = true; render(); return; }
    detach();
    onCancel?.();
  }

  const onClick = (e) => {
    const t = e.target.closest('[data-ta]');
    if (!t) return;
    e.stopPropagation();
    const a = t.dataset.ta;
    if (a === 'cancel') cancel();
    else if (a === 'keep') { collect(); discard = false; render(); }
    else if (a === 'discard') { dirty = false; detach(); onCancel?.(); }
    else if (a === 'save') save();
    else if (a === 'save-anyway') save(true);
    else if (a === 'keep-ports') { confirmRemove = false; render(); }
    else if (a === 'foot') { collect(); d.footText = d.footText === t.dataset.n ? '' : t.dataset.n; dirty = true; render(); }
    else if (a === 'tag') { collect(); const g = t.dataset.tag; d.departments = d.departments.includes(g) ? d.departments.filter((x) => x !== g) : [...d.departments, g]; dirty = true; render(); }
    else if (a === 'add-spec') { collect(); d.specs.push({ label: '', value: '' }); render(); $$('.spec-row input', sheet.el).at(-2)?.focus(); }
    else if (a === 'rm-spec') { collect(); d.specs.splice(+t.dataset.i, 1); dirty = true; render(); }
    else if (a === 'add-port') { collect(); d.ports.push({ id: '', name: '', signal: '', connector: '', direction: 'io' }); render(); $$('.port-name', sheet.el).at(-1)?.focus(); }
    else if (a === 'rm-port') { collect(); d.ports.splice(+t.dataset.i, 1); dirty = true; render(); }
    else if (a === 'bulk') { collect(); bulk = true; render(); $('#b-prefix', sheet.el)?.focus(); }
    else if (a === 'bulk-cancel') { collect(); bulk = false; render(); }
    else if (a === 'bulk-add') bulkAdd();
  };
  const onInput = (e) => { if (e.target.closest('#type-form') && !e.target.id.startsWith('b-')) dirty = true; };
  const onChange = (e) => { if (e.target.id === 't-modes') { collect(); render(); } }; // refresh the mode chips
  function detach() {
    sheet.el.removeEventListener('click', onClick, true);
    sheet.el.removeEventListener('input', onInput, true);
    sheet.el.removeEventListener('change', onChange, true);
  }
  // Capture phase so the editor handles its own buttons before any host sheet does.
  sheet.el.addEventListener('click', onClick, true);
  sheet.el.addEventListener('input', onInput, true);
  sheet.el.addEventListener('change', onChange, true);
  render();
  $('#t-name', sheet.el)?.focus();
  return { cancel };
}
