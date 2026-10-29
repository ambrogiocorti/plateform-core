import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
// A prior deployment can contain published menus or venue pages that have since
// been withdrawn. Never let those HTML files survive into a later release.
const mode = process.env.PAGES_MODE ?? 'commercial';
if (mode !== 'test' && mode !== 'commercial') throw Error('INVALID_PAGES_MODE');
const siteUrl = new URL(process.env.PUBLIC_SITE_ORIGIN ?? 'https://invalid.example');
const prefix = siteUrl.pathname.replace(/\/?$/, '/');
if (
  siteUrl.protocol !== 'https:' ||
  siteUrl.search ||
  siteUrl.hash ||
  siteUrl.username ||
  siteUrl.password
)
  throw Error('INVALID_SITE_ORIGIN');
if (
  mode === 'test' &&
  (siteUrl.origin !== 'https://ambrogiocorti.github.io' || prefix !== '/plateform-core/')
)
  throw Error('UNEXPECTED_GITHUB_PAGES_TEST_ORIGIN');
if (mode === 'commercial' && prefix !== '/') throw Error('COMMERCIAL_SITE_REQUIRES_ROOT_DOMAIN');
const staffPrefix = `${prefix}staff/`;
await rm('dist/site', { recursive: true, force: true });
await mkdir('dist/site', { recursive: true });
await cp('dist/public', 'dist/site', { recursive: true });
await cp('dist/staff', 'dist/site/staff', { recursive: true });
await writeFile('dist/site/.nojekyll', '');
const fallback = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Plateform</title></head><body><script>
const path=location.pathname+location.search+location.hash;
const publicBase=${JSON.stringify(prefix)};
const staffBase=${JSON.stringify(staffPrefix)};
const isStaff=location.pathname===staffBase.slice(0,-1)||location.pathname.startsWith(staffBase);
const isOwned=location.pathname===publicBase.slice(0,-1)||location.pathname.startsWith(publicBase);
if(!isOwned){location.replace(publicBase);}else{
try{sessionStorage.setItem(isStaff?'plateform-route-staff':'plateform-route-public',path);}catch{}
location.replace(isStaff?staffBase:publicBase);
}
</script><noscript>Apri la home per continuare.</noscript></body></html>`;
await writeFile('dist/site/404.html', fallback);
if (mode === 'test' && process.env.PAGES_CUSTOM_DOMAIN) throw Error('TEST_SITE_MUST_NOT_USE_CNAME');
if (mode === 'commercial' && process.env.PAGES_CUSTOM_DOMAIN) {
  if (!/^[a-z0-9.-]+$/.test(process.env.PAGES_CUSTOM_DOMAIN)) throw new Error('Invalid domain');
  await writeFile('dist/site/CNAME', process.env.PAGES_CUSTOM_DOMAIN + '\n');
}
const staff = await readFile('dist/site/staff/index.html', 'utf8');
if (!staff.includes(`${staffPrefix}assets/`)) throw new Error('STAFF_ASSET_BASE_MISMATCH');

if (mode === 'test') {
  // Never expose commercial canonical metadata or sitemap in a test deployment.
  const html = await readFile('dist/site/index.html', 'utf8');
  await writeFile(
    'dist/site/index.html',
    html.replace('</head>', '<meta name="robots" content="noindex,nofollow"></head>'),
  );
  await writeFile('dist/site/robots.txt', 'User-agent: *\nDisallow: /\n');
  await rm('dist/site/sitemap.xml', { force: true });
} else {
  // Commercial pages require authoritative public RPC metadata.
  await import('./prerender-public.mjs').then(({ prerenderPublic }) =>
    prerenderPublic({
      distDir: 'dist/site',
      siteOrigin: process.env.PUBLIC_SITE_ORIGIN,
      supabaseUrl: process.env.VITE_SUPABASE_URL,
      publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    }),
  );
}
