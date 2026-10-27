import { z } from 'npm:zod@4.6.5';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const waitlistRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('CREATE'),
      venue_id: z.uuid(),
      service_id: z.uuid(),
      date: z.iso.date(),
      preferred_start: time,
      preferred_end: time.nullable(),
      party_size: z.number().int().min(1).max(1000),
      customer_name: z.string().trim().min(1).max(160),
      customer_phone: z.string().regex(/^\+[0-9]{7,15}$/),
      notes: z.string().trim().max(2000).nullable(),
      idempotency_key: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('ACCEPT'),
      entry_id: z.uuid(),
      access_token: z
        .string()
        .min(32)
        .max(256)
        .regex(/^[a-f0-9]+$/i),
      idempotency_key: z.uuid(),
    })
    .strict(),
]);

export const waitlistCreateResult = z.object({
  id: z.uuid(),
  status: z.literal('WAITING'),
  service_date: z.iso.date(),
  preferred_start_time: z.string(),
  preferred_end_time: z.string().nullable(),
});

export const waitlistAcceptResult = z.object({
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
