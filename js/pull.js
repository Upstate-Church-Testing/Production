// Pull down to refresh, on touch screens. With the page at its top, dragging down brings a
// small console read-out down from the top middle: a bar that fills as you pull ("Pull to
// refresh"), then "Release to refresh"; letting go there runs onRefresh ("Refreshing", the
// bar sweeping) and says how it ended. Letting go early, or dragging sideways, does nothing.
// Not while something's open over the page or being typed in (busy()), and not from inside
// a list that's scrolled down itself.

const PULL = 120;  // how far a finger has to come down (px) to arm it
const SLACK = 10;  // movement before it's taken as a pull at all

export function initPull({ onRefresh, busy = () => false }) {
  const el = document.createElement('div');
  el.className = 'ptr';
  el.setAttribute('role', 'status');
  el.innerHTML = '<div class="ptr-box"><span class="ptr-t"></span><span class="ptr-bar"><i></i></span></div>';
  document.body.append(el);
  const text = el.querySelector('.ptr-t');
  let from = null;     // where the finger went down
  let pulling = false;
  let armed = false;
  let running = false;

  const say = (t) => { if (text.textContent !== t) text.textContent = t; };
  const show = (p) => {
    el.classList.add('is-on');
    el.style.setProperty('--p', p.toFixed(3));
  };
  const hide = () => {
    el.classList.remove('is-on', 'is-armed', 'is-run', 'is-done');
    el.style.removeProperty('--p');
    pulling = false; armed = false; from = null;
  };
  /** Is anything between what was touched and the page scrolled down by itself? */
  const scrolledInside = (n) => {
    for (; n && n !== document.body && n.nodeType === 1; n = n.parentElement) if (n.scrollTop > 0) return true;
    return false;
  };

  window.addEventListener('touchstart', (e) => {
    if (running || e.touches.length !== 1 || window.scrollY > 0 || busy()) { from = null; return; }
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable="true"]') || scrolledInside(t)) { from = null; return; }
    from = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    pulling = false; armed = false;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!from || running) return;
    const dx = e.touches[0].clientX - from.x;
    const dy = e.touches[0].clientY - from.y;
    if (!pulling) {
      if (Math.abs(dx) > SLACK || dy < -SLACK || window.scrollY > 0) { from = null; return; } // sideways, or up: not a pull
      if (dy < SLACK || dy < Math.abs(dx) * 1.5) return;
      pulling = true;
    }
    if (dy <= 0) { hide(); return; }
    armed = dy >= PULL;
    el.classList.toggle('is-armed', armed);
    say(armed ? 'Release to refresh' : 'Pull to refresh');
    show(Math.min(1, dy / PULL));
  }, { passive: true });

  const end = async () => {
    if (!from || running) return;
    if (!pulling || !armed) { hide(); return; }
    running = true;
    from = null;
    el.classList.remove('is-armed');
    el.classList.add('is-run');
    say('Refreshing');
    let result = 'Up to date';
    try { result = (await Promise.all([onRefresh(), new Promise((r) => setTimeout(r, 550))]))[0] || result; }
    catch { result = 'Couldn’t refresh'; }
    el.classList.remove('is-run');
    el.classList.add('is-done');
    say(result);
    setTimeout(() => { running = false; hide(); }, 900);
  };
  window.addEventListener('touchend', end, { passive: true });
  window.addEventListener('touchcancel', () => { if (!running) hide(); }, { passive: true });
}
