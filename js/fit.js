// A sheet that fills what's left of the screen, so its page needn't scroll (Haze, Patch).

/** Where the screen really ends, measured now. The iPhone home-screen app sometimes
 *  reports its window about a status bar shorter than the screen it fills (iOS 26.0), and
 *  sometimes not, changing without notice: so the screen's own height is used there
 *  whenever the window is within a status bar of it (further off is a keyboard). */
export function screenBottom() {
  const ios = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!(ios && standalone)) return window.innerHeight;
  const tall = window.innerHeight > window.innerWidth;
  const full = tall ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const short = full - window.innerHeight;
  return short >= 0 && short <= 90 ? full : window.innerHeight;
}

/** Makes `board` as tall as the screen has left under it (less its own bottom margin, which
 *  keeps it clear of the home bar): never past the bottom, never short of it. While what's
 *  in it fits, the page holds still (html.hb-lock: no scrolling, no bounce); if it can't
 *  (a very short screen), the lock comes off and it scrolls. Returns whether it fits. */
export function fitBoard(board) {
  const root = document.documentElement;
  root.classList.add('hb-lock'); // (measured as it will be: the page's home-bar strip gone)
  const top = board.getBoundingClientRect().top + window.scrollY;
  const room = screenBottom();
  let h = Math.max(0, Math.floor(room - top - (parseFloat(getComputedStyle(board).marginBottom) || 0)));
  board.style.height = `${h}px`;
  // Anything else still under it comes off too, and so does whatever of the sheet itself
  // is past the window's edge.
  const over = Math.max(root.scrollHeight - room, Math.ceil(board.getBoundingClientRect().bottom) - room);
  if (over > 0 && over < h) { h -= over; board.style.height = `${h}px`; }
  // (A few px of leeway: lines still rising into place on opening count as taller.)
  const fits = board.scrollHeight <= board.clientHeight + 8;
  root.classList.toggle('hb-lock', fits);
  return fits;
}

/** Lets the page scroll again (leaving a fitted page, or opening a long one). */
export function unlockPage() { document.documentElement.classList.remove('hb-lock'); }

/** Calls `again` whenever the window's height changes, resize event or not (see screenBottom).
 *  Returns a function that stops it. */
export function watchHeight(again) {
  let seen = window.innerHeight;
  const onResize = () => { seen = window.innerHeight; again(); };
  let t = null;
  const soon = () => { clearTimeout(t); t = setTimeout(onResize, 100); };
  window.addEventListener('resize', soon);
  window.visualViewport?.addEventListener('resize', soon);
  const poll = setInterval(() => { if (window.innerHeight !== seen) onResize(); }, 1000);
  return () => { clearTimeout(t); clearInterval(poll); window.removeEventListener('resize', soon); window.visualViewport?.removeEventListener('resize', soon); };
}
