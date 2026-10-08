import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

// CI version of the no-JS smoke test, using the repository's pinned Node
// Playwright dependency (rather than requiring a separate Python install).
const [root, repo] = process.argv.slice(2);
if (!root || !repo) throw Error('STEP11_BROWSER_FIXTURE_MISSING');
const tokens=await readFile(join(repo,'styles/tokens.css'),'utf8');
const base=(await readFile(join(repo,'styles/base.css'),'utf8')).replace("@import './tokens.css';",'');
const publicCss=(await readFile(join(repo,'styles/public.css'),'utf8')).replace("@import './base.css';",'');
const styles=`<style>${tokens}\n${base}\n${publicCss}</style>`;
const browser=await chromium.launch({headless:true});
let tests=0;
try {
  for(const [width,path,heading] of [
    [390,'/','Un luogo da scoprire'],[1280,'/','Un luogo da scoprire'],
    [390,'/menu','Il nostro menu'],[390,'/contatti','Contatti']
  ]) {
    const target=path==='/'?join(root,'dist/site/index.html'):join(root,'dist/site',path.slice(1),'index.html');
    const source=await readFile(target,'utf8');
    const page=await browser.newPage({javaScriptEnabled:false,viewport:{width,height:840}});
    try {
      await page.setContent(source.replace('</head>',styles+'</head>'));
      assert.equal((await page.locator('#main h1').innerText()).trim(),heading);tests++;
      assert.equal(await page.locator('a.skip-link').count(),1);tests++;
      assert.equal(await page.locator('nav[aria-label="Principale"]').count(),1);tests++;
      assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth+1),true);tests++;
      if(path==='/menu') {
        assert.equal(await page.getByText('Risotto & limone').count(),1);tests++;
        assert.ok(await page.getByText('Latte',{exact:false}).count()>=1);tests++;
      }
      if(path==='/contatti'){
        assert.equal(await page.locator('a[href="tel:+390000"]').count(),1);tests++;
      }
    } finally {await page.close();}
  }
}finally {await browser.close();}
console.log(`STEP11_STATIC_SITE_NODE_CHROMIUM=PASS (${tests} checks; JS disabled)`);
