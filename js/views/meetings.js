// Meetings (staff): any meeting you want, each with questions & answers and notes.
//
// A question shows who it's waiting on and how long it's been open (red after
// three days). Answering records what was said, who said it, when, and where it
// came from; then the question folds into one line: the answer in bold, with
// "Landon · 10:06 AM · answered in 1h 6m" under it. Tap it for the history, a new
// answer when it changes ("changed 1×"), or to reopen it. Everyone's screen
// updates live, so this works open on an iPad in the meeting.

import { esc, icon, $, debounce, storage, store } from '../util.js';

const LATE_MS = 3 * 864e5;            // an open question turns red after three days
const VIA = ['Text', 'Email', 'Phone call'];
const T = {
  meetings: 'meetings', notes: 'meeting_notes', questions: 'meeting_questions', answers: 'meeting_answers',
};

const fDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fMon = new Intl.DateTimeFormat(undefined, { month: 'short' });
const fWk = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const timeKey = (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
const fromInputs = (date, time) => new Date(`${date}T${time || '00:00'}`).toISOString();
const sameDay = (a, b) => dayKey(a) === dayKey(b);
/** "10:06 AM" on the reference day, otherwise "Mon, Oct 26, 10:06 AM". */
const at = (iso, ref = Date.now()) => (sameDay(iso, ref) ? fTime.format(new Date(iso)) : `${fDay.format(new Date(iso))}, ${fTime.format(new Date(iso))}`);
/** "under a minute", "12 min", "1h 6m", "3 days" */
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day' : `${d} days`;
}
const clean = (v, max) => { const t = String(v ?? '').trim().replace(/\s+/g, ' '); return t ? t.slice(0, max) : null; };

export function mount(el, ctx) {
  let alive = true;
  const s = {
    data: null, error: null, people: new Map(),
    open: storage('tally.meeting', null), // the meeting on screen (null: the list)
    shown: null,                           // which meeting the screen was built for
    expanded: new Set(),                   // answered questions opened to their history
  };

  const reload = debounce(() => load(true), 250);
  const unsubscribe = ctx.store.subscribe((table) => { if (table === 'meetings') reload(); });
  const tick = setInterval(() => { if (s.shown) fill(); }, 60000); // keeps "open 12 min" honest

  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('keydown', onKey);
  // ---------------------------------------------------------------- data ---

  async function load(quiet = false) {
    try {
      const [data, people] = await Promise.all([
        ctx.store.meetings(),
        s.people.size ? null : ctx.store.profiles().catch(() => []),
      ]);
      s.data = data;
      if (people) s.people = new Map(people.map((p) => [p.id, p]));
      s.error = null;
    } catch (e) {
      if (!quiet || !s.data) s.error = e.message;
    }
    if (alive) draw();
  }

  const meeting = (id) => s.data?.meetings.find((m) => m.id === id) || null;
  const questionsOf = (id) => s.data.questions.filter((q) => q.meeting_id === id);
  const notesOf = (id) => s.data.notes.filter((n) => n.meeting_id === id);
  const answersOf = (qid) => s.data.answers.filter((a) => a.question_id === qid).sort((a, b) => Date.parse(a.answered_at) - Date.parse(b.answered_at));
  const firstName = (id) => (s.people.get(id)?.full_name || '').trim().split(/\s+/)[0] || '';
  const me = () => firstName(ctx.me.id) || (ctx.me.full_name || '').split(/\s+/)[0] || 'Me';
  const place = (m) => (m.campus_id ? ctx.campusById.get(m.campus_id)?.short_name : '') || '';

  /** Names used before (who answered, who it's waiting on), most used first. */
  function names() {
    const count = new Map();
    const add = (n) => { const k = clean(n, 80); if (k) count.set(k, (count.get(k) || 0) + 1); };
    for (const a of s.data.answers) add(a.who);
    for (const q of s.data.questions) add(q.waiting_on);
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  }
  function vias(m) {
    const used = new Map();
    for (const a of s.data.answers) { const v = clean(a.via, 80); if (v) used.set(v, (used.get(v) || 0) + 1); }
    const list = [m.title, ...[...used].sort((a, b) => b[1] - a[1]).map(([v]) => v), ...VIA];
    return [...new Set(list.map((v) => v.trim()))].slice(0, 7);
  }

  // ---------------------------------------------------------------- draw ---

  function draw() {
    if (s.error) {
      s.shown = null;
      el.innerHTML = `<div class="page-head"><h1 class="h1">Meetings</h1></div>
        <div class="results"><div class="empty"><h3>Couldn’t load meetings</h3><p>${esc(s.error)}</p><div class="empty-actions"><button class="btn" data-act="retry">Try again</button></div></div></div>`;
      return;
    }
    if (!s.data) {
      el.innerHTML = `<div class="page-head"><h1 class="h1">Meetings</h1></div><div class="results"><div class="loading">${'<div class="sk tall"></div>'.repeat(2)}</div></div>`;
      return;
    }
    const m = meeting(s.open);
    if (!m) { if (s.open) { s.open = null; store('tally.meeting', null); } s.shown = null; drawList(); return; }
    if (s.shown !== m.id) build(m);
    fill();
  }

  function drawList() {
    el.classList.remove('is-meeting');
    const today = dayKey(Date.now());
    const all = s.data.meetings.slice();
    const todays = all.filter((m) => dayKey(m.starts_at) === today).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const soon = all.filter((m) => dayKey(m.starts_at) > today).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const past = all.filter((m) => dayKey(m.starts_at) < today).sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at));
    const open = s.data.questions.filter((q) => q.open).length;
    const group = (title, list) => (list.length ? `<section class="mt-group"><h2 class="mt-h">${esc(title)} <span class="count">${list.length}</span></h2><div class="mt-cards">${list.map(card).join('')}</div></section>` : '');
    el.innerHTML = `
      <div class="page-head">
        <div class="head-row"><h1 class="h1">Meetings</h1><button class="btn primary" data-act="new">${icon('plus')}<span>New meeting</span></button></div>
        <p class="head-meta">${all.length ? `${soon.length + todays.length} coming up <i>·</i> ${open} open ${open === 1 ? 'question' : 'questions'}` : 'Any meeting: notes, and questions with who answered and when.'}</p>
      </div>
      <div class="results mt-results">
        ${all.length ? group('Today', todays) + group('Coming up', soon) + group('Earlier', past)
          : `<div class="empty"><h3>No meetings yet</h3><p>Start one for anything: a production meeting, Christmas planning, a walk-through. Each gets its own notes and questions & answers.</p><div class="empty-actions"><button class="btn primary" data-act="new">${icon('plus')}New meeting</button></div></div>`}
      </div>`;
  }

  function card(m) {
    const qs = questionsOf(m.id);
    const open = qs.filter((q) => q.open).length;
    const done = qs.length - open;
    const notes = notesOf(m.id).length;
    const d = new Date(m.starts_at);
    return `<button type="button" class="mt-card" data-meeting="${esc(m.id)}">
      <span class="mt-date"><small>${esc(fMon.format(d))}</small><b>${d.getDate()}</b><small>${esc(fWk.format(d))}</small></span>
      <span class="mt-what"><b>${esc(m.title)}</b><small>${esc([fTime.format(d), place(m)].filter(Boolean).join(' · '))}</small>
        <span class="mt-tags">${open ? `<span class="mt-tag is-open">${open} open</span>` : ''}${done ? `<span class="mt-tag">${done} answered</span>` : ''}${notes ? `<span class="mt-tag">${notes} ${notes === 1 ? 'note' : 'notes'}</span>` : ''}${!open && !done && !notes ? '<span class="mt-tag is-empty">Nothing yet</span>' : ''}</span></span>
      ${icon('chevron', 'mt-go')}
    </button>`;
  }

  /** The meeting screen. Built once per meeting; live changes only refill the lists, so typing isn't interrupted. */
  function build(m) {
    s.shown = m.id;
    s.expanded.clear();
    el.classList.add('is-meeting');
    el.innerHTML = `
      <div class="page-head mt-head">
        <button type="button" class="btn small ghost mt-back" data-act="back">${icon('chevron', 'flip')}<span>Meetings</span></button>
        <div class="head-row"><h1 class="h1 mt-title" id="mt-title"></h1><button type="button" class="btn small" data-act="edit">${icon('edit')}<span>Edit</span></button></div>
        <p class="head-meta" id="mt-meta"></p>
      </div>
      <div class="results mt-results">
        <div class="mt-cols">
          <section class="mt-col" aria-labelledby="mt-qa-h">
            <h2 class="mt-h" id="mt-qa-h">Questions &amp; answers <span class="count" id="mt-qcount"></span></h2>
            <form class="mt-ask" id="mt-ask" autocomplete="off">
              <input id="mt-q" placeholder="Ask a question…" maxlength="1000" aria-label="Question" enterkeyhint="send">
              <div class="mt-ask-row">
                <input id="mt-qwho" list="mt-names" placeholder="Waiting on (optional)" maxlength="80" aria-label="Who has the answer">
                <button class="btn primary" type="submit">Ask</button>
              </div>
              <div class="mt-chips" id="mt-qwho-chips"></div>
            </form>
            <ul class="mt-list" id="mt-open"></ul>
            <h3 class="mt-sub" id="mt-done-h" hidden>Answered</h3>
            <ul class="mt-list" id="mt-done"></ul>
          </section>
          <section class="mt-col" aria-labelledby="mt-n-h">
            <h2 class="mt-h" id="mt-n-h">Notes <span class="count" id="mt-ncount"></span></h2>
            <form class="mt-note" id="mt-note" autocomplete="off">
              <textarea id="mt-n" rows="2" placeholder="Add a note…" maxlength="5000" aria-label="Note"></textarea>
              <div class="mt-note-row"><span class="fine">Return adds it · Shift-Return for a new line</span><button class="btn" type="submit">Add note</button></div>
            </form>
            <ul class="mt-list mt-notes" id="mt-notes"></ul>
          </section>
        </div>
      </div>
      <datalist id="mt-names"></datalist>`;
    window.scrollTo(0, 0);
  }

  function fill() {
    const m = meeting(s.shown);
    if (!m) return;
    const qs = questionsOf(m.id);
    const open = qs.filter((q) => q.open).sort((a, b) => Date.parse(a.asked_at) - Date.parse(b.asked_at));
    const done = qs.filter((q) => !q.open).sort((a, b) => lastAt(b) - lastAt(a));
    const notes = notesOf(m.id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    $('#mt-title', el).textContent = m.title;
    $('#mt-meta', el).innerHTML = [fLong.format(new Date(m.starts_at)), fTime.format(new Date(m.starts_at)), place(m)].filter(Boolean).map(esc).join(' <i>·</i> ');
    $('#mt-qcount', el).textContent = qs.length ? `${open.length} open · ${done.length} answered` : '';
    $('#mt-ncount', el).textContent = notes.length || '';
    $('#mt-open', el).innerHTML = open.map((q) => openRow(q, m)).join('') || (qs.length ? '<li class="mt-none">Every question has an answer.</li>' : '<li class="mt-none">No questions yet. Ask one above; it stays open until someone answers.</li>');
    $('#mt-done-h', el).hidden = !done.length;
    $('#mt-done', el).innerHTML = done.map((q) => doneRow(q, m)).join('');
    $('#mt-notes', el).innerHTML = notes.map(noteRow).join('') || '<li class="mt-none">No notes yet.</li>';
    const known = names();
    $('#mt-names', el).innerHTML = known.map((n) => `<option value="${esc(n)}"></option>`).join('');
    $('#mt-qwho-chips', el).innerHTML = known.slice(0, 6).map((n) => `<button type="button" class="chip mt-chip" data-fill="mt-qwho" data-v="${esc(n)}">${esc(n)}</button>`).join('');
  }

  const lastAt = (q) => { const a = answersOf(q.id); return a.length ? Date.parse(a[a.length - 1].answered_at) : Date.parse(q.asked_at); };

  function openRow(q, m) {
    const age = Date.now() - Date.parse(q.asked_at);
    const prev = answersOf(q.id);
    const last = prev[prev.length - 1];
    return `<li class="mt-q is-open">
      <button type="button" class="mt-q-main" data-qedit="${esc(q.id)}" aria-label="Edit question">
        <b class="mt-q-text">${esc(q.body)}</b>
        <span class="mt-q-meta"><span class="mt-age ${age > LATE_MS ? 'is-late' : ''}">Open ${esc(dur(age))}</span> <i>·</i> asked ${esc(at(q.asked_at, m.starts_at))}${q.waiting_on ? ` <i>·</i> waiting on <b>${esc(q.waiting_on)}</b>` : ''}</span>
        ${last ? `<span class="mt-q-meta">Reopened. Last answer: “${esc(last.body)}”${last.who ? `, ${esc(last.who)}` : ''}</span>` : ''}
      </button>
      <button type="button" class="btn small primary mt-answer" data-answer="${esc(q.id)}">Answer</button>
    </li>`;
  }

  function doneRow(q, m) {
    const list = answersOf(q.id);
    const first = list[0];
    const last = list[list.length - 1];
    const open = s.expanded.has(q.id);
    const took = first ? dur(Date.parse(first.answered_at) - Date.parse(q.asked_at)) : '';
    const meta = [last?.who, last ? at(last.answered_at, m.starts_at) : '', took ? `answered in ${took}` : '', list.length > 1 ? `changed ${list.length - 1}×` : ''].filter(Boolean);
    return `<li class="mt-q is-done ${open ? 'is-expanded' : ''}">
      <button type="button" class="mt-q-main" data-toggle="${esc(q.id)}" aria-expanded="${open}">
        <small class="mt-q-ask">${esc(q.body)}</small>
        <b class="mt-q-ans">${esc(last?.body || 'Answered')}</b>
        <span class="mt-q-meta">${meta.map(esc).join(' <i>·</i> ')}</span>
      </button>
      ${open ? `<div class="mt-more">
        <ol class="mt-hist">${list.slice().reverse().map((a, i) => `<li>
          <button type="button" class="mt-hist-row" data-aedit="${esc(a.id)}" aria-label="Edit this answer">
            <b>${esc(a.body)}</b>
            <small>${esc([a.who, at(a.answered_at, m.starts_at), a.via].filter(Boolean).join(' · '))}${i === list.length - 1 ? ` <i>·</i> asked ${esc(at(q.asked_at, m.starts_at))}${q.waiting_on ? `, waiting on ${esc(q.waiting_on)}` : ''}` : ''}</small>
          </button></li>`).join('')}</ol>
        <div class="mt-acts">
          <button type="button" class="btn small" data-answer="${esc(q.id)}">${icon('plus')}New answer</button>
          <button type="button" class="btn small ghost" data-reopen="${esc(q.id)}">${icon('history')}Reopen</button>
          <button type="button" class="btn small ghost" data-qedit="${esc(q.id)}">${icon('edit')}Edit question</button>
        </div>
      </div>` : ''}
    </li>`;
  }

  function noteRow(n) {
    const by = firstName(n.created_by);
    const edited = n.updated_at && Date.parse(n.updated_at) - Date.parse(n.created_at) > 60000;
    return `<li class="mt-n"><button type="button" class="mt-n-btn" data-nedit="${esc(n.id)}" aria-label="Edit note">
      <span class="mt-n-text">${esc(n.body)}</span>
      <small>${esc([fTime.format(new Date(n.created_at)), by].filter(Boolean).join(' · '))}${edited ? ' · edited' : ''}</small>
    </button></li>`;
  }

  // ------------------------------------------------------------- actions ---

  function onClick(e) {
    const t = e.target.closest('button, [data-meeting]');
    if (!t || !el.contains(t)) return;
    const d = t.dataset;
    if (d.act === 'retry') { load(); return; }
    if (d.act === 'new') { meetingSheet(null); return; }
    if (d.act === 'back') { s.open = null; store('tally.meeting', null); draw(); window.scrollTo(0, 0); return; }
    if (d.act === 'edit') { meetingSheet(meeting(s.shown)); return; }
    if (d.meeting) { s.open = d.meeting; store('tally.meeting', d.meeting); draw(); return; }
    if (d.fill) { const input = $(`#${d.fill}`, el); input.value = d.v; input.focus(); return; }
    if (d.answer) { answerSheet(s.data.questions.find((q) => q.id === d.answer), null); return; }
    if (d.toggle) { if (s.expanded.has(d.toggle)) s.expanded.delete(d.toggle); else s.expanded.add(d.toggle); fill(); return; }
    if (d.qedit) { questionSheet(s.data.questions.find((q) => q.id === d.qedit)); return; }
    if (d.aedit) { const a = s.data.answers.find((x) => x.id === d.aedit); answerSheet(s.data.questions.find((q) => q.id === a?.question_id), a); return; }
    if (d.nedit) { noteSheet(s.data.notes.find((n) => n.id === d.nedit)); return; }
    if (d.reopen) { save(T.questions, { id: d.reopen, open: true }, 'Reopened'); s.expanded.delete(d.reopen); }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    if (f.id === 'mt-ask') {
      const body = clean($('#mt-q', el).value, 1000);
      if (!body) { $('#mt-q', el).focus(); return; }
      btn.disabled = true;
      const ok = await save(T.questions, { meeting_id: s.shown, body, waiting_on: clean($('#mt-qwho', el).value, 80), asked_at: new Date().toISOString() });
      btn.disabled = false;
      if (ok) { $('#mt-q', el).value = ''; $('#mt-qwho', el).value = ''; $('#mt-q', el).focus(); }
    }
    if (f.id === 'mt-note') {
      const body = String($('#mt-n', el).value || '').trim().slice(0, 5000);
      if (!body) { $('#mt-n', el).focus(); return; }
      btn.disabled = true;
      const ok = await save(T.notes, { meeting_id: s.shown, body });
      btn.disabled = false;
      if (ok) { $('#mt-n', el).value = ''; $('#mt-n', el).focus(); }
    }
  }

  function onKey(e) {
    // Return adds a note; Shift-Return starts a new line.
    if (e.target.id === 'mt-n' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#mt-note', el).requestSubmit(); }
  }

  /** Saves, refreshes right away (the live update follows), and says what went wrong if it didn't work. */
  async function save(table, row, done = '') {
    try {
      const id = await ctx.store.saveMeetingRow(table, row);
      if (done) ctx.toast(done);
      await load(true);
      return id || true;
    } catch (err) {
      ctx.toast(err.message);
      return false;
    }
  }
  async function remove(table, id, done) {
    try { await ctx.store.deleteMeetingRow(table, id); ctx.toast(done); await load(true); return true; }
    catch (err) { ctx.toast(err.message); return false; }
  }

  // -------------------------------------------------------------- sheets ---

  function sheetHead(eyebrow, title) {
    return `<header class="sh-head"><div class="sh-top"><span class="eyebrow">${esc(eyebrow)}</span><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div><h2>${esc(title)}</h2></header>`;
  }
  const chips = (target, list) => (list.length ? `<div class="mt-chips">${list.map((v) => `<button type="button" class="chip mt-chip" data-fill="${target}" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>` : '');
  const whenFields = (prefix, iso) => `<div class="mt-when-row">
      <label class="field"><span>Day</span><input type="date" id="${prefix}-d" value="${dayKey(iso)}" required></label>
      <label class="field"><span>Time</span><input type="time" id="${prefix}-t" value="${timeKey(iso)}" required></label>
    </div>`;
  function wire(sheet) {
    sheet.el.addEventListener('click', (e) => {
      const f = e.target.closest('[data-fill]');
      if (f) { const input = sheet.el.querySelector(`#${f.dataset.fill}`); input.value = f.dataset.v; input.focus(); }
    });
  }
  /** Two taps to delete. */
  function armed(btn, label) {
    if (btn.dataset.sure === '1') return true;
    btn.dataset.sure = '1';
    btn.querySelector('span').textContent = label;
    return false;
  }

  function meetingSheet(m) {
    const start = m ? m.starts_at : (() => { const d = new Date(); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0); return d.toISOString(); })();
    const sheet = ctx.openSheet({ label: m ? 'Edit meeting' : 'New meeting', className: 'mt-sheet' });
    sheet.render(`${sheetHead(m ? 'Meeting' : 'New meeting', m ? m.title : 'What’s the meeting?')}
      <form class="sh-body form" id="mm-form" novalidate>
        <label class="field"><span>Name <b class="req">required</b></span><input id="mm-title" maxlength="200" value="${esc(m?.title || '')}" placeholder="Friendsgiving production meeting, Christmas planning…" required></label>
        ${whenFields('mm', start)}
        <label class="field"><span>Location</span><select id="mm-loc"><option value="">Anywhere / not one location</option>${ctx.campuses.map((c) => `<option value="${esc(c.id)}" ${m?.campus_id === c.id ? 'selected' : ''}>${esc(c.short_name)}</option>`).join('')}</select></label>
      </form>
      <footer class="sh-foot"><p class="form-msg" role="status"></p>
        ${m ? `<button type="button" class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete meeting</span></button>` : ''}
        <span class="spacer"></span><button type="button" class="btn primary" data-save>${m ? 'Save' : 'Start meeting'}</button></footer>`);
    setTimeout(() => $('#mm-title', sheet.el)?.focus(), 60);
    sheet.el.addEventListener('submit', (e) => { e.preventDefault(); go(); });
    sheet.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-save]')) go();
      const del = e.target.closest('[data-del]');
      if (del && armed(del, 'Tap again: deletes its notes and Q&A too')) {
        del.disabled = true;
        if (await remove(T.meetings, m.id, 'Meeting deleted')) { sheet.close(true); s.open = null; store('tally.meeting', null); draw(); } else del.disabled = false;
      }
    });
    async function go() {
      const title = clean($('#mm-title', sheet.el).value, 200);
      const msg = $('.form-msg', sheet.el);
      if (!title) { msg.textContent = 'Give the meeting a name.'; msg.classList.add('bad'); $('#mm-title', sheet.el).focus(); return; }
      const date = $('#mm-d', sheet.el).value;
      if (!date) { msg.textContent = 'Pick a day.'; msg.classList.add('bad'); return; }
      const row = { title, starts_at: fromInputs(date, $('#mm-t', sheet.el).value), campus_id: $('#mm-loc', sheet.el).value || null };
      if (m) row.id = m.id;
      const btn = $('[data-save]', sheet.el);
      btn.disabled = true;
      const id = await save(T.meetings, row, m ? 'Saved' : '');
      btn.disabled = false;
      if (!id) return;
      sheet.close(true);
      if (!m) { s.open = id; store('tally.meeting', id); draw(); setTimeout(() => $('#mt-q', el)?.focus(), 80); }
    }
  }

  function questionSheet(q) {
    if (!q) return;
    const sheet = ctx.openSheet({ label: 'Edit question', className: 'mt-sheet' });
    sheet.render(`${sheetHead(q.open ? 'Open question' : 'Answered question', 'Edit question')}
      <form class="sh-body form" novalidate>
        <label class="field"><span>Question <b class="req">required</b></span><textarea id="mq-body" rows="2" maxlength="1000">${esc(q.body)}</textarea></label>
        <label class="field"><span>Waiting on</span><input id="mq-who" list="mt-names" maxlength="80" value="${esc(q.waiting_on || '')}" placeholder="Who has the answer?"></label>
        ${chips('mq-who', names().slice(0, 6))}
        <p class="fine">Asked</p>
        ${whenFields('mq', q.asked_at)}
      </form>
      <footer class="sh-foot"><p class="form-msg" role="status"></p>
        <button type="button" class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete</span></button>
        <span class="spacer"></span><button type="button" class="btn primary" data-save>Save</button></footer>`);
    wire(sheet);
    sheet.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-save]')) {
        const body = clean($('#mq-body', sheet.el).value, 1000);
        const msg = $('.form-msg', sheet.el);
        if (!body) { msg.textContent = 'The question can’t be empty.'; msg.classList.add('bad'); return; }
        const row = { id: q.id, body, waiting_on: clean($('#mq-who', sheet.el).value, 80), asked_at: fromInputs($('#mq-d', sheet.el).value || dayKey(q.asked_at), $('#mq-t', sheet.el).value) };
        if (await save(T.questions, row, 'Saved')) sheet.close(true);
      }
      const del = e.target.closest('[data-del]');
      if (del && armed(del, `Tap again to delete${answersOf(q.id).length ? ' it and its answers' : ''}`)) {
        del.disabled = true;
        if (await remove(T.questions, q.id, 'Question deleted')) sheet.close(true); else del.disabled = false;
      }
    });
  }

  function answerSheet(q, a) {
    if (!q) return;
    const m = meeting(q.meeting_id);
    const now = new Date().toISOString();
    const prior = answersOf(q.id);
    const sheet = ctx.openSheet({ label: a ? 'Edit answer' : 'Answer', className: 'mt-sheet' });
    const when = a ? a.answered_at : now;
    const via = a ? a.via || '' : (m && sameDay(now, m.starts_at) ? m.title : '');
    const who = a ? a.who || '' : q.waiting_on || '';
    sheet.render(`${sheetHead(a ? 'Edit answer' : prior.length ? 'New answer' : 'Answer', q.body)}
      <form class="sh-body form" novalidate>
        ${prior.length && !a ? `<p class="fine mt-was">Was: <b>${esc(prior[prior.length - 1].body)}</b></p>` : ''}
        <label class="field"><span>Answer <b class="req">required</b></span><textarea id="ma-body" rows="2" maxlength="2000" placeholder="What did they say?">${esc(a?.body || '')}</textarea></label>
        <label class="field"><span>Who said it</span><input id="ma-who" list="mt-names" maxlength="80" value="${esc(who)}" placeholder="Leave blank for you (${esc(me())})"></label>
        ${chips('ma-who', names().slice(0, 6))}
        ${whenFields('ma', when)}
        <label class="field"><span>Where</span><input id="ma-via" maxlength="80" value="${esc(via)}" placeholder="This meeting, a text, an email…"></label>
        ${chips('ma-via', m ? vias(m) : VIA)}
      </form>
      <footer class="sh-foot"><p class="form-msg" role="status"></p>
        ${a ? `<button type="button" class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete answer</span></button>` : ''}
        <span class="spacer"></span><button type="button" class="btn primary" data-save>${a ? 'Save' : 'Save answer'}</button></footer>`);
    wire(sheet);
    setTimeout(() => $('#ma-body', sheet.el)?.focus(), 60);
    sheet.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-save]')) {
        const body = String($('#ma-body', sheet.el).value || '').trim().slice(0, 2000);
        const msg = $('.form-msg', sheet.el);
        if (!body) { msg.textContent = 'Type the answer first.'; msg.classList.add('bad'); $('#ma-body', sheet.el).focus(); return; }
        const row = {
          body, who: clean($('#ma-who', sheet.el).value, 80) || me(),
          answered_at: fromInputs($('#ma-d', sheet.el).value || dayKey(when), $('#ma-t', sheet.el).value),
          via: clean($('#ma-via', sheet.el).value, 80),
        };
        if (a) row.id = a.id; else row.question_id = q.id;
        const btn = $('[data-save]', sheet.el);
        btn.disabled = true;
        const ok = await save(T.answers, row, a ? 'Saved' : 'Answered');
        btn.disabled = false;
        if (ok) sheet.close(true);
      }
      const del = e.target.closest('[data-del]');
      if (del && armed(del, 'Tap again to delete this answer')) {
        del.disabled = true;
        const last = prior.length === 1;
        if (await remove(T.answers, a.id, 'Answer deleted')) {
          if (last) await save(T.questions, { id: q.id, open: true }); // no answers left: it's open again
          sheet.close(true);
        } else del.disabled = false;
      }
    });
  }

  function noteSheet(n) {
    if (!n) return;
    const sheet = ctx.openSheet({ label: 'Edit note', className: 'mt-sheet' });
    sheet.render(`${sheetHead(`Note · ${fTime.format(new Date(n.created_at))}`, 'Edit note')}
      <form class="sh-body form" novalidate>
        <label class="field"><span>Note</span><textarea id="mn-body" rows="5" maxlength="5000">${esc(n.body)}</textarea></label>
      </form>
      <footer class="sh-foot"><p class="form-msg" role="status"></p>
        <button type="button" class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete</span></button>
        <span class="spacer"></span><button type="button" class="btn primary" data-save>Save</button></footer>`);
    sheet.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-save]')) {
        const body = String($('#mn-body', sheet.el).value || '').trim().slice(0, 5000);
        if (!body) { const msg = $('.form-msg', sheet.el); msg.textContent = 'Empty notes can be deleted instead.'; msg.classList.add('bad'); return; }
        if (await save(T.notes, { id: n.id, body }, 'Saved')) sheet.close(true);
      }
      const del = e.target.closest('[data-del]');
      if (del && armed(del, 'Tap again to delete')) {
        del.disabled = true;
        if (await remove(T.notes, n.id, 'Note deleted')) sheet.close(true); else del.disabled = false;
      }
    });
  }

  load();
  return {
    unmount() { alive = false; clearInterval(tick); unsubscribe(); },
  };
}
