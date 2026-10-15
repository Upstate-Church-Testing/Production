// Small shared helpers: escaping, IPv4 math, formatting, clipboard, icons.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function storage(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- IPv4 ----

/** "10.1.2.3" → 167838211, or null when it isn't a valid IPv4 address. */
export function ipToInt(s) {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

export const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Splits "10.1.2.3/24" (Postgres inet text) into { addr, prefix }. */
export function splitInet(v) {
  if (!v) return { addr: '', prefix: null };
  const [addr, p] = String(v).split('/');
  return { addr, prefix: p == null ? null : Number(p) };
}

export const prefixToMask = (p) => (p == null ? '' : intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0));

/** Accepts "255.255.255.0", "/24" or "24". Returns a prefix length or null. */
export function maskToPrefix(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const slash = /^\/?(\d{1,2})$/.exec(t);
  if (slash) { const p = Number(slash[1]); return p <= 32 ? p : null; }
  const n = ipToInt(t);
  if (n == null) return null;
  const inv = (~n) >>> 0;
  if ((inv & (inv + 1)) !== 0) return null; // must be contiguous ones
  return 32 - Math.log2(inv + 1);
}

/** "10.50.10.0/24" → { base, prefix, first, last, size } */
export function parseCidr(s) {
  const [a, p] = String(s ?? '').split('/');
  const base = ipToInt(a);
  const prefix = p == null ? 32 : Number(p);
  if (base == null || !(prefix >= 0 && prefix <= 32)) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (base & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  const hosts = prefix >= 31 ? bcast - net + 1 : Math.max(0, bcast - net - 1);
  return { base: net, prefix, mask, first: prefix >= 31 ? net : net + 1, last: prefix >= 31 ? bcast : bcast - 1, size: hosts };
}

export function inCidr(ipInt, cidr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  return !!c && ipInt != null && ((ipInt & c.mask) >>> 0) === c.base;
}

/** First unused host address in a subnet, skipping the gateway. */
export function nextFreeIp(cidr, usedInts, gatewayInt) {
  const c = parseCidr(cidr);
  if (!c) return null;
  const used = new Set(usedInts);
  if (gatewayInt != null) used.add(gatewayInt);
  for (let n = c.first; n <= c.last && n - c.first < 70000; n++) if (!used.has(n)) return intToIp(n);
  return null;
}

/** Accepts aa:bb:cc:dd:ee:ff, aa-bb-…, aabb.ccdd.eeff or aabbccddeeff. */
export function normMac(s) {
  const hex = String(s ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/../g).join(':');
}

// ------------------------------------------------------------ formatting --

export function timeAgo(d) {
  const t = typeof d === 'string' ? Date.parse(d) : +d;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const days = Math.round(h / 24); if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// ------------------------------------------------------------- clipboard --

export async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackEl) {
      const r = document.createRange();
      r.selectNodeContents(fallbackEl);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
    return false;
  }
}

// ----------------------------------------------------------------- icons --

const paths = {
  network: '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/><path d="M6.5 8v8M17.5 16v-3.5h-11"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.4 6-5.4s5.4 2 6 5.4"/><path d="M15.5 4.9a3.2 3.2 0 0 1 0 6.2M17.6 14.8c1.9.7 3.1 2.5 3.4 5.2"/>',
  me: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c.8-4 3.8-6.4 7.5-6.4s6.7 2.4 7.5 6.4"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V20H4z"/><path d="M10 20v-5h4v5"/>',
  box: '<path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  open: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  warn: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9M12 8v4.5l3 2"/>',
  out: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h9.5"/>',
  wand: '<path d="m4 20 11-11M14 4v2M19 9h2M17.5 5.5 19 4M9 4.5l.5 1.5M18.5 13.5 20 14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chart: '<path d="M4.5 19.5h15"/><path d="M7 16.5v-5M11.5 16.5V7M16 16.5v-8"/>',
  camera: '<path d="M4 8.5h3.2l1.6-2.5h6.4l1.6 2.5H20v10.5H4z"/><circle cx="12" cy="13.2" r="3.4"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  live: '<circle cx="12" cy="12" r="2"/><path d="M8.6 8.6a4.8 4.8 0 0 0 0 6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8M5.7 5.7a8.9 8.9 0 0 0 0 12.6M18.3 5.7a8.9 8.9 0 0 1 0 12.6"/>',
  play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2a.8.8 0 0 0-1.2.7z"/>',
  sound: '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
