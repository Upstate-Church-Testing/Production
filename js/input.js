// How the app is being used, for the whole app (started once at boot):
//
// Full screen (computers): a small button in the top right corner puts Tally in the browser's
//   full screen and takes it out again (Esc works too). Only where the browser can and there's
//   a mouse or trackpad: not on phones and iPads, and not in the home-screen app (already
//   full screen). It sits under sheets and menus, and Live hides it (Live has its own).
//
// Touch screens: touching shouldn't leave a mouse pointer sitting where you touched. While
//   you're using touch the pointer is hidden over Tally (html.is-touch); it comes back as soon
//   as a real mouse or trackpad moves. A touch screen the browser reports as touch (Windows,
//   most Chromebooks) is known for sure. One the computer treats as a mouse (most touch
//   monitors on a Mac) can only be told by how it moves: the pointer jumps to a new spot and
//   presses at once, where a mouse travels there first. Tally can't stop the computer moving
//   its own pointer; it only keeps it out of sight over the app while you're touching.

import { icon } from './util.js';

export function watchInput() {
  const root = document.documentElement;
  const set = (touch) => {
    if (root.classList.contains('is-touch') === touch) return;
    root.classList.toggle('is-touch', touch);
  };
  let last = null;      // the last pointer move: where, when, and how far it jumped to get there
  let calm = 0;         // small mouse moves in a row with no button down (a hand on a mouse)
  addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (e.pointerType !== 'mouse') { last = null; calm = 0; return; }
    const jump = last ? Math.hypot(e.clientX - last.x, e.clientY - last.y) : Infinity;
    last = { x: e.clientX, y: e.clientY, t: now, jump };
    // A real mouse or trackpad: several small moves in a row, nothing pressed.
    if (!e.buttons && jump < 40) { calm += 1; if (calm >= 3) set(false); } else calm = 0;
  }, { passive: true, capture: true });
  addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') { set(true); return; }
    if (e.pointerType !== 'mouse') return;
    // Pressed the moment the pointer jumped somewhere new (or with no move before it at all):
    // a finger on a touch screen the computer passes on as a mouse.
    const jumped = !last || (performance.now() - last.t < 80 && last.jump > 60)
      || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 60;
    if (jumped) set(true);
    calm = 0;
  }, { passive: true, capture: true });
}

export function fullscreenButton() {
  const d = document;
  const can = (d.fullscreenEnabled || d.webkitFullscreenEnabled)
    && matchMedia('(hover: hover) and (pointer: fine)').matches
    && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  if (!can || d.querySelector('.fs-btn')) return;
  const b = d.createElement('button');
  b.type = 'button';
  b.className = 'fs-btn';
  const isFull = () => !!(d.fullscreenElement || d.webkitFullscreenElement);
  const paint = () => {
    const on = isFull();
    b.innerHTML = icon(on ? 'shrink' : 'expand');
    b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    b.title = on ? 'Exit full screen (Esc)' : 'Full screen';
    b.setAttribute('aria-pressed', String(on));
  };
  b.addEventListener('click', async () => {
    const el = d.documentElement;
    try {
      if (isFull()) await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
      else await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
    } catch { /* the browser said no */ }
    paint();
  });
  d.addEventListener('fullscreenchange', paint);
  d.addEventListener('webkitfullscreenchange', paint);
  paint();
  d.body.appendChild(b);
}
