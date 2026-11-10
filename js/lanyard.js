// Lanyards, drawn like the real ones: production badges are black and white (the Upstate
// Church mark up top), on a dark blue lanyard. Kinds: volunteer, coach, staff.
//   microBadge(kind): a tiny black badge with a white V, C or S on a stub of lanyard, beside a
//     name on Scheduling, so who has a badge (and who still needs one) shows on the schedule.
//   badgeArt(kind): the badge itself, larger, with the mark and the word, for the profile's
//     lanyard picker. noBadgeArt(): an empty badge outline crossed out in red.

export const LANYARD_LETTER = { volunteer: 'V', coach: 'C', staff: 'S' };
export const LANYARD_WORD = { volunteer: 'Volunteer', coach: 'Coach', staff: 'Staff' };

const NAVY = '#22397a';
const NAVY_DARK = '#16275a';

/** The badge's own black and the hairline that keeps it visible on a dark screen. */
const CARD = '#0d0d0e';
const EDGE = 'rgba(255,255,255,0.55)';

export function microBadge(kind, title = '') {
  const l = LANYARD_LETTER[kind];
  if (!l) return '';
  return `<svg class="lan-micro is-${kind}" viewBox="0 0 12 19" width="12" height="19" role="img" aria-label="${title || `${LANYARD_WORD[kind]} lanyard`}">
    <path d="M2.2 0 6 5.4 9.8 0" fill="none" stroke="${NAVY}" stroke-width="2.1" stroke-linejoin="round"/>
    <circle cx="6" cy="6.1" r="1.05" fill="#9aa0a6"/>
    <rect x="1.4" y="6.7" width="9.2" height="11.8" rx="1.6" fill="${CARD}" stroke="${EDGE}" stroke-width="0.7"/>
    <text x="6" y="15.6" text-anchor="middle" font-size="7.4" font-weight="800" font-family="'Chakra Petch', 'Manrope', system-ui, sans-serif" fill="#fff">${l}</text>
  </svg>`;
}

/** The Upstate Church mark: the ring (cut off by the badge's top and right edges) and the
 *  two interlocking corners inside it. In the badge's 76-wide space, card top at y = 0. */
const MARK = `
  <circle cx="44" cy="29" r="35.5" fill="none" stroke="#fff" stroke-width="6.4"/>
  <path d="M29 7.7h25v7.7H37.6v16.3H29z" fill="#fff"/>
  <path d="M44.3 21h24v9.8H53V47h-8.7z" fill="#fff"/>`;

let artN = 0;
export function badgeArt(kind) {
  const word = LANYARD_WORD[kind];
  if (!word) return noBadgeArt();
  const id = `lan-clip-${++artN}`;
  return `<svg class="lan-art-svg is-${kind}" viewBox="0 0 76 130" role="img" aria-label="${word} badge">
    <defs><clipPath id="${id}"><rect x="0" y="30" width="76" height="100" rx="6"/></clipPath></defs>
    <path d="M14 0 33 26M62 0 43 26" stroke="${NAVY}" stroke-width="10"/>
    <path d="M14 0 33 26M62 0 43 26" stroke="${NAVY_DARK}" stroke-width="1" stroke-dasharray="2 2.4" opacity="0.8"/>
    <rect x="31.5" y="22" width="13" height="7" rx="2" fill="#7d838a"/>
    <path d="M38 28.5v10" stroke="#aab0b6" stroke-width="2.4" stroke-linecap="round"/>
    <rect x="0.5" y="30.5" width="75" height="99" rx="6" fill="${CARD}" stroke="#3a3b3e"/>
    <g clip-path="url(#${id})"><g transform="translate(0 30)">${MARK}</g></g>
    <rect x="32" y="38" width="12" height="2.6" rx="1.3" fill="#2a2a2c"/>
    <text x="38" y="110" text-anchor="middle" font-size="${word.length > 6 ? 11 : 13}" font-weight="700" letter-spacing="0.6" font-family="'Chakra Petch', 'Manrope', system-ui, sans-serif" fill="#fff">${word.toUpperCase()}</text>
    <text x="38" y="120.5" text-anchor="middle" font-size="5" font-weight="600" font-family="'Manrope', system-ui, sans-serif" fill="#bfc0c3">upstatechurch.org</text>
  </svg>`;
}

export function noBadgeArt() {
  return `<svg class="lan-art-svg is-none" viewBox="0 0 76 130" role="img" aria-label="No badge">
    <rect x="1" y="31" width="74" height="98" rx="6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.45"/>
    <path d="M22 64 54 96M54 64 22 96" stroke="#ff4a5c" stroke-width="5" stroke-linecap="round"/>
  </svg>`;
}
