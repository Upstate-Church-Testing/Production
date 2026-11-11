# Edge check: on the Haze page nothing may run past the window, on several phone sizes, with and without
# the iOS home-screen gap (--vgap). Needs the app served locally: python3 -m http.server 8777 --bind 127.0.0.1
from playwright.sync_api import sync_playwright
errs=[]; bad=[]
M="() => { const b=document.querySelector('.hb-board').getBoundingClientRect(); const rows=[...document.querySelectorAll('.hb-r')]; const last=rows.at(-1).getBoundingClientRect(); const cut=[...document.querySelectorAll('.hb-r > *, .hb-can, .hb-d b, .hb-nm > *')].filter(e=>{const r=e.getBoundingClientRect(); return r.width && (r.bottom>innerHeight+0.5||r.right>innerWidth+0.5||r.left<-0.5)}).length; return {vh: innerHeight, vw: innerWidth, boardBottom: Math.round(b.bottom), lastBottom: Math.round(last.bottom), right: Math.round(b.right), cut, scroll: document.documentElement.scrollHeight-innerHeight} }"
with sync_playwright() as p:
    b=p.chromium.launch()
    for vgap in (0, 62):
        for size in [(393,852),(440,956),(375,667),(430,932)]:
            c=b.new_context(viewport={'width':size[0],'height':size[1]}, device_scale_factor=2, has_touch=True, is_mobile=True, color_scheme='dark')
            c.add_init_script('window.UCP_PREVIEW = true;'); pg=c.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto('http://127.0.0.1:8777/index.html#haze'); pg.wait_for_timeout(2300)
            if vgap: pg.evaluate(f"document.documentElement.style.setProperty('--vgap','{vgap}px'); window.dispatchEvent(new Event('resize'))"); pg.wait_for_timeout(400)
            m=pg.evaluate(M); ok = m['lastBottom']<=m['vh'] and m['boardBottom']<=m['vh'] and m['right']<=m['vw'] and m['cut']==0
            print('ok ' if ok else 'BAD', size, 'vgap', vgap, m)
            if not ok: bad.append((size,vgap))
            c.close()
    b.close()
print('BAD', bad or 'none', 'ERRORS', errs or 'none')
