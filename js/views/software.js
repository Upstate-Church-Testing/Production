// Gear › Software: what runs on the computers, by title. The Gear filters pick the
// computers (location, room, area / spot, operator position…); this draws, for each
// operating system and each piece of software on them, which version is on which
// computer, newest first, so a computer that's behind (or ahead, being tested) stands out.
// The OS comes from each item's Firmware / OS field; the rest from software_installs.
// "Set a version" puts one version on several computers at once (after an update round).

import { esc, icon, $, $$, plural } from '../util.js';
import { typeThumb } from './types.js';
import { roomPath } from '../rooms.js';
import { osOf, cmpVersion, logoHtml, familyLogo, familyMaker, familyRank, asOf, today, versionText } from '../software.js';
import { posKey } from './devices.js';

export const SW_ALL = 'all';

/** h: { s, ctx, typeOf, computers(): the filtered computers, words(d): an item's search words,
 *  tally(shown, total), openModel(id), load(quiet), filtering(), openCompare(list) } */
export function softwareView(h) {
  const { s, ctx } = h;

  /** Every title on the computers given: operating systems (from Firmware / OS) and software. */
  function titles(list) {
    const out = new Map();
    const add = (key, base) => { if (!out.has(key)) out.set(key, { key, rows: [], ...base }); return out.get(key); };
    for (const d of list) {
      const os = osOf(d);
      if (os) {
        add(`os:${os.family}`, { kind: 'os', name: os.family, maker: familyMaker(os.family), logo: familyLogo(os.family) })
          .rows.push({ d, version: os.version || '', release: os.release, label: os.label, build: null, seen_on: null, notes: null });
      }
      for (const i of s.ix.installs.get(d.id) || []) {
        add(`sw:${i.sw.id}`, { kind: 'app', id: i.sw.id, name: i.sw.name, maker: i.sw.maker, logo: i.sw.logo })
          .rows.push({ d, version: i.version, build: i.build, label: versionText(i), seen_on: i.seen_on, notes: i.notes, install: i });
      }
    }
    // Titles nobody has yet still show (just added), so there's somewhere to set a version.
    for (const sw of s.data.software || []) add(`sw:${sw.id}`, { kind: 'app', id: sw.id, name: sw.name, maker: sw.maker, logo: sw.logo });
    return [...out.values()].sort((a, b) => (a.kind === 'os' ? 0 : 1) - (b.kind === 'os' ? 0 : 1)
      || (a.kind === 'os' ? familyRank(a.name) - familyRank(b.name) : 0) || a.name.localeCompare(b.name));
  }

  /** The Software filter: each OS and title on the computers the other filters picked. */
  function options() {
    const list = h.computers();
    const all = titles(list);
    const os = all.filter((t) => t.kind === 'os');
    const apps = all.filter((t) => t.kind === 'app');
    const opt = (t) => ({ value: t.key, label: t.name, count: new Set(t.rows.map((r) => r.d.id)).size });
    return [{ value: SW_ALL, label: 'All', count: list.length },
      ...(os.length ? [{ value: 'kind:os', label: 'Operating systems', count: new Set(os.flatMap((t) => t.rows.map((r) => r.d.id))).size, children: os.map(opt) }] : []),
      ...(apps.length ? [{ value: 'kind:app', label: 'Apps', count: new Set(apps.flatMap((t) => t.rows.map((r) => r.d.id))).size, children: apps.map(opt) }] : [])];
  }

  function wanted(t) {
    const v = s.sw || SW_ALL;
    return v === SW_ALL || v === t.key || v === `kind:${t.kind}`;
  }

  function matches(t, r) {
    if (!s.q) return true;
    const hay = [t.name, t.maker, r.version, r.release, r.label, r.build, r.notes, ...h.words(r.d)].filter(Boolean).join(' ').toLowerCase();
    return s.q.split(/\s+/).every((w) => hay.includes(w));
  }

  function draw(box) {
    const list = h.computers();
    const all = titles(list).filter(wanted);
    // Search narrows the rows; a title whose own name matches keeps all of its rows.
    const shown = all.map((t) => {
      const named = s.q && s.q.split(/\s+/).every((w) => [t.name, t.maker].filter(Boolean).join(' ').toLowerCase().includes(w));
      return { ...t, rows: named ? t.rows : t.rows.filter((r) => matches(t, r)) };
    }).filter((t) => t.rows.length || (!s.q && t.kind === 'app' && (s.sw || SW_ALL) !== SW_ALL));
    const noOs = list.filter((d) => !osOf(d) && ['all', 'kind:os'].includes(s.sw || SW_ALL)
      && (!s.q || s.q.split(/\s+/).every((w) => h.words(d).join(' ').toLowerCase().includes(w))));
    const onScreen = [...new Set([...shown.flatMap((t) => t.rows.map((r) => r.d)), ...noOs])];
    h.tally(onScreen.length, list.length);
    if (!list.length) {
      box.innerHTML = `<div class="empty"><h3>No computers here</h3><p>Software shows for computers and tablets, and anything with an OS written in its Firmware / OS field.</p>
        ${h.filtering() ? '<button class="btn" data-act="clear">Clear search and filters</button>' : ''}</div>`;
      return;
    }
    if (!shown.length && !noOs.length) {
      box.innerHTML = `<div class="empty"><h3>No matches</h3><p>${s.q ? `Nothing matches “${esc(s.q)}”.` : 'Nothing matches these filters.'}</p><button class="btn" data-act="clear">Clear search and filters</button></div>`;
      return;
    }
    const os = shown.filter((t) => t.kind === 'os');
    const apps = shown.filter((t) => t.kind === 'app');
    const compare = onScreen.length >= 2 && onScreen.length <= 40
      ? `<button class="btn small" data-act="compare">${icon('compare')}Compare these ${onScreen.length}</button>` : '';
    box.innerHTML = `${compare ? `<div class="list-tools">${compare}</div>` : ''}
      ${os.length || noOs.length ? `<section class="campus-block sw-group">
        <h2 class="campus-h">Operating systems<small>${esc(plural(new Set([...os.flatMap((t) => t.rows.map((r) => r.d.id)), ...noOs.map((d) => d.id)]).size, 'computer'))}</small></h2>
        ${os.map(card).join('')}${noOs.length ? missingCard(noOs) : ''}
      </section>` : ''}
      ${apps.length ? `<section class="campus-block sw-group">
        <h2 class="campus-h">Apps<small>${esc(plural(apps.length, 'title'))}</small></h2>
        ${apps.map(card).join('')}
      </section>` : ''}`;
  }

  /** One title: its versions newest first, each with the computers on it. */
  function card(t) {
    const groups = new Map();
    for (const r of t.rows) {
      const k = t.kind === 'os' ? `${r.release || ''}|${r.version}` : r.label;
      if (!groups.has(k)) groups.set(k, { label: r.label, version: r.version, release: r.release, build: r.build, rows: [] });
      groups.get(k).rows.push(r);
    }
    const list = [...groups.values()].sort((a, b) => cmpVersion(b.version, a.version) || (b.build || '').localeCompare(a.build || ''));
    const count = new Set(t.rows.map((r) => r.d.id)).size;
    // Header: one version everywhere, or how many; for an OS, which releases (Tahoe on 9 · Sequoia on 1).
    let summary;
    if (!list.length) summary = '<span class="sw-chip">Not on any computer yet</span>';
    else if (list.length === 1) summary = `<span class="sw-chip is-same">${icon('check')}All on ${esc(list[0].label)}</span>`;
    else summary = `<span class="sw-chip is-mixed">${esc(plural(list.length, 'version'))}</span>`;
    let releases = '';
    if (t.kind === 'os') {
      const by = new Map();
      for (const r of t.rows) { const k = r.release || 'Version unknown'; by.set(k, (by.get(k) || 0) + 1); }
      if (by.size > 1) releases = `<span class="sw-rel">${[...by].map(([k, n]) => `${esc(k)} on ${n}`).join(' · ')}</span>`;
    }
    return `<section class="net sw-card">
      <header class="net-head sw-head">
        ${logoHtml(t.name, t.logo)}
        <div class="sw-title"><h3>${esc(t.name)}</h3><small>${esc([t.maker, t.kind === 'os' ? 'Operating system' : null].filter(Boolean).join(' · '))}</small></div>
        <div class="sw-meta">${summary}${releases}<span class="sw-n">${esc(plural(count, 'computer'))}</span></div>
        ${t.kind === 'app' ? `<button class="btn small sw-set" data-swset="${t.id}">Set version</button>` : ''}
      </header>
      ${list.map((g, i) => `<div class="sw-ver ${list.length > 1 ? (i === 0 ? 'is-newest' : 'is-older') : ''}">
        <div class="sw-vhead"><b class="mono">${esc(t.kind === 'os' ? g.label : g.version)}</b>${g.build ? `<small class="mono">build ${esc(g.build)}</small>` : ''}
          ${list.length > 1 && i === 0 ? '<span class="sw-tag">Newest</span>' : ''}<span class="sw-vn">${esc(plural(g.rows.length, 'computer'))}</span></div>
        <ul class="gear-list">${g.rows.sort(byPlace).map((r) => row(r)).join('')}</ul>
      </div>`).join('')}
    </section>`;
  }

  /** Computers with no OS written down yet. */
  function missingCard(list) {
    return `<section class="net sw-card is-missing">
      <header class="net-head sw-head">
        <span class="sw-logo is-initials" aria-hidden="true">?</span>
        <div class="sw-title"><h3>OS not written down</h3><small>Add it in each one’s Firmware / OS field (macOS Tahoe 26.1)</small></div>
        <div class="sw-meta"><span class="sw-n">${esc(plural(list.length, 'computer'))}</span></div>
      </header>
      <div class="sw-ver"><ul class="gear-list">${list.sort((a, b) => byPlace({ d: a }, { d: b })).map((d) => row({ d })).join('')}</ul></div>
    </section>`;
  }

  function byPlace(a, b) {
    const rank = new Map(ctx.campuses.map((c, i) => [c.id, i]));
    const ra = s.ix.room.get(a.d.room_id), rb = s.ix.room.get(b.d.room_id);
    return (rank.get(a.d.campus_id) ?? 99) - (rank.get(b.d.campus_id) ?? 99) || (ra?.sort_order ?? 999) - (rb?.sort_order ?? 999)
      || (ra?.name || '').localeCompare(rb?.name || '') || a.d.name.localeCompare(b.d.name, undefined, { numeric: true });
  }

  function row(r) {
    const d = r.d;
    const t = h.typeOf(d);
    const room = d.room_id ? s.ix.room.get(d.room_id) : null;
    const where = [room ? roomPath(room, s.ix.room) : null, d.area, d.location, (d.positions || []).join(', ') || null].filter(Boolean)
      .filter((x, i, a) => a.findIndex((y) => posKey(y) === posKey(x)) === i).join(' · ');
    return `<li class="gear-row sw-row">
      <button class="row-hit" data-model="${d.id}" aria-label="Open ${esc(d.name)}"></button>
      ${typeThumb(ctx, t)}
      <span class="g-text">
        <span class="g-brand"><span>${esc(h.campusName(d.campus_id))}</span></span>
        <b class="g-name">${esc(d.name)}</b>
        <span class="g-sub">${esc([t?.name, where].filter(Boolean).join(' · '))}</span>
        ${r.notes ? `<span class="g-sub sw-note">${esc(r.notes)}</span>` : ''}
      </span>
      ${r.seen_on ? `<span class="sw-asof"><small>as of</small>${esc(asOf(r.seen_on))}</span>` : '<span></span>'}
    </li>`;
  }

  function click(e) {
    const t = e.target.closest('[data-swset]');
    if (t) { e.stopPropagation(); openSetVersion(t.dataset.swset || null); }
  }

  /** Put one version on several computers: pick the title, the version, and which ones. */
  function openSetVersion(softwareId) {
    const pool = h.computers().sort((a, b) => byPlace({ d: a }, { d: b }));
    const st = { sw: softwareId, name: '', maker: '', version: '', build: '', seen_on: today(), picked: new Set(), busy: false, error: '' };
    const sheet = ctx.openSheet({ label: 'Set a version', className: 'sw-sheet' });
    const current = (d) => (st.sw ? (s.ix.installs.get(d.id) || []).find((i) => i.software_id === st.sw) : null);
    const read = () => {
      for (const k of ['name', 'maker', 'version', 'build', 'seen_on']) { const f = $(`#sv-${k}`, sheet.el); if (f) st[k] = f.value.trim(); }
    };
    function render() {
      const sw = (s.data.software || []).find((x) => x.id === st.sw);
      sheet.render(`
        <header class="sh-head">
          <div class="sh-top"><span class="eyebrow">Software</span><button class="icon-btn" data-v="close" aria-label="Close">${icon('close')}</button></div>
          <h2>${sw ? `Set ${esc(sw.name)}` : 'Set a version'}</h2>
          <p class="sh-sub">After an update, put the new version on every computer that got it.</p>
        </header>
        <div class="sh-body">
          <section class="block">
            <h3>Software</h3>
            <div class="chips sw-picks">${(s.data.software || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<button type="button" class="chip sw-pick" data-v="pick" data-id="${x.id}" aria-pressed="${x.id === st.sw}">${logoHtml(x.name, x.logo, 'xs')}${esc(x.name)}</button>`).join('')}
              <button type="button" class="chip" data-v="new" aria-pressed="${st.sw === 'new'}">${icon('plus')}New software</button></div>
            ${st.sw === 'new' ? `<div class="form-row two">
              <label class="field"><span>Name</span><input id="sv-name" value="${esc(st.name)}" placeholder="vMix" autocomplete="off"></label>
              <label class="field"><span>Maker</span><input id="sv-maker" value="${esc(st.maker)}" placeholder="StudioCoast" autocomplete="off"></label></div>` : ''}
          </section>
          <section class="block">
            <h3>Version</h3>
            <div class="form-row three">
              <label class="field"><span>Version</span><input id="sv-version" class="mono" value="${esc(st.version)}" placeholder="21.4" autocomplete="off"></label>
              <label class="field"><span>Build <small>optional</small></span><input id="sv-build" class="mono" value="${esc(st.build)}" autocomplete="off"></label>
              <label class="field"><span>As of</span><input id="sv-seen_on" type="date" value="${esc(st.seen_on)}"></label>
            </div>
          </section>
          <section class="block">
            <h3>Computers <span class="count">${st.picked.size} of ${pool.length}</span></h3>
            <p class="hint">The ones the filters on the page picked.${st.sw && st.sw !== 'new' ? ' Each shows what it has now.' : ''}</p>
            <div class="chips"><button type="button" class="chip" data-v="all">All</button><button type="button" class="chip" data-v="none">None</button></div>
            <ul class="sw-pick-list">${pool.map((d) => {
              const cur = current(d);
              const room = d.room_id ? s.ix.room.get(d.room_id) : null;
              return `<li><label class="check"><input type="checkbox" data-dev="${d.id}" ${st.picked.has(d.id) ? 'checked' : ''}>
                <span><b>${esc(d.name)}</b><small>${esc([h.campusName(d.campus_id), room?.name, d.location].filter(Boolean).join(' · '))}</small></span>
                <em class="mono">${cur ? esc(versionText(cur)) : st.sw && st.sw !== 'new' ? 'Not on it' : ''}</em></label></li>`;
            }).join('')}</ul>
          </section>
          ${st.error ? `<p class="form-msg bad">${esc(st.error)}</p>` : ''}
        </div>
        <footer class="sh-foot"><span class="spacer"></span><button class="btn" data-v="close">Cancel</button>
          <button class="btn primary" data-v="save" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Saving…' : `Save${st.picked.size ? ` on ${plural(st.picked.size, 'computer')}` : ''}`}</button></footer>`);
    }
    sheet.el.addEventListener('change', (e) => {
      const box = e.target.closest('[data-dev]');
      if (!box) return;
      read();
      if (box.checked) st.picked.add(box.dataset.dev); else st.picked.delete(box.dataset.dev);
      render();
    });
    sheet.el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const v = b.dataset.v;
      if (v === 'close') return sheet.close();
      read();
      if (v === 'pick') { st.sw = b.dataset.id; st.error = ''; render(); }
      else if (v === 'new') { st.sw = 'new'; st.error = ''; render(); $('#sv-name', sheet.el)?.focus(); }
      else if (v === 'all') { pool.forEach((d) => st.picked.add(d.id)); render(); }
      else if (v === 'none') { st.picked.clear(); render(); }
      else if (v === 'save') save();
    });
    render();

    async function save() {
      st.error = !st.sw ? 'Pick the software.' : st.sw === 'new' && !st.name ? 'Give the new software a name.'
        : !st.version ? 'Which version?' : !st.picked.size ? 'Tick the computers that have it.' : '';
      if (st.error) return render();
      st.busy = true; render();
      try {
        let swId = st.sw;
        if (swId === 'new') {
          swId = await ctx.store.saveSoftware({ name: st.name, maker: st.maker || null, logo: null, notes: null });
          st.sw = swId;
        }
        for (const id of st.picked) {
          const cur = (s.ix.installs.get(id) || []).find((i) => i.software_id === swId);
          await ctx.store.saveInstall({ id: cur?.id, software_id: swId, device_id: id, version: st.version, build: st.build || null, seen_on: st.seen_on || null, notes: cur?.notes ?? null });
        }
        sheet.close(true);
        ctx.toast(`${st.version} saved on ${plural(st.picked.size, 'computer')}`);
        h.load(true);
      } catch (err) {
        st.busy = false; st.error = err.message; render();
      }
    }
  }

  return { draw, click, options, openSetVersion };
}
