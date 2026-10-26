import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prerenderPublic, renderPublicBody } from './prerender-public.mjs';
import {
  mayUseUnindexedPreviewShell,
  writeUnindexedPreviewShell,
} from './public-prerender-fallback.mjs';
const root = await mkdtemp(join(tmpdir(), 'plateform-prerender-'));
const template =
  '<!doctype html><html><head><meta name="description" content="base"/><title>base</title></head><body><div id="app"></div><script type="module" src="/assets/index-abc.js"></script></body></html>';
const site = {
  name: 'Ristorante <script>alert(1)</script>',
  content: { hero_title: 'La nostra cucina', story: 'Ambiente & ospitalità' },
  multi_venue: false,
  venues: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'centro',
      name: 'Centro',
      address: 'Via 1',
      phone: '+390000',
    },
  ],
};
const origin = 'https://ristorante.example.org';
const methods = {
  get_public_site: site,
  get_public_sitemap_entries: {
    indexable: true,
    urls: [
      { path: '/', loc: origin + '/' },
      { path: '/menu', loc: origin + '/menu' },
      { path: '/contatti', loc: origin + '/contatti' },
    ],
  },
  get_public_page_metadata: (args) => ({
    path: args.p_path,
    title: 'Titolo <test>',
    description: 'Descrizione & piatti',
    canonical_url: origin + args.p_path,
    robots: 'index,follow',
  }),
  get_public_menu: [
    {
      id: 'd1',
      name: 'Pasta & vino',
      category_name: 'Primi',
      description: 'Pomodoro',
      allergens: [{ name: 'Glutine' }],
    },
  ],
};
const calls = [];
const fetcher = async (url, options) => {
  const fn = url.split('/').pop();
  const args = JSON.parse(options.body);
  calls.push({ fn, args });
  const data = typeof methods[fn] === 'function' ? methods[fn](args) : methods[fn];
  if (data === undefined) return { ok: false, status: 404 };
  return { ok: true, json: async () => data };
};
await writeFile(join(root, 'index.html'), template);
let count = 0;
const test = (fn) => {
  fn();
  count++;
};
const output = await prerenderPublic({
  distDir: root,
  siteOrigin: origin,
  supabaseUrl: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_test',
  fetcher,
});
test(() => assert.equal(output.route_count, 3));
const main = await readFile(join(root, 'index.html'), 'utf8');
const menu = await readFile(join(root, 'menu/index.html'), 'utf8');
const contacts = await readFile(join(root, 'contatti/index.html'), 'utf8');
const xml = await readFile(join(root, 'sitemap.xml'), 'utf8');
const robots = await readFile(join(root, 'robots.txt'), 'utf8');
test(() => assert.match(main, /La nostra cucina/));
test(() => assert.match(main, /aria-busy="false"/));
test(() => assert.match(main, /Titolo &lt;test&gt;/));
test(() => assert.doesNotMatch(main, /<script>alert\(1\)<\/script>/));
test(() => assert.match(menu, /Pasta &amp; vino/));
test(() => assert.match(menu, /Glutine/));
test(() => assert.match(contacts, /Centro/));
test(() => assert.match(xml, /sitemap/));
test(() => assert.match(robots, /Disallow: \/staff\//));
test(() =>
  assert.equal(
    calls.some((x) => x.fn === 'get_public_menu'),
    true,
  ),
);
test(() => assert.throws(() => renderPublicBody('/staff', site), /UNSUPPORTED_PUBLIC_ROUTE/));
// Fail closed for forged origin and forbidden JWT roles.
await writeFile(join(root, 'index.html'), template);
await assert.rejects(
  () =>
    prerenderPublic({
      distDir: root,
      siteOrigin: 'https://evil.example',
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      fetcher,
    }),
  /PUBLIC_ORIGIN_MISMATCH/,
);
count++;
const jwt =
  'eyJhbGciOiJIUzI1NiJ9.' +
  Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') +
  '.x';
await writeFile(join(root, 'index.html'), template);
await assert.rejects(
  () =>
    prerenderPublic({
      distDir: root,
      siteOrigin: origin,
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: jwt,
      fetcher,
    }),
  /FORBIDDEN_BROWSER_API_KEY/,
);
count++;
const badFetch = async (url, options) => {
  const name = url.split('/').pop();
  return {
    ok: true,
    json: async () =>
      name === 'get_public_sitemap_entries'
        ? { indexable: true, urls: [{ path: '/staff', loc: origin + '/staff' }] }
        : name === 'get_public_site'
          ? site
          : methods.get_public_page_metadata(JSON.parse(options.body)),
  };
};
await writeFile(join(root, 'index.html'), template);
await assert.rejects(
  () =>
    prerenderPublic({
      distDir: root,
      siteOrigin: origin,
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      fetcher: badFetch,
    }),
  /UNSUPPORTED_SITEMAP_ROUTE/,
);
count++;
// A temporary sub-folder site (GitHub Pages project link) must never be indexed, and its
// prerendered links must carry the folder.
// Even when the restaurant already set its own (indexable) domain, the folder build stays
// noindex and carries no canonical or sitemap.
await writeFile(join(root, 'index.html'), template);
const folderIndexable = await prerenderPublic({
  distDir: root,
  siteOrigin: 'https://ambrogiocorti.github.io',
  supabaseUrl: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_test',
  base: '/plateform/',
  fetcher,
});
test(() => assert.deepEqual(folderIndexable, { route_count: 1, indexable: false }));
const folderIndexableHome = await readFile(join(root, 'index.html'), 'utf8');
test(() => assert.match(folderIndexableHome, /<meta name="robots" content="noindex,nofollow">/));
test(() => assert.doesNotMatch(folderIndexableHome, /rel="canonical"/));
const folderIndexableRobots = await readFile(join(root, 'robots.txt'), 'utf8');
test(() => assert.equal(folderIndexableRobots, 'User-agent: *\nDisallow: /\n'));
const noindexFetcher = async (url, options) => {
  const fn = url.split('/').pop();
  if (fn === 'get_public_sitemap_entries')
    return { ok: true, json: async () => ({ indexable: false, urls: [] }) };
  if (fn === 'get_public_page_metadata')
    return {
      ok: true,
      json: async () => ({
        path: '/',
        title: 'Titolo',
        description: '',
        canonical_url: null,
        robots: 'noindex,nofollow',
      }),
    };
  return fetcher(url, options);
};
await writeFile(join(root, 'index.html'), template);
await prerenderPublic({
  distDir: root,
  siteOrigin: 'https://ambrogiocorti.github.io',
  supabaseUrl: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_test',
  base: '/plateform/',
  fetcher: noindexFetcher,
});
const folderHome = await readFile(join(root, 'index.html'), 'utf8');
test(() => assert.match(folderHome, /href="\/plateform\/menu"/));
test(() => assert.doesNotMatch(folderHome, /href="\/menu"/));
const folderRobots = await readFile(join(root, 'robots.txt'), 'utf8');
test(() => assert.match(folderRobots, /Disallow: \/\n/));
// A fresh install (no restaurant configured yet) publishes the untouched app shell, never indexed.
await writeFile(join(root, 'index.html'), template);
const fresh = await prerenderPublic({
  distDir: root,
  siteOrigin: 'https://ambrogiocorti.github.io',
  supabaseUrl: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_test',
  base: '/plateform/',
  fetcher: async (url) =>
    url.endsWith('/get_public_site')
      ? { ok: true, json: async () => null }
      : { ok: false, status: 400 },
});
test(() => assert.deepEqual(fresh, { route_count: 0, indexable: false, configured: false }));
const freshHome = await readFile(join(root, 'index.html'), 'utf8');
test(() => assert.equal(freshHome, template));
const freshRobots = await readFile(join(root, 'robots.txt'), 'utf8');
test(() => assert.equal(freshRobots, 'User-agent: *\nDisallow: /\n'));
// A temporary Vercel preview may compile with a disconnected backend, never
// with a bad auth response, invalid payload, or on production.
const previewEnv = { VERCEL: '1', VERCEL_ENV: 'preview' };
const offline = new TypeError('fetch failed', {
  cause: Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' }),
});
test(() => assert.equal(mayUseUnindexedPreviewShell(offline, previewEnv), true));
test(() =>
  assert.equal(
    mayUseUnindexedPreviewShell(offline, { VERCEL: '1', VERCEL_ENV: 'production' }),
    false,
  ),
);
test(() =>
  assert.equal(mayUseUnindexedPreviewShell(offline, { VERCEL_ENV: 'preview' }), false),
);
test(() =>
  assert.equal(
    mayUseUnindexedPreviewShell(new Error('PUBLIC_RPC_FAILED:get_public_site:403'), previewEnv),
    false,
  ),
);
test(() =>
  assert.equal(
    mayUseUnindexedPreviewShell(new Error('PUBLIC_RPC_INVALID_PAYLOAD'), previewEnv),
    false,
  ),
);
const shellRoot = await mkdtemp(join(tmpdir(), 'plateform-preview-shell-'));
await writeFile(join(shellRoot, 'robots.txt'), 'User-agent: *\\nAllow: /\\n');
await writeFile(join(shellRoot, 'sitemap.xml'), '<urlset/>');
await writeUnindexedPreviewShell(shellRoot);
const previewRobots = await readFile(join(shellRoot, 'robots.txt'), 'utf8');
test(() => assert.equal(previewRobots, 'User-agent: *\\nDisallow: /\\n'));
await assert.rejects(readFile(join(shellRoot, 'sitemap.xml'), 'utf8'), { code: 'ENOENT' });
count++;
console.log(`STEP11_RECOVERED_PRERENDER=PASS (${count} assertions)`);
