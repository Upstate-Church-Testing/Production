// Services › Roster: tap an Open spot to schedule someone into it (staff only).
//
// The sheet lists everyone on that Planning Center team, with what Planning Center
// knows about that day: blockouts, declines, and anything else they're already on.
// Scheduling adds them the way Planning Center does: unconfirmed, with the invite
// email prepared but NOT sent. Planning Center's API can't send it, so the sheet
// hands off to the plan in Planning Center, where the ✉️ and Send happen as usual.

import { esc, icon, initials } from '../util.js';
import { realPhoto } from '../pco.js';
import { LANYARDS } from './volunteers.js';

/**
 * spots: [{ plan, team_id }] for one position at one location on one day.
 * h: helpers from the Services view (kindName, kindLetter, firstTime, model, openPlan).
 */
export function openScheduleSheet({ ctx, m, row, spots, h }) {
  const chosen = new Set(spots.map((s) => s.plan.id));
  const st = { list: null, error: null, pick: null, confirm: false, busy: false, done: null, msg: '' };
  const first = spots[0].plan;
  const place = ctx.campusById.get(row.campusId)?.short_name;
  const day = m.c.day(first.sort_date);
  const svcName = (p) => h.kindName(m.type(p), p) || 'Service';
  const svcList = (plans) => {
    const n = plans.map(svcName);
    return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };

  const sheet = ctx.openSheet({ label: `Schedule ${row.position}`, className: 'sch-sheet' });
  sheet.el.addEventListener('click', onClick);
  render();
  load();

  async function load() {
    st.list = null; st.error = null;
    render();
    try {
      const r = await ctx.store.pco('candidates', { picks: spots.map((s) => ({ plan_id: s.plan.id, team_id: s.team_id })), position: row.position });
      st.list = r.people || [];
    } catch (e) {
      st.error = e.message;
    }
    render();
  }

  // Who's on the roster on other days (from what the app already has), for "serving a lot lately".
  function otherDays(personId) {
    const days = new Set();
    for (const p of m.plans) {
      if (p._day === day) continue;
      if ((m.people.get(p.id) || []).some((x) => x.person_id === personId && x.status !== 'D')) days.add(p._day);
    }
    return days.size;
  }

  function standing(p) {
    const blocks = p.blockouts.filter((b) => b.blocks);
    const later = p.blockouts.filter((b) => !b.blocks);
    const declined = p.schedules.filter((s) => s.status === 'D');
    const here = p.schedules.filter((s) => s.status !== 'D' && s.this_spot);
    const elsewhere = p.schedules.filter((s) => s.status !== 'D' && !s.this_spot);
    const level = blocks.length || declined.length ? 'no' : here.length || elsewhere.length || p.unchecked ? 'check' : 'ok';
    return { blocks, later, declined, here, elsewhere, level };
  }

  function span(b) {
    const s = new Date(b.starts_at);
    const e = new Date(b.ends_at);
    const d1 = m.c.day(s);
    const d2 = m.c.day(new Date(e.getTime() - 1000));
    const wholeDay = m.c.time(s) === '12 AM' && /11:59 PM|12 AM/.test(m.c.time(e));
    if (d1 !== d2) return `${m.c.date(s)} – ${m.c.date(e)}`;
    if (wholeDay) return 'all day';
    return `${m.c.time(s)} – ${m.c.time(e)}`;
  }

  function notes(p, s) {
    const out = [];
    for (const b of s.blocks) out.push(['no', `Blocked out ${span(b)}${b.reason ? ` · ${b.reason.trim()}` : ''}`]);
    // One line per position, however many services it covers.
    const byPos = (list) => {
      const g = new Map();
      for (const x of list) {
        const k = x.position || x.team || 'Something';
        if (!g.has(k)) g.set(k, { pos: k, services: [], open: false, reasons: [] });
        const e = g.get(k);
        if (x.service && !e.services.includes(x.service)) e.services.push(x.service);
        if (x.status === 'U') e.open = true;
        if (x.decline_reason && !e.reasons.includes(x.decline_reason.trim())) e.reasons.push(x.decline_reason.trim());
      }
      return [...g.values()];
    };
    const svcs = (e) => (e.services.length > 2 ? `${e.services[0]} +${e.services.length - 1} more` : e.services.join(' & '));
    for (const e of byPos(s.declined)) out.push(['no', `Declined ${e.pos}${e.services.length ? ` · ${svcs(e)}` : ''}${e.reasons.length ? ` · “${e.reasons.join('; ')}”` : ''}`]);
    for (const e of byPos(s.here)) out.push(['check', `Already on ${e.pos}${e.services.length ? ` for ${svcs(e)}` : ''}${e.open ? ' (not answered)' : ''}`]);
    for (const e of byPos(s.elsewhere)) out.push(['check', `Also that day: ${e.pos}${e.services.length ? ` · ${svcs(e)}` : ''}${e.open ? ' (not answered)' : ''}`]);
    for (const b of s.later) out.push(['', `Blocked out later that day, ${span(b)}`]);
    if (p.unchecked) out.push(['check', 'Couldn’t check their blockouts in Planning Center']);
    const n = otherDays(p.person_id);
    out.push(['', n ? `On ${n} other ${n === 1 ? 'day' : 'days'} in the next ${h.weeks} weeks` : `Not on the schedule in the next ${h.weeks} weeks`]);
    if (p.preference && !/as often as needed/i.test(p.preference)) out.push(['', `Prefers ${p.preference.toLowerCase()}`]);
    return out;
  }

  function personRow(p) {
    const s = standing(p);
    const photo = realPhoto(p.photo);
    const picked = st.pick === p.person_id;
    const can = p.positions.filter((x) => x.toLowerCase() !== row.position.toLowerCase());
    return `<li><button type="button" class="sch-p is-${s.level} ${picked ? 'is-picked' : ''}" data-cand="${esc(p.person_id)}" aria-pressed="${picked}">
      <span class="ro-av">${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : esc(initials(p.name))}</span>
      <span class="sch-who">
        <b>${esc(p.name)}${p.lanyard ? ` <i class="lan-dot is-${esc(p.lanyard)}" title="${esc(LANYARDS[p.lanyard] || '')}"></i>` : ''}</b>
        ${!p.qualified && can.length ? `<small class="sch-can">Does ${esc(can.slice(0, 3).join(', '))}</small>` : ''}
        ${notes(p, s).map(([k, t]) => `<small class="sch-note ${k ? `is-${k}` : ''}">${k === 'no' ? icon('close') : k === 'check' ? icon('warn') : ''}${esc(t)}</small>`).join('')}
      </span>
      <span class="sch-tick">${picked ? icon('check') : ''}</span>
    </button></li>`;
  }

  function group(title, list, hint = '') {
    if (!list.length) return '';
    return `<section class="sch-group"><h3>${esc(title)} <small>${list.length}</small></h3>${hint ? `<p class="fine">${esc(hint)}</p>` : ''}<ul class="sch-list">${list.map(personRow).join('')}</ul></section>`;
  }

  function people() {
    if (st.error) return `<div class="empty"><h3>Couldn’t check Planning Center</h3><p>${esc(st.error)}</p><div class="empty-actions"><button class="btn" data-sch="retry">Try again</button></div></div>`;
    if (!st.list) return `<p class="sch-wait">${icon('refresh')}Checking blockouts and schedules in Planning Center…</p><div class="loading">${'<div class="sk"></div>'.repeat(4)}</div>`;
    const lv = (p) => standing(p).level;
    const ok = st.list.filter((p) => p.qualified && lv(p) === 'ok');
    const check = st.list.filter((p) => p.qualified && lv(p) === 'check');
    const no = st.list.filter((p) => lv(p) === 'no');
    const rest = st.list.filter((p) => !p.qualified && lv(p) !== 'no');
    if (!st.list.length) return `<div class="empty"><h3>No one on this team yet</h3><p>Add people to the team in Planning Center first.</p></div>`;
    return [
      group('Available', ok),
      group('Check first', check, 'Already serving that day, or Planning Center couldn’t say.'),
      group('Can’t that day', no, 'Blocked out during the service, or declined.'),
      group('Rest of the team', rest, `On the team, but not set up for ${row.position} in Planning Center.`),
    ].join('') || '<p class="fine">No one to show.</p>';
  }

  function foot() {
    const p = st.list?.find((x) => x.person_id === st.pick);
    if (!p) return `<footer class="sh-foot"><span class="fine">Pick someone, then Schedule.</span></footer>`;
    const s = standing(p);
    const risky = s.level !== 'ok' || !p.qualified;
    const plans = spots.filter((x) => chosen.has(x.plan.id)).map((x) => x.plan);
    const firstName = p.name.split(/\s+/)[0];
    const warn = st.confirm
      ? `<p class="form-msg bad">${icon('warn')}${esc(s.level === 'no' ? `${firstName} can’t that day in Planning Center.` : !p.qualified ? `${firstName} isn’t set up for ${row.position} in Planning Center.` : `${firstName} is already on something that day.`)} Schedule anyway?</p>` : '';
    return `<footer class="sh-foot">${warn}<p class="form-msg ${st.msg ? 'bad' : ''}">${esc(st.msg)}</p>
      <span class="sch-what">${esc(row.position)} · ${esc(svcList(plans))}</span><span class="spacer"></span>
      <button type="button" class="btn ${st.confirm ? 'danger' : 'primary'}" data-sch="go" ${st.busy || !plans.length ? 'disabled' : ''}>${st.busy ? 'Scheduling…' : st.confirm || !risky ? `Schedule ${esc(firstName)}${st.confirm ? ' anyway' : ''}` : `Schedule ${esc(firstName)}`}</button>
    </footer>`;
  }

  function doneView() {
    const d = st.done;
    const plans = d.plans;
    const links = plans.filter((p) => p.url && p.url !== '#');
    return `<div class="sh-body sch-done">
      <p class="rp-sum st-U"><span class="ro-st st-U"><i aria-hidden="true">?</i></span><b>${esc(d.name)} is on ${esc(row.position)} for ${esc(svcList(plans))}</b></p>
      <section class="block sch-send">
        <h3>${icon('mail')}Send the invite</h3>
        <p>Planning Center hasn’t emailed ${esc(d.first)} yet, and until it does they can’t see this on their schedule. Open the plan, tap the ✉️ by their name, keep <b>Email</b> checked, and hit <b>Send</b>.</p>
        <div class="sch-links">${links.length ? links.map((p) => `<a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('open')}${esc(svcName(p))} in Planning Center</a>`).join('')
          : '<span class="fine">Open the plan in Planning Center to send it.</span>'}</div>
        <p class="fine">The roster shows ${icon('mail')} on their name until the invite goes out.</p>
      </section>
      ${st.msg ? `<p class="form-msg bad">${esc(st.msg)}</p>` : ''}
    </div>
    <footer class="sh-foot"><button type="button" class="btn ghost" data-sch="undo" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Taking off…' : 'Undo'}</button><span class="spacer"></span><button type="button" class="btn primary" data-close>Done</button></footer>`;
  }

  function render() {
    const head = `<header class="sh-head">
      <div class="sh-top"><span class="eyebrow">${esc([place, `${m.c.weekday(first.sort_date)}, ${m.c.date(first.sort_date)}`].filter(Boolean).join(' · '))}</span>
        <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
      <h2>${st.done ? 'Scheduled' : `Schedule ${esc(row.position)}`}</h2>
      ${st.done ? '' : `<p class="sh-sub">${esc(row.team)} · pick who fills the open spot</p>`}
    </header>`;
    if (st.done) { sheet.render(head + doneView()); return; }
    const chips = spots.length > 1 ? `<section class="sch-svcs"><h3>Services</h3><div class="sch-chips">${spots.map(({ plan }) => `<button type="button" class="chip" data-svc="${esc(plan.id)}" aria-pressed="${chosen.has(plan.id)}">
        ${chosen.has(plan.id) ? icon('check') : ''}<span class="rp-dots"><i class="st-U">${esc(h.kindLetter(m.type(plan), plan))}</i></span>${esc(svcName(plan))} <small>${esc(h.firstTime(m, plan))}</small></button>`).join('')}</div></section>`
      : `<p class="sch-one"><span class="rp-dots"><i class="st-U">${esc(h.kindLetter(m.type(first), first))}</i></span>${esc(svcName(first))} · ${esc(h.firstTime(m, first))}</p>`;
    sheet.render(`${head}<div class="sh-body">${chips}${people()}</div>${foot()}`);
  }

  async function onClick(e) {
    const c = e.target.closest('[data-cand]');
    if (c) { st.pick = st.pick === c.dataset.cand ? null : c.dataset.cand; st.confirm = false; st.msg = ''; render(); return; }
    const v = e.target.closest('[data-svc]');
    if (v) {
      const id = v.dataset.svc;
      if (chosen.has(id) && chosen.size === 1) return; // at least one
      if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
      st.confirm = false;
      render();
      return;
    }
    const a = e.target.closest('[data-sch]')?.dataset.sch;
    if (a === 'retry') { load(); return; }
    if (a === 'go') await go();
    if (a === 'undo') await undo();
  }

  async function go() {
    const p = st.list?.find((x) => x.person_id === st.pick);
    if (!p || st.busy) return;
    const s = standing(p);
    if ((s.level !== 'ok' || !p.qualified) && !st.confirm) { st.confirm = true; render(); return; }
    const picks = spots.filter((x) => chosen.has(x.plan.id));
    st.busy = true; st.msg = ''; render();
    try {
      const r = await ctx.store.pco('schedule', { picks: picks.map((x) => ({ plan_id: x.plan.id, team_id: x.team_id })), position: row.position, person_id: p.person_id });
      st.done = { name: p.name, first: p.name.split(/\s+/)[0], plans: picks.map((x) => x.plan), made: (r.scheduled || []).map((x) => x.plan_person_id).filter(Boolean) };
      ctx.toast(`${p.name} scheduled · invite not sent yet`);
    } catch (err) {
      st.msg = err.message;
    }
    st.busy = false;
    st.confirm = false;
    render();
  }

  async function undo() {
    if (!st.done || st.busy) return;
    st.busy = true; st.msg = ''; render();
    try {
      for (const id of st.done.made) await ctx.store.pco('unschedule', { plan_person_id: id });
      ctx.toast(`${st.done.name} taken back off`);
      st.done = null; st.pick = null;
      st.busy = false;
      load();
      return;
    } catch (err) {
      st.msg = err.message;
    }
    st.busy = false;
    render();
  }
}

/** Take people back off before their invite goes out (from a roster pill). */
export async function takeOff(ctx, planPersonIds) {
  for (const id of planPersonIds) await ctx.store.pco('unschedule', { plan_person_id: id });
}
