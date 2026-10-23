import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const validPath =
  /^\/(?:|menu|ristorante|gallery|contatti|prenota|sedi|(?:menu|sedi)\/[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const isHttpsUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
};
const image = (url, alt) =>
  isHttpsUrl(url)
    ? `<img src="${escape(url)}" alt="${escape(alt)}" loading="lazy" decoding="async">`
    : '';
const str = (obj, key) => (typeof obj?.[key] === 'string' ? obj[key] : '');
const safeTel = (v) => String(v ?? '').replace(/[^+0-9]/g, '');
const section = (heading, content) =>
  `<section class="public-section"><h1>${escape(heading)}</h1>${content}</section>`;

function renderMenuCategories(categories) {
  return (categories ?? [])
    .map(
      (cat) =>
        `<h2 class="menu-category">${escape(cat.name)}</h2><div class="dish-grid">${(cat.items ?? []).map((d) => `<article class="dish-public">${image(d.image_path, d.name)}<h3>${escape(d.name)}</h3><p>${escape(d.description)}</p>${Array.isArray(d.allergens) && d.allergens.length ? `<p class="allergens">Contiene: ${escape(d.allergens.map((a) => a.name).join(', '))}</p>` : ''}</article>`).join('')}</div>`,
    )
    .join('');
}
export function renderPublicBody(path, site, { legacyMenu = [], publishedMenu = null } = {}) {
  const content = site.content ?? {};
  const venues = Array.isArray(site.venues) ? site.venues : [];
  const name = escape(site.name);
  const head = `<header class="public-header"><a class="restaurant-brand" href="/">${name}</a><nav aria-label="Principale"><a href="/menu">Menu</a> <a href="/ristorante">Ristorante</a> <a href="/gallery">Gallery</a> <a href="/contatti">Contatti</a></nav></header>`;
  const footer = `<footer class="public-footer"><p>${name}</p></footer>`;
  let body;
  if (path === '/')
    body = section(
      str(content, 'hero_title') || site.name,
      `<p>${escape(str(content, 'hero_subtitle'))}</p>${image(str(content, 'hero_image_url'), str(content, 'hero_image_alt'))}<h2>${escape(str(content, 'story_title') || 'Il ristorante')}</h2><p>${escape(str(content, 'story'))}</p>`,
    );
  else if (path === '/ristorante')
    body = section(
      str(content, 'story_title') || 'Il ristorante',
      `<p>${escape(str(content, 'story'))}</p>`,
    );
  else if (path === '/gallery')
    body = section(
      'Gallery',
      `<div class="gallery-grid">${(Array.isArray(content.gallery) ? content.gallery : []).map((x) => image(x.url, x.alt)).join('')}</div>`,
    );
  else if (path === '/contatti')
    body = section(
      'Contatti',
      venues
        .map(
          (v) =>
            `<article><h2>${escape(v.name)}</h2><p>${escape(v.address)}</p><a href="tel:${escape(safeTel(v.phone))}">${escape(v.phone)}</a></article>`,
        )
        .join(''),
    );
  else if (path === '/sedi')
    body = section(
      'Le nostre sedi',
      venues
        .map(
          (v) =>
            `<article><h2><a href="/sedi/${escape(v.slug)}">${escape(v.name)}</a></h2><p>${escape(v.address)}</p></article>`,
        )
        .join(''),
    );
  else if (path.startsWith('/sedi/')) {
    const v = venues.find((v) => v.slug === path.slice(6));
    if (!v) throw Error('MISSING_VENUE');
    body = section(
      v.name,
      `<p>${escape(v.address)}</p><a href="tel:${escape(safeTel(v.phone))}">${escape(v.phone)}</a>`,
    );
  } else if (path === '/menu' && site.multi_venue && venues.length > 1)
    body = section(
      'Il nostro menu',
      venues
        .map((v) => `<p><a href="/menu?sede=${escape(v.slug)}">${escape(v.name)}</a></p>`)
        .join(''),
    );
  else if (path === '/menu') {
    const cats = new Map();
    for (const d of legacyMenu) {
      const category = str(d, 'category_name') || 'Piatti';
      if (!cats.has(category)) cats.set(category, []);
      cats.get(category).push(d);
    }
    body = section(
      'Il nostro menu',
      renderMenuCategories([...cats.entries()].map(([name, items]) => ({ name, items }))),
    );
  } else if (path.startsWith('/menu/')) {
    if (!publishedMenu || publishedMenu.menu?.slug !== path.slice(6))
      throw Error('INVALID_PUBLISHED_MENU');
    body = section(publishedMenu.menu.name, renderMenuCategories(publishedMenu.categories));
  } else if (path === '/prenota')
    body = section(
      'Prenotazioni',
      `<p>Per verificare la disponibilità e inviare una prenotazione attiva JavaScript. In alternativa contatta il ristorante.</p>`,
    );
  else throw Error('UNSUPPORTED_PUBLIC_ROUTE');
  return `${head}<main id="main" tabindex="-1">${body}</main>${footer}`;
}

export async function prerenderPublic({
  distDir = 'dist/site',
  siteOrigin,
  supabaseUrl,
  publishableKey,
  base = '/',
  fetcher = fetch,
}) {
  if (!/^\/(?:[a-z0-9-]+\/)*$/.test(base)) throw Error('PUBLIC_BASE_INVALID');
  if (
    !isHttpsUrl(siteOrigin) ||
    !isHttpsUrl(supabaseUrl) ||
    typeof publishableKey !== 'string' ||
    !(publishableKey.startsWith('sb_publishable_') || publishableKey.startsWith('eyJ'))
  )
    throw Error('PUBLIC_SITE_CONFIGURATION_REQUIRED');
  if (publishableKey.startsWith('eyJ')) {
    try {
      const claims = JSON.parse(
        Buffer.from(publishableKey.split('.')[1] || '', 'base64url').toString(),
      );
      if (claims.role !== 'anon') throw Error('FORBIDDEN_BROWSER_API_KEY');
    } catch {
      throw Error('FORBIDDEN_BROWSER_API_KEY');
    }
  }
  const origin = new URL(siteOrigin).origin;
  if (siteOrigin !== origin) throw Error('PUBLIC_SITE_ORIGIN_MUST_NOT_HAVE_PATH');
  const endpoint = supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/';
  async function rpc(name, args = {}) {
    const result = await fetcher(endpoint + name, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey,
        ...(publishableKey.startsWith('eyJ') ? { Authorization: `Bearer ${publishableKey}` } : {}),
      },
      body: JSON.stringify(args),
    });
    if (!result.ok) throw Error(`PUBLIC_RPC_FAILED:${name}:${result.status}`);
    return result.json();
  }
  const site = await rpc('get_public_site');
  if (site === null) {
    // A fresh install has no restaurant yet: publish the app shell (the staff area is how the
    // restaurant gets configured) and keep the public site out of search engines.
    await writeFile(join(distDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    await rm(join(distDir, 'sitemap.xml'), { force: true });
    return { route_count: 0, indexable: false, configured: false };
  }
  const [sitemap, home] = await Promise.all([
    rpc('get_public_sitemap_entries'),
    rpc('get_public_page_metadata', { p_path: '/' }),
  ]);
  if (!site?.name || !Array.isArray(site.venues) || !Array.isArray(sitemap?.urls) || !home?.title)
    throw Error('PUBLIC_RPC_INVALID_PAYLOAD');
  if (sitemap.indexable !== (home.robots === 'index,follow'))
    throw Error('PUBLIC_INDEXING_MISMATCH');
  // A sub-folder site (a temporary GitHub Pages link) is never indexed: search engines must
  // learn the restaurant's own domain, not the temporary one.
  if (sitemap.indexable && base !== '/') throw Error('PUBLIC_SUBFOLDER_SITE_MUST_NOT_BE_INDEXED');
  if (sitemap.indexable && home.canonical_url !== siteOrigin + '/')
    throw Error('PUBLIC_ORIGIN_MISMATCH');
  const routes = sitemap.indexable ? sitemap.urls : [{ path: '/', loc: null }];
  const html = await readFile(join(distDir, 'index.html'), 'utf8');
  if (!html.includes('<div id="app"></div>')) throw Error('PUBLIC_HTML_MOUNT_MISSING');
  const unique = new Set();
  for (const entry of routes) {
    const path = entry.path;
    if (
      typeof path !== 'string' ||
      path.length > 160 ||
      !validPath.test(path) ||
      unique.has(path) ||
      path.startsWith('/staff') ||
      path.startsWith('/tavolo')
    )
      throw Error('UNSUPPORTED_SITEMAP_ROUTE');
    unique.add(path);
    if (sitemap.indexable && entry.loc !== siteOrigin + path) throw Error('SITEMAP_CROSS_ORIGIN');
    const metadata = path === '/' ? home : await rpc('get_public_page_metadata', { p_path: path });
    if (
      metadata.path !== path ||
      metadata.robots !== (sitemap.indexable ? 'index,follow' : 'noindex,nofollow') ||
      (sitemap.indexable && metadata.canonical_url !== entry.loc)
    )
      throw Error('PUBLIC_METADATA_MISMATCH');
    let legacyMenu = [],
      publishedMenu = null;
    if (path === '/menu' && !(site.multi_venue && site.venues.length > 1)) {
      const venue = site.venues[0];
      if (venue) legacyMenu = await rpc('get_public_menu', { p_venue: venue.id });
    }
    if (path.startsWith('/menu/'))
      publishedMenu = await rpc('get_public_menu_by_slug', {
        p_slug: path.slice(6),
        p_venue: site.venues[0]?.id,
      });
    const body = renderPublicBody(path, site, { legacyMenu, publishedMenu }).replace(
      /href="\/(?!\/)/g,
      `href="${base}`,
    );
    const tags =
      `<meta name="robots" content="${escape(metadata.robots)}">` +
      (metadata.canonical_url
        ? `<link rel="canonical" href="${escape(metadata.canonical_url)}">`
        : '') +
      `<meta property="og:title" content="${escape(metadata.title)}">` +
      `<meta property="og:description" content="${escape(metadata.description ?? '')}">`;
    let output = html
      .replace(/<title>[\s\S]*?<\/title>/, '<title>' + escape(metadata.title) + '</title>')
      .replace(
        /<meta\s+name="description"[\s\S]*?\/>/,
        `<meta name="description" content="${escape(metadata.description ?? '')}">`,
      )
      .replace('</head>', tags + '</head>')
      .replace('<div id="app"></div>', `<div id="app" aria-busy="false">${body}</div>`);
    const destination = path === '/' ? distDir : join(distDir, path.slice(1));
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'index.html'), output);
  }
  if (sitemap.indexable) {
    await writeFile(
      join(distDir, 'robots.txt'),
      `User-agent: *\nDisallow: /staff/\nDisallow: /tavolo/\nSitemap: ${siteOrigin}/sitemap.xml\n`,
    );
    const locs = sitemap.urls.map((v) => `<url><loc>${escape(v.loc)}</loc></url>`).join('');
    await writeFile(
      join(distDir, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
    );
  } else {
    await writeFile(join(distDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    await rm(join(distDir, 'sitemap.xml'), { force: true });
  }
  return { route_count: unique.size, indexable: sitemap.indexable };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outcome = await prerenderPublic({
    distDir: process.env.PUBLIC_DIST_DIR || 'dist/site',
    siteOrigin: process.env.PUBLIC_SITE_ORIGIN,
    supabaseUrl: process.env.VITE_SUPABASE_URL,
    publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    base: process.env.VITE_PUBLIC_BASE_URL
      ? new URL(process.env.VITE_PUBLIC_BASE_URL).pathname.replace(/\/?$/, '/')
      : '/',
  });
  console.log('PLATEFORM_PUBLIC_PRERENDER', outcome);
}
