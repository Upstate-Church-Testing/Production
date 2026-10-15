// Preview store: the same methods as the live store, kept in memory with
// example data. Used when no Supabase project is configured.

import { createPcoDemo } from './pco-demo.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2));
const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const now = () => new Date().toISOString();
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

const DEPARTMENTS = [
  { slug: 'audio', name: 'Audio', color: '#4DA3FF', sort_order: 1 },
  { slug: 'video', name: 'Video', color: '#A78BFA', sort_order: 2 },
  { slug: 'lighting', name: 'Lighting', color: '#F5B544', sort_order: 3 },
  { slug: 'network', name: 'Network', color: '#2DD4BF', sort_order: 4 },
];

const CAMPUSES = [
  ['Anderson Campus', 'Anderson', 'AND'], ['Five Forks Campus', 'Five Forks', 'FF'],
  ['Fountain Inn Campus', 'Fountain Inn', 'FI'], ['Greenville Campus', 'Greenville', 'GVL'],
  ['Greenville Convention Center (GCC) Campus', 'GCC', 'GCC'], ['Harrison Bridge Campus', 'Harrison Bridge', 'HB'],
  ['Laurens Campus', 'Laurens', 'LAU'], ['Mauldin Campus', 'Mauldin', 'MAU'],
  ['Simpsonville Campus', 'Simpsonville', 'SVL'], ['Union Gathering', 'Union', 'UN'],
].map(([name, short_name, code], i) => ({ id: 'c-' + code, name, short_name, code, sort_order: i + 1, is_active: true }));

const PEOPLE = [
  { id: 'p-me', email: 'you@upstatechurch.org', full_name: 'Demo Admin', role: 'admin', departments: ['video'] },
  { id: 'p-tom', email: 'tom@example.org', full_name: 'Tom', role: 'staff', departments: ['audio', 'video', 'lighting'] },
  { id: 'p-bethany', email: 'bethany@example.org', full_name: 'Bethany', role: 'staff', departments: ['lighting'] },
  { id: 'p-chris', email: 'chris@example.org', full_name: 'Chris Orozco', role: 'staff', departments: ['video'] },
  { id: 'p-will', email: 'will@example.org', full_name: 'Will', role: 'pending', departments: [] },
].map((p) => ({ ...p, home_campus_id: null, created_at: ago(60 * 24 * 3) }));

// [campus, room, network, name, tags, category, model, location, ip, extra]
function buildExample() {
  const rooms = [], networks = [], devices = [], ips = [], creds = [], activity = [], types = [], typePorts = [], devPorts = [];
  const nums = (prefix, n, o) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i + 1}`, ...o }));
  // Example port layouts and specs, keyed by type name.
  const PORTS = {
    'Net-X II': [...nums('DMX ', 8, { signal: 'DMX', connector: 'XLR5', direction: 'out' }), { name: 'Ethernet', signal: 'Art-Net / sACN', connector: 'etherCON' }],
    'Hoglet 4': [...nums('DMX ', 4, { signal: 'DMX', connector: 'XLR5', direction: 'out' }), { name: 'Ethernet', signal: 'Ethernet', connector: 'RJ45' }, { name: 'USB to PC', signal: 'USB', connector: 'USB-A' }],
    'SG350-10': nums('Port ', 10, { signal: 'Ethernet', connector: 'RJ45' }),
    'KY-PZ100': [{ name: 'SDI Out', signal: 'SDI', connector: 'BNC', direction: 'out' }, { name: 'HDMI Out', signal: 'HDMI', connector: 'HDMI', direction: 'out' }, { name: 'LAN', signal: 'Ethernet', connector: 'RJ45' }],
    'Rio3224-D2': [{ name: 'Dante Primary', signal: 'Dante', connector: 'etherCON' }, { name: 'Dante Secondary', signal: 'Dante', connector: 'etherCON' }],
    'Pathport 8-port rack mount': [...nums('DMX ', 8, { signal: 'DMX', connector: 'XLR5', direction: 'out' }), { name: 'Ethernet', signal: 'Art-Net / sACN', connector: 'RJ45' }],
  };
  const SPECS = {
    'Hoglet 4': { description: 'Compact Hog 4 console wing; runs with a Hog 4 PC.', specs: [{ label: 'DMX outputs', value: '4 universes' }, { label: 'Network', value: 'HogNet, Art-Net, sACN' }] },
    'Net-X II': { description: 'Ethernet-to-DMX gateway.', specs: [{ label: 'DMX ports', value: '8' }, { label: 'Protocols', value: 'Art-Net, sACN' }] },
    'KY-PZ100': { specs: [{ label: 'Zoom', value: '30x optical' }, { label: 'Outputs', value: '3G-SDI, HDMI, IP stream' }] },
  };
  const typeFor = (d) => {
    const name = d.model || d.category || d.name;
    const key = `${d.manufacturer || ''}|${name}`;
    let t = types.find((x) => x.key === key);
    if (!t) {
      t = { id: uid(), key, name, manufacturer: d.manufacturer || null, part_number: null, category: d.category || null,
        departments: [...d.departments], description: SPECS[name]?.description || null, specs: SPECS[name]?.specs || [],
        manual_url: null, notes: null, photo_path: null, networked: d.networked !== false, created_at: ago(60 * 24 * 3), updated_at: ago(60 * 24 * 3), created_by: 'p-me', updated_by: 'p-me' };
      types.push(t);
      (PORTS[name] || []).forEach((p, i) => typePorts.push({ id: uid(), type_id: t.id, connector: null, direction: 'io', notes: null, sort_order: i, ...p }));
    }
    return t.id;
  };
  const patch = (deviceId, portName, connected_to, assignment = null) => {
    const d = devices.find((x) => x.id === deviceId);
    const port = typePorts.find((p) => p.type_id === d.type_id && p.name === portName);
    devPorts.push({ id: uid(), device_id: deviceId, type_port_id: port.id, connected_to, assignment, notes: null });
  };
  const room = (code, name) => {
    let r = rooms.find((x) => x.campus_id === 'c-' + code && x.name === name);
    if (!r) rooms.push((r = { id: uid(), campus_id: 'c-' + code, name, sort_order: rooms.length }));
    return r.id;
  };
  const net = (code, key, o) => {
    const n = { id: 'n-' + code + '-' + key, campus_id: 'c-' + code, purpose: null, vlan_id: null, gateway: null,
      departments: [], is_isolated: false, notes: null, sort_order: networks.length, ...o };
    networks.push(n);
  };
  const dev = (code, roomName, d, addr = []) => {
    const id = uid();
    const { manufacturer, model, category, networked, ...rest } = d;
    devices.push({ id, type_id: typeFor(d), campus_id: 'c-' + code, room_id: roomName ? room(code, roomName) : null,
      serial_number: null, firmware: null, location: null, status: 'active',
      notes: null, created_at: ago(60 * 24 * 2), updated_at: ago(60 * 24 * 2), created_by: 'p-me', updated_by: 'p-me', ...rest });
    addr.forEach((a, i) => ips.push({ id: uid(), device_id: id, campus_id: 'c-' + code, network_id: a.net ? 'n-' + code + '-' + a.net : null,
      label: a.label || null, ip: a.ip || null, gateway: a.gw || null, mac: a.mac || null, hostname: null,
      mode: a.mode || 'static', notes: null, sort_order: i }));
    return id;
  };

  // Simpsonville
  net('SVL', 'ctl', { name: 'Production Control', purpose: 'Switchers, cameras, projectors, lighting control', subnet: '10.50.10.0/24', gateway: '10.50.10.101', departments: ['video', 'lighting'] });
  net('SVL', 'dante', { name: 'Dante Primary', purpose: 'Audio network', subnet: '192.168.50.0/24', departments: ['audio'], is_isolated: true });
  net('SVL', 'house', { name: 'House Network', purpose: 'Church LAN, internet access', subnet: '10.60.20.0/24', gateway: '10.60.20.1', vlan_id: 203, departments: ['video'] });
  const W = 'Worship Center';
  const sw = dev('SVL', W, { name: 'FOH Switch', departments: ['network'], category: 'Switch', manufacturer: 'Cisco', model: 'SG350-10', location: 'FOH Rack' }, [{ net: 'ctl', ip: '10.50.10.102/24', label: 'Management' }]);
  creds.push({ id: uid(), device_id: sw, label: 'Web UI', username: 'admin', password: 'example-only', notes: null, sort_order: 0 });
  dev('SVL', W, { name: 'A-Control Switch', departments: ['network'], category: 'Switch', manufacturer: 'Cisco', model: 'SF300-24PP (PoE+)', location: 'A-Control Rack' }, [{ net: 'ctl', ip: '10.50.10.103/24', label: 'Management' }]);
  dev('SVL', W, { name: 'Stage Switch', departments: ['network'], category: 'Switch', manufacturer: 'Cisco', model: 'SG300-10', location: 'Stage Rack' }, [{ net: 'ctl', ip: '10.50.10.104/24', label: 'Management' }]);
  const ma = dev('SVL', W, { name: 'Lighting Console', departments: ['lighting'], category: 'Console', manufacturer: 'MA Lighting', model: 'grandMA3 compact XT', location: 'FOH', firmware: '2.3.1.1' }, [{ net: 'ctl', ip: '10.50.10.105/24' }]);
  const stageGw = dev('SVL', W, { name: 'Stage Gateway', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Chauvet', model: 'Net-X II', location: 'Stage Rack', firmware: 'B1.0 V3.4' }, [{ net: 'ctl', ip: '10.50.10.106/24', label: 'Art-Net / sACN' }]);
  const cat = dev('SVL', W, { name: 'Catwalk Gateway', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Chauvet', model: 'Net-X II', location: 'Catwalk', firmware: 'B1.0 V3.7' }, [{ net: 'ctl', ip: '10.50.10.107/24', label: 'Art-Net / sACN' }]);
  dev('SVL', W, { name: 'MA3 Node 1', departments: ['lighting'], category: 'Node / Gateway', model: 'grandMA3 node', location: 'Stage Rack', firmware: '2.1.1.2', notes: 'Old sheet lists this at .106 too. Check which one is live.' }, [{ net: 'ctl', ip: '10.50.10.106/24' }]);
  dev('SVL', W, { name: 'Truss Gateway', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Chauvet', model: 'Net-X II', location: 'Truss' });
  dev('SVL', W, { name: 'SL Projector', departments: ['video'], category: 'Projector', manufacturer: 'Panasonic', model: 'PT-RZ990 WUXGA', location: 'Projector Room' }, [{ net: 'ctl', ip: '10.50.10.121/24', gw: '10.50.10.101' }]);
  dev('SVL', W, { name: 'SR Projector', departments: ['video'], category: 'Projector', manufacturer: 'Panasonic', model: 'PT-RZ990 WUXGA', location: 'Projector Room' }, [{ net: 'ctl', ip: '10.50.10.123/24', gw: '10.50.10.101' }]);
  dev('SVL', W, { name: 'PTZ Controller 1', departments: ['video'], category: 'PTZ Controller', manufacturer: 'JVC', model: 'RM-LP100', location: 'A-Control Desk' }, [{ net: 'ctl', ip: '10.50.10.135/24', gw: '10.50.10.101' }]);
  dev('SVL', W, { name: 'PTZ Controller 2', departments: ['video'], category: 'PTZ Controller', manufacturer: 'JVC', model: 'RM-LP100', location: 'A-Control Desk' }, [{ net: 'ctl', ip: '10.50.10.136/24', gw: '10.50.10.101' }]);
  for (let c = 2; c <= 6; c++) {
    const id = dev('SVL', W, { name: `Camera ${c}`, departments: ['video'], category: 'Camera', manufacturer: 'JVC', model: 'KY-PZ100', location: c <= 3 ? 'Balcony' : 'Stage' }, [{ net: 'ctl', ip: `10.50.10.${135 + c}/24`, gw: '10.50.10.101' }]);
    if (c === 2) creds.push({ id: uid(), device_id: id, label: 'Web UI', username: 'jvc', password: 'example-only', notes: null, sort_order: 0 });
  }
  dev('SVL', W, { name: 'LED Processor', departments: ['video'], category: 'LED Processor', manufacturer: 'NovaStar', model: 'MX30', location: 'Stage Rack' }, [{ net: 'ctl', ip: '10.50.10.191/24', gw: '10.50.10.101' }]);
  dev('SVL', W, { name: 'Videohub 40x40', departments: ['video'], category: 'Router', manufacturer: 'Blackmagic', model: 'Videohub 40x40 12G', location: 'A-Control Rack' }, [{ net: 'ctl', ip: '10.50.10.201/24', gw: '10.50.10.101' }]);
  dev('SVL', W, { name: 'Switcher', departments: ['video'], category: 'Switcher', manufacturer: 'Blackmagic', model: 'ATEM 2 M/E Production Studio 4K', location: 'A-Control Rack' }, [{ net: 'ctl', ip: '10.50.10.202/24' }]);
  dev('SVL', W, { name: 'Switcher Panel', departments: ['video'], category: 'Control Panel', manufacturer: 'Blackmagic', location: 'A-Control Desk' }, [{ net: 'ctl', ip: '10.50.10.205/24', gw: '10.50.10.101' }]);
  dev('SVL', W, { name: 'Director’s Mac', departments: ['video'], category: 'Computer', manufacturer: 'Apple', model: 'Mac mini', location: 'A-Control Desk' }, [{ net: 'ctl', ip: '10.50.10.217/24', gw: '10.50.10.101' }]);
  dev('SVL', W, { name: 'CG1', departments: ['video'], category: 'Computer', manufacturer: 'Apple', model: 'Mac mini', location: 'FOH Desk', notes: 'ProPresenter' },
    [{ net: 'ctl', ip: '10.50.10.234/24', gw: '10.50.10.101', label: 'Production' }, { net: 'house', ip: '10.60.20.79/24', label: 'House', mode: 'dhcp' }]);
  dev('SVL', W, { name: 'FOH Console', departments: ['audio'], category: 'Console', manufacturer: 'Yamaha', model: 'QL5', location: 'FOH' }, [{ net: 'dante', ip: '192.168.50.35/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Stage Box', departments: ['audio'], category: 'Stagebox', manufacturer: 'Yamaha', model: 'Rio3224-D2', location: 'Amp Room' }, [{ net: 'dante', ip: '192.168.50.32/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Wireless Rx 1–4', departments: ['audio'], category: 'Wireless Receiver', manufacturer: 'Shure', model: 'ULXD4Q', location: 'FOH Rack' }, [{ net: 'dante', ip: '192.168.50.37/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Main L Amp', departments: ['audio'], category: 'Amplifier', location: 'Amp Room' }, [{ net: 'dante', ip: '192.168.50.20/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Main R Amp', departments: ['audio'], category: 'Amplifier', location: 'Amp Room' }, [{ net: 'dante', ip: '192.168.50.21/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Sub Amp', departments: ['audio'], category: 'Amplifier', location: 'Amp Room' }, [{ net: 'dante', ip: '192.168.50.22/24', label: 'Dante Primary' }]);
  for (let i = 1; i <= 6; i++) dev('SVL', W, { name: `R2X Wash ${i}`, departments: ['lighting'], category: 'Fixture', manufacturer: 'Chauvet', model: 'Rogue R2X Wash', networked: false, location: i <= 3 ? 'Upstage truss' : 'Midstage truss' });
  dev('SVL', 'North Auditorium', { name: 'DMX Node', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Chauvet', model: 'DMX-AN2', location: 'Stage Right' }, [{ ip: '10.50.10.120/24', gw: '2.0.0.1' }]);
  dev('SVL', 'North Auditorium', { name: 'EPIX Drive', departments: ['lighting'], category: 'LED Driver', manufacturer: 'Chauvet', model: 'EPIX Drive 2000 IP', location: 'Stage Right' });

  // Harrison Bridge
  net('HB', 'lx', { name: 'Lighting', purpose: 'Console, Pathports, wall stations', subnet: '10.50.0.0/16', gateway: '10.50.1.1', departments: ['lighting'], is_isolated: true });
  net('HB', 'prod', { name: 'Production', subnet: '10.80.8.0/24', vlan_id: 203, departments: ['video', 'audio'] });
  dev('HB', W, { name: 'Stage Switch', departments: ['lighting'], category: 'Switch', manufacturer: 'Cisco', model: 'SF300-24PP (PoE+)', location: 'Stage Rack' }, [{ net: 'lx', ip: '10.50.1.1/16' }]);
  dev('HB', W, { name: 'Lighting PC', departments: ['lighting'], category: 'Console', manufacturer: 'High End Systems', model: 'Hoglet 4', location: 'FOH', firmware: '3.20.0' }, [{ net: 'lx', ip: '10.50.100.101/16', gw: '10.50.1.1' }]);
  dev('HB', W, { name: 'Pathport 8-Port #1', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Pathway', model: 'Pathport 8-port rack mount', location: 'Stage Rack', firmware: '6.3.1' }, [{ net: 'lx', ip: '10.50.50.101/16', gw: '10.50.1.1' }]);
  dev('HB', W, { name: 'Pathport 8-Port #2', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Pathway', model: 'Pathport 8-port rack mount', location: 'Stage Rack', firmware: '6.3.1' }, [{ net: 'lx', ip: '10.50.50.102/16', gw: '10.50.1.1' }]);
  dev('HB', W, { name: 'HL Button Station', departments: ['lighting'], category: 'Wall Station', manufacturer: 'Pathway', model: 'Vignette PoE Wall Station', location: 'House Left', firmware: '6.2.0' }, [{ net: 'lx', ip: '10.50.10.101/16', gw: '10.50.1.1' }]);
  dev('HB', W, { name: 'HR Button Station', departments: ['lighting'], category: 'Wall Station', manufacturer: 'Pathway', model: 'Vignette PoE Wall Station', location: 'House Right', firmware: '6.2.0' }, [{ net: 'lx', ip: '10.50.10.102/16', gw: '10.50.1.1' }]);

  // Five Forks
  net('FF', 'lx', { name: 'Lighting', subnet: '10.50.0.0/16', gateway: '10.50.0.1', departments: ['lighting'], is_isolated: true });
  dev('FF', W, { name: 'Stage Switch', departments: ['lighting'], category: 'Switch', manufacturer: 'Cisco', model: 'SF300-24PP (PoE+)', location: 'Rack' });
  dev('FF', W, { name: 'Pathport Octo', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Pathway', model: 'Pathport Octo', location: 'Rack', firmware: '4.0.5' }, [{ net: 'lx', ip: '10.50.49.1/16', gw: '10.50.0.1' }]);
  dev('FF', W, { name: 'Lighting PC', departments: ['lighting'], category: 'Console', manufacturer: 'High End Systems', model: 'Hoglet 4', location: 'FOH', firmware: '4.1.0' }, [{ net: 'lx', ip: '10.50.50.3/16' }]);
  dev('FF', W, { name: 'HR Button Station', departments: ['lighting'], category: 'Wall Station', manufacturer: 'Pathway', model: 'Vignette PoE Wall Station', location: 'HR Wall', firmware: '4.0.3', notes: 'Mask is 255.0.0.0 on the unit. Probably should be /16 like the rest.' }, [{ net: 'lx', ip: '10.50.10.101/8', gw: '10.0.0.1' }]);

  // Anderson
  net('AND', 'video', { name: 'Video', subnet: '10.90.60.0/24', vlan_id: 60, departments: ['video'] });
  net('AND', 'prod', { name: 'Production', subnet: '10.90.8.0/24', vlan_id: 203, departments: ['audio', 'video'] });
  dev('AND', W, { name: 'SmartView 4K', departments: ['video'], category: 'Monitor', manufacturer: 'Blackmagic', model: 'SmartView 4K', location: 'Booth' }, [{ net: 'video', ip: '10.90.60.8/24' }]);
  dev('AND', W, { name: 'SmartView Duo', departments: ['video'], category: 'Monitor', manufacturer: 'Blackmagic', model: 'SmartView Duo', location: 'Booth' }, [{ net: 'video', ip: '10.90.60.9/24' }]);
  dev('AND', W, { name: 'ATEM Control', departments: ['video'], category: 'Switcher', manufacturer: 'Blackmagic', location: 'Booth' }, [{ net: 'video', ip: '10.90.60.100/24' }]);
  dev('AND', W, { name: 'Sound Board', departments: ['audio'], category: 'Console', manufacturer: 'Yamaha', location: 'FOH' }, [{ net: 'prod', ip: '10.90.8.250/24' }]);
  dev('AND', W, { name: 'Lighting Console', departments: ['lighting'], category: 'Console', manufacturer: 'High End Systems', model: 'Hoglet 4', location: 'FOH', firmware: '4.2.0' });

  // A little history so the device screen shows how it works.
  activity.push(
    { id: 1, at: ago(26), actor_id: 'p-bethany', action: 'updated', entity: 'devices', entity_id: cat, device_id: cat, campus_id: 'c-SVL', label: 'Catwalk Gateway', changes: { firmware: ['B1.0 V3.4', 'B1.0 V3.7'] } },
    { id: 2, at: ago(60 * 5), actor_id: 'p-tom', action: 'updated', entity: 'devices', entity_id: ma, device_id: ma, campus_id: 'c-SVL', label: 'Lighting Console', changes: { model: ['HES HedgeHog 4X', 'grandMA3 compact XT'] } },
  );

  patch(stageGw, 'DMX 1', 'Stage left floor', 'Universe 5');
  patch(stageGw, 'DMX 2', 'Upstage truss', 'Universe 3');
  patch(stageGw, 'DMX 3', 'Midstage truss', 'Universe 4');
  patch(stageGw, 'Ethernet', 'Stage Switch port 4', 'sACN');
  patch(cat, 'DMX 1', 'FOH batten', 'Universe 1');
  patch(cat, 'DMX 2', 'Catwalk positions', 'Universe 2');
  types.forEach((t) => delete t.key);

  return { rooms, networks, devices, ips, creds, activity, types, typePorts, devPorts };
}

// Example Resi players. The preview makes up what each one is showing.
const STREAMS = [
  ['SVL', 'Online', 'live', 'Wednesday Night Worship', 38],
  ['GVL', 'Online', 'live', 'Wednesday Night Worship', 41],
  ['FF', 'Online', 'replay', 'Sunday 11:00 Service', null, 4380],
  ['HB', 'Online', 'offline'],
  ['AND', 'Online', 'offline'],
  ['MAU', 'Online', 'offline'],
  ['GCC', 'Online', 'missing'],
].map(([code, name, state, title, mins, dur], i) => ({
  stream: { id: 's-' + code, campus_id: 'c-' + code, name, provider: 'resi', embed_id: `0000000${i}-0000-4000-8000-00000000000${i}`, embed_type: 'webchannel', sort_order: 0, created_at: ago(60 * 24) },
  status: { state, title: title || '', startedAt: mins ? new Date(Date.now() - mins * 60000) : null, duration: dur || null },
}));

export function createDemoStore() {
  let db = buildExample();
  let streams = STREAMS.map((x) => x.stream);
  const demoStatus = new Map(STREAMS.map((x) => [x.stream.embed_id, x.status]));
  const photos = new Map(); // demo photo path -> object URLs
  let me = clone(PEOPLE[0]);
  let people = clone(PEOPLE);
  let signedIn = true;
  const listeners = new Set();
  const authListeners = new Set();
  const changed = (table) => setTimeout(() => listeners.forEach((cb) => cb(table)), 30);
  const depOrder = (tags) => DEPARTMENTS.map((d) => d.slug).filter((s) => tags.includes(s));

  function log(action, entity, row, changes = {}) {
    const device_id = entity === 'devices' ? row.id : row.device_id ?? null;
    const dev = db.devices.find((d) => d.id === device_id);
    db.activity.unshift({ id: Date.now() + Math.random(), at: now(), actor_id: me.id, action, entity, entity_id: row.id,
      device_id, campus_id: row.campus_id ?? dev?.campus_id ?? null,
      label: entity === 'device_ips' ? (row.ip ? row.ip.split('/')[0] : row.label || 'IP') : entity === 'device_credentials' ? row.label || 'Login' : row.name,
      changes });
  }
  function diff(a, b, keys) {
    const out = {};
    for (const k of keys) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) out[k] = k === 'password' ? ['hidden', 'hidden'] : [a[k] ?? null, b[k] ?? null];
    return out;
  }
  const blank = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

  const pco = createPcoDemo({ wait, clone, me, changed });

  return {
    mode: 'demo',
    ...pco,

    async session() { return signedIn ? { user: { id: me.id, email: me.email } } : null; },
    onAuth(cb) { authListeners.add(cb); return () => authListeners.delete(cb); },
    async signIn() { await wait(300); signedIn = true; authListeners.forEach((cb) => cb('SIGNED_IN', {})); },
    async signUp() { await wait(300); signedIn = true; authListeners.forEach((cb) => cb('SIGNED_IN', {})); return { needsConfirm: false }; },
    async sendReset() { await wait(300); },
    async setPassword() { await wait(300); },
    async signOut() { signedIn = false; authListeners.forEach((cb) => cb('SIGNED_OUT', null)); },

    async me() { await wait(); return clone(me); },
    async updateMe(id, patch) {
      await wait(); Object.assign(me, patch); Object.assign(people.find((p) => p.id === id), patch);
    },

    async reference() { await wait(); return { campuses: clone(CAMPUSES), departments: clone(DEPARTMENTS) }; },

    async networkData() {
      await wait(160);
      return clone({ rooms: db.rooms, networks: db.networks, devices: db.devices, ips: db.ips,
        types: db.types.map((t) => ({ ...t, ports: db.typePorts.filter((p) => p.type_id === t.id) })) });
    },

    async saveDevice(payload) {
      await wait(220);
      const d = payload.device;
      const type = db.types.find((t) => t.id === d.type_id);
      if (!type) throw new Error('Pick a model for this item.');
      let tags = depOrder((d.departments || []).map((x) => x.toLowerCase()));
      if (!tags.length) tags = [...type.departments];
      const fields = { type_id: type.id, campus_id: d.campus_id, room_id: d.room_id || null, name: blank(d.name) || type.name, departments: tags,
        serial_number: blank(d.serial_number), firmware: blank(d.firmware), location: blank(d.location), status: d.status || 'active', notes: blank(d.notes) };
      let dev = d.id ? db.devices.find((x) => x.id === d.id) : null;
      if (d.id && !dev) throw new Error('That item was deleted by someone else.');
      if (dev && dev.type_id !== type.id) {
        const keepPorts = new Set(db.typePorts.filter((p) => p.type_id === type.id).map((p) => p.id));
        db.devPorts = db.devPorts.filter((x) => x.device_id !== dev.id || keepPorts.has(x.type_port_id));
      }
      if (dev) {
        const ch = diff(dev, fields, Object.keys(fields));
        Object.assign(dev, fields, { updated_at: now(), updated_by: me.id });
        if (Object.keys(ch).length) log('updated', 'devices', dev, ch);
      } else {
        dev = { id: uid(), ...fields, created_at: now(), updated_at: now(), created_by: me.id, updated_by: me.id };
        db.devices.push(dev);
        log('created', 'devices', dev, { name: dev.name });
      }
      const sync = (table, rows, keys, extra) => {
        const keep = new Set();
        rows.forEach((r, i) => {
          const clean = { ...Object.fromEntries(keys.map((k) => [k, k === 'username' || k === 'password' ? (r[k] || null) : blank(r[k])])), ...extra(r), sort_order: i };
          let cur = r.id ? db[table].find((x) => x.id === r.id && x.device_id === dev.id) : null;
          if (cur) {
            const ch = diff(cur, clean, keys);
            Object.assign(cur, clean);
            if (Object.keys(ch).length) log('updated', table === 'ips' ? 'device_ips' : 'device_credentials', cur, ch);
          } else {
            cur = { id: uid(), device_id: dev.id, ...clean };
            db[table].push(cur);
            log('created', table === 'ips' ? 'device_ips' : 'device_credentials', cur, table === 'ips' ? { ip: cur.ip } : { label: cur.label });
          }
          keep.add(cur.id);
        });
        db[table] = db[table].filter((x) => {
          if (x.device_id !== dev.id || keep.has(x.id)) return true;
          log('deleted', table === 'ips' ? 'device_ips' : 'device_credentials', x, {});
          return false;
        });
      };
      sync('ips', payload.ips || [], ['label', 'ip', 'gateway', 'mac', 'hostname', 'notes', 'network_id'],
        (r) => ({ campus_id: dev.campus_id, mode: r.mode || 'static', network_id: r.network_id || null }));
      if ('credentials' in payload) sync('creds', payload.credentials || [], ['label', 'username', 'password', 'notes'], () => ({}));
      if ('ports' in payload) {
        for (const pp of payload.ports || []) {
          const vals = { connected_to: blank(pp.connected_to), assignment: blank(pp.assignment), notes: blank(pp.notes) };
          const cur = db.devPorts.find((x) => x.device_id === dev.id && x.type_port_id === pp.type_port_id);
          const portName = db.typePorts.find((p) => p.id === pp.type_port_id)?.name || 'Port';
          if (!vals.connected_to && !vals.assignment && !vals.notes) {
            if (cur) { db.devPorts = db.devPorts.filter((x) => x !== cur); log('deleted', 'device_ports', { ...cur, name: portName }, {}); }
          } else if (cur) {
            const ch = diff(cur, vals, ['connected_to', 'assignment', 'notes']);
            Object.assign(cur, vals);
            if (Object.keys(ch).length) log('updated', 'device_ports', { ...cur, name: portName }, ch);
          } else {
            const row = { id: uid(), device_id: dev.id, type_port_id: pp.type_port_id, ...vals };
            db.devPorts.push(row);
            log('created', 'device_ports', { ...row, name: portName }, { connected_to: vals.connected_to });
          }
        }
      }
      changed('devices');
      return dev.id;
    },

    async deleteDevice(id) {
      await wait(200);
      const dev = db.devices.find((d) => d.id === id);
      if (!dev) return;
      db.devices = db.devices.filter((d) => d.id !== id);
      db.ips = db.ips.filter((i) => i.device_id !== id);
      db.creds = db.creds.filter((c) => c.device_id !== id);
      db.devPorts = db.devPorts.filter((x) => x.device_id !== id);
      log('deleted', 'devices', dev, { name: dev.name });
      changed('devices');
    },

    async credentials(deviceId) { await wait(); return clone(db.creds.filter((c) => c.device_id === deviceId)); },
    async devicePorts(deviceId) { await wait(); return clone(db.devPorts.filter((x) => x.device_id === deviceId)); },

    async saveType(payload) {
      await wait(220);
      const t = payload.type;
      const name = blank(t.name);
      if (!name) throw new Error('Give the model a name.');
      const tags = depOrder(t.departments || []);
      if (!tags.length) throw new Error('Pick at least one section: Audio, Video, Lighting or Network.');
      const mfr = blank(t.manufacturer);
      if (db.types.some((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase() && (x.manufacturer || '').toLowerCase() === (mfr || '').toLowerCase())) {
        throw new Error('There’s already a model with that name from that brand.');
      }
      const fields = { name, manufacturer: mfr, part_number: blank(t.part_number), category: blank(t.category), departments: tags, networked: t.networked !== false,
        description: blank(t.description), specs: t.specs || [], manual_url: blank(t.manual_url), notes: blank(t.notes) };
      let row = t.id ? db.types.find((x) => x.id === t.id) : null;
      if (row) Object.assign(row, fields, { updated_at: now(), updated_by: me.id });
      else db.types.push((row = { id: uid(), ...fields, created_at: now(), updated_at: now(), created_by: me.id, updated_by: me.id }));
      if ('ports' in payload) {
        const keep = new Set();
        (payload.ports || []).forEach((p, i) => {
          const vals = { name: p.name.trim(), signal: blank(p.signal), connector: blank(p.connector), direction: p.direction || 'io', notes: blank(p.notes), sort_order: i };
          let cur = p.id && db.typePorts.find((x) => x.id === p.id && x.type_id === row.id);
          if (cur) Object.assign(cur, vals); else db.typePorts.push((cur = { id: uid(), type_id: row.id, ...vals }));
          keep.add(cur.id);
        });
        const gone = new Set(db.typePorts.filter((x) => x.type_id === row.id && !keep.has(x.id)).map((x) => x.id));
        db.typePorts = db.typePorts.filter((x) => !gone.has(x.id));
        db.devPorts = db.devPorts.filter((x) => !gone.has(x.type_port_id));
      }
      changed('device_types');
      return row.id;
    },
    async addDevices(payload) {
      await wait(250);
      const d = payload.device;
      const type = db.types.find((t) => t.id === d.type_id);
      if (!type) throw new Error('Pick a model for these items.');
      const names = payload.names || [];
      if (names.length < 1 || names.length > 500) throw new Error('Add between 1 and 500 at a time.');
      const tags = depOrder(d.departments || []);
      for (const n of names) {
        const dev = { id: uid(), type_id: type.id, campus_id: d.campus_id, room_id: d.room_id || null, name: blank(n) || type.name,
          departments: tags.length ? tags : [...type.departments], serial_number: null, firmware: null, location: blank(d.location),
          status: d.status || 'active', notes: blank(d.notes), created_at: now(), updated_at: now(), created_by: me.id, updated_by: me.id };
        db.devices.push(dev);
        log('created', 'devices', dev, { name: dev.name });
      }
      changed('devices');
      return names.length;
    },
    async deleteType(id) {
      await wait(150);
      if (db.devices.some((d) => d.type_id === id)) throw new Error('This model still has items at some locations. Delete or change those first.');
      db.types = db.types.filter((x) => x.id !== id);
      db.typePorts = db.typePorts.filter((x) => x.type_id !== id);
      changed('device_types');
    },
    async history(deviceId) { await wait(); return clone(db.activity.filter((a) => a.device_id === deviceId).slice(0, 40)); },

    async saveNetwork(n) {
      await wait(200);
      const fields = { campus_id: n.campus_id, name: blank(n.name), purpose: blank(n.purpose), vlan_id: n.vlan_id ?? null,
        subnet: blank(n.subnet), gateway: blank(n.gateway), departments: depOrder(n.departments || []),
        is_isolated: !!n.is_isolated, notes: blank(n.notes) };
      if (!fields.name) throw new Error('Give the network a name.');
      if (db.networks.some((x) => x.campus_id === fields.campus_id && x.name === fields.name && x.id !== n.id)) {
        throw new Error('That location already has a network with that name.');
      }
      let row = n.id && db.networks.find((x) => x.id === n.id);
      if (row) Object.assign(row, fields);
      else db.networks.push((row = { id: uid(), sort_order: db.networks.length, ...fields }));
      changed('networks');
      return row.id;
    },
    async deleteNetwork(id) {
      await wait(150);
      db.networks = db.networks.filter((x) => x.id !== id);
      db.ips.forEach((i) => { if (i.network_id === id) i.network_id = null; });
      changed('networks');
    },
    async addRoom(campus_id, name) {
      await wait(120);
      const existing = db.rooms.find((r) => r.campus_id === campus_id && r.name.toLowerCase() === name.toLowerCase());
      if (existing) return clone(existing);
      const r = { id: uid(), campus_id, name, sort_order: db.rooms.length };
      db.rooms.push(r);
      changed('rooms');
      return clone(r);
    },

    photoUrl(path, thumb = false) { return path ? photos.get(path)?.[thumb ? 'thumb' : 'full'] || null : null; },
    async setTypePhoto(typeId, { full, thumb }) {
      await wait(250);
      const path = `demo/${typeId}/${Date.now().toString(36)}.jpg`;
      photos.set(path, { full: URL.createObjectURL(full), thumb: URL.createObjectURL(thumb) });
      db.types.find((t) => t.id === typeId).photo_path = path;
      changed('device_types');
      return path;
    },
    async removeTypePhoto(typeId) {
      await wait(120);
      db.types.find((t) => t.id === typeId).photo_path = null;
      changed('device_types');
    },

    async streams() { await wait(); return clone(streams); },
    async saveStream(st) {
      await wait(160);
      if (streams.some((x) => x.campus_id === st.campus_id && x.embed_id === st.embed_id && x.id !== st.id)) throw new Error('That player is already on this location.');
      const row = { campus_id: st.campus_id, name: (st.name || '').trim() || 'Online', embed_id: st.embed_id, embed_type: st.embed_type || 'webchannel' };
      if (st.id) Object.assign(streams.find((x) => x.id === st.id), row);
      else streams.push({ id: uid(), provider: 'resi', sort_order: 0, created_at: now(), ...row });
      changed('streams');
      return st.id || streams[streams.length - 1].id;
    },
    async deleteStream(id) { await wait(120); streams = streams.filter((x) => x.id !== id); changed('streams'); },
    /** Stands in for asking Resi, so the preview has something to show. */
    async resiStatus(st) {
      await wait(250);
      const s = demoStatus.get(st.embed_id) || { state: 'offline' };
      return { ...s, checkedAt: new Date(), demo: true };
    },

    async profiles() { await wait(); return clone(people); },
    async updateProfile(id, patch) {
      await wait(180);
      const p = people.find((x) => x.id === id);
      if (patch.role && p.role === 'admin' && patch.role !== 'admin' && !people.some((x) => x.id !== id && x.role === 'admin')) {
        throw new Error('There has to be at least one admin. Make someone else an admin first.');
      }
      Object.assign(p, patch);
      if (id === me.id) Object.assign(me, patch);
      changed('profiles');
    },

    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
