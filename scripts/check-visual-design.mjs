import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const root = 'dist/site';
const collectCss = async (dir) => {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.css'));
  assert.ok(names.length > 0, `NO_CSS_BUNDLES:${dir}`);
  return (await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')))).join('\n');
};
const pageHtml = await readFile(join(root, 'index.html'), 'utf8');
const staffHtml = await readFile(join(root, 'staff/index.html'), 'utf8');
const customerCss = await collectCss(join(root, 'assets'));
const staffCss = await collectCss(join(root, 'staff/assets'));
for (const [directory, html] of [
  [root, pageHtml],
  [join(root, 'staff'), staffHtml],
]) {
  assert.match(html, /icon\.svg\?v=blue-20261108/);
  assert.match(html, /apple-touch-icon-blue\.png/);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.theme_color, '#245edb');
  assert.equal(manifest.background_color, '#f3f6fb');
  const favicon = await readFile(join(directory, 'icon.svg'), 'utf8');
  assert.match(favicon, /fill="#245edb"/);
  assert.match(favicon, /fill="#ffffff"/);
  assert.ok(!favicon.includes('<image'), 'FAVICON_MUST_BE_SCALABLE_VECTOR');
  for (const [file, size] of [
    ['icon-blue-192.png', 192],
    ['icon-blue-512.png', 512],
    ['apple-touch-icon-blue.png', 180],
  ]) {
    const png = await readFile(join(directory, file));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
}
for (const [css, label, selectors] of [
  [
    customerCss,
    'CUSTOMER',
    [
      '--pf-background',
      '--pf-blue',
      '.app-home-heading',
      '.restaurant-welcome',
      '.restaurant-home-content',
      '.restaurant-featured-grid',
      '.restaurant-visit-panel',
      '.restaurant-story-panel',
      '.dish-public.public-dish-card',
      '.public-menu-toolbar',
      '.customer-task-nav',
      '.customer-account-summary',
      '.public-dish-detail',
      '.customer-cart-row',
      '.public-offer-card',
      '.public-footer',
      'prefers-reduced-motion',
    ],
  ],
  [
    staffCss,
    'STAFF',
    [
      '--pf-background',
      '--pf-blue',
      '.sidebar',
      '.primary-navigation',
      '.workspace-directory',
      '.topbar-location',
      '.ops-overview',
      '.ops-body-grid',
      '.ops-attention-card',
      '.ops-summary-grid',
      '.kds-workspace',
      '.kds-filter-actions',
      '.host-desk-body',
      '.host-service-kpis',
      '.cash-desk-header',
      '.cashier-command-center',
      '.waiter-service-intro',
      '.waiter-priority-bar',
      '.staff-shell.sidebar-collapsed',
      '.nav-icon',
      '.kpi-grid',
      '.topbar',
      '.login-layout',
      '.kitchen-grid',
      '.floor-grid',
      '.table-wrap',
      '.dialog',
      'prefers-reduced-motion',
    ],
  ],
]) {
  for (const selector of selectors) {
    assert.ok(css.includes(selector), `VISUAL_BUNDLE_MISSING:${label}:${selector}`);
  }
}
if (process.env.PAGES_MODE === 'test') {
  assert.match(pageHtml, /noindex,nofollow/);
  assert.match(pageHtml, /\/plateform-core\/assets\//);
  assert.match(staffHtml, /\/plateform-core\/staff\/assets\//);
  await assert.rejects(readFile(join(root, 'CNAME')), /ENOENT/);
}
console.log('PLATEFORM_VISUAL_ARTIFACT=PASS');
console.log('PLATEFORM_VISUAL_THEME=light+dark');
console.log(`PLATEFORM_VISUAL_CUSTOMER_CSS_BYTES=${Buffer.byteLength(customerCss)}`);
console.log(`PLATEFORM_VISUAL_STAFF_CSS_BYTES=${Buffer.byteLength(staffCss)}`);
