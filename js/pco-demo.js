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
  let n = 0;
  const name = () => NAMES[(n++ * 7) % NAMES.length];
  const today = new Date();
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const daysToSunday = (7 - base.getUTCDay()) % 7 || 7;

  SERVICES.forEach(([id, title, path, campus, access, times, call], i) => {
    types.push({ id, name: title, path, campus_id: campus, campus_set: false, access, access_set: false, sequence: i, teams_synced_at: new Date().toISOString() });
    const tb = { id: `${id}-b`, service_type_id: id, name: 'Broadcast', shown: true, sequence: 1, positions: BROADCAST.map((p, k) => ({ id: `${id}-b${k}`, name: p, sequence: k })) };
    const tf = { id: `${id}-f`, service_type_id: id, name: 'FOH', shown: true, sequence: 2, positions: FOH.map((p, k) => ({ id: `${id}-f${k}`, name: p, sequence: k })) };
    const tw = { id: `${id}-w`, service_type_id: id, name: 'Worship Team', shown: false, sequence: 3, positions: [] };
    const tu = { id: `${id}-u`, service_type_id: id, name: 'Ushers', shown: false, sequence: 4, positions: [] };
    teams.push(tb, tf, tw, tu);
    if (id === 'st-hb-k' || id === 'st-ya') return;
    for (let w = 0; w < 4; w++) {
      const isWed = id === 'st-svl-r';
      const day = new Date(base.getTime() + (daysToSunday + w * 7 - (isWed ? 4 : 0)) * 864e5);
      if (id === 'st-svl-x' && w > 0) continue;
      const pid = `${id}-p${w}`;
      const serviceTimes = times.map((t) => ({ name: null, kind: 'service', starts_at: eastern(day, t), ends_at: null }));
      plans.push({
        id: pid, service_type_id: id, title: title.split(' - ')[1] || null, series_title: w < 2 ? 'Better Together' : null,
        dates: day.toISOString().slice(0, 10), sort_date: serviceTimes[0].starts_at,
        times: [{ name: 'Call and Rehearsal', kind: 'rehearsal', starts_at: eastern(day, call), ends_at: null }, ...serviceTimes],
        url: '#', needed: [], synced_at: new Date().toISOString(),
      });
      const plan = plans[plans.length - 1];
      const fill = (team, roles, gaps) => roles.forEach((pos, k) => {
        if (gaps.includes(k)) { plan.needed.push({ team_id: team.id, position: pos, quantity: 1 }); return; }
        const roll = (k * 3 + w * 5 + i) % 9;
        const mine = meId && id === 'st-svl-m' && team === tb && pos === 'Director' && w < 3;
        people.push({
          id: `${pid}-${team.id}-${k}`, plan_id: pid, team_id: team.id, person_id: mine ? 'pp-me' : `pp-${n}`,
          name: mine ? null : name(), position: pos, status: mine ? (w === 2 ? 'U' : 'C') : roll === 0 ? 'D' : roll < 3 ? 'U' : 'C', photo: null,
        });
      });
      fill(tb, BROADCAST, w === 0 ? [5] : w === 1 ? [3, 6] : [2, 4, 5, 6]);
      fill(tf, FOH, w >= 2 ? [1] : []);
    }
  });
  return { types, teams, plans, people };
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
        connected_as: ['staff', 'admin'].includes(me.role) ? 'Production Office' : null,
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
    async pco(action, payload = {}) {
      await wait(500);
      if (action === 'connect') {
        if (!payload.app_id || !payload.secret) throw new Error('Paste both the Application ID and the Secret.');
        if (payload.secret.length < 8) throw new Error('Planning Center didn’t accept that Application ID and secret. Check them and try again.');
        connected = true; db = build(me.id); fakeSync(2200);
        return { connected: true, org_name: 'Upstate Church', connected_as: 'Production Office', syncing: true };
      }
      if (action === 'disconnect') { connected = false; changed('pco'); return { connected: false }; }
      if (action === 'sync') {
        if (!connected) throw new Error('Planning Center isn’t connected.');
        if (syncing) return { started: false, already: true };
        fakeSync(); return { started: true };
      }
      throw new Error('Unknown action.');
    },
    async pcoSetAccess(id, access) {
      await wait(120);
      if (!isAdmin()) throw new Error('Only an admin can choose who sees services.');
      Object.assign(db.types.find((t) => t.id === id), { access, access_set: true });
      changed('pco');
    },
    async pcoShowTeam(name, shown) {
      await wait(120);
      if (!isAdmin()) throw new Error('Only an admin can choose which teams show.');
      for (const t of db.teams) if (t.name.trim().toLowerCase() === name.trim().toLowerCase()) t.shown = shown;
      changed('pco');
    },
    async pcoSetWeeks() { await wait(120); },
    async pcoSetCampus(id, campusId) {
      await wait(120);
      Object.assign(db.types.find((t) => t.id === id), { campus_id: campusId, campus_set: true });
      changed('pco');
    },
  };
}
