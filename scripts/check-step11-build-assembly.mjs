import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the actual release assembler using the actual public HTML template.
// Network I/O is replaced only at the Supabase RPC boundary.
const root = await mkdtemp(join(tmpdir(), 'plateform-build-site-'));
const source = process.cwd();
let tests = 0;
const check = (fn) => {
  fn();
  tests++;
};
const checkAsync = async (fn) => {
  await fn();
  tests++;
};
try {
  for (const dir of ['scripts', 'dist/public', 'dist/staff', 'dist/site/old-menu'])
    await mkdir(join(root, dir), { recursive: true });
  await cp(join(source, 'scripts/build-site.mjs'), join(root, 'scripts/build-site.mjs'));
  await cp(
    join(source, 'scripts/prerender-public.mjs'),
    join(root, 'scripts/prerender-public.mjs'),
  );
  const original = await readFile(join(source, 'apps/public/index.html'), 'utf8');
  const built = original.replaceAll('%BASE_URL%', '/').replace('./main.ts', '/assets/public.js');
  await writeFile(join(root, 'dist/public/index.html'), built);
  await writeFile(
    join(root, 'dist/staff/index.html'),
    '<!doctype html><script src="/staff/assets/staff.js"></script>',
  );
  await writeFile(join(root, 'dist/site/old-menu/index.html'), 'OLD_PUBLISHED_CONTENT');
  await writeFile(
    join(root, 'scripts/mock-rpc.mjs'),
    `
const origin='https://ristorante.example.org';
const site={name:'Ristorante <pericoloso>',branding:{},content:{hero_title:'Un luogo da scoprire',story:'Cucina & territorio'},multi_venue:false,venues:[{id:'00000000-0000-4000-8000-000000000001',slug:'centro',name:'Centro',address:'Via Test, 1',phone:'+390000'}]};
const indexable=process.env.TEST_INDEXABLE==='yes';
globalThis.fetch=async (input,init)=>{
 const fn=String(input).split('/').at(-1),arg=JSON.parse(init.body);
 let data;
 if(fn==='get_public_site')data=site;
 if(fn==='get_public_sitemap_entries')data={indexable,urls:indexable?[{path:'/',loc:origin+'/'},{path:'/menu',loc:origin+'/menu'},{path:'/contatti',loc:origin+'/contatti'}]:[]};
 if(fn==='get_public_page_metadata')data={path:arg.p_path,title:'Cucina & ospitalità',description:'Sapori locali',robots:indexable?'index,follow':'noindex,nofollow',canonical_url:indexable?origin+arg.p_path:null};
 if(fn==='get_public_menu')data=[{name:'Risotto & limone',category_name:'Primi',description:'Piatto del giorno',allergens:[{name:'Latte'}]}];
 return {ok:data!==undefined,status:data===undefined?404:200,json:async()=>data};
};`,
  );
  const run = (indexable) =>
    spawnSync(process.execPath, ['--import', './scripts/mock-rpc.mjs', 'scripts/build-site.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PAGES_MODE: 'commercial',
        PUBLIC_SITE_ORIGIN: 'https://ristorante.example.org',
        VITE_SUPABASE_URL: 'https://project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        TEST_INDEXABLE: indexable ? 'yes' : 'no',
      },
    });
  let output = run(true);
  check(() => assert.equal(output.status, 0, output.stderr));
  const first = await readFile(join(root, 'dist/site/index.html'), 'utf8');
  const menu = await readFile(join(root, 'dist/site/menu/index.html'), 'utf8');
  const robots = await readFile(join(root, 'dist/site/robots.txt'), 'utf8');
  const map = await readFile(join(root, 'dist/site/sitemap.xml'), 'utf8');
  check(() => assert.match(first, /Un luogo da scoprire/));
  check(() => assert.match(first, /aria-busy="false"/));
  check(() =>
    assert.match(first, /<link rel="canonical" href="https:\/\/ristorante\.example\.org\/">/),
  );
  check(() => assert.match(first, /Ristorante &lt;pericoloso&gt;/));
  check(() => assert.match(menu, /Risotto &amp; limone/));
  check(() => assert.match(robots, /Sitemap: https:\/\/ristorante\.example\.org\/sitemap.xml/));
  check(() => assert.match(map, /\/contatti/));
  check(() => assert.doesNotMatch(first, /<script>pericoloso<\/script>/));
  check(() => assert.match(first, /skip-link/));
  const browserMode = process.argv.includes('--browser-python')
    ? { executable: 'python', script: 'check-step11-built-site-browser.py' }
    : process.argv.includes('--browser-node')
      ? { executable: process.execPath, script: 'check-step11-built-site-browser.mjs' }
      : null;
  if (browserMode) {
    const browser = spawnSync(
      browserMode.executable,
      [join(source, 'scripts', browserMode.script), root, source],
      { cwd: root, encoding: 'utf8', timeout: 25000 },
    );
    check(() => assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`));
    console.log(browser.stdout.trim());
  }
  // With an unindexable environment, a fresh release must remove every prior
  // SEO page and sitemap (including pages removed since an earlier build).
  output = run(false);
  check(() => assert.equal(output.status, 0, output.stderr));
  const second = await readFile(join(root, 'dist/site/index.html'), 'utf8');
  const blocked = await readFile(join(root, 'dist/site/robots.txt'), 'utf8');
  check(() => assert.match(second, /noindex,nofollow/));
  check(() => assert.match(blocked, /Disallow: \/\n/));
  await checkAsync(() => assert.rejects(access(join(root, 'dist/site/old-menu/index.html'))));
  await checkAsync(() => assert.rejects(access(join(root, 'dist/site/menu/index.html'))));
  await checkAsync(() => assert.rejects(access(join(root, 'dist/site/sitemap.xml'))));
  // Preview mode must always be unindexable, path-prefixed and without a CNAME.
  await writeFile(
    join(root, 'dist/staff/index.html'),
    '<!doctype html><script src="/plateform-core/staff/assets/staff.js"></script>',
  );
  const preview = spawnSync(
    process.execPath,
    ['--import', './scripts/mock-rpc.mjs', 'scripts/build-site.mjs'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PAGES_MODE: 'test',
        PUBLIC_SITE_ORIGIN: 'https://ambrogiocorti.github.io/plateform-core',
        VITE_SUPABASE_URL: 'https://project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        PAGES_CUSTOM_DOMAIN: '',
      },
    },
  );
  check(() => assert.equal(preview.status, 0, preview.stderr));
  const previewHtml = await readFile(join(root, 'dist/site/index.html'), 'utf8');
  const fallback = await readFile(join(root, 'dist/site/404.html'), 'utf8');
  const previewRobots = await readFile(join(root, 'dist/site/robots.txt'), 'utf8');
  check(() => assert.match(previewHtml, /noindex,nofollow/));
  check(() => assert.ok(fallback.includes('plateform-core/')));
  check(() => assert.ok(previewRobots.includes('Disallow: /')));
  await checkAsync(() => assert.rejects(access(join(root, 'dist/site/CNAME'))));
  await checkAsync(() => assert.rejects(access(join(root, 'dist/site/sitemap.xml'))));
  console.log(
    `STEP11_INTEGRATED_BUILD_ASSEMBLY=PASS (${tests} assertions, real public index.html, isolated RPC transport)`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
