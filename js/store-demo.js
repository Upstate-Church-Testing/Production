// Preview store: the same methods as the live store, kept in memory with
// example data. Used when no Supabase project is configured.

import { createPcoDemo } from './pco-demo.js';
import { footprint, nameNumber, isFixtureType } from './lighting.js';

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
  ['Fountain Inn Campus', 'Fountain Inn', 'FI'], ['Greenville Convention Center (GCC) Campus', 'GCC', 'GCC'],
  ['Greenville Campus', 'Greenville', 'GVL'], ['Harrison Bridge Campus', 'Harrison Bridge', 'HB'],
  ['Laurens Campus', 'Laurens', 'LAU'], ['Mauldin Campus', 'Mauldin', 'MAU'],
  ['Simpsonville Campus', 'Simpsonville', 'SVL'], ['Union Gathering', 'Union', 'UN'],
].map(([name, short_name, code], i) => ({ id: 'c-' + code, name, short_name, code, sort_order: i + 1, is_active: true }));

const PEOPLE = [
  { id: 'p-me', email: 'you@upstatechurch.org', full_name: 'Demo Admin', role: 'admin', departments: ['video'] },
  { id: 'p-tom', email: 'audio.lead@example.org', full_name: 'Audio Lead', role: 'staff', departments: ['audio', 'video', 'lighting'] },
  { id: 'p-bethany', email: 'lighting.lead@example.org', full_name: 'Lighting Lead', role: 'staff', departments: ['lighting'] },
  { id: 'p-chris', email: 'video.lead@example.org', full_name: 'Video Lead', role: 'staff', departments: ['video'] },
  { id: 'p-will', email: 'new.signup@example.org', full_name: 'New Sign-up', role: 'pending', departments: [] },
].map((p) => ({ ...p, home_campus_id: null, created_at: ago(60 * 24 * 3) }));

// [campus, room, network, name, tags, category, model, location, ip, extra]
function buildExample() {
  const rooms = [], networks = [], devices = [], ips = [], creds = [], activity = [], types = [], typePorts = [], devPorts = [], positions = [];
  const nums = (prefix, n, o) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i + 1}`, ...o }));
  // Example port layouts and specs, keyed by type name.
  const PORTS = {
    'Net-X II': [...nums('DMX ', 8, { signal: 'DMX', connector: 'XLR5', direction: 'out' }), { name: 'Ethernet', signal: 'Art-Net / sACN', connector: 'etherCON' }],
    'Hoglet 4': [...nums('DMX ', 4, { signal: 'DMX', connector: 'XLR5', direction: 'out' }), { name: 'Ethernet', signal: 'Ethernet', connector: 'RJ45' }, { name: 'USB to PC', signal: 'USB', connector: 'USB-A' }],
    'SG350-10': nums('Port ', 10, { signal: 'Ethernet', connector: 'RJ45' }),
    'KY-PZ100': [{ name: 'SDI Out', signal: 'SDI', connector: 'BNC', direction: 'out' }, { name: 'HDMI Out', signal: 'HDMI', connector: 'HDMI', direction: 'out' }, { name: 'LAN', signal: 'Ethernet', connector: 'RJ45' }],
    'Rio3224-D2': [{ name: 'Dante Primary', signal: 'Dante', connector: 'etherCON' }, { name: 'Dante Secondary', signal: 'Dante', connector: 'etherCON' }],
    'Pathport 8-port rack mount': [...nums('DMX ', 8, { signal: 'DMX', connector: 'XLR5', direction: 'out' }), { name: 'Ethernet', signal: 'Art-Net / sACN', connector: 'RJ45' }],
    // The same layouts as the live database, from Blackmagic's specs and back-panel photos.
    'Videohub 40x40 12G': [...nums('SDI In ', 40, { signal: 'SDI', connector: 'BNC', direction: 'in' }),
      { name: 'Ref In', signal: 'Reference', connector: 'BNC', direction: 'in', notes: 'Tri-sync or black burst.' },
      ...nums('Power ', 2, { signal: 'Power', connector: 'IEC', direction: 'in', notes: 'One of two internal power supplies, 100–240V AC.' }),
      ...nums('SDI Out ', 40, { signal: 'SDI', connector: 'BNC', direction: 'out' }),
      { name: 'Ref Out', signal: 'Reference', connector: 'BNC', direction: 'out', notes: 'Loop-through of Ref In.' },
      { name: 'Ethernet', signal: 'Ethernet', connector: 'RJ45', notes: '10/100/1000. For Videohub Control and Videohub hardware panels.' },
      { name: 'USB-C', signal: 'USB', connector: 'USB-C', notes: 'For Videohub Setup on a computer.' }],
    'QL5': [...nums('Input ', 32, { signal: 'Analog audio', connector: 'XLR3', direction: 'in', notes: 'Balanced mic/line input, –62 to +10 dBu, with +48V phantom.' }),
      ...nums('Dante In ', 64, { signal: 'Dante', connector: null, direction: 'in', face: null, notes: 'Dante network channel, carried on the Dante PRIMARY/SECONDARY ports.' }),
      { name: 'Word Clock In', signal: 'Word clock', connector: 'BNC', direction: 'in', notes: 'Internal 75-ohm termination.' },
      { name: 'MIDI In', signal: 'MIDI', connector: 'DIN 5', direction: 'in' },
      { name: 'AC In', signal: 'Power', connector: 'IEC', direction: 'in', notes: '100–240V AC, 200 W. Locking (V-lock) power cord.' },
      ...nums('Omni Out ', 16, { signal: 'Analog audio', connector: 'XLR3', direction: 'out', notes: 'Balanced, +4 dBu nominal.' }),
      ...nums('Dante Out ', 64, { signal: 'Dante', connector: null, direction: 'out', face: null, notes: 'Dante network channel, carried on the Dante PRIMARY/SECONDARY ports.' }),
      { name: 'Digital Out', signal: 'AES', connector: 'XLR3', direction: 'out', notes: 'AES/EBU. Mainly for the STEREO/MONO mix.' },
      { name: 'Word Clock Out', signal: 'Word clock', connector: 'BNC', direction: 'out' },
      { name: 'MIDI Out', signal: 'MIDI', connector: 'DIN 5', direction: 'out' },
      { name: 'Phones', signal: 'Analog audio', connector: 'TRS ¼"', direction: 'out', face: 'front', notes: 'Headphones: the MONITOR OUT or CUE signal.' },
      ...nums('Lamp ', 2, { signal: 'Power', connector: 'XLR4', direction: 'out', notes: '12V for a gooseneck lamp, like the Yamaha LA1L.' }),
      { name: 'Dante Primary', signal: 'Dante', connector: 'etherCON', notes: '1000Base-T.' },
      { name: 'Dante Secondary', signal: 'Dante', connector: 'etherCON', notes: '1000Base-T.' },
      { name: 'Network', signal: 'Ethernet', connector: 'RJ45', notes: '10/100. For QL Editor on a computer and QL StageMix on an iPad.' },
      { name: 'GPI', signal: 'GPIO', connector: 'DB15', notes: '5 in, 5 out.' },
      ...nums('Slot ', 2, { signal: 'MY card', connector: 'MY slot', notes: 'Mini-YGDAI slot for a DSP or I/O card. The card’s own ports aren’t listed here.' }),
      { name: 'USB', signal: 'USB', connector: 'USB-A', face: 'top', notes: 'USB 2.0 host for a flash drive: recording, playback and saving data.' }],
    'ATEM 2 M/E Production Studio 4K': [
      { name: 'SDI In 1', signal: 'SDI', connector: 'BNC', direction: 'in', notes: 'Input 1 is either this or HDMI In 1, picked in the switcher’s input settings.' },
      ...nums('SDI In ', 20, { signal: 'SDI', connector: 'BNC', direction: 'in' }).slice(1),
      { name: 'HDMI In 1', signal: 'HDMI', connector: 'HDMI', direction: 'in', notes: 'Shares input 1 with SDI In 1.' },
      { name: 'Ref In', signal: 'Reference', connector: 'BNC', direction: 'in', notes: 'Tri-sync or black burst.' },
      { name: 'Analog In Ch 1', signal: 'Analog audio', connector: 'XLR3', direction: 'in', notes: 'Balanced. Labeled ANALOG AUDIO IN CH 1.' },
      { name: 'Analog In Ch 2', signal: 'Analog audio', connector: 'XLR3', direction: 'in', notes: 'Balanced. Labeled ANALOG AUDIO IN CH 2.' },
      { name: 'Stereo In L', signal: 'Analog audio', connector: 'RCA', direction: 'in', notes: 'Unbalanced. Labeled STEREO IN L.' },
      { name: 'Stereo In R', signal: 'Analog audio', connector: 'RCA', direction: 'in', notes: 'Unbalanced. Labeled STEREO IN R.' },
      { name: 'Timecode In', signal: 'Timecode', connector: 'XLR3', direction: 'in', notes: 'SMPTE linear timecode.' },
      { name: 'Talkback In', signal: 'Analog audio', connector: 'XLR3', direction: 'in', notes: 'Line level, balanced, for an existing talkback system.' },
      ...nums('Power ', 2, { signal: 'Power', connector: 'IEC', direction: 'in', notes: 'One of two internal power supplies, 110–240V AC.' }),
      ...nums('Program ', 2, { signal: 'SDI', connector: 'BNC', direction: 'out', notes: 'Program output.' }),
      { name: 'Program M/E 2', signal: 'SDI', connector: 'BNC', direction: 'out', notes: 'M/E 2 program. Labeled M/E 2 under PROGRAM OUTPUTS.' },
      { name: 'Program HD', signal: 'SDI', connector: 'BNC', direction: 'out', notes: 'Program down-converted to HD.' },
      { name: 'Program HDMI', signal: 'HDMI', connector: 'HDMI', direction: 'out', notes: 'Program output.' },
      { name: 'M/E 1 Preview', signal: 'SDI', connector: 'BNC', direction: 'out', notes: 'Labeled M/E 1 PVW.' },
      ...nums('Aux ', 6, { signal: 'SDI', connector: 'BNC', direction: 'out' }),
      { name: 'Multiview 1 SDI', signal: 'SDI', connector: 'BNC', direction: 'out', notes: 'HD multiview. Labeled HD 1 under MULTI-VIEW.' },
      { name: 'Multiview 2 SDI', signal: 'SDI', connector: 'BNC', direction: 'out', notes: 'HD multiview. Labeled HD 2 under MULTI-VIEW.' },
      { name: 'Multiview 1 HDMI', signal: 'HDMI', connector: 'HDMI', direction: 'out', notes: 'HD multiview. Labeled HD 1 under MULTI-VIEW.' },
      { name: 'Multiview 2 HDMI', signal: 'HDMI', connector: 'HDMI', direction: 'out', notes: 'HD multiview. Labeled HD 2 under MULTI-VIEW.' },
      { name: 'Analog Out Ch 1', signal: 'Analog audio', connector: 'XLR3', direction: 'out', notes: 'Program audio, balanced. Labeled ANALOG AUDIO OUT CH 1.' },
      { name: 'Analog Out Ch 2', signal: 'Analog audio', connector: 'XLR3', direction: 'out', notes: 'Program audio, balanced. Labeled ANALOG AUDIO OUT CH 2.' },
      { name: 'Monitor Out Ch 1', signal: 'Analog audio', connector: 'XLR3', direction: 'out', notes: 'For monitoring. Labeled MONITOR CH 1.' },
      { name: 'Monitor Out Ch 2', signal: 'Analog audio', connector: 'XLR3', direction: 'out', notes: 'For monitoring. Labeled MONITOR CH 2.' },
      { name: 'Timecode Out', signal: 'Timecode', connector: 'XLR3', direction: 'out', notes: 'SMPTE linear timecode, frame synchronized.' },
      { name: 'Talkback Out', signal: 'Analog audio', connector: 'XLR3', direction: 'out', notes: 'Line level, balanced, for an existing talkback system.' },
      { name: 'Control', signal: 'Ethernet', connector: 'RJ45', notes: '10/100/1000. For ATEM Software Control and ATEM hardware panels. Labeled CONTROL.' },
      { name: 'USB 2.0', signal: 'USB', connector: 'USB-B', notes: 'For ATEM Setup: IP address and software updates.' },
      { name: 'Remote', signal: 'RS-422', connector: 'DB9', notes: 'RS-422, for PTZ heads or GVG100 edit control. Labeled REMOTE.' }],
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
        manual_url: null, notes: null, photo_path: null, networked: d.networked !== false, dmx_modes: [], dmx_footprint: null, created_at: ago(60 * 24 * 3), updated_at: ago(60 * 24 * 3), created_by: 'p-me', updated_by: 'p-me' };
      types.push(t);
      (PORTS[name] || []).forEach((p, i) => typePorts.push({ id: uid(), type_id: t.id, connector: null, direction: 'io', face: 'back', notes: null, sort_order: i, ...p }));
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
      serial_number: null, firmware: null, location: null, status: 'active', asset_no: null,
      fixture_id: null, patch_universe: null, patch_address: null, dmx_channels: null, notes: null, projection: null, position_id: null, positions: [], used_as: null, area: null, created_at: ago(60 * 24 * 2), updated_at: ago(60 * 24 * 2), created_by: 'p-me', updated_by: 'p-me', ...rest });
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
  const hub = dev('SVL', W, { name: 'Videohub 40x40', departments: ['video'], category: 'Router', manufacturer: 'Blackmagic', model: 'Videohub 40x40 12G', location: 'A-Control Rack' }, [{ net: 'ctl', ip: '10.50.10.201/24', gw: '10.50.10.101' }]);
  dev('SVL', W, { name: 'Switcher', departments: ['video'], category: 'Switcher', manufacturer: 'Blackmagic', model: 'ATEM 2 M/E Production Studio 4K', location: 'A-Control Rack' }, [{ net: 'ctl', ip: '10.50.10.202/24' }]);
  dev('SVL', W, { name: 'Switcher Panel', departments: ['video'], category: 'Control Panel', manufacturer: 'Blackmagic', location: 'A-Control Desk' }, [{ net: 'ctl', ip: '10.50.10.205/24', gw: '10.50.10.101' }]);
  const dirMac = dev('SVL', W, { name: 'Director’s Mac', departments: ['video'], category: 'Computer', manufacturer: 'Apple', model: 'Mac mini', location: 'A-Control Desk', firmware: 'macOS Sequoia 15.6', positions: ['Director'] }, [{ net: 'ctl', ip: '10.50.10.217/24', gw: '10.50.10.101' }]);
  const cg1 = dev('SVL', W, { name: 'CG1', departments: ['video'], category: 'Computer', manufacturer: 'Apple', model: 'Mac mini', location: 'CG1', firmware: 'macOS Tahoe 26.1', positions: ['CG'] },
    [{ net: 'ctl', ip: '10.50.10.234/24', gw: '10.50.10.101', label: 'Production' }, { net: 'house', ip: '10.60.20.79/24', label: 'House', mode: 'dhcp' }]);
  const ql = dev('SVL', W, { name: 'FOH Console', departments: ['audio'], category: 'Console', manufacturer: 'Yamaha', model: 'QL5', location: 'FOH' }, [{ net: 'dante', ip: '192.168.50.35/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Stage Box', departments: ['audio'], category: 'Stagebox', manufacturer: 'Yamaha', model: 'Rio3224-D2', location: 'Amp Room' }, [{ net: 'dante', ip: '192.168.50.32/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Wireless Rx 1–4', departments: ['audio'], category: 'Wireless Receiver', manufacturer: 'Shure', model: 'ULXD4Q', location: 'FOH Rack' }, [{ net: 'dante', ip: '192.168.50.37/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Main L Amp', departments: ['audio'], category: 'Amplifier', location: 'Amp Room' }, [{ net: 'dante', ip: '192.168.50.20/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Main R Amp', departments: ['audio'], category: 'Amplifier', location: 'Amp Room' }, [{ net: 'dante', ip: '192.168.50.21/24', label: 'Dante Primary' }]);
  dev('SVL', W, { name: 'Sub Amp', departments: ['audio'], category: 'Amplifier', location: 'Amp Room' }, [{ net: 'dante', ip: '192.168.50.22/24', label: 'Dante Primary' }]);
  // A lighting rig with its patch: fixture IDs by model (101…, 201…, 401…), universes 1 and 2.
  for (let i = 1; i <= 6; i++) dev('SVL', W, { name: `R2X Wash ${i}`, departments: ['lighting'], category: 'Fixture', manufacturer: 'Chauvet Professional', model: 'R2X Wash', networked: false, location: i <= 3 ? 'Upstage truss' : 'Midstage truss',
    fixture_id: 100 + i, patch_universe: 1, patch_address: 1 + (i - 1) * 22 });
  for (let i = 1; i <= 8; i++) dev('SVL', W, { name: `ColorSource Par Deep Blue ${i}`, departments: ['lighting'], category: 'Fixture', manufacturer: 'ETC', model: 'ColorSource Par Deep Blue', networked: false, location: 'FOH batten',
    fixture_id: 200 + i, patch_universe: 1, patch_address: i === 8 ? 130 : 201 + (i - 1) * 5, serial_number: i === 1 ? 'CSP-2219-0417' : null });
  for (let i = 1; i <= 24; i++) dev('SVL', W, { name: `Jolt Panel FX2 ${i}`, departments: ['lighting'], category: 'Fixture', manufacturer: 'ADJ', model: 'Jolt Panel FX2', location: i <= 12 ? 'Upstage wall' : 'Downstage truss',
    ...(i <= 22 ? { fixture_id: 400 + i, patch_universe: 2, patch_address: 1 + (i - 1) * 20 } : {}), serial_number: i <= 2 ? `JPF2-21${30 + i}` : null });
  for (let i = 25; i <= 26; i++) dev('SVL', 'Lighting Storage', { name: `Jolt Panel FX2 ${i}`, departments: ['lighting'], category: 'Fixture', manufacturer: 'ADJ', model: 'Jolt Panel FX2' });
  dev('SVL', 'North Auditorium', { name: 'DMX Node', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Chauvet', model: 'DMX-AN2', location: 'Stage Right' }, [{ ip: '10.50.10.120/24', gw: '2.0.0.1' }]);

  // Harrison Bridge
  net('HB', 'lx', { name: 'Lighting', purpose: 'Console, Pathports, wall stations', subnet: '10.50.0.0/16', gateway: '10.50.1.1', departments: ['lighting'], is_isolated: true });
  net('HB', 'prod', { name: 'Production', subnet: '10.80.8.0/24', vlan_id: 203, departments: ['video', 'audio'] });
  dev('HB', W, { name: 'Stage Switch', departments: ['lighting'], category: 'Switch', manufacturer: 'Cisco', model: 'SF300-24PP (PoE+)', location: 'Stage Rack' }, [{ net: 'lx', ip: '10.50.1.1/16' }]);
  dev('HB', W, { name: 'Lighting PC', departments: ['lighting'], category: 'Console', manufacturer: 'High End Systems', model: 'Hoglet 4', location: 'FOH', firmware: '3.20.0' }, [{ net: 'lx', ip: '10.50.100.101/16', gw: '10.50.1.1' }]);
  dev('HB', W, { name: 'Pathport 8-Port #1', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Pathway', model: 'Pathport 8-port rack mount', location: 'Stage Rack', firmware: '6.3.1' }, [{ net: 'lx', ip: '10.50.50.101/16', gw: '10.50.1.1' }]);
  dev('HB', W, { name: 'Pathport 8-Port #2', departments: ['lighting'], category: 'Node / Gateway', manufacturer: 'Pathway', model: 'Pathport 8-port rack mount', location: 'Stage Rack', firmware: '6.3.1' }, [{ net: 'lx', ip: '10.50.50.102/16', gw: '10.50.1.1' }]);
  dev('HB', W, { name: 'HL Button Station', departments: ['lighting'], category: 'Wall Station', manufacturer: 'Pathway', model: 'Vignette PoE Wall Station', location: 'House Left', firmware: '6.2.0' }, [{ net: 'lx', ip: '10.50.10.101/16', gw: '10.50.1.1' }]);
  for (let i = 1; i <= 6; i++) dev('HB', W, { name: `R2X Wash ${i}`, departments: ['lighting'], category: 'Fixture', manufacturer: 'Chauvet Professional', model: 'R2X Wash', networked: false, location: 'Truss',
    fixture_id: 300 + i, patch_universe: 1, patch_address: 1 + (i - 1) * 15, dmx_channels: 15 });
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

  room('SVL', 'Chapel'); // a room with nothing in it yet
  // A room group: E-Wing Offices holds Production Storage and an office.
  const ewing = room('SVL', 'E-Wing Offices');
  for (const name of ['Production Storage', 'Luken’s Office']) { const id = room('SVL', name); rooms.find((r) => r.id === id).group_id = ewing; }
  for (let i = 1; i <= 2; i++) dev('SVL', 'Luken’s Office', { name: `HS5 ${i}`, departments: ['audio'], category: 'Speaker', manufacturer: 'Yamaha', model: 'HS5', networked: false, location: 'Desk' });
  // Hazers: lighting items in the Hazer category, so they keep a patch.
  dev('SVL', W, { name: 'ATMe', departments: ['lighting'], category: 'Hazer', manufacturer: 'MDG', model: 'ATMe', networked: false, location: 'Upstage', fixture_id: 901, patch_universe: 2, patch_address: 501 });
  dev('SVL', 'North Auditorium', { name: 'HZ-350', departments: ['lighting'], category: 'Hazer', manufacturer: 'Antari', model: 'HZ-350', networked: false });
  dev('HB', W, { name: 'HZ-350', departments: ['lighting'], category: 'Hazer', manufacturer: 'Antari', model: 'HZ-350', networked: false });
  dev('GCC', W, { name: 'Amhaze Stadium 2X IP', departments: ['lighting'], category: 'Hazer', manufacturer: 'Chauvet Professional', model: 'Amhaze Stadium 2X IP', networked: false });
  // Open positions: three projectors we haven't identified yet.
  ['House left', 'Center', 'House right'].forEach((spot, i) => dev('SVL', 'North Auditorium', { name: `Projector ${i + 1}`, departments: ['video'], category: 'Projector', model: 'Projector', location: spot, projection: spot === 'Center' ? 'front' : 'rear' }));
  dev('SVL', 'North Auditorium', { name: 'Epix Drive 2000 IP', departments: ['lighting'], category: 'LED Driver', manufacturer: 'Chauvet Professional', model: 'Epix Drive 2000 IP', status: 'broken', notes: 'Bricked.' });
  // Broadcast camera builds: gear whose Spot is "Cam N".
  const cam = (name, model, manufacturer, category, location, roomName = W, status = 'active') =>
    dev('SVL', roomName, { name, departments: ['video'], category, manufacturer, model, networked: false, location, status });
  cam('URSA Broadcast', 'URSA Broadcast', 'Blackmagic', 'Camera', 'Cam 1');
  cam('URSA Studio Viewfinder', 'URSA Studio Viewfinder', 'Blackmagic', 'Monitor', 'Cam 1');
  cam('VB99 Mini 1', 'VB99 Mini', 'SmallRig', 'Battery', 'Cam 1');
  cam('FX30 1', 'FX30', 'Sony', 'Camera', 'Cam 2');
  cam('MK18-55mm T2.9 1', 'MK18-55mm T2.9', 'Fujinon', 'Lens', 'Cam 2');
  cam('FX30 2', 'FX30', 'Sony', 'Camera', 'Cam 3');
  cam('MK50-135mm T2.9 1', 'MK50-135mm T2.9', 'Fujinon', 'Lens', 'Cam 3');
  cam('Ninja V 1', 'Ninja V', 'Atomos', 'Monitor', 'Cam 3');
  cam('VB99 Mini 2', 'VB99 Mini', 'SmallRig', 'Battery', 'Cam 3');
  cam('SQ75', 'SQ75', 'Sirui', 'Tripod', 'Cam 3');
  cam('VB99 Mini 5', 'VB99 Mini', 'SmallRig', 'Battery', null, 'Production Storage', 'spare');
  cam('RS-701 1', 'RS-701', 'Clear-Com', 'Intercom', 'Cam 3');
  cam('CC-400 1', 'CC-400', 'Clear-Com', 'Intercom', 'Cam 3');
  cam('RS-601 1', 'RS-601', 'Clear-Com', 'Intercom', 'Cam 1');
  cam('MS-702', 'MS-702', 'Clear-Com', 'Intercom', 'Main rack', 'A Control');
  cam('RS-701 2', 'RS-701', 'Clear-Com', 'Intercom', 'Director', 'A Control');
  cam('ATEM 2 M/E Production Studio 4K', 'ATEM 2 M/E Production Studio 4K', 'Blackmagic', 'Switcher', 'Main rack', 'A Control', 'update');

  // Rigging: battens and trusses front to back, and what hangs on each (by the item's spot here).
  const rig = (code, roomName, names, hang = {}) => {
    const rid = room(code, roomName);
    names.forEach((name, i) => {
      const id = uid();
      positions.push({ id, campus_id: 'c-' + code, room_id: rid, name, sort_order: i, notes: null, created_at: ago(60 * 24), updated_at: ago(60 * 24), created_by: 'p-me', updated_by: 'p-me' });
      for (const d of devices) if (d.room_id === rid && hang[name]?.(d)) d.position_id = id;
    });
  };
  rig('SVL', W, ['FOH Batten', 'Downstage Truss', 'Midstage Truss', 'Upstage Truss', 'Upstage Wall'], {
    'FOH Batten': (d) => d.location === 'FOH batten', 'Downstage Truss': (d) => d.location === 'Downstage truss',
    'Midstage Truss': (d) => d.location === 'Midstage truss', 'Upstage Truss': (d) => d.location === 'Upstage truss', 'Upstage Wall': (d) => d.location === 'Upstage wall',
  });
  positions.find((p) => p.name === 'FOH Batten' && p.campus_id === 'c-SVL').notes = 'Over the front rows. Fly it in from the catwalk.';
  rig('HB', W, ['FOH Batten', 'Midstage Batten Center 1', 'Midstage Batten Center 2', 'Midstage Batten Center 3', 'Midstage Batten Left', 'Midstage Batten Right',
    'Upstage Batten Center', 'Upstage Batten Left', 'Upstage Batten Right']);

  // What things are for: the positions they make possible, and what displays are used as.
  const forPos = (code, name, positions, used_as = null) => devices.filter((x) => x.campus_id === 'c-' + code && x.name === name).forEach((x) => Object.assign(x, { positions, used_as }));
  forPos('SVL', 'CG1', ['CG']); forPos('SVL', 'Director’s Mac', ['Director']); forPos('SVL', 'Switcher Panel', ['Switcher']); forPos('SVL', 'Switcher', ['Switcher']);
  forPos('SVL', 'FOH Console', ['Audio']); forPos('SVL', 'Lighting Console', ['Lighting']); forPos('HB', 'Lighting PC', ['Lighting']);
  forPos('FF', 'Lighting PC', ['Lighting']); forPos('AND', 'Lighting Console', ['Lighting']); forPos('AND', 'Sound Board', ['Audio']);
  forPos('SVL', 'Videohub 40x40', ['CG', 'Director']);
  const screen = (code, name, manufacturer, model, location, positions, used_as) => dev(code, W, { name, departments: ['video'], category: 'Display', manufacturer, model, networked: false, location, positions, used_as });
  screen('SVL', 'CG monitor', 'Samsung', 'LF27T35', 'FOH Desk', ['CG'], 'Computer monitor');
  screen('SVL', 'Stage display', 'NEC', 'C751Q', 'Stage display', ['CG'], 'Stage display');
  screen('SVL', 'Director monitor', 'Dell', 'U2417H', 'A-Control Desk', ['Director'], 'Computer monitor');
  screen('HB', 'Stage display', 'Samsung', 'BE75T-H', 'Stage display', ['CG'], 'Stage display');
  screen('HB', 'Hog screen 1', 'Dell', 'P2418HT', 'FOH', ['Lighting'], 'Computer monitor');
  screen('HB', 'Hog screen 2', 'Dell', 'P2418HT', 'FOH', ['Lighting'], 'Computer monitor');
  screen('AND', 'Confidence monitor', 'Samsung', 'BE55T-H', 'Downstage', [], 'Confidence monitor');
  // Areas of the room: the spots that say where they are get their area.
  const AREAS = [[/^foh( |$)/i, 'Front of house'], [/^backstage/i, 'Backstage'],
    [/^(stage|upstage|downstage|front of stage)/i, 'Stage'], [/^amp room/i, 'Backstage']];
  for (const x of devices) {
    const hit = x.location && AREAS.find(([re]) => re.test(x.location));
    if (hit) x.area = hit[1];
    if (x.area && ['foh', 'stage', 'backstage'].includes(x.location.toLowerCase())) x.location = null; // the spot just named the area
  }

  // CG computers at other locations, and what runs on them (Gear › Software).
  const cgFF = dev('FF', W, { name: 'Mac mini (CG)', departments: ['video'], category: 'Computer', manufacturer: 'Apple', model: 'Mac mini (M2, 2023)', location: 'FOH desk', firmware: 'macOS Tahoe 26.0.1', positions: ['CG'], notes: '16 GB memory.' });
  const cgHB = dev('HB', W, { name: 'Mac mini (CG)', departments: ['video'], category: 'Computer', manufacturer: 'Apple', model: 'Mac mini (M4, 2024)', location: 'CG', firmware: 'macOS Tahoe 26.0.1', positions: ['CG'], notes: '16 GB memory.' });
  const cgAND = dev('AND', W, { name: 'Mac mini (CG)', departments: ['video'], category: 'Computer', manufacturer: 'Apple', model: 'Mac mini (M2 Pro, 2023)', location: 'CG', firmware: 'macOS Tahoe 26.0', positions: ['CG'] });
  const cg2 = dev('SVL', 'A Control', { name: 'Mac mini (CG2)', departments: ['video'], category: 'Computer', manufacturer: 'Apple', model: 'Mac mini (M4, 2024)', location: 'CG2', firmware: 'macOS Sequoia 15.6', positions: ['CG'], notes: '24 GB memory.' });
  dev('HB', W, { name: 'Lighting computer', departments: ['lighting'], category: 'Computer', manufacturer: 'Lenovo', model: 'ThinkCentre M75q-1', location: 'FOH', positions: ['Lighting'] });
  const software = [
    { id: 'sw-pp', name: 'ProPresenter', maker: 'Renewed Vision', logo: 'propresenter.svg', notes: null },
    { id: 'sw-comp', name: 'Companion', maker: 'Bitfocus', logo: 'companion.png', notes: null },
    { id: 'sw-dv', name: 'Desktop Video', maker: 'Blackmagic Design', logo: 'blackmagic.svg', notes: null },
  ].map((x) => ({ ...x, created_at: ago(60 * 24), updated_at: ago(60 * 24) }));
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const installs = [
    ['sw-pp', cgFF, '22', '369098928', day(0), 'Testing at Five Forks only this Sunday. Not on the other locations yet.'],
    ['sw-pp', cgHB, '21.4', null, day(2), null], ['sw-pp', cg1, '21.4', null, day(8), null], ['sw-pp', cgAND, '21.4', null, day(1), null],
    ['sw-dv', cgFF, '15.0', null, day(1), null], ['sw-dv', cgHB, '15.0', null, day(2), 'SDI and HDMI out at 1080i59.94.'], ['sw-dv', cg1, '14.3', null, day(8), null],
    ['sw-pp', cg2, '21.4', '352583705', day(1), null], ['sw-comp', cg1, '3.3.1', null, day(8), null], ['sw-comp', dirMac, '3.3.1', null, day(8), null],
  ].map(([software_id, device_id, version, build, seen_on, notes]) => ({ id: uid(), software_id, device_id, version, build, seen_on, notes, created_at: ago(60 * 24), updated_at: ago(60 * 24) }));

  // A little history so the device screen shows how it works.
  activity.push(
    { id: 1, at: ago(26), actor_id: 'p-bethany', action: 'updated', entity: 'devices', entity_id: cat, device_id: cat, campus_id: 'c-SVL', label: 'Catwalk Gateway', changes: { firmware: ['B1.0 V3.4', 'B1.0 V3.7'] } },
    { id: 2, at: ago(60 * 5), actor_id: 'p-tom', action: 'updated', entity: 'devices', entity_id: ma, device_id: ma, campus_id: 'c-SVL', label: 'Lighting Console', changes: { model: ['HES HedgeHog 4X', 'grandMA3 compact XT'] } },
    { id: 3, at: ago(60 * 26), actor_id: null, actor_name: 'Claude', action: 'updated', entity: 'devices', entity_id: cat, device_id: cat, campus_id: 'c-SVL', label: 'Catwalk Gateway', changes: { location: [null, 'Catwalk'] } },
  );

  patch(ql, 'Dante In 1', 'Y004-001', 'KICK IN');
  patch(ql, 'Dante In 3', 'Y003-015', 'SNARE TO');
  patch(ql, 'Dante In 37', '???-???');
  patch(hub, 'SDI In 1', 'Camera 1');
  patch(hub, 'SDI In 2', 'Camera 2');
  patch(hub, 'SDI Out 12', 'Switcher SDI In 1');
  patch(hub, 'Ethernet', 'FOH Switch');
  patch(stageGw, 'DMX 1', 'Stage left floor', 'Universe 5');
  patch(stageGw, 'DMX 2', 'Upstage truss', 'Universe 3');
  patch(stageGw, 'DMX 3', 'Midstage truss', 'Universe 4');
  patch(stageGw, 'Ethernet', 'Stage Switch port 4', 'sACN');
  patch(cat, 'DMX 1', 'FOH batten', 'Universe 1');
  patch(cat, 'DMX 2', 'Catwalk positions', 'Universe 2');
  // What the lighting models offer (from each maker's manual).
  const setType = (name, o) => Object.assign(types.find((t) => t.name === name) || {}, o);
  setType('Jolt Panel FX2', { part_number: 'JOL299', dmx_modes: [6, 9, 13, 18, 20, 36, 41, 43, 51, 81, 83, 126, 141, 143], dmx_footprint: 20 });
  setType('R2X Wash', { part_number: 'ROGUER2XWASH', dmx_modes: [15, 17, 22, 33, 54, 56], dmx_footprint: 22 });
  setType('ColorSource Par Deep Blue', { dmx_modes: [1, 3, 5, 6], dmx_footprint: 5 });
  setType('grandMA3 compact XT', { part_number: '4010505' });
  setType('Hoglet 4', { part_number: '61040064' });
  setType('Amhaze Stadium 2X IP', { part_number: 'AMHAZESTADIUM2XIP', dmx_modes: [2], tank_liters: 5, haze_fluid_id: 'hf-phf' });
  setType('HZ-350', { tank_liters: 2.5, haze_fluid_id: 'hf-hzl' });
  setType('ATMe', { tank_liters: 2.5, haze_fluid_id: 'hf-mdg' });
  setType('Projector', { unknown: true, notes: 'Placeholder until we know the model.' });
  numberAll(devices, rooms, types);
  types.forEach((t) => delete t.key);

  return { rooms, networks, devices, ips, creds, activity, types, typePorts, devPorts, positions, software, installs };
}

/** One asset # per item, UCP-000001 up, by location and room; fixtures named for their model (like the database). */
function numberAll(devices, rooms, types) {
  const campusAt = (id) => CAMPUSES.findIndex((c) => c.id === id);
  const roomRank = (d) => { const n = rooms.find((r) => r.id === d.room_id)?.name || ''; return /storage/i.test(n) || !n ? 2 : /^worship/i.test(n) ? 0 : 1; };
  const sorted = [...devices].sort((a, b) => campusAt(a.campus_id) - campusAt(b.campus_id) || roomRank(a) - roomRank(b)
    || (nameNumber(a.name) - nameNumber(b.name)) || a.name.localeCompare(b.name));
  sorted.forEach((d, i) => { d.asset_no = i + 1; });
  for (const d of devices) {
    const t = types.find((x) => x.id === d.type_id);
    if (isFixtureType(t)) d.name = t.name;
  }
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
  /** Like the database: trimmed, no blanks, each position once (any case), in order. */
  const cleanPositions = (list) => {
    const out = [];
    for (const p of list || []) { const v = String(p || '').trim(); if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v); }
    return out;
  };
  const NUMBER_KEYS = ['asset_no', 'fixture_id', 'patch_universe', 'patch_address', 'dmx_channels'];
  let assetHigh = 0; // highest asset # handed out (never reused)

  /** What the database's numbering trigger does: asset #, a fixture's name, clearing a moved item's patch, the 512 check. */
  function number(dev, prev, explicit = {}) {
    for (const k of NUMBER_KEYS) if (k in explicit) dev[k] = explicit[k] === '' || explicit[k] == null ? null : Number(explicit[k]);
    const moved = prev && (prev.campus_id !== dev.campus_id || (prev.room_id || null) !== (dev.room_id || null));
    const everyone = db.devices.filter((d) => d.id !== dev.id);
    assetHigh = Math.max(assetHigh, ...everyone.map((d) => d.asset_no || 0));
    if (dev.asset_no == null) { do dev.asset_no = ++assetHigh; while (everyone.some((d) => d.asset_no === dev.asset_no)); }
    else if (everyone.some((d) => d.asset_no === dev.asset_no)) throw new Error('Another item already has that asset number. Every item has its own.');
    const t = db.types.find((x) => x.id === dev.type_id);
    if (isFixtureType(t)) dev.name = t.name;
    if (moved) {
      if (!('fixture_id' in explicit)) dev.fixture_id = null;
      if (!('patch_universe' in explicit)) { dev.patch_universe = null; dev.patch_address = null; }
    }
    if ((dev.patch_universe == null) !== (dev.patch_address == null)) throw new Error('A patch needs both a universe and an address, like 1.333.');
    if (dev.patch_address != null) {
      const ch = footprint(dev, db.types.find((t) => t.id === dev.type_id)) || 1;
      if (dev.patch_address + ch - 1 > 512) {
        throw new Error(`Patched at ${dev.patch_universe}.${dev.patch_address} with ${ch} channels, it runs past address 512. Start it at ${dev.patch_universe}.${513 - ch} or lower, or on the next universe.`);
      }
    }
  }

  /** What the database's position trigger does: moving rooms takes an item down; a position must be in its room. */
  function hangCheck(dev, prev) {
    const moved = prev && (prev.campus_id !== dev.campus_id || (prev.room_id || null) !== (dev.room_id || null));
    if (moved && dev.position_id === prev.position_id) dev.position_id = null;
    if (dev.position_id && db.positions.find((p) => p.id === dev.position_id)?.room_id !== dev.room_id) throw new Error('That position is in a different room.');
  }

  const pco = createPcoDemo({ wait, clone, me, changed });
  let meetings = null;
  let gear = null;
  let cablesDb = null;
  const GEAR_LISTS = { camera_builds: 'builds', haze_fluids: 'fluids', haze_stock: 'stock', haze_checks: 'checks', systems: 'systems', system_items: 'systemItems' };
  const GEAR_DEFAULTS = { camera_builds: { in_service: true, note: null }, haze_stock: { bottles: 0 }, haze_checks: { filled: false, note: null }, haze_fluids: {}, systems: { notes: null }, system_items: { role: null } };
  const MEETING_LISTS = { meetings: 'meetings', meeting_notes: 'notes', meeting_questions: 'questions', meeting_answers: 'answers' };

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

    /** CG uploads for one Sunday: each campus's status (the preview starts with a few going). */
    async cgUploads(sunday) {
      await wait(60);
      if (!db.cg) {
        const first = CAMPUSES.slice(0, 3);
        db.cg = first.map((c, i) => ({ sunday, campus_id: c.id, station: '', status: i < 2 ? 'done' : 'working', updated_at: new Date(Date.now() - (i + 1) * 3600e3).toISOString(), who: { full_name: me.full_name || 'Demo Admin' } }));
      }
      return clone(db.cg.filter((r) => r.sunday === sunday));
    },
    async cgSetUpload(sunday, campusId, status, station = '') {
      await wait(120);
      if (!['staff', 'admin'].includes(me.role)) throw new Error('Only staff can change CG uploads.');
      db.cg = db.cg || [];
      const row = db.cg.find((r) => r.sunday === sunday && r.campus_id === campusId && (r.station || '') === (station || ''));
      const now = { status, updated_at: new Date().toISOString(), who: { full_name: me.full_name || 'Demo Admin' } };
      if (row) Object.assign(row, now); else db.cg.push({ sunday, campus_id: campusId, station: station || '', ...now });
      changed('cg');
    },
    /** Lighting › House lights: the Worship Centers (not Laurens or Union), Planning Center's
     *  made-up services, and a few levels to start. */
    async houseLights() {
      await wait(90);
      const rooms = db.rooms.filter((r) => /^worship center$/i.test(r.name) && !['c-LAU', 'c-UN'].includes(r.campus_id)).map((r) => ({ id: r.id, name: r.name, campus_id: r.campus_id }));
      const { types } = await pco.pcoData();
      if (!db.house) {
        const at = (code) => rooms.find((r) => r.campus_id === 'c-' + code)?.id;
        const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
        db.house = [
          ['SVL', 'vintage', 'pre', 60], ['SVL', 'vintage', 'worship', 35], ['SVL', 'vintage', 'host', 50], ['SVL', 'vintage', 'video', 15], ['SVL', 'vintage', 'message', 45],
          ['SVL', 'modern', 'pre', 50], ['SVL', 'modern', 'worship', 10], ['SVL', 'modern', 'host', 40], ['SVL', 'modern', 'video', 0], ['SVL', 'modern', 'message', 40],
          ['AND', 'vintage', 'pre', 55], ['AND', 'modern', 'pre', 55], ['AND', 'modern', 'worship', 15],
          ['SVL', 'midweek', 'pre', 40], ['SVL', 'midweek', 'worship', 20],
        ].filter(([c]) => at(c)).map(([c, service, segment, level], i) => ({ room_id: at(c), service, segment, level, updated_at: ago(i + 2), who: { full_name: 'Demo Admin' } }));
      }
      return clone({ rooms, types, levels: db.house });
    },
    async houseLightSet(roomId, service, segment, level) {
      await wait(150);
      if (!['staff', 'admin'].includes(me.role)) throw new Error('Only staff can change house lights.');
      db.house = (db.house || []).filter((r) => !(r.room_id === roomId && r.service === service && r.segment === segment));
      if (level != null) db.house.push({ room_id: roomId, service, segment, level, updated_at: new Date().toISOString(), who: { full_name: me.full_name || 'Demo Admin' } });
      changed('house');
    },
    /** Gear's computers (campus, name, location): which CGs there are. */
    async cgComputers() {
      await wait(40);
      const cat = new Map(db.types.map((t) => [t.id, t.category]));
      return clone(db.devices.filter((d) => cat.get(d.type_id) === 'Computer').map((d) => ({ campus_id: d.campus_id, name: d.name, location: d.location })));
    },
    /** Events › Live: what each person in an event is on (VOX 4), and the gear when it's logged.
     *  The preview's Women's Night: Speaker 1 is on VOX 4, linked to a handheld if there is one. */
    async eventGear(planId) {
      await wait(60);
      if (!/^st-svl-e-e0$/.test(planId)) return [];
      const mic = db.devices.find((d) => /handheld|mic/i.test(d.name || ''))
        || db.devices.find((d) => d.campus_id === 'c-SVL') || null;
      return clone([
        { item_id: `${planId}-i10`, label: 'VOX 4', device_ids: mic ? [mic.id] : [] },
        { item_id: `${planId}-i11`, label: 'VOX 5', device_ids: [] },
        { item_id: `${planId}-i12`, label: 'VOX 6', device_ids: [] },
        { item_id: `${planId}-i13`, label: 'VOX 3', device_ids: [] },
      ]);
    },
    async networkData() {
      await wait(160);
      return clone({ rooms: db.rooms, networks: db.networks, devices: db.devices, ips: db.ips, positions: db.positions, software: db.software, installs: db.installs,
        types: db.types.map((t) => ({ ...t, ports: db.typePorts.filter((p) => p.type_id === t.id) })) });
    },

    // ---- Software (like the database: names unique in any case; a title once per computer).
    async saveSoftware(row) {
      await wait(120);
      const name = blank(row.name);
      if (!name) throw new Error('Give the software a name.');
      if (db.software.some((x) => x.id !== row.id && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`There’s already software called ${name}.`);
      const fields = { name, maker: blank(row.maker), logo: blank(row.logo), notes: blank(row.notes) };
      let cur = row.id ? db.software.find((x) => x.id === row.id) : null;
      if (cur) { const ch = diff(cur, fields, Object.keys(fields)); Object.assign(cur, fields, { updated_at: now() }); if (Object.keys(ch).length) log('updated', 'software', cur, ch); }
      else { cur = { id: uid(), ...fields, created_at: now(), updated_at: now() }; db.software.push(cur); log('created', 'software', cur, { name }); }
      changed('software');
      return cur.id;
    },
    async deleteSoftware(id) {
      await wait(120);
      const cur = db.software.find((x) => x.id === id);
      db.installs = db.installs.filter((x) => x.software_id !== id);
      db.software = db.software.filter((x) => x.id !== id);
      if (cur) log('deleted', 'software', cur, {});
      changed('software');
    },
    async saveInstall(row) {
      await wait(120);
      const version = blank(row.version);
      if (!version) throw new Error('Which version?');
      const sw = db.software.find((x) => x.id === row.software_id);
      if (!sw) throw new Error('Pick the software.');
      if (db.installs.some((x) => x.id !== row.id && x.software_id === row.software_id && x.device_id === row.device_id)) throw new Error(`${sw.name} is already on this item.`);
      const fields = { software_id: row.software_id, device_id: row.device_id, version, build: blank(row.build), seen_on: row.seen_on || null, notes: blank(row.notes) };
      let cur = row.id ? db.installs.find((x) => x.id === row.id) : null;
      if (cur) {
        const ch = diff(cur, fields, ['version', 'build', 'seen_on', 'notes']);
        Object.assign(cur, fields, { updated_at: now() });
        if (Object.keys(ch).length) log('updated', 'software_installs', { ...cur, name: sw.name }, ch);
      } else {
        cur = { id: uid(), ...fields, created_at: now(), updated_at: now() };
        db.installs.push(cur);
        log('created', 'software_installs', { ...cur, name: sw.name }, { version });
      }
      changed('software_installs');
      return cur.id;
    },
    async deleteInstall(id) {
      await wait(120);
      const cur = db.installs.find((x) => x.id === id);
      db.installs = db.installs.filter((x) => x.id !== id);
      if (cur) log('deleted', 'software_installs', { ...cur, name: db.software.find((x) => x.id === cur.software_id)?.name || 'Software' }, {});
      changed('software_installs');
    },

    async saveDevice(payload) {
      await wait(220);
      const d = payload.device;
      const type = db.types.find((t) => t.id === d.type_id);
      if (!type) throw new Error('Pick a model for this item.');
      let tags = depOrder((d.departments || []).map((x) => x.toLowerCase()));
      if (!tags.length) tags = [...type.departments];
      const fields = { type_id: type.id, campus_id: d.campus_id, room_id: d.room_id || null, name: blank(d.name) || type.name, departments: tags,
        serial_number: blank(d.serial_number), firmware: blank(d.firmware), location: blank(d.location), status: d.status || 'active', notes: blank(d.notes),
        ...('projection' in d ? { projection: blank(d.projection) } : {}), ...('position_id' in d ? { position_id: d.position_id || null } : {}),
        ...('positions' in d ? { positions: cleanPositions(d.positions) } : {}), ...('used_as' in d ? { used_as: blank(d.used_as) } : {}),
        ...('area' in d ? { area: blank(d.area) } : {}) };
      let dev = d.id ? db.devices.find((x) => x.id === d.id) : null;
      if (d.id && !dev) throw new Error('That item was deleted by someone else.');
      if (dev && dev.type_id !== type.id) {
        const keepPorts = new Set(db.typePorts.filter((p) => p.type_id === type.id).map((p) => p.id));
        db.devPorts = db.devPorts.filter((x) => x.device_id !== dev.id || keepPorts.has(x.type_port_id));
      }
      if (dev) {
        const before = clone(dev);
        const next = { ...dev, ...fields };
        number(next, before, payload.numbers || {});
        hangCheck(next, before);
        const keys = [...new Set([...Object.keys(fields), ...NUMBER_KEYS, 'position_id'])];
        const ch = diff(dev, next, keys);
        Object.assign(dev, next, { updated_at: now(), updated_by: me.id });
        if (Object.keys(ch).length) log('updated', 'devices', dev, ch);
      } else {
        dev = { id: uid(), position_id: null, positions: [], used_as: null, area: null, ...fields, ...Object.fromEntries(NUMBER_KEYS.map((k) => [k, null])), created_at: now(), updated_at: now(), created_by: me.id, updated_by: me.id };
        number(dev, null, payload.numbers || {});
        hangCheck(dev, null);
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
      db.installs = db.installs.filter((x) => x.device_id !== id);
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
      if (!tags.length) throw new Error('Pick at least one department: Audio, Video, Lighting or Network.');
      const mfr = blank(t.manufacturer);
      if (db.types.some((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase() && (x.manufacturer || '').toLowerCase() === (mfr || '').toLowerCase())) {
        throw new Error('There’s already a model with that name from that brand.');
      }
      const fields = { name, manufacturer: mfr, part_number: blank(t.part_number), category: blank(t.category), departments: tags, networked: t.networked !== false,
        description: blank(t.description), specs: t.specs || [], manual_url: blank(t.manual_url), notes: blank(t.notes),
        dmx_modes: t.dmx_modes || [], dmx_footprint: t.dmx_footprint || null, ...('unknown' in t ? { unknown: !!t.unknown } : {}) };
      let row = t.id ? db.types.find((x) => x.id === t.id) : null;
      if (row) Object.assign(row, fields, { updated_at: now(), updated_by: me.id });
      else db.types.push((row = { id: uid(), ...fields, created_at: now(), updated_at: now(), created_by: me.id, updated_by: me.id }));
      if ('ports' in payload) {
        const keep = new Set();
        (payload.ports || []).forEach((p, i) => {
          const vals = { name: p.name.trim(), signal: blank(p.signal), connector: blank(p.connector), direction: p.direction || 'io', ...('face' in p ? { face: blank(p.face) } : {}), notes: blank(p.notes), sort_order: i };
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
          status: d.status || 'active', notes: blank(d.notes), projection: blank(d.projection), position_id: null,
          positions: cleanPositions(d.positions), used_as: blank(d.used_as), area: blank(d.area), ...Object.fromEntries(NUMBER_KEYS.map((k) => [k, null])),
          created_at: now(), updated_at: now(), created_by: me.id, updated_by: me.id };
        number(dev, null);
        db.devices.push(dev);
        log('created', 'devices', dev, { name: dev.name });
      }
      changed('devices');
      return names.length;
    },
    async setDeviceStatus(id, status) {
      await wait(120);
      const dev = db.devices.find((d) => d.id === id);
      if (!dev) throw new Error('That item was deleted by someone else.');
      if (dev.status !== status) log('updated', 'devices', dev, { status: [dev.status, status] });
      Object.assign(dev, { status, updated_at: now(), updated_by: me.id });
      changed('devices');
    },
    async setDeviceNumbers(rows) {
      await wait(200);
      const staged = rows.map((r) => {
        const dev = db.devices.find((d) => d.id === r.id);
        if (!dev) return null;
        const next = { ...dev };
        const explicit = Object.fromEntries(NUMBER_KEYS.filter((k) => k in r).map((k) => [k, r[k]]));
        for (const k of Object.keys(explicit)) next[k] = explicit[k] === '' || explicit[k] == null ? null : Number(explicit[k]);
        return { dev, next, explicit };
      }).filter(Boolean);
      // Check everything first so a bad row saves nothing (like one database transaction).
      for (const { dev, next, explicit } of staged) {
        const others = db.devices.filter((d) => d.id !== dev.id).map((d) => staged.find((x) => x.dev === d)?.next || d);
        if (next.asset_no != null && others.some((d) => d.asset_no === next.asset_no)) throw new Error('Another item already has that asset number. Every item has its own.');
        const { asset_no: _skip, ...rest } = explicit; // asset #s were checked above, across the whole batch
        number({ ...next, asset_no: dev.asset_no }, dev, rest);
      }
      for (const { dev, next, explicit } of staged) {
        const ch = diff(dev, next, NUMBER_KEYS);
        if (!Object.keys(ch).length) continue;
        if (next.asset_no == null) number(next, dev, explicit);
        Object.assign(dev, next, { updated_at: now(), updated_by: me.id });
        log('updated', 'devices', dev, ch);
      }
      changed('devices');
      return staged.length;
    },
    // Rigging positions.
    async savePosition(row) {
      await wait(120);
      const name = blank(row.name);
      const cur = row.id ? db.positions.find((p) => p.id === row.id) : null;
      if (row.id && !cur) throw new Error('That position was deleted by someone else.');
      const roomId = row.room_id ?? cur?.room_id;
      if ('name' in row && (!name || name.length > 60)) throw new Error('Give the position a name (up to 60 characters).');
      if ('name' in row && db.positions.some((p) => p.id !== row.id && p.room_id === roomId && p.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('There’s already a position with that name in this room.');
      }
      const fields = { ...row, ...('name' in row ? { name } : {}), ...('notes' in row ? { notes: blank(row.notes) } : {}), updated_at: now(), updated_by: me.id };
      delete fields.id;
      if (cur) { Object.assign(cur, fields); changed('rig_positions'); return cur.id; }
      const made = { id: uid(), sort_order: 0, notes: null, created_at: now(), created_by: me.id, ...fields };
      db.positions.push(made);
      changed('rig_positions');
      return made.id;
    },
    async deletePosition(id) {
      await wait(100);
      db.positions = db.positions.filter((p) => p.id !== id);
      db.devices.forEach((d) => { if (d.position_id === id) d.position_id = null; });
      changed('rig_positions');
    },
    async setDevicePosition(ids, positionId) {
      await wait(150);
      const pos = positionId ? db.positions.find((p) => p.id === positionId) : null;
      if (positionId && !pos) throw new Error('That position was deleted by someone else.');
      for (const id of ids) {
        const dev = db.devices.find((d) => d.id === id);
        if (!dev) continue;
        if (pos && pos.room_id !== dev.room_id) throw new Error('That position is in a different room.');
        const next = positionId || null;
        if ((dev.position_id || null) === next) continue;
        log('updated', 'devices', dev, { position_id: [dev.position_id || null, next] });
        Object.assign(dev, { position_id: next, updated_at: now(), updated_by: me.id });
      }
      changed('devices');
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
    async addRoom(campus_id, name, group_id = null) {
      await wait(120);
      const existing = db.rooms.find((r) => r.campus_id === campus_id && r.name.toLowerCase() === name.toLowerCase());
      if (existing) return clone(existing);
      const g = group_id && db.rooms.find((r) => r.id === group_id);
      if (g && (g.campus_id !== campus_id || g.group_id)) throw new Error('A room can only be part of a group at the same location.');
      const r = { id: uid(), campus_id, name, sort_order: db.rooms.length, group_id: g ? g.id : null };
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

    // Meetings: one example meeting with notes and questions & answers.
    async meetings() { await wait(); return clone(meetingData()); },
    async saveMeetingRow(table, row) {
      await wait(120);
      const list = meetingData()[MEETING_LISTS[table]];
      if (!list) throw new Error('Not a meeting table.');
      const stamp = { updated_at: now(), updated_by: me.id };
      if (row.id) { Object.assign(list.find((x) => x.id === row.id), row, stamp); }
      else {
        const made = { id: uid(), created_at: now(), created_by: me.id, ...stamp, ...row };
        if (table === 'meeting_questions') { made.open = row.open ?? true; made.asked_at = row.asked_at || now(); }
        if (table === 'meeting_answers') { made.answered_at = row.answered_at || now(); const q = meetingData().questions.find((x) => x.id === row.question_id); if (q) q.open = false; }
        if (table === 'meetings') made.starts_at = row.starts_at || now();
        list.push(made);
        row = made;
      }
      changed('meetings');
      return row.id;
    },
    async deleteMeetingRow(table, id) {
      await wait(100);
      const m = meetingData();
      if (table === 'meetings') { m.meetings = m.meetings.filter((x) => x.id !== id); const qs = m.questions.filter((q) => q.meeting_id === id).map((q) => q.id); m.notes = m.notes.filter((x) => x.meeting_id !== id); m.questions = m.questions.filter((x) => x.meeting_id !== id); m.answers = m.answers.filter((a) => !qs.includes(a.question_id)); }
      if (table === 'meeting_notes') m.notes = m.notes.filter((x) => x.id !== id);
      if (table === 'meeting_questions') { m.questions = m.questions.filter((x) => x.id !== id); m.answers = m.answers.filter((a) => a.question_id !== id); }
      if (table === 'meeting_answers') m.answers = m.answers.filter((x) => x.id !== id);
      changed('meetings');
    },

    // Camera builds and haze.
    async gearExtras() { await wait(); return clone(gearData()); },
    async saveGearRow(table, row) {
      await wait(120);
      const list = gearData()[GEAR_LISTS[table]];
      if (!list) throw new Error('Not a gear table.');
      const stamp = { updated_at: now(), updated_by: me.id };
      if (row.id) {
        const r = list.find((x) => x.id === row.id);
        if (!r) throw new Error('That was deleted by someone else.');
        Object.assign(r, row, stamp);
      } else {
        if (table === 'camera_builds' && list.some((b) => b.campus_id === row.campus_id && b.number === row.number)) throw new Error('That camera number is already set up at this location.');
        if (table === 'haze_stock' && list.some((b) => b.campus_id === row.campus_id && b.fluid_id === row.fluid_id)) throw new Error('That fluid is already listed at this location.');
        if (table === 'system_items' && list.some((b) => b.system_id === row.system_id && b.device_id === row.device_id)) throw new Error('That item is already in this system.');
        const made = { id: uid(), created_at: now(), created_by: me.id, ...stamp, ...GEAR_DEFAULTS[table], ...(table === 'haze_checks' ? { checked_at: now() } : {}), ...row };
        list.push(made);
        row = made;
      }
      changed(table);
      return row.id;
    },
    async deleteGearRow(table, id) {
      await wait(100);
      const g = gearData();
      const key = GEAR_LISTS[table];
      if (!key) throw new Error('Not a gear table.');
      g[key] = g[key].filter((x) => x.id !== id);
      if (table === 'systems') g.systemItems = g.systemItems.filter((m) => m.system_id !== id);
      if (table === 'haze_fluids') {
        g.stock = g.stock.filter((r) => r.fluid_id !== id);
        db.types.forEach((t) => { if (t.haze_fluid_id === id) t.haze_fluid_id = null; });
      }
      changed(table);
    },
    async setTypeUnknown(typeId, unknown) {
      await wait(120);
      Object.assign(db.types.find((t) => t.id === typeId), { unknown: !!unknown, updated_at: now() });
      changed('device_types');
    },
    async setHazerModel(typeId, { haze_fluid_id = null, tank_liters = null }) {
      await wait(120);
      Object.assign(db.types.find((t) => t.id === typeId), { haze_fluid_id, tank_liters, updated_at: now() });
      changed('device_types');
    },

    // Cables.
    async cables() { await wait(); return clone({ ...cableData(), rooms: db.rooms }); },
    async saveCableRow(table, row) {
      await wait(110);
      const c = cableData();
      const list = table === 'cable_types' ? c.types : table === 'cables' ? c.cables : null;
      if (!list) throw new Error('Not a cable table.');
      if (table === 'cable_types') {
        const dup = c.types.find((t) => t.id !== row.id && t.signal === (row.signal ?? t.signal) && t.end_a === row.end_a && t.end_b === row.end_b);
        if (dup) throw new Error('That kind of cable is already listed.');
      }
      const stamp = { updated_at: now(), updated_by: me.id };
      if (row.id) {
        const r = list.find((x) => x.id === row.id);
        if (!r) throw new Error('That was deleted by someone else.');
        Object.assign(r, row, stamp);
        changed('cables');
        return r.id;
      }
      const made = { id: uid(), created_at: now(), created_by: me.id, ...stamp, ...(table === 'cables' ? { room_id: null, labeled: false, label_color: null, quantity: 1, notes: null } : { name: null, notes: null }), ...row };
      list.push(made);
      changed('cables');
      return made.id;
    },
    async deleteCableRow(table, id) {
      await wait(90);
      const c = cableData();
      if (table === 'cable_types') { c.types = c.types.filter((t) => t.id !== id); c.cables = c.cables.filter((x) => x.type_id !== id); }
      else c.cables = c.cables.filter((x) => x.id !== id);
      changed('cables');
    },

    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };

  function cableData() {
    if (cablesDb) return cablesDb;
    const storage = db.rooms.find((r) => r.campus_id === 'c-SVL' && r.name === 'Lighting Storage')?.id || null;
    const types = [
      { id: 'ct-dmx3', signal: 'DMX', end_a: 'XLR 3-pin male', end_b: 'XLR 3-pin female', name: null, notes: null },
      { id: 'ct-dmx5', signal: 'DMX', end_a: 'XLR 5-pin male', end_b: 'XLR 5-pin female', name: null, notes: null },
      { id: 'ct-edpc', signal: 'Power', end_a: 'Edison male', end_b: 'PowerCon blue (in)', name: null, notes: null },
      { id: 'ct-pcl', signal: 'Power', end_a: 'PowerCon white (out)', end_b: 'PowerCon blue (in)', name: 'PowerCon link', notes: null },
    ];
    const line = (type_id, length_ft, color = null) => ({ id: uid(), type_id, campus_id: 'c-SVL', room_id: storage, length_ft, labeled: !!color, label_color: color, quantity: 1, notes: null });
    const cables = [];
    for (const n of [3, 5, 10, 15, 20, 25]) {
      cables.push(line('ct-dmx3', n, 'Purple'), line('ct-dmx5', n, 'Blue'), line('ct-edpc', n, n === 25 ? 'Green' : n === 10 ? 'Orange' : null), line('ct-pcl', n));
    }
    cablesDb = { types, cables };
    return cablesDb;
  }

  function gearData() {
    if (gear) return gear;
    const at = (days) => new Date(Date.now() - days * 864e5).toISOString();
    const find = (code, name) => db.devices.find((d) => d.campus_id === 'c-' + code && d.name === name)?.id;
    const check = (code, name, level, days, filled = false) => ({ id: uid(), device_id: find(code, name), level, filled, checked_at: at(days), note: null, created_by: 'p-bethany' });
    gear = {
      builds: [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'cb-' + n, campus_id: 'c-SVL', number: n, in_service: n !== 2 && n !== 6, note: n === 2 ? 'Waiting on a part' : null })),
      fluids: [
        { id: 'hf-phf', manufacturer: 'Chauvet Professional', name: 'Premium Haze Fluid', part_number: 'PHF5L', bottle_liters: 5, base: 'Water-based', notes: null },
        { id: 'hf-hzl', manufacturer: 'Antari', name: 'HZL haze fluid', part_number: 'HZL-1', bottle_liters: 1, base: 'Oil-based', notes: null },
        { id: 'hf-mdg', manufacturer: 'MDG', name: 'Neutral Fog Fluid', part_number: null, bottle_liters: null, base: null, notes: null },
      ],
      stock: [
        { id: 'hs-1', campus_id: 'c-GCC', fluid_id: 'hf-phf', bottles: 3 },
        { id: 'hs-2', campus_id: 'c-SVL', fluid_id: 'hf-hzl', bottles: 5 },
        { id: 'hs-3', campus_id: 'c-SVL', fluid_id: 'hf-mdg', bottles: 3 },
      ],
      checks: [
        check('SVL', 'ATMe', 100, 37, true),
        check('SVL', 'HZ-350', 90, 20),
        check('HB', 'HZ-350', 100, 20, true),
        check('GCC', 'Amhaze Stadium 2X IP', 100, 88),
        check('SVL', 'HZ-350', 20, 2),
      ].filter((c) => c.device_id),
      systems: [{ id: 'sys-1', campus_id: 'c-SVL', name: 'Clear-Com intercom', notes: 'Two-channel, all wired. The MS-702 main station in A Control runs to the director spot and every camera.' }],
      systemItems: db.devices.filter((d) => d.campus_id === 'c-SVL' && /^(MS-702|RS-|CC-)/.test(d.name))
        .map((d) => ({ id: uid(), system_id: 'sys-1', device_id: d.id, role: d.name === 'MS-702' ? 'Main station' : d.name.startsWith('RS-') ? 'Belt pack' : 'Headset' })),
    };
    return gear;
  }

  function meetingData() {
    if (meetings) return meetings;
    const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
    const ago = (min) => new Date(Date.now() - min * 60e3).toISOString(); // today's meeting is already under way
    const mt = { id: 'mt-1', title: 'Friendsgiving production meeting', starts_at: ago(75), campus_id: 'c-SVL', created_by: me.id, updated_by: me.id };
    const past = { id: 'mt-2', title: 'Weekly staff check-in', starts_at: at(-7, 10), campus_id: null, created_by: 'p-tom', updated_by: 'p-tom' };
    const next = { id: 'mt-3', title: 'Christmas services planning', starts_at: at(3, 13, 30), campus_id: 'c-SVL', created_by: me.id, updated_by: me.id };
    const q = (id, meeting_id, body, asked_at, waiting_on, open) => ({ id, meeting_id, body, asked_at, waiting_on, open, created_by: me.id, updated_by: me.id });
    const a = (id, question_id, body, who, answered_at, via) => ({ id, question_id, body, who, answered_at, via, created_by: me.id, updated_by: me.id });
    const n = (id, meeting_id, body, created_at, by = me.id) => ({ id, meeting_id, body, created_at, updated_at: created_at, created_by: by, updated_by: by });
    meetings = {
      meetings: [mt, past, next].map((x) => ({ ...x, created_at: x.starts_at, updated_at: x.starts_at })),
      questions: [
        q('q-1', 'mt-1', 'How many people are coming?', ago(71), 'Student pastor', false),
        q('q-2', 'mt-1', 'Are we doing cameras in the gym?', ago(63), 'Events lead', true),
        q('q-3', 'mt-1', 'What time do doors open?', at(-2, 15), 'Events lead', true),
        q('q-4', 'mt-1', 'Is the balcony open?', ago(55), null, false),
        q('q-5', 'mt-2', 'Who covers lighting on the 15th?', at(-7, 10, 5), null, false),
      ].map((x) => ({ ...x, created_at: x.asked_at, updated_at: x.asked_at })),
      answers: [
        a('a-1', 'q-1', 'About 900 students', 'Student pastor', ago(5), 'Production meeting'),
        a('a-2', 'q-4', 'No, closed off', 'Events lead', ago(51), 'Production meeting'),
        a('a-3', 'q-5', 'The Lighting Lead', 'Lighting Lead', at(-7, 10, 9), 'Weekly staff check-in'),
      ].map((x) => ({ ...x, created_at: x.answered_at, updated_at: x.answered_at })),
      notes: [
        n('n-1', 'mt-1', 'Dinner in the gym, worship after in the auditorium.', ago(69)),
        n('n-2', 'mt-1', 'Students sit on the floor; keep the center aisle clear for the camera.', ago(60), 'p-tom'),
        n('n-3', 'mt-2', 'Lighting console update this week.', at(-7, 10, 2)),
      ],
    };
    return meetings;
  }
}
