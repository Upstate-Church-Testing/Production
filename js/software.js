// Software on the gear: titles (ProPresenter, Companion…), the version of each on a
// computer (software_installs), and the computer's operating system, which is read from
// the item's Firmware / OS field ("macOS Tahoe 26.1") so it's only written in one place.

import { esc } from './util.js';

/** Kinds of item that run software, by category. */
const COMPUTER_CATS = /^(computers?|laptops?|tablets?|desktops?|servers?)$/i;
// macOS releases by major version, for an OS written without its name ("macOS 26.1").
export const MAC_RELEASE = { 27: 'Golden Gate', 26: 'Tahoe', 15: 'Sequoia', 14: 'Sonoma', 13: 'Ventura', 12: 'Monterey', 11: 'Big Sur' };
const OS_RE = /^\s*(macOS|Mac OS X|OS X|iPadOS|iOS|Windows|Ubuntu|Linux|ChromeOS)\b\s*(.*)$/i;
const FAMILY = { macos: 'macOS', 'mac os x': 'macOS', 'os x': 'macOS', ipados: 'iPadOS', ios: 'iOS', windows: 'Windows', ubuntu: 'Ubuntu', linux: 'Linux', chromeos: 'ChromeOS' };
const FAMILY_ORDER = ['macOS', 'iPadOS', 'iOS', 'Windows', 'Ubuntu', 'Linux', 'ChromeOS'];
const FAMILY_MAKER = { macOS: 'Apple', iPadOS: 'Apple', iOS: 'Apple', Windows: 'Microsoft', ChromeOS: 'Google', Ubuntu: 'Canonical' };
/** Logos drawn in the text color (the file is used as a mask), so they work in light and dark. */
const MONO = new Set(['apple.svg']);

/** The operating system an item runs, read from its Firmware / OS field, or null.
 *  "macOS Tahoe 26.0.1" → { family: 'macOS', release: 'Tahoe', version: '26.0.1' }. */
export function osOf(d) {
  const m = OS_RE.exec(d?.firmware || '');
  if (!m) return null;
  const family = FAMILY[m[1].toLowerCase()];
  let rest = m[2].trim();
  let release = null;
  const named = /^([A-Za-z][A-Za-z ]*?)\s+(\d.*)$/.exec(rest); // "Tahoe 26.1", "Big Sur 11.7"
  if (named) { release = named[1].trim(); rest = named[2].trim(); }
  else if (/^[A-Za-z][A-Za-z ]*$/.test(rest)) { release = rest; rest = ''; } // "macOS Sequoia"
  const version = rest || null;
  if (family === 'macOS' && !release && version) release = MAC_RELEASE[parseInt(version, 10)] || null;
  return { family, release, version, label: [release, version].filter(Boolean).join(' ') || family };
}

/** Whether an item is something software runs on: a computer or tablet, or anything with an OS written down. */
export function runsSoftware(d, t) {
  return COMPUTER_CATS.test(String(t?.category || '').trim()) || !!osOf(d);
}

/** Compares two version strings the way people read them: 21.10 is after 21.9. */
export function cmpVersion(a, b) {
  const pa = String(a ?? '').match(/\d+|[^\d.\s]+/g) || [];
  const pb = String(b ?? '').match(/\d+|[^\d.\s]+/g) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x - +y; continue; }
    if (nx !== ny) return nx ? 1 : -1;
    const c = x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}

export const familyRank = (f) => { const i = FAMILY_ORDER.indexOf(f); return i < 0 ? 99 : i; };
export const familyMaker = (f) => FAMILY_MAKER[f] || null;
export const familyLogo = (f) => (['macOS', 'iPadOS', 'iOS'].includes(f) ? 'apple.svg' : null);

/** A title's logo: its file in icons/software/, or its initials when it has none. */
export function logoHtml(name, logo, size = '') {
  const cls = `sw-logo ${size}`;
  if (logo && /^[a-z0-9-]+\.(svg|png)$/.test(logo)) {
    const src = `icons/software/${logo}`;
    return MONO.has(logo)
      ? `<span class="${cls} is-mono" aria-hidden="true"><i style="--logo:url('${src}')"></i></span>`
      : `<span class="${cls}" aria-hidden="true"><img src="${src}" alt=""></span>`;
  }
  const initials = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<span class="${cls} is-initials" aria-hidden="true">${esc(initials || '?')}</span>`;
}

/** "Nov 5" (or "Nov 5, 2025" in another year) from yyyy-mm-dd. */
export function asOf(day) {
  if (!day) return '';
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) };
  return d.toLocaleDateString('en-US', opts);
}

/** Today as yyyy-mm-dd, in this device's time zone. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The software on each item: Map device id → [{ ...install, sw }], A–Z by title. */
export function installsByDevice(data) {
  const swById = new Map((data.software || []).map((x) => [x.id, x]));
  const out = new Map();
  for (const i of data.installs || []) {
    const sw = swById.get(i.software_id);
    if (!sw) continue;
    if (!out.has(i.device_id)) out.set(i.device_id, []);
    out.get(i.device_id).push({ ...i, sw });
  }
  for (const list of out.values()) list.sort((a, b) => a.sw.name.localeCompare(b.sw.name));
  return out;
}

/** "22 (369098928)" */
export const versionText = (i) => `${i.version}${i.build ? ` (${i.build})` : ''}`;
