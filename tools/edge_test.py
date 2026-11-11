# Edge check: on the pages made to fit the screen (Haze, Patch) nothing may run past the window, on several phone sizes, with and without
# the iOS home-screen gap (--vgap). Needs the app served locally: python3 -m http.server 8777 --bind 127.0.0.1
from playwright.sync_api import sync_playwright
errs=[]; bad=[]
PAGES=[('haze','hb'),('patch','pb')]  # page address, and the prefix of its sheet's classes (.hb-board, .hb-r)
M="() => { const b=document.querySelector('.hb-board').getBoundingClientRect(); const rows=[...document.querySelectorAll('.hb-r')]; const last=rows.at(-1).getBoundingClientRect(); const cut=[...document.querySelectorAll('.hb-r > *, .hb-can, .hb-d b, .hb-nm > *')].filter(e=>{const r=e.getBoundingClientRect(); return r.width && (r.bottom>innerHeight+0.5||r.right>innerWidth+0.5||r.left<-0.5)}).length; return {vh: innerHeight, vw: innerWidth, boardBottom: Math.round(b.bottom), lastBottom: Math.round(last.bottom), right: Math.round(b.right), cut, scroll: document.documentElement.scrollHeight-innerHeight} }"
with sync_playwright() as p:
    b=p.chromium.launch()
    for PAGE, K in PAGES:
        for vgap in (0, 62):
            for size in [(393,852),(440,956),(375,667),(430,932)]:
                c=b.new_context(viewport={'width':size[0],'height':size[1]}, device_scale_factor=2, has_touch=True, is_mobile=True, color_scheme='dark')
                c.add_init_script('window.UCP_PREVIEW = true;'); pg=c.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
                pg.goto('http://127.0.0.1:8777/index.html#'+PAGE); pg.wait_for_timeout(2300)
                if vgap: pg.evaluate(f"document.documentElement.style.setProperty('--vgap','{vgap}px'); window.dispatchEvent(new Event('resize'))"); pg.wait_for_timeout(400)
                m=pg.evaluate(M.replace('.hb-', '.'+K+'-').replace('.pb-can, .pb-d b, .pb-nm > *', '.pb-r > * > *')); ok = m['lastBottom']<=m['vh'] and m['boardBottom']<=m['vh'] and m['right']<=m['vw'] and m['cut']==0
                print('ok ' if ok else 'BAD', PAGE, size, 'vgap', vgap, m)
                if not ok: bad.append((PAGE,size,vgap))
                c.close()
        # The installed iPhone app: the window is either the whole screen, or about a status bar short of it
        # (iOS 26.0). Either way the sheet must end at the bottom of the screen: no gap, nothing past it.
        UA='Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
        for short in (0, 61):
            for sw, sh in [(393,852),(430,932)]:
                c=b.new_context(viewport={'width':sw,'height':sh-short}, screen={'width':sw,'height':sh}, user_agent=UA, device_scale_factor=2, has_touch=True, is_mobile=True, color_scheme='dark')
                c.add_init_script("window.UCP_PREVIEW = true; Object.defineProperty(navigator, 'standalone', { get: () => true });"); pg=c.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
                pg.goto('http://127.0.0.1:8777/index.html#'+PAGE); pg.wait_for_timeout(2300)
                m=pg.evaluate("() => { const r=[...document.querySelectorAll('."+K+"-r')].at(-1).getBoundingClientRect(); return {window: innerHeight, screen: screen.height, lastBottom: Math.round(r.bottom), vgap: getComputedStyle(document.documentElement).getPropertyValue('--vgap')} }")
                ok = abs(m['lastBottom'] - sh) <= 1
                print('ok ' if ok else 'BAD', PAGE, 'iPhone app', (sw, sh), 'window short by', short, m)
                if not ok: bad.append((PAGE,'ios', sw, sh, short))
                c.close()
    b.close()
print('BAD', bad or 'none', 'ERRORS', errs or 'none')
