/** The restaurant server, not the browser, owns availability and booking status. */
export type PublicSlot = {
  time: string;
  available: boolean;
  reason?: string;
  status_if_booked?: 'RESERVED' | 'REQUESTED' | 'PENDING_DEPOSIT';
  deposit?: { amount_cents: number; currency: string; expiry_minutes: number };
};
export type PublicAvailability = {
  venue_id: string;
  service_id: string;
  date: string;
  party_size: number;
  slots: PublicSlot[];
};
export type SearchKey = { venueId: string; serviceId: string; date: string; party: number };
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const localTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function venueLocalToday(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Calendar-day shift, intentionally not a 24-hour local-time shift (DST-safe). */
export function addCalendarDays(iso: string, days: number): string {
  if (!isoDate.test(iso)) throw new Error('INVALID_DATE');
  const value = new Date(`${iso}T12:00:00.000Z`);
  if (!Number.isFinite(value.valueOf()) || value.toISOString().slice(0, 10) !== iso)
    throw new Error('INVALID_DATE');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function bookableSlots(input: unknown, expected: SearchKey): PublicSlot[] {
  if (!input || typeof input !== 'object') throw new Error('INVALID_AVAILABILITY');
  const data = input as Partial<PublicAvailability>;
  if (data.venue_id !== expected.venueId || data.service_id !== expected.serviceId ||
      data.date !== expected.date || data.party_size !== expected.party ||
      !Array.isArray(data.slots)) throw new Error('STALE_AVAILABILITY');
  const unique = new Set<string>();
  const slots: PublicSlot[] = [];
  for (const slot of data.slots) {
    if (!slot || typeof slot !== 'object' || !localTime.test(slot.time) ||
        typeof slot.available !== 'boolean' || unique.has(slot.time))
      throw new Error('INVALID_AVAILABILITY');
    unique.add(slot.time);
    if (!slot.available) continue;
    if (!['RESERVED', 'REQUESTED', 'PENDING_DEPOSIT'].includes(slot.status_if_booked ?? ''))
      throw new Error('INVALID_AVAILABILITY');
    slots.push(slot);
  }
  return slots;
}

/** A checkout URL comes from our authoritative Edge Function, never the form. */
export function verifiedPaymentUrl(url: unknown, provider: 'STRIPE' | 'SATISPAY'): string {
  if (typeof url !== 'string' || url.length > 2048) throw new Error('INVALID_CHECKOUT_URL');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port)
    throw new Error('INVALID_CHECKOUT_URL');
  // Match only the concrete checkout hosts allowed by the server integration.
  // A generic *.stripe.com / *.satispay.com suffix would allow unrelated hosts.
  const allowedHosts = provider === 'STRIPE'
    ? ['checkout.stripe.com']
    : ['online.satispay.com', 'staging-online.satispay.com', 'staging.online.satispay.com'];
  if (!allowedHosts.includes(parsed.hostname)) throw new Error('INVALID_CHECKOUT_URL');
  return parsed.href;
}

export type CheckoutResult = {
  deposit_id: string;
  provider: 'STRIPE' | 'SATISPAY';
  state: 'WAITING' | 'COMPLETED' | 'FAILED';
  checkout_url: string | null;
};

/** Provider initiation is not a payment receipt; only the backend may confirm a booking. */
export function depositNextAction(
  result: CheckoutResult,
  depositId: string,
  provider: 'STRIPE' | 'SATISPAY',
): { action: 'REDIRECT'; url: string } | { action: 'AWAIT_CONFIRMATION' | 'FAILED' | 'PROCESSING' } {
  if (result.deposit_id !== depositId || result.provider !== provider)
    throw new Error('INVALID_CHECKOUT_CONTEXT');
  if (result.state === 'COMPLETED') return { action: 'AWAIT_CONFIRMATION' };
  if (result.state === 'FAILED') return { action: 'FAILED' };
  if (!result.checkout_url) return { action: 'PROCESSING' };
  return { action: 'REDIRECT', url: verifiedPaymentUrl(result.checkout_url, provider) };
}
