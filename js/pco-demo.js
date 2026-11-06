// Planning Center in the preview: made-up services, teams and rosters that
// behave like the real thing (connect, share, show teams, sync).

const NAMES = ['Avery Cole', 'Jordan Pike', 'Riley Shaw', 'Morgan Diaz', 'Casey Lund', 'Taylor Brooks', 'Jamie Ortiz', 'Drew Patel',
  'Sam Whitfield', 'Quinn Harper', 'Reese Kim', 'Parker Lane', 'Hayden Moss', 'Rowan Price', 'Emery Fox', 'Logan Reyes',
  'Blake Turner', 'Cameron Webb', 'Dakota Gray', 'Skyler Ross', 'Finley Hart', 'Sage Collins', 'Elliot Park', 'Kendall Ray'];

const BROADCAST = ['Audio', 'Director', 'TD [Switcher]', 'Cam 1 [Center]', 'Cam 2 [Wide]', 'Cam 3 [HL]', 'Cam 4 [HR]'];
const FOH = ['Audio', 'CG', 'Lighting'];

const SERVICES = [
  // id, name, path, campus, access, times (local hh:mm), call
  ['st-svl-m', 'Simpsonville - Modern', ['09 UC Simpsonville'], 'c-SVL', 'everyone', ['09:30', '11:30'], '06:00'],
  ['st-svl-n', 'Simpsonville - Modern [North Auditorium]', ['09 UC Simpsonville'], 'c-SVL', 'everyone', ['11:30'], '08:30'],
  ['st-svl-v', 'Simpsonville - Vintage', ['09 UC Simpsonville'], 'c-SVL', 'everyone', ['09:30'], '07:30'],
  ['st-svl-t', 'Traditional', ['09 UC Simpsonville'], 'c-SVL', 'everyone', ['11:00'], '09:00'],
  ['st-and-v', 'Anderson - Vintage', ['01 UC Anderson'], 'c-AND', 'everyone', ['09:00'], '07:30'],
  ['st-and-m', 'Anderson - Modern', ['01 UC Anderson'], 'c-AND', 'everyone', ['10:00', '11:30'], '07:30'],
  ['st-ff-m', 'Five Forks - Modern', ['02 UC Five Forks'], 'c-FF', 'everyone', ['10:00'], '07:30'],
  ['st-gvl-m', 'Greenville - Modern', ['04 UC Greenville'], 'c-GVL', 'staff', ['11:00'], '08:00'],
  ['st-svl-x', 'Simpsonville - Christmas Eve', ['09 UC Simpsonville', '02 Christmas Eve'], 'c-SVL', 'hidden', ['16:00'], '13:00'],
  ['st-svl-r', 'Reset (Wednesday Nights)', ['09 UC Simpsonville'], 'c-SVL', 'hidden', ['18:30'], '17:00'],
  // Like the real student midweeks: FOH only, and they keep their audio op (show_audio).
  ['st-svl-w', 'Simpsonville Midweek', ['11 Students'], 'c-SVL', 'everyone', ['19:00'], '17:30'],
  ['st-mau-w', 'Mauldin Midweek', ['11 Students'], 'c-MAU', 'everyone', ['19:00'], '17:30'],
  ['st-hb-k', 'UC:HB Upstate Kids Preschool', ['13 Upstate Kids'], 'c-HB', 'hidden', ['09:30'], '08:30'],
  ['st-ya', 'Young Adults Worship', ['12 Young Adults'], null, 'hidden', ['19:00'], '17:30'],
];

// Wall-clock time in New York on a given date, as an ISO string.
function eastern(dateUtcMidnight, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = new Date(dateUtcMidnight.getTime() + (h + 4) * 3600e3 + m * 60e3); // EDT
  const shown = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(guess);
  const off = (Number(shown) % 24) - h; // 0 in EDT, -1 in EST
  return new Date(guess.getTime() - off * 3600e3).toISOString();
}

function build(meId) {
  const types = [];
  const teams = [];
  const plans = [];
  const people = [];
  const today = new Date();
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const daysToSunday = (7 - base.getUTCDay()) % 7 || 7;

  SERVICES.forEach(([id, title, path, campus, access, times, call], i) => {
    const midweek = /Midweek/.test(title);
    types.push({ id, name: title, path, campus_id: campus, campus_set: false, access, access_set: midweek, on_roster: id !== 'st-svl-t', show_audio: midweek, sequence: i, teams_synced_at: new Date().toISOString() });
    const tb = { id: `${id}-b`, service_type_id: id, name: 'Broadcast', shown: !midweek, sequence: 1, positions: midweek ? [] : BROADCAST.map((p, k) => ({ id: `${id}-b${k}`, name: p, sequence: k })) };
    const tf = { id: `${id}-f`, service_type_id: id, name: 'FOH', shown: true, sequence: 2, positions: FOH.map((p, k) => ({ id: `${id}-f${k}`, name: p, sequence: k })) };
    const tw = { id: `${id}-w`, service_type_id: id, name: 'Worship Team', shown: false, sequence: 3, positions: [] };
    const tu = { id: `${id}-u`, service_type_id: id, name: 'Ushers', shown: false, sequence: 4, positions: [] };
    teams.push(tb, tf, tw, tu);
    if (id === 'st-hb-k' || id === 'st-ya') return;
    for (let w = -4; w < 4; w++) { // like the real copy: some weeks back as well as ahead
      const isWed = id === 'st-svl-r' || midweek;
      const day = new Date(base.getTime() + (daysToSunday + w * 7 - (isWed ? 4 : 0)) * 864e5);
      if (id === 'st-svl-x' && w !== 0) continue;
      const pid = `${id}-p${w}`;
      const serviceTimes = times.map((t) => ({ name: null, kind: 'service', starts_at: eastern(day, t), ends_at: null }));
      plans.push({
        id: pid, service_type_id: id, title: title.split(' - ')[1] || null, series_title: w >= 0 && w < 2 ? 'Better Together' : null,
        dates: day.toISOString().slice(0, 10), sort_date: serviceTimes[0].starts_at,
        times: [{ name: 'Call and Rehearsal', kind: 'rehearsal', starts_at: eastern(day, call), ends_at: null }, ...serviceTimes],
        url: '#', needed: [], synced_at: new Date().toISOString(),
      });
      const plan = plans[plans.length - 1];
      // Like the real schedule: one person covers a position for every service at a
      // location that day (Traditional has its own crew), and answers each one separately.
      const crew = id === 'st-svl-t' ? 'trad' : midweek ? `${campus}-mid` : campus;
      const fill = (team, roles, gaps) => roles.forEach((pos, k) => {
        if (gaps.includes(k)) { plan.needed.push({ team_id: team.id, position: pos, quantity: 1 }); return; }
        const seed = [...`${crew}|${team.name}|${pos}|${w}`].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
        const roll = (seed + i * (seed % 3 === 0 ? 1 : 0)) % 9; // now and then a different answer per service
        const mine = meId && campus === 'c-SVL' && crew !== 'trad' && team === tb && pos === 'Director' && w < 3;
        const who = NAMES[seed % NAMES.length];
        people.push({
          id: `${pid}-${team.id}-${k}`, plan_id: pid, team_id: team.id, person_id: mine ? 'pp-me' : `pp-${who.replace(/\W/g, '')}`,
          name: mine ? null : who, position: pos, status: mine ? (w === 2 && id === 'st-svl-v' ? 'U' : 'C') : roll === 0 ? 'D' : roll < 3 ? 'U' : 'C', photo: null,
          invite_pending: !mine && roll === 1 && w > 0, // scheduled, invite not sent yet
        });
      });
      const broadcast = ['st-svl-m', 'st-svl-v'].includes(id); // like the real thing: only Simpsonville's main room has a broadcast
      if (broadcast) fill(tb, BROADCAST, w === 0 ? [5] : w === 1 ? [3, 6] : [2, 4, 5, 6]);
      fill(tf, FOH, midweek ? (w === 1 ? [0] : w >= 2 ? [2] : []) : w >= 2 ? [1] : []);
    }
  });
  // Events (like Simpsonville › Events): one-off services on the Events page, with Live.
  // Today's started 21 minutes ago, so Live has something to show.
  const ev = 'st-svl-e';
  const POS = ['Director', 'Audio', 'CG', 'Lighting', 'Cam 1'];
  types.push({ id: ev, name: 'Events', path: ['09 UC Simpsonville'], campus_id: 'c-SVL', campus_set: false, access: 'staff', access_set: true, on_roster: false, show_audio: false, is_event: true, sequence: SERVICES.length, teams_synced_at: new Date().toISOString() });
  const te = { id: `${ev}-p`, service_type_id: ev, name: 'Production', shown: true, sequence: 1, positions: POS.map((x, k) => ({ id: `${ev}-p${k}`, name: x, sequence: k })) };
  teams.push(te);
  // Today's two: one 21 minutes in (Live has an item up), one starting in 40 (doors are open).
  const minute = (n) => new Date(Math.floor((Date.now() + n * 60e3) / 60e3) * 60e3).toISOString();
  [["Women's Night", 0, minute(-21)], ['Chili Fest', 1, '10:00'], ['Newcomers Lunch', 16, '16:00'], ['Christmas Coffeehouse', 28, '18:00'], ['Marriage Conference', -13, '10:00'], ['Student Worship Night', 0, minute(40)]]
    .forEach(([title, inDays, hhmm], k) => {
      const day = new Date(base.getTime() + inDays * 864e5);
      const start = /T/.test(hhmm) ? hhmm : eastern(day, hhmm);
      const before = (min) => new Date(Date.parse(start) - min * 60e3).toISOString();
      const pid = `${ev}-e${k}`;
      plans.push({
        id: pid, service_type_id: ev, title, series_title: null, dates: start.slice(0, 10), sort_date: start,
        times: [
          { name: 'Rehearsal', kind: 'other', starts_at: before(150), ends_at: before(60) },
          { name: 'Service Runthrough', kind: 'other', starts_at: before(120), ends_at: before(90) },
          { name: 'Doors Open', kind: 'other', starts_at: before(60), ends_at: before(15) },
          { name: 'Worship Center Doors Open', kind: 'other', starts_at: before(15), ends_at: start },
          { name: null, kind: 'service', starts_at: start, ends_at: before(-120) },
        ],
        url: '#', needed: k === 1 ? [{ team_id: te.id, position: 'Lighting', quantity: 1 }] : [], synced_at: new Date().toISOString(),
      });
      POS.forEach((pos, j) => {
        if (k === 1 && pos === 'Lighting') return;
        const who = NAMES[(k * 5 + j * 3) % NAMES.length];
        people.push({ id: `${pid}-x${j}`, plan_id: pid, team_id: te.id, person_id: `pp-${who.replace(/\W/g, '')}`, name: who, position: pos, status: k === 2 && j === 3 ? 'U' : 'C', photo: null, invite_pending: false });
      });
    });
  return { types, teams, plans, people };
}

/** An event's order of service (the demo's events all run like this). */
function eventItems(planId) {
  const it = (n, title, kind, length, extra = {}) => ({ id: `${planId}-i${n}`, plan_id: planId, sequence: n, title, kind, position: 'during', length, description: null, key_name: null, arrangement: null, notes: [], ...extra });
  return [
    it(1, 'Worship', 'header', 0),
    it(2, 'Call to Worship', 'item', 30, { description: 'Avery', notes: [{ category: 'Audio', content: 'VOX - 1' }, { category: 'CG', content: 'Scripture: Psalm 95:1-2' }, { category: 'Lighting', content: 'Stage wash up from preset' }] }),
    it(3, 'Holy Spirit Welcome', 'song', 261, { key_name: 'E', description: 'Avery', notes: [{ category: 'Audio', content: 'VOX - 1' }, { category: 'CG', content: 'Lyrics' }] }),
    it(4, 'I Believe', 'song', 350, { key_name: 'F', description: 'Jordan', notes: [{ category: 'Audio', content: 'VOX - 2' }, { category: 'CG', content: 'Lyrics' }, { category: 'Lighting', content: 'Song look 4' }] }),
    it(5, 'Jesus Paid It All', 'song', 333, { key_name: 'F', description: 'Jordan', notes: [{ category: 'Audio', content: 'VOX - 2 · Jordan prays, Avery brings the table' }, { category: 'CG', content: 'Lyrics' }, { category: 'Lighting', content: 'Warm wash; haze down for the prayer' }] }),
    it(6, 'Welcome', 'header', 0),
    it(7, 'Event Welcome', 'item', 60, { notes: [{ category: 'Audio', content: 'Host: VOX - 3' }, { category: 'CG', content: 'Welcome slide' }] }),
    it(8, 'Bumper Video', 'media', 20, { notes: [{ category: 'Media', content: 'Bumper video' }, { category: 'Audio', content: 'Playback up' }] }),
    it(9, 'Speakers', 'header', 0),
    it(10, 'Speaker 1', 'item', 600, { notes: [{ category: 'Audio', content: 'VOX - 4' }, { category: 'CG', content: 'Name lower third' }, { category: 'Lighting', content: 'Speaker look' }] }),
    it(11, 'Speaker 2', 'item', 600, { notes: [{ category: 'Audio', content: 'VOX - 5' }, { category: 'CG', content: 'Name lower third' }] }),
    it(12, 'Speaker 3', 'item', 600, { notes: [{ category: 'Audio', content: 'VOX - 6' }, { category: 'CG', content: 'Name lower third' }] }),
    it(13, 'Speaker 4', 'item', 600, { notes: [{ category: 'Audio', content: 'VOX - 3 · keys pad in at the 3:00 mark' }, { category: 'CG', content: 'Name lower third; leave the verse up at the end' }] }),
    it(14, 'Worship', 'header', 0),
    it(15, 'Holy Forever', 'song', 315, { key_name: 'F', notes: [{ category: 'Audio', content: 'VOX - 2' }, { category: 'CG', content: 'Lyrics' }, { category: 'Lighting', content: 'Song look 2' }] }),
    it(16, 'Shout to the Lord', 'song', 341, { key_name: 'F', notes: [{ category: 'Audio', content: 'VOX - 1' }, { category: 'CG', content: 'Lyrics' }] }),
    it(17, 'Pray and Close', 'item', 120, { notes: [{ category: 'Lighting', content: 'House to half' }] }),
  ];
}

export function createPcoDemo({ wait, clone, me, changed }) {
  let connected = true;
  let db = build(me.id);
  let syncing = false;
  let lastSync = new Date(Date.now() - 6 * 60e3).toISOString();
  me.pco_person_id = 'pp-me';
  const myName = () => me.full_name || 'You';

  const isAdmin = () => me.role === 'admin';
  const canSee = (access) => (access === 'everyone' ? me.role !== 'pending' : access === 'staff' ? ['staff', 'admin'].includes(me.role) : isAdmin());

  // The volunteer list: everyone scheduled, a few who aren't right now, lanyards on some.
  let vols = null;
  let members = [];
  function volunteerData() {
    if (!vols) {
      const seen = new Map();
      for (const p of db.people) if (p.person_id && !seen.has(p.person_id)) seen.set(p.person_id, p.person_id === 'pp-me' ? myName() : p.name);
      const extra = ['Morgan Hale', 'Jesse Brandt', 'Avery Lin', 'Toby Grant', 'Nora Fields'];
      extra.forEach((n) => seen.set(`pp-${n.replace(/\W/g, '')}`, n));
      const list = [...seen].sort((a, b) => a[1].localeCompare(b[1]));
      vols = list.map(([pid, name], i) => ({
        id: `v-${pid}`, pco_person_id: pid, name, photo: null, home_campus_id: null,
        lanyard: i % 9 === 4 ? 'coach' : i % 3 === 0 ? 'volunteer' : null,
        lanyard_at: i % 3 === 0 || i % 9 === 4 ? new Date(Date.now() - (i + 2) * 864e5).toISOString() : null,
        lanyard_by: i % 3 === 0 || i % 9 === 4 ? 'p-tom' : null,
        tags: pid === 'pp-me' ? ['Staff'] : i === 2 ? ['Trainer'] : [], notes: i === 1 ? 'Prefers the 9:30. Learning lighting.' : null,
        last_seen_at: new Date().toISOString(), created_at: new Date(Date.now() - 30 * 864e5).toISOString(), updated_at: new Date().toISOString(), created_by: null, updated_by: null,
      }));
      vols.push({ id: 'v-manual-1', pco_person_id: null, name: 'Sam Rivera', photo: null, home_campus_id: 'c-FF', lanyard: 'volunteer', lanyard_at: new Date(Date.now() - 12 * 864e5).toISOString(), lanyard_by: 'p-bethany',
        tags: [], notes: 'Not in Planning Center yet.', last_seen_at: null, created_at: new Date(Date.now() - 20 * 864e5).toISOString(), updated_at: new Date().toISOString(), created_by: 'p-bethany', updated_by: 'p-bethany' });
      // Team members and the positions they can fill: who's scheduled on each team, plus the
      // unscheduled ones on Simpsonville FOH and Five Forks (one of them only runs audio).
      const m = new Map();
      const add = (team, person, pos) => { const k = `${team}|${person}`; if (!m.has(k)) m.set(k, new Set()); if (pos) m.get(k).add(pos); };
      for (const p of db.people) if (p.person_id) add(p.team_id, p.person_id, p.position);
      extra.forEach((n, i) => add(i < 3 ? 'st-svl-m-f' : 'st-ff-m-f', `pp-${n.replace(/\W/g, '')}`, i === 4 ? 'Audio' : i % 2 ? 'Lighting' : 'CG'));
      members = [...m].map(([k, set]) => { const [team_id, person_id] = k.split('|'); return { team_id, person_id, positions: [...set].sort() }; });
    }
    return { people: vols, members };
  }
  function lanyardFields(row, lanyard) {
    const v = ['volunteer', 'coach', 'staff'].includes(lanyard) ? lanyard : null;
    if (row && row.lanyard === v) return {};
    return { lanyard: v, lanyard_at: v ? new Date().toISOString() : null, lanyard_by: v ? me.id : null };
  }

  // Scheduling from the roster, like the server: who could fill a spot (with made-up
  // blockouts and that day's schedules), putting them on with the invite not sent, and
  // taking them back off.
  function scheduling(action, { picks = [], position, person_id, plan_person_id } = {}) {
    const hash = (str) => [...str].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const typeName = (planId) => db.types.find((t) => t.id === db.plans.find((p) => p.id === planId)?.service_type_id)?.name;
    if (action === 'unschedule') {
      const row = db.people.find((p) => p.id === plan_person_id);
      if (!row) throw new Error('They’re not on that service anymore.');
      if (!row.invite_pending) throw new Error('Their invite already went out. Take them off in Planning Center so they’re told.');
      db.people = db.people.filter((p) => p !== row);
      db.plans.find((p) => p.id === row.plan_id)?.needed.push({ team_id: row.team_id, position: row.position, quantity: 1 });
      changed('pco');
      return { removed: row.id };
    }
    const plans = picks.map((x) => db.plans.find((p) => p.id === x.plan_id)).filter(Boolean);
    if (!plans.length) throw new Error('Pick at least one service.');
    // Audio only on services that keep their audio op (the midweeks), like the server.
    const keepsAudio = (planId) => db.types.find((t) => t.id === db.plans.find((p) => p.id === planId)?.service_type_id)?.show_audio;
    if (/^\s*(audio|sound)\b/i.test(position || '') && !picks.every((x) => keepsAudio(x.plan_id))) throw new Error('Audio isn’t scheduled from here.');
    const { people: vlist, members: mem } = volunteerData();
    if (action === 'schedule') {
      const name = vlist.find((v) => v.pco_person_id === person_id)?.name || 'Someone';
      const scheduled = picks.map((x, n) => {
        const id = `pp-new-${Date.now()}-${n}`;
        db.people.push({ id, plan_id: x.plan_id, team_id: x.team_id, person_id, name, position, status: 'U', photo: null, invite_pending: true });
        const plan = db.plans.find((p) => p.id === x.plan_id);
        const k = plan.needed.findIndex((nd) => nd.team_id === x.team_id && nd.position === position);
        if (k >= 0) plan.needed.splice(k, 1);
        return { plan_id: x.plan_id, plan_person_id: id, name };
      });
      changed('pco');
      return { scheduled };
    }
    // candidates
    const day = plans[0].sort_date.slice(0, 10);
    const teamIds = new Set(picks.map((x) => x.team_id));
    const ids = new Set(mem.filter((x) => teamIds.has(x.team_id)).map((x) => x.person_id));
    const sameDay = db.plans.filter((p) => p.sort_date.slice(0, 10) === day).map((p) => p.id);
    const list = [...ids].map((pid) => {
      const v = vlist.find((x) => x.pco_person_id === pid);
      const positions = [...new Set(mem.filter((x) => x.person_id === pid).flatMap((x) => x.positions))].filter((x) => x === position || !/^\s*(audio|sound)\b/i.test(x)).sort();
      const hsh = hash(pid + day);
      const start = new Date(plans[0].sort_date);
      const blockouts = hsh % 7 === 0 ? [{ starts_at: new Date(start.getTime() - 12 * 36e5).toISOString(), ends_at: new Date(start.getTime() + 12 * 36e5).toISOString(), reason: hsh % 2 ? 'Out of town' : null, blocks: true }]
        : hsh % 11 === 0 ? [{ starts_at: new Date(start.getTime() + 8 * 36e5).toISOString(), ends_at: new Date(start.getTime() + 11 * 36e5).toISOString(), reason: 'Dinner', blocks: false }] : [];
      const schedules = db.people.filter((p) => p.person_id === pid && sameDay.includes(p.plan_id)).map((p) => ({
        plan_id: p.plan_id, plan_person_id: p.id, service: typeName(p.plan_id), team: db.teams.find((t) => t.id === p.team_id)?.name, position: p.position,
        status: p.status, decline_reason: p.status === 'D' ? 'Family thing' : null, sort_date: db.plans.find((x) => x.id === p.plan_id)?.sort_date, this_spot: picks.some((x) => x.plan_id === p.plan_id),
      }));
      return { person_id: pid, name: v?.name || (pid === 'pp-me' ? myName() : pid), photo: null, lanyard: v?.lanyard || null, positions, qualified: positions.includes(position),
        preference: hsh % 5 === 0 ? 'Once a month' : 'As often as needed', blockouts, schedules, unchecked: false };
    }).filter((x) => x.positions.length || !mem.some((y) => y.person_id === x.person_id && y.positions.length));
    list.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.name.localeCompare(b.name));
    return { position, days: [day], people: list };
  }

  function fakeSync(ms = 1600) {
    syncing = true;
    setTimeout(() => { syncing = false; lastSync = new Date().toISOString(); changed('pco'); }, ms);
  }

  return {
    async pcoStatus() {
      await wait(80);
      if (!connected) return null;
      return {
        connected: true, org_name: 'Upstate Church', time_zone: 'America/New_York',
        connected_as: null,
        connected_at: new Date(Date.now() - 3 * 864e5).toISOString(), weeks_ahead: 6,
        last_sync_at: lastSync, last_sync_error: null, people_note: null, syncing,
      };
    },
    async pcoData() {
      await wait(140);
      if (!connected) return { types: [], teams: [], plans: [], people: [] };
      const types = db.types.filter((t) => canSee(t.access));
      const ids = new Set(types.map((t) => t.id));
      const teams = db.teams.filter((t) => ids.has(t.service_type_id) && (t.shown || isAdmin()));
      const plans = db.plans.filter((p) => ids.has(p.service_type_id) && types.find((t) => t.id === p.service_type_id).access !== 'hidden');
      const planIds = new Set(plans.map((p) => p.id));
      const shown = new Set(db.teams.filter((t) => t.shown).map((t) => t.id));
      const people = db.people.filter((p) => planIds.has(p.plan_id) && shown.has(p.team_id))
        .map((p) => (p.person_id === 'pp-me' ? { ...p, name: myName() } : p));
      return clone({ types, teams, plans, people });
    },
    async pcoItems(planId) {
      await wait(120);
      const plan = db.plans.find((p) => p.id === planId);
      if (!plan) return [];
      if (plan.service_type_id === 'st-svl-e') return eventItems(planId);
      const it = (n, title, kind, position, length, extra = {}) => ({ id: `${planId}-i${n}`, plan_id: planId, sequence: n, title, kind, position, length, description: null, key_name: null, arrangement: null, notes: [], ...extra });
      return [
        it(1, 'Pre-Service', 'header', 'during', 0),
        it(2, 'Online Welcome Host', 'item', 'pre', 67),
        it(3, 'Campus Countdown Video', 'media', 'pre', 300, { notes: [{ category: 'Video', content: 'Roll at 5:00 to go' }] }),
        it(4, 'Worship', 'header', 'during', 0),
        it(5, 'Holy Spirit Welcome', 'song', 'during', 261, { key_name: 'E', description: 'Jordan', arrangement: 'I V1 C V2 C B C' }),
        it(6, 'Holy Forever', 'song', 'during', 315, { key_name: 'F', description: 'Jordan', notes: [{ category: 'Lighting', content: 'Blue wash through the bridge' }] }),
        it(7, 'Opening Host', 'header', 'during', 0),
        it(8, 'Welcome and announcements', 'item', 'during', 180, { description: '- Welcome to Upstate Church\n- Engage the online audience\n- Introduce yourself\nCONNECT - If this is your first time with us, text CONNECT to 85321.\nGIVE - Text GIVE to 85321 to give online.' }),
        it(9, 'Video', 'header', 'during', 0),
        it(10, 'Series Bumper', 'media', 'during', 40, { notes: [{ category: 'Audio', content: 'CG' }] }),
        it(11, 'Message', 'header', 'during', 0),
        it(12, 'Message', 'item', 'during', 2100, { description: 'Teaching pastor' }),
        it(13, 'Prayer', 'item', 'during', 30),
        it(14, 'Worship', 'header', 'during', 0),
        it(15, 'Living Hope', 'song', 'during', 278, { key_name: 'C', description: 'Jordan' }),
        it(16, 'Closing Comments / Prayer', 'item', 'during', 30),
        it(17, 'Post-Service', 'header', 'during', 0),
        it(18, 'Online Closing Host', 'item', 'post', 27),
      ];
    },
    /** Planning Center Live, made up: today's event is a few items in, each a little long or short. */
    async pcoLive(planId) {
      await wait(90);
      if (!['staff', 'admin'].includes(me.role)) throw new Error('Only staff can see Live.');
      const plan = db.plans.find((p) => p.id === planId);
      if (!plan) throw new Error('That service isn’t shared in the app.');
      const items = eventItems(planId);
      const svc = plan.times.find((x) => x.kind === 'service') || { starts_at: plan.sort_date };
      const pt = `${planId}-svc`;
      const start = Date.parse(svc.starts_at);
      const t = Date.now();
      const iso = (ms) => new Date(ms).toISOString();
      const run = items.filter((x) => x.kind !== 'header');
      const times = run.map((r) => ({ id: `${r.id}-t`, item_id: r.id, plan_time_id: pt, start: null, end: null, length: 0, exclude: false }));
      let current = null;
      let next = null;
      if (t >= start && t < start + 3 * 3600e3) {
        let at = start;
        for (let k = 0; k < run.length; k++) {
          const len = (run[k].length + [12, -8, 35, 0][k % 4]) * 1000;
          times[k].start = iso(at);
          if (t < at + len || k === run.length - 1) { current = times[k]; next = times[k + 1] || null; break; }
          times[k].end = iso(at + len);
          at += len;
        }
      } else if (t < start) next = { id: pt, item_id: null, plan_time_id: pt, start: null, end: null, length: 0, exclude: false };
      return clone({
        plan_id: planId, available: true, current_id: current?.id ?? null, next_id: next?.id ?? null, current, next,
        controller: current ? 'Jordan Pike' : null, note: null,
        items: items.map(({ plan_id: _p, arrangement: _a, ...x }) => x), item_times: times,
        plan_times: plan.times.map((x, i) => ({ id: x.kind === 'service' ? pt : `${planId}-t${i}`, name: x.name, kind: x.kind, starts_at: x.starts_at, ends_at: x.ends_at, live_starts_at: x.kind === 'service' && current ? x.starts_at : null, live_ends_at: null })),
        read_at: iso(t - 700), full_read_at: iso(t - 6000), now: iso(t),
      });
    },
    async pcoSetEvent(id, on) {
      await wait(120);
      if (!isAdmin()) throw new Error('Only an admin can choose which services are events.');
      db.types.find((t) => t.id === id).is_event = !!on;
      changed('pco');
    },
    async pco(action, payload = {}) {
      await wait(500);
      if (action === 'connect') {
        if (!payload.app_id || !payload.secret) throw new Error('Paste both the Application ID and the Secret.');
        if (payload.secret.length < 8) throw new Error('Planning Center didn’t accept that Application ID and secret. Check them and try again.');
        connected = true; db = build(me.id); fakeSync(2200);
        return { connected: true, org_name: 'Upstate Church', connected_as: null, syncing: true };
      }
      if (action === 'disconnect') { connected = false; changed('pco'); return { connected: false }; }
      if (action === 'sync') {
        if (!connected) throw new Error('Planning Center isn’t connected.');
        if (syncing) return { started: false, already: true };
        fakeSync(); return { started: true };
      }
      if (['candidates', 'schedule', 'unschedule'].includes(action)) {
        if (!['staff', 'admin'].includes(me.role)) throw new Error('Only staff can do that.');
        return clone(scheduling(action, payload));
      }
      throw new Error('Unknown action.');
    },
    async pcoSetAccess(id, access) {
      await wait(120);
      if (!isAdmin()) throw new Error('Only an admin can choose who sees services.');
      Object.assign(db.types.find((t) => t.id === id), { access, access_set: true });
      changed('pco');
    },
    async pcoSetRoster(id, on) {
      await wait(120);
      if (!isAdmin()) throw new Error('Only an admin can choose what’s on the roster.');
      db.types.find((t) => t.id === id).on_roster = !!on;
      changed('pco');
    },
    async pcoShowTeam(name, shown) {
      await wait(120);
      if (!isAdmin()) throw new Error('Only an admin can choose which teams show.');
      for (const t of db.teams) if (t.name.trim().toLowerCase() === name.trim().toLowerCase()) t.shown = shown;
      changed('pco');
    },
    async pcoSetWeeks() { await wait(120); },

    // Volunteers: everyone on the production teams, plus people added by hand.
    async volunteers() {
      await wait(120);
      if (!['staff', 'admin'].includes(me.role)) return { people: [], members: [] };
      return clone(volunteerData());
    },
    async saveVolunteer(v) {
      await wait(160);
      const row = vols.find((x) => x.id === v.id);
      const name = 'name' in v ? String(v.name || '').trim() : row?.name;
      if (!name) throw new Error('Give them a name.');
      const fields = { name };
      if ('home_campus_id' in v) fields.home_campus_id = v.home_campus_id || null;
      if ('notes' in v) fields.notes = String(v.notes || '').trim() || null;
      if ('tags' in v) fields.tags = [...new Set((v.tags || []).map((t) => String(t).trim()).filter(Boolean))].sort();
      if ('lanyard' in v) Object.assign(fields, lanyardFields(row, v.lanyard));
      const stamp = { updated_at: new Date().toISOString(), updated_by: me.id };
      if (row) { Object.assign(row, fields, stamp); changed('volunteers'); return row.id; }
      const made = { id: 'v-' + Math.random().toString(36).slice(2), pco_person_id: null, photo: null, home_campus_id: null, lanyard: null, lanyard_at: null, lanyard_by: null,
        tags: [], notes: null, last_seen_at: null, created_at: stamp.updated_at, created_by: me.id, ...fields, ...stamp };
      vols.push(made);
      changed('volunteers');
      return made.id;
    },
    async setLanyard(id, lanyard) {
      await wait(90);
      const row = vols.find((x) => x.id === id);
      if (!row) throw new Error('That person was removed by someone else.');
      Object.assign(row, lanyardFields(row, lanyard), { updated_at: new Date().toISOString(), updated_by: me.id });
      changed('volunteers');
      return clone(row);
    },
    async deleteVolunteer(id) {
      await wait(120);
      const row = vols.find((x) => x.id === id);
      if (row?.pco_person_id) throw new Error('People from Planning Center can’t be removed here.');
      vols = vols.filter((x) => x.id !== id);
      changed('volunteers');
    },
    async pcoSetCampus(id, campusId) {
      await wait(120);
      Object.assign(db.types.find((t) => t.id === id), { campus_id: campusId, campus_set: true });
      changed('pco');
    },
  };
}
