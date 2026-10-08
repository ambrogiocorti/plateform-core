import type { PublicSite, Venue } from '../types/domain';

export type PublicPath =
  '/' | '/menu' | '/ristorante' | '/gallery' | '/sedi' | '/prenota' | '/contatti';

export function selectedVenue(
  site: PublicSite,
  pathname: string,
  search: string,
): Venue | undefined {
  const params = new URLSearchParams(search);
  const querySlug = params.get('sede');
  const pathSlug = pathname.startsWith('/sedi/') ? pathname.split('/')[2] : undefined;
  const slug = pathSlug || querySlug;
  return site.venues.find((venue) => venue.slug === slug) ?? site.venues[0];
}

export function bookingVenue(site: PublicSite, current?: Venue): Venue | undefined {
  if (current?.reservations_enabled) return current;
  return site.venues.find((venue) => venue.reservations_enabled);
}

export function venueAwarePath(path: string, site: PublicSite, venue?: Venue): string {
  if (!venue || !site.multi_venue || site.venues.length <= 1 || path === '/' || path === '/sedi')
    return path;
  const url = new URL(path, 'https://plateform.invalid');
  url.searchParams.set('sede', venue.slug);
  return `${url.pathname}${url.search}`;
}

export function canonicalPublicUrl(
  site: PublicSite,
  pathname: string,
  search: string,
  origin: string,
): string {
  const contextual = new Set(['/menu', '/ristorante', '/gallery', '/prenota', '/contatti']);
  const venue = selectedVenue(site, pathname, search);
  const path = contextual.has(pathname) ? venueAwarePath(pathname, site, venue) : pathname;
  return new URL(path, origin).toString();
}

export function normalizePublicPath(
  pathname: string,
): PublicPath | '/menu/:slug' | '/sedi/:venue' | '/tavolo/:id' | null {
  // Keep the public route catalogue aligned with the pages actually rendered by
  // apps/public/main.ts. These canonical route labels are also used by telemetry.
  if (/^\/menu\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pathname))
    return '/menu/:slug';
  if (/^\/sedi\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pathname))
    return '/sedi/:venue';
  if (pathname.startsWith('/tavolo/') && pathname.split('/').filter(Boolean).length === 2)
    return '/tavolo/:id';
  return ['/', '/menu', '/ristorante', '/gallery', '/sedi', '/prenota', '/contatti'].includes(
    pathname,
  )
    ? (pathname as PublicPath)
    : null;
}

/** Only a route owned by the public SPA may be intercepted by its click router.
 * Staff, provider callbacks, document links and unknown URLs must perform a
 * normal browser navigation so the server can enforce host/path isolation.
 */
export function isClientSidePublicPath(pathname: string): boolean {
  return normalizePublicPath(pathname) !== null;
}

function rgb(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number | null {
  const value = rgb(hex);
  if (!value) return null;
  const channel = (input: number) => {
    const normalized = input / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(value[0]) + 0.7152 * channel(value[1]) + 0.0722 * channel(value[2]);
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  if (a === null || b === null) return 0;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function readableInk(background: string): '#111315' | '#fffdf8' {
  return contrastRatio(background, '#111315') >= contrastRatio(background, '#fffdf8')
    ? '#111315'
    : '#fffdf8';
}

export function safeBackground(candidate: string, darkMode: boolean): string | undefined {
  if (!/^#[0-9a-f]{6}$/i.test(candidate)) return undefined;
  const preferredText = darkMode ? '#f4f0e8' : '#181b1d';
  return contrastRatio(candidate, preferredText) >= 4.5 ? candidate : undefined;
}

export function safeAccent(candidate: string, background: string): string | undefined {
  if (!/^#[0-9a-f]{6}$/i.test(candidate) || !/^#[0-9a-f]{6}$/i.test(background)) return undefined;
  return contrastRatio(candidate, background) >= 4.5 ? candidate : undefined;
}
export function safePublicLink(value: string, origin: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, origin);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (url.protocol === 'http:' && url.origin !== new URL(origin).origin) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
