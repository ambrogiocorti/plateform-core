import { registerPwa } from '../../src/services/pwa';
import '../../styles/public.css';
import { z } from 'zod';
import { rpc } from '../../src/api/client';
import { button, el, emptyState, loading, showError } from '../../src/components/dom';
import { watchLive } from '../../src/realtime/live';
import { environment, safeImageUrl } from '../../src/config/environment';
import { menuDishSchema, publicSiteSchema } from '../../src/types/domain';
import type { PublicSite, Venue } from '../../src/types/domain';
import { availabilityBadge } from '../../src/services/menu';
import { formatMoney } from '../../src/services/money';
import { setupPublicNavigation } from '../../src/services/public-navigation';
import {
  bookingVenue,
  canonicalPublicUrl,
  isClientSidePublicPath,
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

try {
  const storedRoute = sessionStorage.getItem('plateform-route-public');
  if (storedRoute !== null) {
    sessionStorage.removeItem('plateform-route-public');
    const recovered = safeRecoveredPublicRoute(storedRoute, location.origin);
    if (recovered) history.replaceState(null, '', recovered);
  }
} catch {
  // Storage may be unavailable in a privacy-restricted browser. Serve /.
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
  const explicitlySelectedVenue = location.pathname.startsWith('/sedi/') ||
    new URLSearchParams(location.search).has('sede');
  const invalidVenueContext = explicitlySelectedVenue && !venue;
  const pageLabels: Record<string, string> = {
    '/menu': 'Menu',
    '/ristorante': 'Il ristorante',
    '/gallery': 'Gallery',
    '/sedi': 'Sedi',
    '/prenota': 'Prenota',
    '/contatti': 'Contatti',
  };
  const configuredTitle = textValue(site.content, 'seo_title', site.name);
  const pageLabel = location.pathname.startsWith('/sedi/')
    ? (venue?.name ?? 'Sede')
    : pageLabels[location.pathname];
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
    location.pathname,
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
  if (!location.pathname.startsWith('/tavolo/') && !invalidVenueContext) {
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
  void pending.then(() => {
    if (expectedRevision === revision && focusAfterNavigation)
      document.getElementById('main')?.focus({ preventScroll: true });
  }).catch((error: unknown) => {
    // A superseded slow RPC must not replace a newer, successfully rendered
    // page with the error state from the previous navigation.
    if (expectedRevision === revision) failed(error);
  });
}
function route(path: string): void {
  history.pushState(null, '', path);
  startPublicRender(true);
}

async function render(): Promise<void> {
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
  if (preservePrerender) app.setAttribute('aria-busy', 'true');
  else app.replaceChildren(loading());
  const site = await rpc('get_public_site', {}, publicSiteSchema.nullable());
  if (current !== revision) return;
  app.removeAttribute('aria-busy');
  if (!site) {
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
  const venue = selectedVenue(site, location.pathname, location.search);
  applyMetadata(site, venue);
  const invalidVenueContext = !venue &&
    (location.pathname.startsWith('/sedi/') || new URLSearchParams(location.search).has('sede'));
  if (invalidVenueContext) {
    // Invalid/archived venue URLs are never indexable and must not receive a
    // canonical address or structured data belonging to another venue.
    document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.remove();
    document.head.querySelector('meta[property="og:url"]')?.remove();
    const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (robots) robots.content = 'noindex,nofollow';
  }
  if (!location.pathname.startsWith('/tavolo/') && !invalidVenueContext) {
    const pathForSeo = location.pathname;
    const seoRevision = current;
    void rpc('get_public_page_metadata', {
      p_path: pathForSeo, p_venue: venue?.id ?? null,
    }, z.object({
      path: z.string(), title: z.string(), description: z.string(),
      robots: z.enum(['index,follow', 'noindex,nofollow']),
      canonical_url: z.string().nullable(), og_image_url: z.string().nullable(),
    })).then((metadata) => {
      if (seoRevision !== revision || metadata.path !== location.pathname) return;
      document.title = metadata.title;
      setMeta('description', metadata.description);
      setMeta('og:title', metadata.title, true);
      setMeta('og:description', metadata.description, true);
      const multiVenueQuery = site.multi_venue && site.venues.length > 1 &&
        new URLSearchParams(location.search).has('sede');
      const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
      if (robots) robots.content = invalidVenueContext || multiVenueQuery
        ? 'noindex,nofollow' : metadata.robots;
      const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (canonical) {
        if (invalidVenueContext) canonical.remove();
        else if (metadata.canonical_url) canonical.href = metadata.canonical_url;
        else canonical.remove();
      }
      if (metadata.og_image_url) setMeta('og:image', metadata.og_image_url, true);
    }).catch(() => {
      // Never promote an unverified route or deployment to public indexing.
      const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
      if (seoRevision === revision && robots) robots.content = 'noindex,nofollow';
    });
  }
  const reservationVenue = resolveBookingVenue(site, location.pathname, location.search);
  const bookingEnabled = sectionEnabled(site, 'booking') && Boolean(reservationVenue);
  const venueSlug = location.pathname.startsWith('/sedi/')
    ? location.pathname.split('/')[2]
    : undefined;
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
          ...(location.pathname === link.current ||
          (link.current === '/sedi' && location.pathname.startsWith('/sedi/'))
            ? { 'aria-current': 'page' }
            : {}),
        },
        link.label,
      ),
    ),
  );
  const menuButton = el('button', {
    type: 'button', class: 'button quiet public-menu-toggle',
    'aria-controls': 'public-navigation', 'aria-expanded': 'false',
  }, 'Menu');
  const header = el(
    'header',
    { class: 'public-header' },
    el(
      'a',
      { href: '/', class: 'restaurant-brand', 'aria-label': `${site.name} — Home` },
      logo ? el('img', { src: logo, alt: '', width: '150', decoding: 'async' }) : site.name,
    ),
    menuButton,
    navigation,
  );
  app.replaceChildren(header, main, footer(site));
  setupPublicNavigation(menuButton, navigation, header, lifetime.signal);
  stopPerformance?.();
  stopPerformance = observePublicPerformance(venue?.id);
  recordPublicPageView(venue?.id);
  const path = location.pathname;
  if (path === '/') main.append(home(site, venue, bookingEnabled ? reservationVenue : undefined));
  else if (path === '/menu') main.append(await menu(site, venue));
  else if (path.startsWith('/menu/') && venue) {
    const slug = path.slice('/menu/'.length);
    main.append(await (await import('../../src/pages/public-menu')).publishedMenuPage(slug, venue));
  }
  else if (path.startsWith('/menu/') && !venue) {
    main.append(emptyState('Sede non disponibile',
      'Il collegamento del menu si riferisce a una sede non valida o non più attiva.'));
    if (site.multi_venue) main.append(el('a', { href: '/sedi' }, 'Visualizza le sedi'));
  }
  else if (path === '/ristorante' && sectionEnabled(site, 'story'))
    main.append(
      el(
        'section',
        { class: 'public-section story-grid' },
        el(
          'div',
          {},
          el('p', { class: 'eyebrow' }, site.name),
          el('h1', {}, textValue(site.content, 'story_title', 'Il ristorante')),
        ),
        el(
          'div',
          { class: 'story-copy' },
          textValue(
            site.content,
            'story',
            'Per conoscere la nostra cucina e organizzare la tua visita, contattaci.',
          ),
        ),
      ),
    );
  else if (path === '/gallery' && sectionEnabled(site, 'gallery')) {
    const photos = z
      .array(z.object({ url: z.string(), alt: z.string() }))
      .safeParse(site.content.gallery);
    main.append(
      el(
        'section',
        { class: 'public-section' },
        el('p', { class: 'eyebrow' }, 'I nostri spazi'),
        el('h1', {}, 'Gallery'),
        el(
          'div',
          { class: 'gallery-grid' },
          ...(photos.success ? photos.data : []).flatMap((photo) => {
            const source = safeImageUrl(photo.url);
            return source
              ? [el('img', { src: source, alt: photo.alt, loading: 'lazy', decoding: 'async' })]
              : [];
          }),
        ),
      ),
    );
  } else if (path.startsWith('/sedi/') && sectionEnabled(site, 'venues')) {
    const entry = site.venues.find((candidate) => candidate.slug === venueSlug);
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
          'div',
          { class: 'grid' },
          ...site.venues.map((entry) => venueCard(entry, site.multi_venue)),
        ),
      ),
    );
  } else if (path === '/prenota' && reservationVenue && bookingEnabled) {
    const section = el(
      'section',
      { class: 'public-section' },
      el('p', { class: 'eyebrow' }, 'Ci vediamo a tavola'),
      el('h1', {}, 'Prenota la tua visita'),
      venuePicker(site, reservationVenue, true),
    );
    main.append(section);
    section.append(
      await (await import('../../src/pages/public-booking')).bookingPage(
        reservationVenue, safePublicLink(textValue(site.content, 'privacy_url'), window.location.origin),
      ),
    );
  } else if (path === '/prenota') {
    main.append(emptyState('Prenotazioni online non disponibili',
      'La sede richiesta non accetta prenotazioni online. Contatta il ristorante o scegli un’altra sede.'));
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
        emptyState('Pagina non disponibile', 'Torna alla home o contattaci per informazioni.'),
        el('a', { href: '/' }, 'Torna alla home'),
      ),
    );
  if (!venue || path.startsWith('/tavolo/')) {
    // Leaving a known public venue must unsubscribe before a stale callback
    // can refresh an invalid venue page or retain the previous venue context.
    stopLive?.();
    stopLive = undefined;
    liveKey = '';
  }
  if (venue && !path.startsWith('/tavolo/')) {
    const key = `${venue.id}:${path}`;
    const connection = el('p', {
      id: 'public-connection',
      class: 'public-section muted',
      role: 'status',
    });
    connection.hidden = true;
    main.append(connection);
    const update = button('Il menu è cambiato. Aggiorna', async () => render(), 'secondary');
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
            location.pathname === '/prenota' ||
            document.activeElement?.matches('input,select,textarea')
          ) {
            const notice = document.getElementById('public-refresh');
            if (notice) notice.hidden = false;
            return;
          }
          const scroll = window.scrollY;
          await render();
          window.scrollTo(0, scroll);
        },
        state: (state) => {
          const label = document.getElementById('public-connection');
          if (label) {
            label.hidden = state === 'LIVE';
            label.textContent =
              state === 'OFFLINE' ? 'MODALITÀ OFFLINE' : 'Aggiornamenti da verificare';
          }
        },
      });
    }
  }
}

function applyBrand(site: PublicSite): void {
  // Always reconstruct the theme from the latest authoritative site snapshot.
  // Otherwise removing a previously configured color/font leaves stale inline
  // CSS variables behind after Realtime refresh or SPA navigation.
  for (const token of ['--bg', '--accent', '--accent-ink', '--font', '--public-heading-font'])
    document.documentElement.style.removeProperty(token);
  const darkMode = site.branding.dark_mode !== false;
  const defaultBackground = darkMode ? '#111315' : '#f4f0e8';
  const background = safeBackground(textValue(site.branding, 'background_color'), darkMode);
  if (background) document.documentElement.style.setProperty('--bg', background);
  const accent = safeAccent(
    textValue(site.branding, 'accent_color'),
    background ?? defaultBackground,
  );
  if (accent) {
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-ink', readableInk(accent));
  }
  const bodyFonts: Record<string, string> = {
    SANS: 'Inter, Segoe UI, Arial, sans-serif',
    SERIF: 'Georgia, Times New Roman, serif',
    HUMANIST: 'Trebuchet MS, Segoe UI, sans-serif',
  };
  const headingFonts: Record<string, string> = {
    SANS: 'Inter, Segoe UI, Arial, sans-serif',
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
    if (icon) icon.href = '/icon.svg';
  }
}

function home(site: PublicSite, venue: Venue | undefined, bookingDestination?: Venue): HTMLElement {
  const bookingEnabled = Boolean(bookingDestination);
  const image = safeImageUrl(site.content.hero_image_url);
  return el(
    'div',
    {},
    el(
      'section',
      { class: 'public-hero' },
      image
        ? el('img', {
            src: image,
            alt: textValue(site.content, 'hero_image_alt', site.name),
            fetchpriority: 'high',
            decoding: 'async',
          })
        : null,
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, textValue(site.content, 'hero_eyebrow', site.name)),
        el('h1', {}, textValue(site.content, 'hero_title', site.name)),
        el(
          'p',
          {},
          textValue(
            site.content,
            'hero_subtitle',
            'La nostra cucina. Il piacere di stare a tavola.',
          ),
        ),
        el(
          'a',
          {
            href: bookingEnabled
              ? venueAwarePath('/prenota', site, bookingDestination)
              : venueAwarePath('/menu', site, venue),
            class: 'button primary',
          },
          bookingEnabled ? 'Prenota un tavolo ↗' : 'Scopri il menu ↗',
        ),
      ),
    ),
    sectionEnabled(site, 'story')
      ? el(
          'section',
          { class: 'public-section story-grid' },
          el(
            'div',
            {},
            el('p', { class: 'eyebrow' }, 'La nostra storia'),
            el('h2', {}, textValue(site.content, 'story_title', 'Un invito a rallentare.')),
          ),
          el(
            'div',
            {},
            el(
              'p',
              { class: 'story-copy' },
              textValue(
                site.content,
                'story',
                'Scopri il menu, conosci il ristorante e scegli quando venirci a trovare.',
              ),
            ),
            el('a', { href: venueAwarePath('/ristorante', site, venue) }, 'Il ristorante ↗'),
          ),
        )
      : null,
    venue && sectionEnabled(site, 'venues')
      ? el(
          'section',
          { class: 'public-section' },
          el('p', { class: 'eyebrow' }, 'Ti aspettiamo'),
          el('h2', {}, venue.name),
          venueCard(venue, site.multi_venue),
        )
      : null,
  );
}

async function menu(site: PublicSite, venue: Venue | undefined): Promise<HTMLElement> {
  const section = el(
    'section',
    { class: 'public-section' },
    el('p', { class: 'eyebrow' }, 'A tavola'),
    el('h1', {}, 'Il nostro menu'),
  );
  if (!venue) {
    section.append(emptyState('Sede non disponibile',
      'Il collegamento indica una sede non valida o non più attiva. Seleziona una sede dal sito del ristorante.'));
    if (site.multi_venue)
      section.append(el('a', { href: '/sedi', class: 'button secondary' }, 'Visualizza le sedi'));
    return section;
  }
  const picker = venuePicker(site, venue, false);
  if (picker) section.append(picker);
  const availableMenus = await (await import('../../src/pages/public-menu')).publishedMenuIndex(venue, site.multi_venue);
  if (availableMenus) section.append(availableMenus);
  const dishes = await rpc('get_public_menu', { p_venue: venue.id }, z.array(menuDishSchema));
  const categories = [...new Set(dishes.map((dish) => dish.category_name))];
  for (const category of categories) {
    section.append(el('h2', { class: 'menu-category' }, category));
    section.append(
      el(
        'div',
        { class: 'dish-grid' },
        ...dishes
          .filter((dish) => dish.category_name === category)
          .map((dish) => {
            const picture = safeImageUrl(dish.image_path);
            const badge = availabilityBadge(dish.availability);
            return el(
              'article',
              { class: 'dish-public' },
              picture
                ? el('img', { src: picture, alt: dish.name, loading: 'lazy', decoding: 'async' })
                : null,
              el(
                'div',
                { class: 'row between' },
                el('h3', {}, dish.name),
                el('strong', {}, formatMoney(dish.price_cents, venue.currency, venue.locale)),
              ),
              el('p', {}, dish.description),
              !dish.beverage
                ? el('p', {}, dish.ingredients.map((ingredient) => ingredient.name).join(', '))
                : null,
              dish.allergens.length
                ? el(
                    'p',
                    { class: 'allergens' },
                    `Contiene: ${dish.allergens.map((allergen) => allergen.name).join(', ')}`,
                  )
                : null,
              el(
                'div',
                { class: 'row' },
                ...dish.dietary_tags.map((tag) => el('span', { class: 'status' }, tag.label)),
                badge.label ? el('span', { class: 'status' }, badge.label) : null,
              ),
            );
          }),
      ),
    );
  }
  if (!dishes.length)
    section.append(
      el(
        'p',
        { class: 'muted' },
        'Il menu viene aggiornato dal ristorante. Contattaci per conoscere le proposte disponibili.',
      ),
    );
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
    route(`${location.pathname}?sede=${encodeURIComponent(select.value)}`),
  );
  return select;
}

function venueCard(venue: Venue, linkToVenue = false): HTMLElement {
  return el(
    'article',
    { class: 'card public-contact venue-card' },
    el('h3', {}, venue.name),
    el('p', {}, venue.address),
    el('p', {}, el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, venue.phone)),
    venue.email ? el('p', {}, el('a', { href: `mailto:${venue.email}` }, venue.email)) : null,
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
    !isClientSidePublicPath(target.pathname) ||
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
  route(target.pathname + target.search);
});
window.addEventListener('popstate', () => startPublicRender());
startPublicRender();

void registerPwa().catch(() => {});
