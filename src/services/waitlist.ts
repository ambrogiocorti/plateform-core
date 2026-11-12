import { z } from 'zod';

export const waitlistCreateResponse = z.object({
  id: z.uuid(),
  status: z.literal('WAITING'),
  service_date: z.iso.date(),
  preferred_start_time: z.string(),
  preferred_end_time: z.string().nullable(),
});

export const waitlistAcceptResponse = z.object({
  entry_id: z.uuid(),
  status: z.literal('CONVERTED_TO_RESERVATION'),
  reservation_id: z.uuid(),
  reservation_status: z.enum(['RESERVED', 'PENDING_DEPOSIT']),
  offered_time: z.string(),
  deposit: z
    .object({
      id: z.uuid(),
      amount_cents: z.number().int().positive(),
      currency: z.literal('EUR'),
      expires_at: z.string(),
      access_token: z.string(),
    })
    .nullable(),
});

const uuid = z.uuid();

export function waitlistOfferFragment(entry: string, token: string): string {
  if (!uuid.safeParse(entry).success || !/^[a-f0-9]{32,256}$/i.test(token))
    throw new Error('INVALID_WAITLIST_LINK');
  // Fragments are not sent in HTTP requests or Referer headers. The recipient
  // page immediately removes the token from browser history after parsing.
  return `#${new URLSearchParams({ entry, token }).toString()}`;
}

export function readWaitlistOfferFragment(hash: string): { entry: string; token: string } | null {
  if (hash.length > 600 || !hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (params.getAll('entry').length !== 1 || params.getAll('token').length !== 1) return null;
  const entry = params.get('entry') ?? '';
  const token = params.get('token') ?? '';
  if (!uuid.safeParse(entry).success || !/^[a-f0-9]{32,256}$/i.test(token)) return null;
  return { entry, token };
}

/** Service slots support services which end after midnight. */
export function waitlistServiceTimes(startsAt: string, endsAt: string, interval: number): string[] {
  const valid = (value: string): number | null => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const start = valid(startsAt);
  let end = valid(endsAt);
  if (
    start === null ||
    end === null ||
    !Number.isInteger(interval) ||
    interval < 5 ||
    interval > 240
  )
    return [];
  if (end <= start) end += 1440;
  const result: string[] = [];
  for (let minute = start; minute < end && result.length < 288; minute += interval) {
    const m = minute % 1440;
    result.push(
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
    );
  }
  return result;
}
