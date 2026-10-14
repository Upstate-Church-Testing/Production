// Team: who has an account, what they can see, and approving new sign-ups.

import { esc, icon, $, initials, timeAgo, debounce } from '../util.js';

const ROLE_HELP = {
  admin: 'Everything staff can do, plus approving people and changing roles.',
  staff: 'Full production database: networks, gear, logins, history.',
  contractor: 'For outside techs. Access gets set up as their tools are built.',
  volunteer: 'Will see service flows and training videos. No equipment or network data.',
  pending: 'Signed up, can’t see anything until approved.',
};

export function mount(el, ctx) {
  const isAdmin = ctx.me.role === 'admin';
  let people = [...ctx.people.values()];

  el.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Team</div>
      <div class="head-row"><h1 class="h1">People &amp; access</h1></div>
      <p class="head-meta">${isAdmin ? 'Approve new sign-ups and set what each person can see.' : 'Only admins can change roles.'}</p>
    </div>
    <div id="team" class="team"></div>`;

  const draw = () => {
    const by = (r) => people.filter((p) => p.role === r).sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
    const pending = by('pending');
    const groups = [['admin', 'Admins'], ['staff', 'Staff'], ['contractor', 'Contractors'], ['volunteer', 'Volunteers']];
    $('#team', el).innerHTML = `
      ${pending.length ? `<section class="team-group waiting">
        <h2 class="group-h">Waiting for approval <span class="count">${pending.length}</span></h2>
        <ul class="people">${pending.map((p) => personRow(p, true)).join('')}</ul>
      </section>` : ''}
      ${groups.map(([r, label]) => {
        const list = by(r);
        if (!list.length) return '';
        return `<section class="team-group"><h2 class="group-h">${label} <span class="count">${list.length}</span></h2>
          <ul class="people">${list.map((p) => personRow(p)).join('')}</ul></section>`;
      }).join('')}
      <p class="fine invite">To add someone, send them this app’s link. They create an account with their email, then show up here for approval.</p>`;
  };

  function personRow(p, waiting = false) {
    const tags = (p.departments || []).map((t) => `<i class="tag" data-dep="${t}" title="${esc(ctx.dep[t]?.name || t)}">${esc((ctx.dep[t]?.name || t)[0])}</i>`).join('');
    return `<li class="person">
      ${isAdmin ? `<button class="row-hit" data-person="${p.id}" aria-label="Manage ${esc(p.full_name || p.email)}"></button>` : ''}
      <span class="avatar">${esc(initials(p.full_name || p.email))}</span>
      <span class="person-text"><b>${esc(p.full_name || 'No name')}${p.id === ctx.me.id ? ' <small>(you)</small>' : ''}</b><small>${esc(p.email)}</small></span>
      <span class="tags">${tags}</span>
      ${waiting && isAdmin
        ? `<span class="quick"><button class="btn small primary" data-approve="${p.id}" data-role="staff">Staff</button><button class="btn small" data-approve="${p.id}" data-role="volunteer">Volunteer</button></span>`
        : `<span class="pill role-${p.role}">${esc(ctx.roleLabel[p.role])}</span>`}
    </li>`;
  }

  el.addEventListener('click', async (e) => {
    const ap = e.target.closest('[data-approve]');
    if (ap) {
      ap.disabled = true;
      try {
        await ctx.store.updateProfile(ap.dataset.approve, { role: ap.dataset.role });
        ctx.toast(`Approved as ${ctx.roleLabel[ap.dataset.role].toLowerCase()}`);
        await refresh();
      } catch (err) { ctx.toast(err.message, 'bad'); ap.disabled = false; }
      return;
    }
    const pr = e.target.closest('[data-person]');
    if (pr) openPerson(pr.dataset.person);
  });

  async function refresh() {
    people = await ctx.store.profiles();
    ctx.people = new Map(people.map((p) => [p.id, p]));
    draw();
  }

  function openPerson(id) {
    const p = people.find((x) => x.id === id);
    const d = { role: p.role, departments: [...(p.departments || [])], home_campus_id: p.home_campus_id || '' };
    const sheet = ctx.openSheet({ label: p.full_name || p.email });
    const render = (msg = '') => sheet.render(`
      <header class="sh-head"><div class="sh-top"><span class="eyebrow">Team member</span><button class="icon-btn" data-a="close" aria-label="Close">${icon('close')}</button></div>
        <h2>${esc(p.full_name || 'No name')}</h2><p class="sh-sub">${esc(p.email)} · joined ${esc(timeAgo(p.created_at))}</p></header>
      <div class="sh-body form">
        <fieldset class="group"><legend>What they can see</legend>
          <div class="role-list" role="radiogroup">
            ${['admin', 'staff', 'contractor', 'volunteer', 'pending'].map((r) => `
              <label class="role-opt"><input type="radio" name="role" value="${r}" ${d.role === r ? 'checked' : ''}>
                <span><b>${esc(r === 'pending' ? 'No access' : ctx.roleLabel[r])}</b><small>${esc(ROLE_HELP[r])}</small></span></label>`).join('')}
          </div>
        </fieldset>
        <div class="field"><span>Production teams</span><div class="tag-picker">${ctx.departments.map((t) => `<button type="button" class="chip dep big" data-a="tag" data-tag="${t.slug}" data-dep="${t.slug}" aria-pressed="${d.departments.includes(t.slug)}"><i class="dot"></i>${esc(t.name)}</button>`).join('')}</div></div>
        <label class="field"><span>Home campus</span><select id="t-campus"><option value="">None</option>${ctx.campuses.map((c) => `<option value="${c.id}" ${c.id === d.home_campus_id ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select></label>
      </div>
      <footer class="sh-foot"><p class="form-msg bad" role="status">${esc(msg)}</p><span class="spacer"></span><button class="btn" data-a="close">Cancel</button><button class="btn primary" data-a="save">Save</button></footer>`);
    const collect = () => {
      d.role = $('input[name=role]:checked', sheet.el)?.value || d.role;
      d.home_campus_id = $('#t-campus', sheet.el).value;
    };
    sheet.el.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.a === 'close') sheet.close();
      else if (t.dataset.a === 'tag') { collect(); const g = t.dataset.tag; d.departments = d.departments.includes(g) ? d.departments.filter((x) => x !== g) : [...d.departments, g]; render(); }
      else if (t.dataset.a === 'save') {
        collect();
        try {
          await ctx.store.updateProfile(p.id, { role: d.role, departments: d.departments, home_campus_id: d.home_campus_id || null });
          ctx.toast(`Saved ${p.full_name || p.email}`);
          sheet.close(true);
          await refresh();
          if (p.id === ctx.me.id) ctx.reloadMe();
        } catch (err) { render(err.message); }
      }
    });
    render();
  }

  draw();
  refresh().catch(() => {});
  const unsub = ctx.store.subscribe(debounce((table) => { if (table === 'profiles') refresh().catch(() => {}); }, 300));
  return { unmount: () => unsub() };
}
