from playwright.sync_api import sync_playwright
from pathlib import Path
script=Path('/tmp/plateform-public-navigation-test.js').read_text()
assertions=0
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={"width":390,"height":844})
 page.set_content('''<html><head><style>@media(max-width:780px){#nav{display:none}#nav.is-open{display:block}}@media(min-width:781px){#nav{display:block}}</style></head><body><header id="header"><button id="toggle" aria-expanded="false" aria-controls="nav">Menu</button><nav id="nav"><a id="link" href="#section">Section</a></nav></header><main><button id="outside">Outside</button></main></body></html>''')
 page.add_script_tag(content=script)
 page.evaluate('''() => { window.navAbort = new AbortController(); setupPublicNavigation(document.querySelector('#toggle'),document.querySelector('#nav'),document.querySelector('#header'),window.navAbort.signal); }''')
 toggle=page.locator('#toggle')
 toggle.click();assert toggle.get_attribute('aria-expanded')=='true';assertions+=1
 toggle.press('Escape');assert toggle.get_attribute('aria-expanded')=='false';assertions+=1
 assert page.evaluate('document.activeElement.id')=='toggle';assertions+=1
 toggle.click();page.locator('#outside').click();assert toggle.get_attribute('aria-expanded')=='false';assertions+=1
 toggle.click();page.locator('#link').click();assert toggle.get_attribute('aria-expanded')=='false';assertions+=1
 toggle.click();page.set_viewport_size({'width':1200,'height':844});page.wait_for_timeout(50);assert toggle.get_attribute('aria-expanded')=='false';assertions+=1
 page.set_viewport_size({'width':390,'height':844});toggle.click();page.evaluate('window.navAbort.abort()');assert toggle.get_attribute('aria-expanded')=='false';assertions+=1
 browser.close()
print(f'STEP11_RECOVERED_MOBILE_DOM=PASS ({assertions} assertions)')
