import { publicSnapshot } from '../../src/services/public-snapshot';
import { publicDishCard } from '../../src/components/public-dish';
import { restaurantPage, galleryPage } from '../../src/pages/public-about';
import { registerPwa } from '../../src/services/pwa';
import '../../styles/public.css';
import '../../styles/public-app.css';
import '../../styles/restaurant-redesign.css';
import '../../styles/overlays.css';
import '../../styles/menu-catalog.css';
import { z } from 'zod';
import { rpc } from '../../src/api/client';
import { button, el, emptyState, loading, showError } from '../../src/components/dom';
import { watchLive } from '../../src/realtime/live';
import { environment, safeImageUrl } from '../../src/config/environment';
import { menuDishSchema, publicSiteSchema } from '../../src/types/domain';
import type { PublicSite, Venue } from '../../src/types/domain';
import { formatMoney } from '../../src/services/money';
import { setupPublicNavigation } from '../../src/services/public-navigation';
import { preferredPublicTheme, savePublicTheme } from '../../src/services/public-theme';
import {
  canonicalPublicUrl,
  isClientSidePublicPath,
  internalPublicPath,
  hostedPublicPath,
  readableInk,
  resolveBookingVenue,
  safeRecoveredPublicRoute,
  safeAccent,
  safeBackground,
  safePublicLink,
  selectedVenue,
  venueAwarePath,
} from '../../src/services/public-site';
import {
  observePublicPerformance,
  recordPublicPageView,
} from '../../src/services/public-telemetry';

const PUBLIC_BASE = import.meta.env.BASE_URL;
const currentPublicPath = (): string =>
  internalPublicPath(location.pathname, PUBLIC_BASE) ?? '/__invalid_public_path__';
const hrefForPublicRoute = (path: string): string => hostedPublicPath(path, PUBLIC_BASE);
const isPreview = import.meta.env.VITE_PAGES_MODE === 'test';

try {
  const storedRoute = sessionStorage.getItem('plateform-route-public');
  if (storedRoute !== null) {
    sessionStorage.removeItem('plateform-route-public');
    const recovered = safeRecoveredPublicRoute(storedRoute, location.origin, PUBLIC_BASE);
    if (recovered) history.replaceState(null, '', recovered);
  }
} catch {
  // Storage may be unavailable in a privacy-restricted browser. Serve /.
}

// A waitlist offer URL contains an opaque one-use credential in its fragment.
// Remove it from the address bar immediately, before any asynchronous work,
// metadata updates or telemetry can run. The token remains only in memory.
let pendingWaitlistOfferFragment = '';
if (currentPublicPath() === '/lista-attesa/offerta') {
  pendingWaitlistOfferFragment = location.hash;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing application root');
const app: HTMLElement = root;
let revision = 0;
let pageLifetime = new AbortController();
let stopLive: (() => void) | undefined;
let liveKey = '';
let stopPerformance: (() => void) | undefined;
let initialPage = true;
const siteSnapshot = publicSnapshot(() => rpc('get_public_site', {}, publicSiteSchema.nullable()));
window.addEventListener('online', () => siteSnapshot.invalidate());

// A lightweight connectivity notice belongs to the public shell as well as
// staff: cached opening hours or menus must never look freshly verified offline.
const publicConnection = el(
  'p',
  { id: 'public-connection', class: 'public-connection', role: 'status', hidden: '' },
  'Sei offline: orari e menu potrebbero non essere aggiornati.',
);
function refreshPublicConnection(): void {
  publicConnection.hidden = navigator.onLine;
}
window.addEventListener('online', refreshPublicConnection);
window.addEventListener('offline', refreshPublicConnection);
refreshPublicConnection();

function releasePublicObservers(): void {
  stopLive?.();
  stopLive = undefined;
  liveKey = '';
  stopPerformance?.();
  stopPerformance = undefined;
}

function failClosedPublicMetadata(): void {
  let robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (!robots) {
    robots = document.createElement('meta');
    robots.name = 'robots';
    document.head.append(robots);
  }
  robots.content = 'noindex,nofollow';
  document.head.querySelector('link[rel="canonical"]')?.remove();
  document.getElementById('restaurant-structured-data')?.remove();
}

function textValue(data: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof data[key] === 'string' ? data[key] : fallback;
}
function sectionEnabled(site: PublicSite, key: string): boolean {
  const sections = site.content.sections;
  return !sections || typeof sections !== 'object' || Array.isArray(sections)
    ? true
    : (sections as Record<string, unknown>)[key] !== false;
}
function setMeta(name: string, content: string, property = false): void {
  if (!content) return;
  const selector = property ? `meta[property="${name}"]` : `meta[name="${name}"]`;
  let meta = document.head.querySelector<HTMLMetaElement>(selector);
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute(property ? 'property' : 'name', name);
    document.head.append(meta);
  }
  meta.content = content;
}
function applyMetadata(site: PublicSite, venue?: Venue): void {
  if (isPreview) {
    failClosedPublicMetadata();
    return;
  }
  const explicitlySelectedVenue =
    currentPublicPath().startsWith('/sedi/') || new URLSearchParams(location.search).has('sede');
  const invalidVenueContext = explicitlySelectedVenue && !venue;
  const pageLabels: Record<string, string> = {
    '/menu': 'Menu',
    '/ristorante': 'Il ristorante',
    '/gallery': 'Gallery',
    '/sedi': 'Sedi',
    '/prenota': 'Prenota',
    '/lista-attesa': 'Lista d’attesa',
    '/contatti': 'Contatti',
  };
  const configuredTitle = textValue(site.content, 'seo_title', site.name);
  const pageLabel = currentPublicPath().startsWith('/sedi/')
    ? (venue?.name ?? 'Sede')
    : pageLabels[currentPublicPath()];
  document.title = pageLabel ? `${pageLabel} · ${configuredTitle}` : configuredTitle;
  const description = textValue(
    site.content,
    'seo_description',
    textValue(site.content, 'hero_subtitle', `Scopri ${site.name}.`),
  );
  setMeta('description', description);
  setMeta('og:title', document.title, true);
  setMeta('og:description', description, true);
  setMeta('og:type', 'website', true);
  const canonicalUrl = canonicalPublicUrl(
    site,
    currentPublicPath(),
    location.search,
    location.origin,
  );
  setMeta('og:url', canonicalUrl, true);
  const hero = safeImageUrl(site.content.hero_image_url);
  if (hero) setMeta('og:image', hero, true);
  else document.head.querySelector('meta[property="og:image"]')?.remove();
  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.append(canonical);
  }
  canonical.href = canonicalUrl;
  const robots =
    document.head.querySelector<HTMLMetaElement>('meta[name="robots"]') ??
    document.head.appendChild(document.createElement('meta'));
  robots.name = 'robots';
  robots.content = 'noindex,nofollow'; // Opt in only after authoritative metadata RPC confirms indexability.
  const previous = document.getElementById('restaurant-structured-data');
  previous?.remove();
  if (
    !isPreview &&
    !currentPublicPath().startsWith('/tavolo/') &&
    currentPublicPath() !== '/lista-attesa/offerta' &&
    !invalidVenueContext
  ) {
    const structured = document.createElement('script');
    structured.id = 'restaurant-structured-data';
    structured.type = 'application/ld+json';
    structured.text = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Restaurant',
      name: site.name,
      url: new URL('/', location.origin).toString(),
      image: hero || logoForStructuredData(site),
      telephone: venue?.phone ?? site.venues[0]?.phone,
      address: venue?.address ?? site.venues[0]?.address,
      ...(site.multi_venue && site.venues.length > 1
        ? {
            department: site.venues.map((venue) => ({
              '@type': 'Restaurant',
              name: venue.name,
              telephone: venue.phone,
              address: venue.address,
              url: new URL(`/sedi/${venue.slug}`, location.origin).toString(),
            })),
          }
        : {}),
    });
    document.head.append(structured);
  }
}
function logoForStructuredData(site: PublicSite): string | undefined {
  return safeImageUrl(site.branding.logo_url);
}
function startPublicRender(focusAfterNavigation = false): void {
  const pending = render();
  const expectedRevision = revision;
  void pending
    .then(() => {
      if (expectedRevision === revision && focusAfterNavigation)
        document.getElementById('main')?.focus({ preventScroll: true });
    })
    .catch((error: unknown) => {
      // A superseded slow RPC must not replace a newer, successfully rendered
      // page with the error state from the previous navigation.
      if (expectedRevision === revision) failed(error);
    });
}
function route(path: string): void {
  if (hrefForPublicRoute(path) === `${location.pathname}${location.search}`) return;
  for (const popup of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) popup.close();
  history.pushState(null, '', hrefForPublicRoute(path));
  startPublicRender(true);
}

async function render(refreshSnapshot = false): Promise<void> {
  const current = ++revision;
  pageLifetime.abort();
  pageLifetime = new AbortController();
  const lifetime = pageLifetime;
  environment();
  // Preserve server-rendered editorial content during initial hydration.
  // Replacing it with a loading message causes layout shifts and an empty page
  // whenever JavaScript starts before the public RPC has responded.
  const preservePrerender = initialPage && app.querySelector('main#main') !== null;
  initialPage = false;
  const retainVisiblePage = preservePrerender || app.querySelector('main#main') !== null;
  if (retainVisiblePage) app.setAttribute('aria-busy', 'true');
  else app.replaceChildren(loading());
  if (refreshSnapshot) siteSnapshot.invalidate();
  const site = await siteSnapshot.read();
  if (current !== revision) return;
  if (!site) {
    app.removeAttribute('aria-busy');
    releasePublicObservers();
    failClosedPublicMetadata();
    app.replaceChildren(
      el(
        'main',
        { id: 'main', class: 'public-error' },
        emptyState(
          'Il nostro sito sta arrivando',
          'Stiamo preparando uno spazio dedicato alla nostra cucina. Torna presto a trovarci.',
        ),
      ),
    );
    return;
  }
  applyBrand(site);
  const venue = selectedVenue(site, currentPublicPath(), location.search);
  applyMetadata(site, venue);
  if (currentPublicPath() === '/lista-attesa/offerta') {
    failClosedPublicMetadata();
    document.head.querySelector('meta[property="og:url"]')?.remove();
  }
  const invalidVenueContext =
    !venue &&
    (currentPublicPath().startsWith('/sedi/') || new URLSearchParams(location.search).has('sede'));
  if (invalidVenueContext) {
    // Invalid/archived venue URLs are never indexable and must not receive a
    // canonical address or structured data belonging to another venue.
    document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.remove();
    document.head.querySelector('meta[property="og:url"]')?.remove();
    const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (robots) robots.content = 'noindex,nofollow';
  }
  if (
    !currentPublicPath().startsWith('/tavolo/') &&
    currentPublicPath() !== '/lista-attesa/offerta' &&
    !invalidVenueContext
  ) {
    const pathForSeo = currentPublicPath();
    const seoRevision = current;
    void rpc(
      'get_public_page_metadata',
      {
        p_path: pathForSeo,
        p_venue: venue?.id ?? null,
      },
      z.object({
        path: z.string(),
        title: z.string(),
        description: z.string(),
        robots: z.enum(['index,follow', 'noindex,nofollow']),
        canonical_url: z.string().nullable(),
        og_image_url: z.string().nullable(),
      }),
    )
      .then((metadata) => {
        if (seoRevision !== revision || metadata.path !== currentPublicPath()) return;
        document.title = metadata.title;
        setMeta('description', metadata.description);
        setMeta('og:title', metadata.title, true);
        setMeta('og:description', metadata.description, true);
        const multiVenueQuery =
          site.multi_venue &&
          site.venues.length > 1 &&
          new URLSearchParams(location.search).has('sede');
        const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
        if (robots)
          robots.content =
            invalidVenueContext || multiVenueQuery ? 'noindex,nofollow' : metadata.robots;
        const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
        if (canonical) {
          if (invalidVenueContext) canonical.remove();
          else if (metadata.canonical_url) canonical.href = metadata.canonical_url;
          else canonical.remove();
        }
        if (metadata.og_image_url) setMeta('og:image', metadata.og_image_url, true);
      })
      .catch(() => {
        // Never promote an unverified route or deployment to public indexing.
        const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
        if (seoRevision === revision && robots) robots.content = 'noindex,nofollow';
      });
  }
  const reservationVenue = resolveBookingVenue(site, currentPublicPath(), location.search);
  const bookingEnabled = sectionEnabled(site, 'booking') && Boolean(reservationVenue);
  const links = [
    { path: '/', label: 'Home', current: '/' },
    { path: venueAwarePath('/menu', site, venue), label: 'Menu', current: '/menu' },
    ...(sectionEnabled(site, 'story')
      ? [
          {
            path: venueAwarePath('/ristorante', site, venue),
            label: 'Il Ristorante',
            current: '/ristorante',
          },
        ]
      : []),
    ...(sectionEnabled(site, 'gallery')
      ? [{ path: venueAwarePath('/gallery', site, venue), label: 'Gallery', current: '/gallery' }]
      : []),
    ...(sectionEnabled(site, 'venues') && site.multi_venue && site.venues.length > 1
      ? [{ path: '/sedi', label: 'Le sedi', current: '/sedi' }]
      : []),
    ...(sectionEnabled(site, 'booking') && bookingEnabled
      ? [
          {
            path: venueAwarePath('/prenota', site, reservationVenue),
            label: 'Prenota',
            current: '/prenota',
          },
        ]
      : []),
    ...(sectionEnabled(site, 'contacts')
      ? [
          {
            path: venueAwarePath('/contatti', site, venue),
            label: 'Contatti',
            current: '/contatti',
          },
        ]
      : []),
  ];
  const main = el('main', { id: 'main', tabindex: '-1' });
  const logo = safeImageUrl(site.branding.logo_url);
  const navigation = el(
    'nav',
    { class: 'public-nav', id: 'public-navigation', 'aria-label': 'Principale' },
    ...links.map((link) =>
      el(
        'a',
        {
          href: link.path,
          ...(currentPublicPath() === link.current ||
          (link.current === '/sedi' && currentPublicPath().startsWith('/sedi/'))
            ? { 'aria-current': 'page' }
            : {}),
        },
        link.label,
      ),
    ),
  );
  const menuButton = el(
    'button',
    {
      type: 'button',
      class: 'button quiet public-menu-toggle',
      'aria-controls': 'public-navigation',
      'aria-expanded': 'false',
      'aria-label': 'Apri la navigazione',
    },
    'Navigazione',
  );
  const themeButton = el(
    'button',
    {
      type: 'button',
      class: 'public-theme-toggle',
      'aria-label': preferredPublicTheme() === 'light' ? 'Attiva tema scuro' : 'Attiva tema chiaro',
      'aria-pressed': String(preferredPublicTheme() === 'dark'),
    },
    preferredPublicTheme() === 'light' ? '☾ Tema scuro' : '☀ Tema chiaro',
  );
  themeButton.addEventListener('click', () => {
    const next = preferredPublicTheme() === 'light' ? 'dark' : 'light';
    savePublicTheme(next);
    applyBrand(site);
    themeButton.textContent = next === 'light' ? '☾ Tema scuro' : '☀ Tema chiaro';
    themeButton.setAttribute(
      'aria-label',
      next === 'light' ? 'Attiva tema scuro' : 'Attiva tema chiaro',
    );
    themeButton.setAttribute('aria-pressed', String(next === 'dark'));
  });
  const header = el(
    'header',
    { class: 'public-header' },
    el(
      'a',
      { href: '/', class: 'restaurant-brand', 'aria-label': `${site.name} — Home` },
      logo ? el('img', { src: logo, alt: '', width: '150', decoding: 'async' }) : site.name,
    ),
    el('div', { class: 'public-header-actions' }, themeButton, menuButton),
    navigation,
  );
  const path = currentPublicPath();
  if (path === '/') {
    // Build the complete homepage offscreen: a late hero would shift the footer on mobile.
    main.append(await home(site, venue, bookingEnabled ? reservationVenue : undefined));
    if (current !== revision) return;
  } else if (path === '/menu') {
    main.append(await menu(site, venue));
    if (current !== revision) return;
  } else if (path === '/prenota' && reservationVenue && bookingEnabled) {
    const section = el(
      'section',
      { class: 'public-section' },
      el('p', { class: 'eyebrow' }, 'Ci vediamo a tavola'),
      el('h1', {}, 'Prenota la tua visita'),
      venuePicker(site, reservationVenue, true),
    );
    section.append(
      await (
        await import('../../src/pages/public-booking')
      ).bookingPage(
        reservationVenue,
        safePublicLink(textValue(site.content, 'privacy_url'), window.location.origin),
      ),
    );
    if (current !== revision) return;
    main.append(section);
  }
  if (path === '/' || path === '/menu' || (path === '/prenota' && bookingEnabled)) {
    // Main content was fully assembled before its first paint on mobile.
  } else if (path.startsWith('/menu/') && venue) {
    const match = /^\/menu\/([^/]+)(?:\/piatto\/([^/]+))?\/?$/.exec(path);
    main.append(
      match
        ? await (
            await import('../../src/pages/public-menu')
          ).publishedMenuPage(match[1] ?? '', venue, match[2])
        : emptyState('Pagina non disponibile', 'Il collegamento alla carta non è valido.'),
    );
  } else if (path.startsWith('/menu/') && !venue) {
    main.append(
      emptyState(
        'Sede non disponibile',
        'Il collegamento del menu si riferisce a una sede non valida o non più attiva.',
      ),
    );
    if (site.multi_venue) main.append(el('a', { href: '/sedi' }, 'Visualizza le sedi'));
  } else if (path === '/ristorante' && sectionEnabled(site, 'story')) {
    main.append(restaurantPage(site));
  } else if (path === '/gallery' && sectionEnabled(site, 'gallery')) {
    main.append(galleryPage(site));
  } else if (path.startsWith('/sedi/') && sectionEnabled(site, 'venues')) {
    // Respect the same fail-closed venue resolution used for SEO, menus and
    // booking links. A conflicting ?sede= must not render a different detail.
    const entry = venue;
    if (!entry) {
      main.append(
        el(
          'section',
          { class: 'public-section' },
          emptyState('Sede non disponibile', 'La sede richiesta non è attiva o non esiste.'),
        ),
      );
    } else {
      main.append(venuePage(site, entry));
    }
  } else if (
    (path === '/contatti' && sectionEnabled(site, 'contacts')) ||
    (path === '/sedi' && sectionEnabled(site, 'venues'))
  ) {
    main.append(
      el(
        'section',
        { class: 'public-section' },
        el('p', { class: 'eyebrow' }, 'Vieni a trovarci'),
        el('h1', {}, path === '/contatti' ? 'Contatti' : 'Le nostre sedi'),
        el(
          'p',
          { class: 'public-intro' },
          textValue(
            site.content,
            'contacts_intro',
            'Scrivici o chiamaci per organizzare la tua visita.',
          ),
        ),
        el(
          'div',
          { class: 'grid' },
          ...site.venues.map((entry) => venueCard(entry, site.multi_venue)),
        ),
      ),
    );
  } else if (path === '/prenota') {
    main.append(
      emptyState(
        'Prenotazioni online non disponibili',
        'La sede richiesta non accetta prenotazioni online. Contatta il ristorante o scegli un’altra sede.',
      ),
    );
  } else if (path === '/lista-attesa/offerta') {
    const fragment = pendingWaitlistOfferFragment;
    pendingWaitlistOfferFragment = '';
    main.append((await import('../../src/pages/public-waitlist')).waitlistOfferPage(fragment));
  } else if (path === '/lista-attesa' && reservationVenue && bookingEnabled) {
    main.append(
      await (
        await import('../../src/pages/public-waitlist')
      ).waitlistPage(
        reservationVenue,
        safePublicLink(textValue(site.content, 'privacy_url'), window.location.origin),
      ),
    );
  } else if (path === '/lista-attesa') {
    main.append(
      emptyState('Lista d’attesa non disponibile', 'Contatta il ristorante per informazioni.'),
    );
  } else if (path.startsWith('/tavolo/')) {
    stopLive?.();
    stopLive = undefined;
    liveKey = '';
    main.append(
      await (
        await import('../../src/pages/customer')
      ).customerPage(path.split('/')[2] ?? '', lifetime.signal),
    );
  } else
    main.append(
      el(
        'section',
        { class: 'public-section' },
        el('h1', {}, 'Pagina non disponibile'),
        el('p', {}, 'Torna alla home o contattaci per informazioni.'),
        el('a', { href: '/' }, 'Torna alla home'),
      ),
    );
  // Commit the completed route atomically; a slow menu must never clear the header or
  // replace a newer destination after the visitor has already navigated elsewhere.
  if (current !== revision) return;
  app.replaceChildren(header, publicConnection, main, footer(site));
  app.removeAttribute('aria-busy');
  refreshPublicConnection();
  setupPublicNavigation(menuButton, navigation, header, lifetime.signal);
  stopPerformance?.();
  if (!isPreview && currentPublicPath() !== '/lista-attesa/offerta') {
    stopPerformance = observePublicPerformance(venue?.id);
    recordPublicPageView(venue?.id);
  }
  if (!venue || path.startsWith('/tavolo/')) {
    // Leaving a known public venue must unsubscribe before a stale callback
    // can refresh an invalid venue page or retain the previous venue context.
    stopLive?.();
    stopLive = undefined;
    liveKey = '';
  }
  if (venue && !path.startsWith('/tavolo/') && path !== '/lista-attesa/offerta') {
    const key = `${venue.id}:${path}`;
    const update = button('Il menu è cambiato. Aggiorna', async () => render(true), 'secondary');
    update.id = 'public-refresh';
    update.hidden = true;
    main.append(update);
    if (key !== liveKey) {
      stopLive?.();
      liveKey = key;
      stopLive = watchLive({
        venueId: venue.id,
        topics: ['PUBLIC'],
        refresh: async () => {
          if (
            currentPublicPath() === '/prenota' ||
            document.querySelector('dialog[open]') ||
            document.activeElement?.matches('input,select,textarea')
          ) {
            const notice = document.getElementById('public-refresh');
            if (notice) notice.hidden = false;
            return;
          }
          const scroll = window.scrollY;
          await render(true);
          window.scrollTo(0, scroll);
        },
        state: () => {
          // Public realtime is advisory; only actual network loss warrants a
          // visitor-facing offline warning, managed by the shared shell.
          refreshPublicConnection();
        },
      });
    }
  }
}

function applyBrand(site: PublicSite): void {
  // Always reconstruct the theme from the latest authoritative site snapshot.
  // Otherwise removing a previously configured color/font leaves stale inline
  // CSS variables behind after Realtime refresh or SPA navigation.
  for (const token of [
    '--bg',
    '--accent',
    '--accent-ink',
    '--font',
    '--public-heading-font',
    '--pf-background',
    '--pf-blue',
    '--pf-on-blue',
  ])
    document.documentElement.style.removeProperty(token);
  const darkMode = preferredPublicTheme() === 'dark';
  const defaultBackground = darkMode ? '#141615' : '#f6f3ed';
  // The restaurant can select a branded background for its configured mode,
  // but it must never override a guest's explicit light/dark preference.
  const brandDarkMode = site.branding.dark_mode !== false;
  const background =
    brandDarkMode === darkMode
      ? safeBackground(textValue(site.branding, 'background_color'), darkMode)
      : null;
  if (background) {
    document.documentElement.style.setProperty('--bg', background);
    document.documentElement.style.setProperty('--pf-background', background);
  }
  const accent = safeAccent(
    textValue(site.branding, 'accent_color'),
    background ?? defaultBackground,
  );
  if (accent) {
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-ink', readableInk(accent));
    document.documentElement.style.setProperty('--pf-blue', accent);
    document.documentElement.style.setProperty('--pf-on-blue', readableInk(accent));
  }
  const bodyFonts: Record<string, string> = {
    SANS: '-apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif',
    SERIF: 'Georgia, Times New Roman, serif',
    HUMANIST: 'Trebuchet MS, Segoe UI, sans-serif',
  };
  const headingFonts: Record<string, string> = {
    SANS: '-apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif',
    SERIF: 'Georgia, Times New Roman, serif',
    HUMANIST: 'Trebuchet MS, Segoe UI, sans-serif',
  };
  const bodyFont = textValue(site.branding, 'font_body');
  const headingFont = textValue(site.branding, 'font_heading');
  if (bodyFonts[bodyFont])
    document.documentElement.style.setProperty('--font', bodyFonts[bodyFont]);
  if (headingFonts[headingFont])
    document.documentElement.style.setProperty('--public-heading-font', headingFonts[headingFont]);
  const layout = textValue(site.branding, 'layout', 'EDITORIAL');
  document.documentElement.dataset.publicLayout = ['EDITORIAL', 'MODERN', 'CLASSIC'].includes(
    layout,
  )
    ? layout.toLowerCase()
    : 'editorial';
  document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
  const themeColor = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = background ?? defaultBackground;
  const favicon = safeImageUrl(site.branding.favicon_url);
  if (favicon) {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = el('link', { rel: 'icon' });
      document.head.append(icon);
    }
    icon.href = favicon;
  } else {
    // A previously configured favicon must not survive its removal.
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = hrefForPublicRoute('/icon.svg');
  }
}

async function home(
  site: PublicSite,
  venue: Venue | undefined,
  bookingDestination?: Venue,
): Promise<HTMLElement> {
  const bookingEnabled = Boolean(bookingDestination);
  const menuHref = venueAwarePath('/menu', site, venue);
  const bookingHref = venueAwarePath('/prenota', site, bookingDestination);
  const storyEnabled = sectionEnabled(site, 'story');
  const contactsEnabled = sectionEnabled(site, 'contacts');
  const galleryEnabled = sectionEnabled(site, 'gallery');
  const homeImage = safeImageUrl(site.content.hero_image_url);
  let featured: z.infer<typeof menuDishSchema>[] = [];
  if (venue) {
    // Menu highlights are read-only and never block the restaurant homepage.
    try {
      featured = (await rpc('get_public_menu', { p_venue: venue.id }, z.array(menuDishSchema)))
        .filter((dish) => dish.availability !== 0)
        .slice(0, 4);
    } catch {
      featured = [];
    }
  }
  const heading = el(
    'section',
    { class: 'restaurant-welcome', 'aria-label': 'Benvenuto al ristorante' },
    el(
      'div',
      { class: 'restaurant-welcome-copy' },
      el('p', { class: 'restaurant-kicker' }, site.name),
      el('h1', {}, textValue(site.content, 'hero_title', site.name)),
      el(
        'p',
        { class: 'restaurant-welcome-description' },
        textValue(
          site.content,
          'hero_subtitle',
          'Una cucina da scoprire, un tavolo da condividere.',
        ),
      ),
      el(
        'div',
        { class: 'restaurant-welcome-actions' },
        el('a', { href: menuHref, class: 'button primary' }, 'Esplora il menu'),
        bookingEnabled
          ? el('a', { href: bookingHref, class: 'button secondary' }, 'Prenota un tavolo')
          : storyEnabled
            ? el(
                'a',
                { href: venueAwarePath('/ristorante', site, venue), class: 'button secondary' },
                'Il ristorante',
              )
            : null,
      ),
      el('p', { class: 'restaurant-welcome-caption' }, venue?.address ?? site.name),
    ),
    homeImage
      ? el(
          'div',
          { class: 'restaurant-welcome-photo' },
          el('img', {
            src: homeImage,
            alt: textValue(site.content, 'hero_image_alt', 'Il nostro ristorante'),
            loading: 'eager',
            decoding: 'async',
          }),
        )
      : venue && contactsEnabled
        ? el(
            'aside',
            { class: 'restaurant-welcome-visit', 'aria-label': 'Organizza la visita' },
            el('p', { class: 'restaurant-kicker' }, 'DOVE SIAMO'),
            el('h2', {}, venue.name),
            venue.address ? el('p', { class: 'restaurant-visit-address' }, venue.address) : null,
            venue.phone ? el('p', { class: 'restaurant-visit-phone' }, venue.phone) : null,
            el(
              'a',
              { href: venueAwarePath('/contatti', site, venue), class: 'restaurant-section-link' },
              'Contatti e indicazioni ↗',
            ),
          )
        : null,
  );
  const menuPreview = el(
    'section',
    { class: 'restaurant-discover', 'aria-label': 'Scopri la nostra cucina' },
    el(
      'div',
      { class: 'restaurant-section-heading' },
      el(
        'div',
        {},
        el('p', { class: 'restaurant-kicker' }, 'DALLA NOSTRA CUCINA'),
        el('h2', {}, 'Il gusto di scegliere.'),
        el('p', {}, 'Esplora i piatti, gli ingredienti e le proposte del momento.'),
      ),
      el('a', { href: menuHref, class: 'restaurant-section-link' }, 'Scopri tutta la carta ↗'),
    ),
  );
  if (featured.length && venue) {
    menuPreview.append(
      el(
        'div',
        { class: 'restaurant-featured-grid' },
        ...featured.map((dish) =>
          el(
            'a',
            { href: menuHref, class: 'restaurant-featured-dish' },
            safeImageUrl(dish.image_path)
              ? el('img', {
                  src: safeImageUrl(dish.image_path)!,
                  alt: dish.name,
                  loading: 'lazy',
                  decoding: 'async',
                })
              : null,
            el(
              'div',
              { class: 'restaurant-featured-info' },
              el('span', {}, dish.category_name),
              el('h3', {}, dish.name),
              el('strong', {}, formatMoney(dish.price_cents, venue.currency, venue.locale)),
            ),
          ),
        ),
      ),
    );
  } else {
    menuPreview.append(
      el(
        'div',
        { class: 'restaurant-featured-empty' },
        el('p', {}, 'Scopri le proposte della nostra cucina, gli ingredienti e gli allergeni.'),
        el('a', { href: menuHref, class: 'button secondary' }, 'Visualizza il menu'),
      ),
    );
  }
  const journey = el(
    'nav',
    { class: 'restaurant-journey-bar', 'aria-label': 'Esplora il ristorante' },
    el(
      'a',
      { href: menuHref },
      el('span', { class: 'restaurant-journey-number', 'aria-hidden': 'true' }, '01'),
      el('span', {}, 'Scopri il menu'),
      el('span', { class: 'restaurant-journey-arrow', 'aria-hidden': 'true' }, '↗'),
    ),
    bookingEnabled
      ? el(
          'a',
          { href: bookingHref },
          el('span', { class: 'restaurant-journey-number', 'aria-hidden': 'true' }, '02'),
          el('span', {}, 'Prenota un tavolo'),
          el('span', { class: 'restaurant-journey-arrow', 'aria-hidden': 'true' }, '↗'),
        )
      : storyEnabled
        ? el(
            'a',
            { href: venueAwarePath('/ristorante', site, venue) },
            el('span', { class: 'restaurant-journey-number', 'aria-hidden': 'true' }, '02'),
            el('span', {}, 'La nostra storia'),
            el('span', { class: 'restaurant-journey-arrow', 'aria-hidden': 'true' }, '↗'),
          )
        : null,
    contactsEnabled
      ? el(
          'a',
          { href: venueAwarePath('/contatti', site, venue) },
          el('span', { class: 'restaurant-journey-number', 'aria-hidden': 'true' }, '03'),
          el('span', {}, 'Vieni a trovarci'),
          el('span', { class: 'restaurant-journey-arrow', 'aria-hidden': 'true' }, '↗'),
        )
      : null,
  );
  const hospitality = el('div', { class: 'restaurant-home-content' });
  const main = el('div', { class: 'restaurant-home' }, heading, journey, menuPreview, hospitality);
  if (storyEnabled) {
    hospitality.append(
      el(
        'section',
        { class: 'restaurant-story-panel' },
        el(
          'div',
          {},
          el('p', { class: 'restaurant-kicker' }, 'LA NOSTRA IDENTITÀ'),
          el('h2', {}, textValue(site.content, 'story_title', 'Il nostro ristorante')),
        ),
        el(
          'div',
          {},
          el(
            'p',
            {},
            textValue(
              site.content,
              'story',
              'La cucina, le persone e i piccoli dettagli che rendono speciale ogni visita.',
            ),
          ),
          el(
            'a',
            { href: venueAwarePath('/ristorante', site, venue), class: 'restaurant-section-link' },
            'Conosci il ristorante ↗',
          ),
        ),
      ),
    );
  }
  hospitality.append(
    el(
      'aside',
      { class: 'restaurant-visit-panel', 'aria-label': 'Organizza la tua visita' },
      el('p', { class: 'restaurant-kicker' }, 'LA TUA PROSSIMA VISITA'),
      el('h2', {}, 'Un posto a tavola, per te.'),
      el('p', {}, 'Tutte le informazioni per venirci a trovare, senza complicazioni.'),
      el(
        'div',
        { class: 'restaurant-visit-links' },
        bookingEnabled
          ? el(
              'a',
              { href: bookingHref },
              el('span', {}, 'Prenota un tavolo'),
              el('span', { 'aria-hidden': 'true' }, '↗'),
            )
          : null,
        site.multi_venue && sectionEnabled(site, 'venues')
          ? el(
              'a',
              { href: '/sedi' },
              el('span', {}, 'Scegli la sede'),
              el('span', { 'aria-hidden': 'true' }, '↗'),
            )
          : null,
        contactsEnabled
          ? el(
              'a',
              { href: venueAwarePath('/contatti', site, venue) },
              el('span', {}, 'Orari e contatti'),
              el('span', { 'aria-hidden': 'true' }, '↗'),
            )
          : null,
        galleryEnabled
          ? el(
              'a',
              { href: venueAwarePath('/gallery', site, venue) },
              el('span', {}, 'Scopri gli ambienti'),
              el('span', { 'aria-hidden': 'true' }, '↗'),
            )
          : null,
        el(
          'a',
          { href: menuHref },
          el('span', {}, 'La nostra carta'),
          el('span', { 'aria-hidden': 'true' }, '↗'),
        ),
      ),
    ),
  );
  if (venue && sectionEnabled(site, 'venues')) {
    main.append(
      el(
        'section',
        { class: 'restaurant-location-panel' },
        el(
          'div',
          { class: 'restaurant-section-heading' },
          el(
            'div',
            {},
            el('p', { class: 'restaurant-kicker' }, 'DOVE TROVARCI'),
            el('h2', {}, venue.name),
          ),
        ),
        venueCard(venue, site.multi_venue),
      ),
    );
  }
  return main;
}

async function menu(site: PublicSite, venue: Venue | undefined): Promise<HTMLElement> {
  const section = el(
    'section',
    { class: 'public-section' },
    el('p', { class: 'eyebrow' }, 'Una scelta di gusto'),
    el('h1', {}, 'Scopri la nostra cucina'),
    el(
      'p',
      { class: 'public-intro' },
      textValue(site.content, 'menu_intro', 'I sapori che amiamo, preparati per essere condivisi.'),
    ),
  );
  if (!venue) {
    section.append(
      emptyState(
        'Sede non disponibile',
        'Il collegamento indica una sede non valida o non più attiva. Seleziona una sede dal sito del ristorante.',
      ),
    );
    if (site.multi_venue)
      section.append(el('a', { href: '/sedi', class: 'button secondary' }, 'Visualizza le sedi'));
    return section;
  }
  const picker = venuePicker(site, venue, false);
  if (picker) section.append(picker);
  // Independent read-only requests run together; catalog availability stays live.
  const [availableMenus, dishes] = await Promise.all([
    import('../../src/pages/public-menu')
      .then((page) => page.publishedMenuIndex(venue, site.multi_venue))
      .catch(() => null),
    rpc('get_public_menu', { p_venue: venue.id }, z.array(menuDishSchema)),
  ]);
  if (availableMenus) section.append(availableMenus);
  section.classList.add('restaurant-menu');
  const categories = [...new Set(dishes.map((dish) => dish.category_name))];
  if (!dishes.length) {
    section.append(
      emptyState('Il menu è in preparazione', 'Contattaci per conoscere le proposte della cucina.'),
    );
    return section;
  }
  const search = el('input', {
    type: 'search',
    class: 'public-menu-search',
    placeholder: 'Cerca un piatto o un ingrediente…',
    'aria-label': 'Cerca un piatto nella carta',
    autocomplete: 'off',
  });
  const count = el(
    'span',
    { class: 'public-menu-results', role: 'status' },
    `${dishes.length} piatti`,
  );
  const categoryNav = el('nav', {
    class: 'public-category-nav',
    'aria-label': 'Categorie del menu',
  });
  let selected: string | null = null;
  const filters: HTMLButtonElement[] = [];
  const simplify = (value: string) =>
    value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('it');
  const noResults = emptyState(
    'Nessun piatto trovato',
    'Prova un altro nome o mostra di nuovo tutta la carta.',
  );
  noResults.hidden = true;
  const applyFilter = (): void => {
    const query = simplify(search.value.trim());
    let visible = 0;
    for (const card of section.querySelectorAll<HTMLElement>('.dish-public')) {
      card.hidden =
        (selected !== null && card.dataset.category !== selected) ||
        Boolean(query && !simplify(card.dataset.search ?? '').includes(query));
      if (!card.hidden) visible++;
    }
    for (const heading of section.querySelectorAll<HTMLElement>('.menu-category')) {
      const grid = heading.nextElementSibling as HTMLElement;
      const shown = [...grid.children].some((card) => !(card as HTMLElement).hidden);
      heading.hidden = !shown;
      grid.hidden = !shown;
    }
    for (const filter of filters)
      filter.setAttribute('aria-pressed', String((filter.dataset.category ?? null) === selected));
    count.textContent = visible === 1 ? '1 piatto' : `${visible} piatti`;
    noResults.hidden = visible > 0;
  };
  for (const category of [null, ...categories]) {
    const filter = button(
      '',
      () => {
        selected = category;
        applyFilter();
      },
      'quiet',
    );
    filter.classList.add('public-category-filter');
    filter.setAttribute('aria-pressed', String(category === null));
    if (category !== null) filter.dataset.category = category;
    const quantity =
      category === null
        ? dishes.length
        : dishes.filter((dish) => dish.category_name === category).length;
    filter.append(
      el('span', {}, category ?? 'Tutti'),
      el('span', { class: 'category-count', 'aria-hidden': 'true' }, quantity),
    );
    filters.push(filter);
    categoryNav.append(filter);
  }
  search.addEventListener('input', applyFilter);
  noResults.append(
    button(
      'Mostra tutti i piatti',
      () => {
        selected = null;
        search.value = '';
        applyFilter();
      },
      'secondary',
    ),
  );
  section.append(el('div', { class: 'public-menu-toolbar' }, search, count), categoryNav);
  for (const [index, category] of categories.entries()) {
    section.append(
      el('h2', { class: 'menu-category', id: `categoria-${index}` }, category),
      el(
        'div',
        { class: 'dish-grid' },
        ...dishes
          .filter((dish) => dish.category_name === category)
          .map((dish) => {
            const card = publicDishCard(dish, venue);
            card.dataset.category = category;
            return card;
          }),
      ),
    );
  }
  section.append(noResults);
  return section;
}

function venuePicker(site: PublicSite, venue: Venue, bookingOnly: boolean): HTMLElement | null {
  if (!site.multi_venue || site.venues.length <= 1) return null;
  const choices = bookingOnly
    ? site.venues.filter((entry) => entry.reservations_enabled)
    : site.venues;
  if (choices.length <= 1) return null;
  const select = el(
    'select',
    {
      'aria-label': bookingOnly ? 'Scegli la sede per la prenotazione' : 'Scegli la sede',
      class: 'venue-selection',
    },
    ...choices.map((entry) => el('option', { value: entry.slug }, entry.name)),
  );
  select.value = venue.slug;
  select.addEventListener('change', () =>
    route(`${currentPublicPath()}?sede=${encodeURIComponent(select.value)}`),
  );
  return select;
}

function venueCard(venue: Venue, linkToVenue = false): HTMLElement {
  return el(
    'article',
    { class: 'card public-contact venue-card' },
    el('h3', {}, venue.name),
    el('address', {}, venue.address),
    el('p', {}, el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, venue.phone)),
    venue.email ? el('p', {}, el('a', { href: `mailto:${venue.email}` }, venue.email)) : null,
    el(
      'a',
      {
        href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue.address)}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        class: 'public-directions',
      },
      'Indicazioni stradali ↗',
    ),
    Object.keys(venue.opening_hours).length === 0
      ? el(
          'p',
          { class: 'muted' },
          'Per orari e disponibilità aggiornati, contattaci prima della visita.',
        )
      : null,
    ...Object.entries(venue.opening_hours).map(([day, hours]) =>
      el('p', {}, `${day} · ${typeof hours === 'string' ? hours : ''}`),
    ),
    linkToVenue
      ? el('a', { href: `/sedi/${encodeURIComponent(venue.slug)}` }, 'Scopri la sede ↗')
      : null,
  );
}

function venuePage(site: PublicSite, venue: Venue): HTMLElement {
  const bookingLink = venue.reservations_enabled ? venueAwarePath('/prenota', site, venue) : null;
  return el(
    'section',
    { class: 'public-section venue-page' },
    el('p', { class: 'eyebrow' }, site.name),
    el('h1', {}, venue.name),
    el(
      'div',
      { class: 'venue-page-grid' },
      venueCard(venue),
      el(
        'div',
        { class: 'venue-actions' },
        el('h2', {}, 'Organizza la tua visita'),
        el(
          'p',
          { class: 'muted' },
          'Consulta il menu della sede e verifica gli orari prima di raggiungerci.',
        ),
        el(
          'a',
          { class: 'button primary', href: venueAwarePath('/menu', site, venue) },
          'Menu della sede',
        ),
        bookingLink
          ? el('a', { class: 'button secondary', href: bookingLink }, 'Prenota un tavolo')
          : null,
      ),
    ),
  );
}
function footer(site: PublicSite): HTMLElement {
  const instagram = safePublicLink(textValue(site.contact, 'instagram'), window.location.origin);
  const facebook = safePublicLink(textValue(site.contact, 'facebook'), window.location.origin);
  const privacy = safePublicLink(textValue(site.content, 'privacy_url'), window.location.origin);
  return el(
    'footer',
    { class: 'public-footer' },
    el(
      'div',
      {},
      el('p', { class: 'restaurant-brand' }, site.name),
      el('p', {}, textValue(site.content, 'footer')),
    ),
    el(
      'div',
      {},
      el('p', { class: 'eyebrow' }, 'Vieni a trovarci'),
      ...site.venues.map((venue) => el('p', {}, venue.address)),
    ),
    el(
      'div',
      {},
      el('p', { class: 'eyebrow' }, 'Contatti'),
      ...site.venues.map((venue) => el('p', {}, venue.phone)),
      textValue(site.contact, 'email')
        ? el(
            'p',
            {},
            el(
              'a',
              { href: `mailto:${textValue(site.contact, 'email')}` },
              textValue(site.contact, 'email'),
            ),
          )
        : null,
      instagram
        ? el(
            'p',
            {},
            el('a', { href: instagram, target: '_blank', rel: 'noopener noreferrer' }, 'Instagram'),
          )
        : null,
      facebook
        ? el(
            'p',
            {},
            el('a', { href: facebook, target: '_blank', rel: 'noopener noreferrer' }, 'Facebook'),
          )
        : null,
      textValue(site.contact, 'vat_number')
        ? el('p', {}, `P. IVA ${textValue(site.contact, 'vat_number')}`)
        : null,
      privacy
        ? el(
            'p',
            {},
            el('a', { href: privacy, target: '_blank', rel: 'noopener noreferrer' }, 'Privacy'),
          )
        : null,
    ),
    el('div', { class: 'powered' }, 'Powered by Plateform'),
  );
}
function failed(error: unknown): void {
  app.removeAttribute('aria-busy');
  releasePublicObservers();
  failClosedPublicMetadata();
  app.replaceChildren(
    el(
      'main',
      { id: 'main', class: 'public-error' },
      el('p', { class: 'eyebrow' }, 'A presto'),
      el('h1', {}, 'Il sito non è al momento disponibile.'),
      el('p', { class: 'muted' }, 'Riprova tra poco.'),
    ),
  );
  if (import.meta.env.DEV) showError(error);
}
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('a') : null;
  if (
    !(target instanceof HTMLAnchorElement) ||
    target.origin !== location.origin ||
    !isClientSidePublicPath(internalPublicPath(target.pathname, PUBLIC_BASE) ?? '') ||
    (target.target !== '' && target.target !== '_self') ||
    target.hasAttribute('download') ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0 ||
    target.hash
  )
    return;
  event.preventDefault();
  route((internalPublicPath(target.pathname, PUBLIC_BASE) ?? '/') + target.search);
});
window.addEventListener('popstate', () => startPublicRender());
// Keyboard skip links must move focus, not only scroll the viewport.
document.querySelector('a.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  document.getElementById('main')?.focus();
});
startPublicRender();

void registerPwa().catch(() => {});
