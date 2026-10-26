import { cp, mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises';
import {
  mayUseUnindexedPreviewShell,
  writeUnindexedPreviewShell,
} from './public-prerender-fallback.mjs';
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

// Render into a separate directory: a network failure midway through the
// sitemap must never leave a partially prerendered public website behind.
const prerenderDir = 'dist/site-prerender';
await rm(prerenderDir, { recursive: true, force: true });
await cp('dist/site', prerenderDir, { recursive: true });
try {
  const { prerenderPublic } = await import('./prerender-public.mjs');
  await prerenderPublic({
    distDir: prerenderDir,
    siteOrigin: process.env.PUBLIC_SITE_ORIGIN,
    supabaseUrl: process.env.VITE_SUPABASE_URL,
    publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    base,
  });
  await rm('dist/site', { recursive: true, force: true });
  await rename(prerenderDir, 'dist/site');
} catch (error) {
  await rm(prerenderDir, { recursive: true, force: true });
  if (!mayUseUnindexedPreviewShell(error)) throw error;
  // Preview only: publish the already-built client-rendered shell, unindexed.
  // Do not call this a release gate or silently reuse stale HTML or sitemap.
  await writeUnindexedPreviewShell('dist/site');
  console.warn(
    'PLATEFORM_PREVIEW_BACKEND_UNREACHABLE: noindex shell only; backend-dependent checks and production release are NOT verified.',
  );
}
