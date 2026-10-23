import { z } from 'npm:zod@4.6.5';
import { endpoint, rateKey, rateLimit, serverClient } from '../_shared/http.ts';

const schema = z
  .object({
    venue_id: z.uuid(),
    service_id: z.uuid(),
    date: z.iso.date(),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().max(100),
    phone: z.string().regex(/^\+[0-9]{7,15}$/),
    party_size: z.number().int().min(1).max(1000),
    answers: z.record(z.string(), z.unknown()),
    idempotency_key: z.uuid(),
  })
  .strict();

Deno.serve(
  endpoint(schema, async (body, request) => {
    const addressKey = await rateKey(request);
    await rateLimit(`reservation-ip:${addressKey}`, 10, 600, request);
    const { data, error } = await serverClient(request).rpc('create_public_reservation', {
      p_venue: body.venue_id,
      p_service: body.service_id,
      p_date: body.date,
      p_time: body.time,
      p_first_name: body.first_name,
      p_last_name: body.last_name,
      p_phone: body.phone,
      p_party: body.party_size,
      p_answers: body.answers,
      p_key: body.idempotency_key,
      p_rate_key: addressKey,
    });
    if (error) throw new Error(error.message);
    // Large groups (admin threshold) get PENDING_DEPOSIT plus the one-time deposit access token;
    // the table is only confirmed once a verified provider result settles the deposit.
    const result = z
      .discriminatedUnion('status', [
        z.object({ id: z.uuid(), status: z.enum(['RESERVED', 'REQUESTED']) }).strict(),
        z
          .object({
            id: z.uuid(),
            status: z.literal('PENDING_DEPOSIT'),
            deposit: z
              .object({
                id: z.uuid(),
                amount_cents: z.number().int().positive(),
                currency: z.literal('EUR'),
                expires_at: z.string(),
                access_token: z.string().regex(/^[0-9a-f]{64}$/),
                providers: z.array(z.enum(['STRIPE', 'SATISPAY'])).min(1),
              })
              .strict(),
          })
          .strict(),
      ])
      .parse(data);
    return result;
  }),
);
