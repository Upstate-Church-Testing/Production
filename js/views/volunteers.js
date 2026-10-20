// Services › People: everyone on the production teams, whether or not they
// have a login. Staff keep a record on each person: the lanyard they've been
// given (Production Volunteer, Coach or Staff), tags and notes. Audio isn't part
// of this app, so people who only run audio are left off the list. Nobody
// signs in as these; they're the staff's records.
//
// Planning Center fills the list (everyone on the shown teams of shared
// services, and anyone on a roster). Staff can add people by hand too.

import { esc, icon, $, $$, plural, initials, timeAgo } from '../util.js';
import { realPhoto, hiddenPosition } from '../pco.js';

export const LANYARDS = { volunteer: 'Production Volunteer', coach: 'Production Coach', staff: 'Production Staff' };
const SHORT = { volunteer: 'Volunteer', coach: 'Coach', staff: 'Staff' };
const KINDS = ['volunteer', 'coach', 'staff'];
const ALL = 'all';

/**
 * host: { ctx, s (services state: vol, campus), model(), kindName(t, p), openPlan(id), reload() }
 * Returns { draw(box), click(e) → handled?, input(e), openPerson(id), lanyardChips(v) }.
 */
export function peopleView(host) {
  const { ctx, s } = host;
  const v = { q: '', lan: ALL };
  let rows = []; // what the list is showing, worked out on draw

  // ------------------------------------------------------------ data ---

  /** Each person with where they serve, what's coming up for them, and when they're next on. */
  function build(m) {
    const people = s.vol?.people || [];
    const members = s.vol?.members || [];
    const teamById = new Map(m.teams.map((t) => [t.id, t]));
    const campusesOfTeam = (t) => new Set((t.service_type_ids?.length ? t.service_type_ids : [t.service_type_id])
      .map((id) => m.typeById.get(id)?.campus_id).filter(Boolean));
    const byPerson = new Map();
    const at = (pid) => {
      if (!byPerson.has(pid)) byPerson.set(pid, { campuses: new Set(), teams: new Map(), upcoming: [], assigned: new Set() });
      return byPerson.get(pid);
    };
    for (const mem of members) {
      const t = teamById.get(mem.team_id);
      if (!t) continue;
      const x = at(mem.person_id);
      for (const pos of mem.positions || []) x.assigned.add(pos);
      // A location counts when they can do something there besides audio (or we don't know their positions).
      const real = !(mem.positions || []).length || (mem.positions || []).some((pos) => !hiddenPosition(pos));
      if (!real) continue;
      for (const c of campusesOfTeam(t)) { x.campuses.add(c); x.teams.set(`${c}|${t.name}`, { campusId: c, team: t.name }); }
    }
    for (const p of m.plans) {
      for (const r of m.people.get(p.id) || []) {
        if (!r.person_id) continue;
        const x = at(r.person_id);
        const campusId = m.type(p).campus_id;
        if (campusId) x.campuses.add(campusId);
        x.upcoming.push({ plan: p, position: r.position || teamById.get(r.team_id)?.name || 'On the team', status: r.status || 'U', campusId });
      }
    }
    return people.map((person) => {
      const x = (person.pco_person_id && byPerson.get(person.pco_person_id)) || { campuses: new Set(), teams: new Map(), upcoming: [], assigned: new Set() };
      const campuses = new Set(x.campuses);
      if (person.home_campus_id) campuses.add(person.home_campus_id);
      const upcoming = [...x.upcoming].sort((a, b) => a.plan._start - b.plan._start);
      const positions = [...new Set([...upcoming.map((u) => u.position), ...[...x.assigned].filter((pos) => !hiddenPosition(pos))])];
      // Only runs audio (everything Planning Center lists for them is audio, and nothing else is coming up).
      const audioOnly = !!person.pco_person_id && x.assigned.size > 0 && !positions.length && !upcoming.length;
      return { ...person, campuses, teams: [...x.teams.values()], upcoming, next: upcoming[0] || null, positions, audioOnly };
    }).filter((p) => !p.audioOnly);
  }

  const placeName = (id) => ctx.campusById.get(id)?.short_name || '';
  const places = (p) => ctx.campuses.filter((c) => p.campuses.has(c.id)).map((c) => c.short_name);

  function matches(p) {
    if (s.campus !== ALL && !p.campuses.has(s.campus)) return false;
    if (!v.q) return true;
    const hay = [p.name, p.notes, ...(p.tags || []), ...places(p), ...p.positions, ...p.teams.map((t) => t.team), p.lanyard ? LANYARDS[p.lanyard] : 'no lanyard']
      .filter(Boolean).join(' ').toLowerCase();
    return v.q.split(/\s+/).every((w) => hay.includes(w));
  }
  const inLan = (p) => v.lan === ALL || (v.lan === 'none' ? !p.lanyard : p.lanyard === v.lan);

  // ---------------------------------------------------------- drawing ---

  function draw(box) {
    const m = host.model();
    if (!s.vol) {
      box.innerHTML = s.volError
        ? `<div class="empty"><h3>Couldn’t load people</h3><p>${esc(s.volError)}</p></div>`
        : `<div class="loading">${'<div class="sk"></div>'.repeat(4)}</div>`;
      return;
    }
    box.innerHTML = `
      <div class="vol-top">
        <div class="search">${icon('search')}<input id="v-q" type="search" autocomplete="off" enterkeyhint="search" placeholder="Search name, location, position, tag" aria-label="Search people" value="${esc(v.q)}"></div>
        <button type="button" class="btn primary" data-vact="add">${icon('plus')}Add person</button>
      </div>
      <div class="seg vol-lans" role="tablist" aria-label="Lanyard" id="v-lans"></div>
      <div id="v-list"></div>`;
    drawList(m);
  }

  function drawList(m = host.model()) {
    const list = $('#v-list');
    if (!list || !m) return;
    const everyone = build(m).filter(matches);
    const count = { all: everyone.length, coach: 0, volunteer: 0, staff: 0, none: 0 };
    for (const p of everyone) count[p.lanyard || 'none']++;
    const scheduledNone = everyone.filter((p) => !p.lanyard && p.next).length;
    $('#v-lans').innerHTML = [
      ['all', 'Everyone'], ['none', 'No lanyard'], ['volunteer', LANYARDS.volunteer], ['coach', LANYARDS.coach], ['staff', LANYARDS.staff],
    ].map(([k, label]) => `<button type="button" role="tab" data-vlan="${k}" aria-selected="${v.lan === k}" class="${k === 'none' && scheduledNone ? 'has-alert' : ''}">${k !== 'all' && k !== 'none' ? `<i class="lan-dot is-${k}"></i>` : ''}${esc(label)}<small>${count[k]}</small></button>`).join('');
    $('#s-tally').innerHTML = `<b>${count.all}</b><span>${count.all === 1 ? 'person' : 'people'}</span><small>${s.campus === ALL ? 'on the production teams' : `at ${esc(placeName(s.campus))}`}</small>`;

    rows = everyone.filter(inLan);
    if (!rows.length) {
      list.innerHTML = `<div class="empty"><h3>${v.q ? 'No one matches' : v.lan === 'none' ? 'Everyone here has a lanyard' : 'No one yet'}</h3>
        <p>${v.q ? `Nobody matches “${esc(v.q)}”.` : LANYARDS[v.lan] ? `Nobody has a ${esc(LANYARDS[v.lan])} lanyard${s.campus === ALL ? '' : ' here'} yet. Tap ${esc(SHORT[v.lan])} beside someone’s name to give them one.` : ''}</p></div>`;
      return;
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    let html;
    if (v.lan === 'none') {
      // Who to hand one to next: the people serving soonest come first.
      const soon = rows.filter((p) => p.next).sort((a, b) => a.next.plan._start - b.next.plan._start || byName(a, b));
      const later = rows.filter((p) => !p.next).sort(byName);
      html = `${soon.length ? `<h3 class="vol-h">On the schedule, no lanyard yet <span class="count">${soon.length}</span></h3><ul class="vol-list">${soon.map(row).join('')}</ul>` : ''}
        ${later.length ? `<h3 class="vol-h">Not on the schedule right now <span class="count">${later.length}</span></h3><ul class="vol-list">${later.map(row).join('')}</ul>` : ''}`;
    } else {
      html = `<ul class="vol-list">${rows.sort(byName).map(row).join('')}</ul>`;
    }
    const scroll = window.scrollY;
    list.innerHTML = html;
    window.scrollTo({ top: scroll });
  }

  function row(p) {
    const m = host.model();
    const photo = realPhoto(p.photo);
    const where = [places(p).join(', '), (p.positions.length ? p.positions : p.teams.map((t) => t.team)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3).join(', ')].filter(Boolean).join(' · ');
    const n = p.next;
    return `<li class="vol-row ${p.lanyard ? `has-${p.lanyard}` : ''}">
      <button class="row-hit" data-vopen="${p.id}" aria-label="Open ${esc(p.name)}"></button>
      <span class="ro-av">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(initials(p.name))}</span>
      <span class="vol-who"><b>${esc(p.name)}${!p.pco_person_id ? ' <em class="vol-tag">Added here</em>' : ''}${(p.tags || []).slice(0, 2).map((t) => ` <em class="vol-tag">${esc(t)}</em>`).join('')}</b>
        <small>${esc(where || 'Not on a team’s list yet')}</small></span>
      <span class="vol-next">${n ? `<b>${esc(m.c.weekday(n.plan.sort_date).slice(0, 3))} ${esc(m.c.date(n.plan.sort_date))}</b><small>${esc([n.position, placeName(n.campusId)].filter(Boolean).join(' · '))}</small>` : '<small>Not scheduled</small>'}</span>
      ${lanyardChips(p)}
    </li>`;
  }

  /** The two quick buttons: tap to give that lanyard, tap again to take it back. */
  function lanyardChips(p) {
    return `<span class="vol-lan" role="group" aria-label="Lanyard for ${esc(p.name)}">${KINDS.map((k) =>
      `<button type="button" class="lan-chip is-${k}" data-lan="${k}" data-vid="${p.id}" aria-pressed="${p.lanyard === k}" title="${p.lanyard === k ? `Take back the ${LANYARDS[k]} lanyard` : `Give a ${LANYARDS[k]} lanyard`}">${esc(SHORT[k])}</button>`).join('')}</span>`;
  }

  // ---------------------------------------------------------- actions ---

  /** Give, switch or take back a lanyard. Shows the change right away and saves it. */
  async function setLanyard(id, kind, after) {
    const person = s.vol?.people.find((x) => x.id === id);
    if (!person) return;
    const was = { lanyard: person.lanyard, lanyard_at: person.lanyard_at, lanyard_by: person.lanyard_by };
    const next = person.lanyard === kind ? null : kind;
    Object.assign(person, { lanyard: next, lanyard_at: next ? new Date().toISOString() : null, lanyard_by: next ? ctx.me.id : null });
    after?.();
    try {
      const saved = await ctx.store.setLanyard(id, next);
      if (saved) Object.assign(person, saved);
      const first = person.name.split(' ')[0];
      ctx.toast(next ? `${first} has a ${LANYARDS[next]} lanyard` : `${first} has no lanyard now`);
    } catch (e) {
      Object.assign(person, was);
      after?.();
      ctx.toast(e.message, 'bad');
    }
  }

  function click(e) {
    const t = e.target.closest('[data-vlan], [data-lan], [data-vopen], [data-vact]');
    if (!t || !t.closest('#s-body')) return false;
    if (t.dataset.vlan) { v.lan = t.dataset.vlan; drawList(); return true; }
    if (t.dataset.lan) { setLanyard(t.dataset.vid, t.dataset.lan, () => drawList()); return true; }
    if (t.dataset.vopen) { openPerson(t.dataset.vopen); return true; }
    if (t.dataset.vact === 'add') { addPerson(); return true; }
    return false;
  }

  function input(e) {
    if (e.target.id !== 'v-q') return;
    v.q = e.target.value.trim().toLowerCase();
    drawList();
  }

  // ------------------------------------------------------ person sheet ---

  function openPerson(id) {
    let editingName = false;
    let confirmDelete = false;
    let notesDraft = null;
    const sheet = ctx.openSheet({ label: 'Person', className: 'vol-sheet' });
    const render = () => {
      const m = host.model();
      const p = build(m).find((x) => x.id === id);
      if (!p) { sheet.close(true); return; }
      const photo = realPhoto(p.photo);
      const login = p.pco_person_id ? [...ctx.people.values()].find((x) => x.pco_person_id === p.pco_person_id) : null;
      const gaveBy = p.lanyard_by ? ctx.people.get(p.lanyard_by)?.full_name : null;
      const allTags = [...new Set((s.vol?.people || []).flatMap((x) => x.tags || []))].sort();
      const days = new Map();
      for (const u of p.upcoming) {
        const k = u.plan._day;
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(u);
      }
      sheet.render(`
        <header class="sh-head">
          <div class="sh-top"><span class="eyebrow">${p.pco_person_id ? 'From Planning Center' : 'Added here'}${login ? ' · has an app login' : ''}</span>
            <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
          <div class="rp-who">
            <span class="ro-av">${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : esc(initials(p.name))}</span>
            <div>${editingName
              ? `<div class="inline-add"><input id="vp-name" value="${esc(p.name)}" aria-label="Name"><button type="button" class="btn primary" data-pa="name-save">Save</button></div>`
              : `<h2>${esc(p.name)}${!p.pco_person_id ? ` <button type="button" class="icon-btn" data-pa="name" aria-label="Change name">${icon('edit')}</button>` : ''}</h2>`}
              <p class="sh-sub">${esc(places(p).join(', ') || 'No location yet')}</p></div>
          </div>
        </header>
        <div class="sh-body">
          <section class="block">
            <h3>Lanyard</h3>
            <div class="seg vol-pick" role="radiogroup" aria-label="Lanyard">
              ${[[null, 'None'], ...KINDS.map((k) => [k, LANYARDS[k]])].map(([k, label]) =>
                `<button type="button" role="radio" data-pa="lan" data-k="${k || ''}" aria-checked="${(p.lanyard || null) === k}" aria-selected="${(p.lanyard || null) === k}">${k ? `<i class="lan-dot is-${k}"></i>` : ''}${esc(label)}</button>`).join('')}
            </div>
            <p class="fine">${p.lanyard ? `Given ${esc(timeAgo(p.lanyard_at))}${gaveBy ? ` by ${esc(gaveBy)}` : ''}.` : 'No lanyard yet.'}</p>
          </section>

          <section class="block">
            <h3>${icon('calendar')}Coming up</h3>
            ${days.size ? `<ul class="svc-mine">${[...days.values()].map((list) => {
              const u = list[0];
              const plans = [...new Map(list.map((x) => [x.plan.id, x.plan])).values()];
              const kinds = plans.map((pl) => host.kindName(m.type(pl), pl)).join(', ');
              const statuses = list.map((x) => x.status);
              const whole = statuses.includes('D') ? 'D' : statuses.some((x) => x !== 'C') ? 'U' : 'C';
              return `<li><button type="button" class="svc-mine-row" data-goto="${u.plan.id}">
                <span class="svc-you-when"><b>${esc(m.c.weekday(u.plan.sort_date).slice(0, 3))} ${esc(m.c.date(u.plan.sort_date))}</b><small>${esc(placeName(u.campusId))}</small></span>
                <span class="svc-you-what"><b>${esc([...new Set(list.map((x) => x.position))].join(', '))}</b><small>${esc(kinds)}</small></span>
                <span class="rp st-${whole} rp-mini">${whole === 'C' ? 'Confirmed' : whole === 'D' ? 'Declined' : 'Requested'}</span>
                ${icon('chevron', 'svc-place-go')}
              </button></li>`;
            }).join('')}</ul>` : '<p class="muted">Not on the schedule in the coming weeks.</p>'}
          </section>

          ${p.teams.length ? `<section class="block">
            <h3>On these teams in Planning Center</h3>
            <div class="vol-teams">${p.teams.map((t) => `<span class="chip static">${esc(t.team)}<small>${esc(placeName(t.campusId))}</small></span>`).join('')}</div>
          </section>` : ''}

          <section class="block">
            <h3>Tags</h3>
            <div class="vol-tags">${(p.tags || []).map((t) => `<span class="chip">${esc(t)}<button type="button" class="icon-btn" data-pa="untag" data-t="${esc(t)}" aria-label="Remove ${esc(t)}">${icon('close')}</button></span>`).join('') || '<span class="muted">No tags yet.</span>'}</div>
            <div class="inline-add"><input id="vp-tag" list="vp-tags" placeholder="Add a tag, like Trainer or Staff" aria-label="New tag" autocomplete="off"><button type="button" class="btn" data-pa="tag">Add</button></div>
            <datalist id="vp-tags">${allTags.filter((t) => !(p.tags || []).includes(t)).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          </section>

          <section class="block">
            <h3>Notes</h3>
            <label class="field"><textarea id="vp-notes" rows="4" placeholder="Anything the team should know: what they’re learning, when they like to serve…">${esc(notesDraft ?? p.notes ?? '')}</textarea></label>
            <div class="btn-row"><button type="button" class="btn" data-pa="notes" ${notesDraft == null ? 'disabled' : ''}>Save notes</button></div>
          </section>

          ${!p.pco_person_id ? `<section class="block">
            <h3>Home location</h3>
            <label class="field"><select id="vp-home">${['', ...ctx.campuses.map((c) => c.id)].map((cid) => `<option value="${cid}" ${cid === (p.home_campus_id || '') ? 'selected' : ''}>${cid ? esc(placeName(cid)) : 'No location'}</option>`).join('')}</select></label>
          </section>` : ''}

          <p class="stamp">${p.pco_person_id ? `<a href="https://services.planningcenteronline.com/people/AC${esc(p.pco_person_id)}" target="_blank" rel="noopener">Open in Planning Center</a>` : 'Not in Planning Center. Only staff see this record.'}${login ? ` · Signs in to this app as ${esc(login.full_name || login.email)}` : ''}</p>
        </div>
        ${!p.pco_person_id ? `<footer class="sh-foot">${confirmDelete
          ? `<span class="confirm-text">Remove ${esc(p.name)}?</span><button class="btn" data-pa="del-no">Keep</button><button class="btn danger" data-pa="del-yes">Remove</button>`
          : `<button class="btn ghost danger-text" data-pa="del">${icon('trash')}Remove</button>`}</footer>` : ''}`);
    };
    const save = async (patch, msg) => {
      try {
        await ctx.store.saveVolunteer({ id, ...patch });
        const row = s.vol.people.find((x) => x.id === id);
        if (row) Object.assign(row, patch);
        if (msg) ctx.toast(msg);
        render(); drawList();
      } catch (e) { ctx.toast(e.message, 'bad'); }
    };
    sheet.el.addEventListener('input', (e) => { if (e.target.id === 'vp-notes') { notesDraft = e.target.value; const b = $('[data-pa="notes"]', sheet.el); if (b) b.disabled = false; } });
    sheet.el.addEventListener('change', (e) => { if (e.target.id === 'vp-home') save({ home_campus_id: e.target.value || null }, 'Location saved'); });
    sheet.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'vp-tag') { e.preventDefault(); $('[data-pa="tag"]', sheet.el)?.click(); }
      if (e.target.id === 'vp-name') { e.preventDefault(); $('[data-pa="name-save"]', sheet.el)?.click(); }
    });
    sheet.el.addEventListener('click', async (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) { sheet.close(true); host.openPlan(g.dataset.goto); return; }
      const t = e.target.closest('[data-pa]');
      if (!t) return;
      const person = s.vol.people.find((x) => x.id === id);
      const a = t.dataset.pa;
      if (a === 'lan') {
        const k = t.dataset.k || null;
        if ((person.lanyard || null) === k) return;
        setLanyard(id, k || person.lanyard, () => { render(); drawList(); });
      } else if (a === 'tag') {
        const input = $('#vp-tag', sheet.el);
        const tag = input.value.trim();
        if (!tag) return input.focus();
        if ((person.tags || []).some((x) => x.toLowerCase() === tag.toLowerCase())) { input.value = ''; return; }
        await save({ tags: [...(person.tags || []), tag].sort() });
        $('#vp-tag', sheet.el)?.focus();
      } else if (a === 'untag') {
        save({ tags: (person.tags || []).filter((x) => x !== t.dataset.t) });
      } else if (a === 'notes') {
        const text = $('#vp-notes', sheet.el).value;
        notesDraft = null;
        save({ notes: text.trim() || null }, 'Notes saved');
      } else if (a === 'name') { editingName = true; render(); $('#vp-name', sheet.el)?.focus(); }
      else if (a === 'name-save') {
        const name = $('#vp-name', sheet.el).value.trim();
        if (!name) return;
        editingName = false;
        save({ name });
      } else if (a === 'del') { confirmDelete = true; render(); }
      else if (a === 'del-no') { confirmDelete = false; render(); }
      else if (a === 'del-yes') {
        try {
          await ctx.store.deleteVolunteer(id);
          s.vol.people = s.vol.people.filter((x) => x.id !== id);
          ctx.toast(`Removed ${person.name}`);
          sheet.close(true);
          drawList();
        } catch (err) { ctx.toast(err.message, 'bad'); }
      }
    });
    render();
    return { refresh: render };
  }

  /** Someone who isn't in Planning Center (yet): just a name the staff keep track of. */
  function addPerson() {
    const draft = { name: '', home_campus_id: s.campus !== ALL ? s.campus : '', lanyard: null, notes: '' };
    let busy = false;
    const sheet = ctx.openSheet({ label: 'Add a person', className: 'vol-sheet' });
    const render = (msg = '') => {
      sheet.render(`
        <header class="sh-head">
          <div class="sh-top"><span class="eyebrow">Add a person</span><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
          <h2>${esc(draft.name || 'New person')}</h2>
          <p class="sh-sub">A record only staff see. They don’t get a login, and nothing is sent to them.</p>
        </header>
        <form class="sh-body form" id="vp-form" novalidate autocomplete="off">
          <label class="field"><span>Name <b class="req">required</b></span><input id="vn-name" value="${esc(draft.name)}" placeholder="First and last name"></label>
          <label class="field"><span>Location</span><select id="vn-home">${['', ...ctx.campuses.map((c) => c.id)].map((cid) => `<option value="${cid}" ${cid === draft.home_campus_id ? 'selected' : ''}>${cid ? esc(placeName(cid)) : 'No location'}</option>`).join('')}</select></label>
          <div class="field"><span>Lanyard</span>
            <div class="seg vol-pick" role="radiogroup" aria-label="Lanyard">${[[null, 'None'], ...KINDS.map((k) => [k, LANYARDS[k]])].map(([k, label]) =>
              `<button type="button" role="radio" data-na="lan" data-k="${k || ''}" aria-checked="${draft.lanyard === k}" aria-selected="${draft.lanyard === k}">${k ? `<i class="lan-dot is-${k}"></i>` : ''}${esc(label)}</button>`).join('')}</div></div>
          <label class="field"><span>Notes</span><textarea id="vn-notes" rows="3">${esc(draft.notes)}</textarea></label>
        </form>
        <footer class="sh-foot"><p class="form-msg ${msg ? 'bad' : ''}" role="status">${esc(msg)}</p><span class="spacer"></span>
          <button class="btn" data-close>Cancel</button><button class="btn primary" data-na="save" ${busy ? 'disabled' : ''}>${busy ? 'Adding…' : 'Add person'}</button></footer>`);
    };
    const collect = () => {
      draft.name = $('#vn-name', sheet.el)?.value ?? draft.name;
      draft.home_campus_id = $('#vn-home', sheet.el)?.value ?? draft.home_campus_id;
      draft.notes = $('#vn-notes', sheet.el)?.value ?? draft.notes;
    };
    sheet.el.addEventListener('submit', (e) => { e.preventDefault(); $('[data-na="save"]', sheet.el)?.click(); });
    sheet.el.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-na]');
      if (!t) return;
      collect();
      if (t.dataset.na === 'lan') { draft.lanyard = t.dataset.k || null; render(); return; }
      if (!draft.name.trim()) { render('Give them a name.'); $('#vn-name', sheet.el)?.focus(); return; }
      busy = true; render();
      try {
        const newId = await ctx.store.saveVolunteer({ name: draft.name, home_campus_id: draft.home_campus_id || null, lanyard: draft.lanyard, notes: draft.notes, tags: [] });
        await host.reloadPeople();
        sheet.close(true);
        ctx.toast(`Added ${draft.name.trim()}`);
        openPerson(newId);
      } catch (err) { busy = false; render(err.message); }
    });
    render();
    $('#vn-name', sheet.el)?.focus();
  }

  return { draw, drawList, click, input, openPerson, lanyardChips, setLanyard };
}
