import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
// A prior deployment can contain published menus or venue pages that have since
// been withdrawn. Never let those HTML files survive into a later release.
await rm('dist/site', { recursive: true, force: true });
await mkdir('dist/site', { recursive: true });
await cp('dist/public', 'dist/site', { recursive: true });
await cp('dist/staff', 'dist/site/staff', { recursive: true });
await writeFile('dist/site/.nojekyll', '');
const fallback = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Plateform</title></head><body><script>
const path=location.pathname+location.search+location.hash;
const staffPath=location.pathname==='/staff'||location.pathname.startsWith('/staff/');
if(staffPath)sessionStorage.setItem('plateform-route-staff',path);
else sessionStorage.setItem('plateform-route-public',path);
location.replace(staffPath?'/staff/':'/');
</script><noscript>Apri la home per continuare.</noscript></body></html>`;
await writeFile('dist/site/404.html', fallback);
if (process.env.PAGES_CUSTOM_DOMAIN) {
  if (!/^[a-z0-9.-]+$/.test(process.env.PAGES_CUSTOM_DOMAIN)) throw new Error('Invalid domain');
  await writeFile('dist/site/CNAME', process.env.PAGES_CUSTOM_DOMAIN + '\n');
}
const staff = await readFile('dist/site/staff/index.html', 'utf8');
if (!staff.includes('/staff/assets/'))
  throw new Error('La build GitHub Pages richiede VITE_STAFF_BASE_URL=https://dominio/staff/');

// Build-time public pages are generated from anonymous server RPCs only.
await import('./prerender-public.mjs').then(({ prerenderPublic }) =>
  prerenderPublic({
    distDir: 'dist/site',
    siteOrigin: process.env.PUBLIC_SITE_ORIGIN,
    supabaseUrl: process.env.VITE_SUPABASE_URL,
    publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  }),
);
