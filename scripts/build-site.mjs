import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { runAtomicPublicPrerender } from './public-prerender-fallback.mjs';
// Vercel serves static headers from vercel.json. Keep those origins tied to
// the selected Supabase project; a preview configured with a different backend
// must fail rather than appear online with a blocked or cross-environment API.
if (process.env.VERCEL === '1') {
  const { assertVercelBackendCsp } = await import('./vercel-configuration.mjs');
  const configuration = JSON.parse(await readFile('vercel.json', 'utf8'));
  assertVercelBackendCsp({
    supabaseUrl: process.env.VITE_SUPABASE_URL,
    configuration,
  });
}
// A prior deployment can contain published menus or venue pages that have since
// been withdrawn. Never let those HTML files survive into a later release.
await rm('dist/site', { recursive: true, force: true });
await mkdir('dist/site', { recursive: true });
await cp('dist/public', 'dist/site', { recursive: true });
await cp('dist/staff', 'dist/site/staff', { recursive: true });
await writeFile('dist/site/.nojekyll', '');
// A GitHub Pages project site lives under a folder (/plateform/); a custom domain at "/".
const folder = (value, fallback) =>
  value ? new URL(value).pathname.replace(/\/?$/, '/') : fallback;
const base = folder(process.env.VITE_PUBLIC_BASE_URL, '/');
const staffBase = folder(process.env.VITE_STAFF_BASE_URL, '/staff/');
if (staffBase !== `${base}staff/`)
  throw new Error(`VITE_STAFF_BASE_URL deve finire con ${base}staff/`);
const fallback = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Plateform</title></head><body><script>
const base=${JSON.stringify(base)},staffBase=${JSON.stringify(staffBase)};
const path=location.pathname+location.search+location.hash;
const staffPath=location.pathname===staffBase.slice(0,-1)||location.pathname.startsWith(staffBase);
if(staffPath)sessionStorage.setItem('plateform-route-staff',path);
else sessionStorage.setItem('plateform-route-public',path);
location.replace(staffPath?staffBase:base);
</script><noscript>Apri la home per continuare.</noscript></body></html>`;
await writeFile('dist/site/404.html', fallback);
if (process.env.PAGES_CUSTOM_DOMAIN) {
  if (!/^[a-z0-9.-]+$/.test(process.env.PAGES_CUSTOM_DOMAIN)) throw new Error('Invalid domain');
  await writeFile('dist/site/CNAME', process.env.PAGES_CUSTOM_DOMAIN + '\n');
}
const staff = await readFile('dist/site/staff/index.html', 'utf8');
if (!staff.includes(`${staffBase}assets/`))
  throw new Error('La build GitHub Pages richiede VITE_STAFF_BASE_URL=https://dominio/staff/');

// Build-time public pages are generated from anonymous server RPCs only.
const { prerenderPublic } = await import('./prerender-public.mjs');
const publishResult = await runAtomicPublicPrerender({
  siteDir: 'dist/site',
  render: (distDir) =>
    prerenderPublic({
      distDir,
      siteOrigin: process.env.PUBLIC_SITE_ORIGIN,
      supabaseUrl: process.env.VITE_SUPABASE_URL,
      publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      base,
    }),
});
if (publishResult === 'preview-unindexed')
  console.warn(
    'PLATEFORM_PREVIEW_BACKEND_UNREACHABLE: noindex shell only; backend-dependent checks and production release are NOT verified.',
  );
