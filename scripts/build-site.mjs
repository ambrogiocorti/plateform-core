import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
await mkdir('dist/site', { recursive: true });
await cp('dist/public', 'dist/site', { recursive: true });
await cp('dist/staff', 'dist/site/staff', { recursive: true });
await writeFile('dist/site/.nojekyll', '');
const fallback = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Plateform</title></head><body><script>
const path=location.pathname+location.search+location.hash;
if(location.pathname.startsWith('/staff/'))sessionStorage.setItem('plateform-route-staff',path);
else sessionStorage.setItem('plateform-route-public',path);
location.replace(location.pathname.startsWith('/staff/')?'/staff/':'/');
</script><noscript>Apri la home per continuare.</noscript></body></html>`;
await writeFile('dist/site/404.html', fallback);
if (process.env.PAGES_CUSTOM_DOMAIN) {
  if (!/^[a-z0-9.-]+$/.test(process.env.PAGES_CUSTOM_DOMAIN)) throw new Error('Invalid domain');
  await writeFile('dist/site/CNAME', process.env.PAGES_CUSTOM_DOMAIN + '\n');
}
const staff = await readFile('dist/site/staff/index.html', 'utf8');
if (!staff.includes('/staff/assets/'))
  throw new Error('La build GitHub Pages richiede VITE_STAFF_BASE_URL=https://dominio/staff/');
