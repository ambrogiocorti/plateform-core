"""Browser assertions on the actual static HTML assembler output; no simulated DOM renderer."""
import pathlib
import shutil
import sys
from playwright.sync_api import sync_playwright

root = pathlib.Path(sys.argv[1])
repo = pathlib.Path(sys.argv[2])
css = (repo / 'styles/tokens.css').read_text()
css += '\n' + (repo / 'styles/base.css').read_text().replace("@import './tokens.css';", '')
css += '\n' + (repo / 'styles/public.css').read_text().replace("@import './base.css';", '')
checks = 0

def check(condition, message):
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1

with sync_playwright() as p:
    browser_path = shutil.which('chromium') or shutil.which('chromium-browser') or shutil.which('google-chrome')
    browser = p.chromium.launch(
        **({'executable_path': browser_path} if browser_path else {}),
        headless=True,
        args=['--no-sandbox'],
    )
    try:
        for width, path, heading in [
            (390, '/', 'Un luogo da scoprire'),
            (1280, '/', 'Un luogo da scoprire'),
            (390, '/menu', 'Il nostro menu'),
            (390, '/contatti', 'Contatti'),
        ]:
            file = root / 'dist/site' / path.lstrip('/') / 'index.html'
            source = file.read_text(encoding='utf8')
            html = source.replace('</head>', '<style>' + css + '</style></head>')
            page = browser.new_page(java_script_enabled=False, viewport={'width': width, 'height': 840})
            page.set_content(html, wait_until='domcontentloaded')
            check(page.locator('main#main h1').inner_text().strip() == heading, 'heading mismatch: '+path)
            check(page.locator('a.skip-link').count() == 1, 'skip link missing: '+path)
            check(page.locator('nav[aria-label="Principale"]').count() == 1, 'navigation missing: '+path)
            check(page.locator('body').evaluate('(el) => el.scrollWidth <= window.innerWidth + 1'), 'horizontal overflow: '+path)
            check(page.locator('html pericoloso').count() == 0, 'untrusted name became markup')
            if path == '/':
                check('Cucina & territorio' in page.locator('#main').inner_text(), 'home editorial body missing')
                page.keyboard.press('Tab')
                check(page.evaluate('document.activeElement?.classList.contains("skip-link")'), 'skip link not keyboard focusable')
                # Compare the real CSS light/dark button palette, not just tokens.
                for theme in ('dark', 'light'):
                    page.evaluate("document.documentElement.setAttribute('data-theme', arguments[0])".replace('arguments[0]', repr(theme)))
                    css_colors = page.evaluate("""() => {
                        const b=document.createElement('button'); b.className='button primary';
                        document.body.appendChild(b); const cs=getComputedStyle(b);
                        const pair=[cs.color,cs.backgroundColor];b.remove();return pair;
                    }""")
                    def lum(value):
                        import re
                        channels = [int(x)/255 for x in re.findall(r'\d+',value)[:3]]
                        linear = [c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4 for c in channels]
                        return sum(x*w for x,w in zip(linear, [0.2126,0.7152,0.0722]))
                    c1,c2=map(lum,css_colors)
                    check((max(c1,c2)+.05)/(min(c1,c2)+.05) >= 4.5, 'button contrast: '+theme)
            if path == '/menu':
                check(page.get_by_text('Risotto & limone').count() == 1, 'static menu dish missing')
                check(page.get_by_text('Latte', exact=False).count() >= 1, 'static allergen missing')
            if path == '/contatti':
                check(page.locator('a[href="tel:+390000"]').count() == 1, 'contact telephone missing')
            page.close()
    finally:
        browser.close()
print(f'STEP11_STATIC_SITE_CHROMIUM=PASS ({checks} checks; JavaScript disabled; desktop/mobile)')
