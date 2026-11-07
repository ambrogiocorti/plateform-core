import { endpoint, rateKey, rateLimit, serverClient } from '../_shared/http.ts';
import {
  waitlistAcceptResult,
  waitlistCreateResult,
  waitlistRequestSchema,
} from '../_shared/waitlist.ts';

// Public entry/acceptance functions are service-role-only in Postgres. The
// gateway enforces origin, payload limits, trusted-IP rate limits and exact
// request schemas before invoking those authoritative database transactions.
// No caller credential or opaque offer token is ever logged or returned by
// other users' endpoints.
Deno.serve(
  endpoint(waitlistRequestSchema, async (body, request) => {
    const ipKey = await rateKey(request);
    await rateLimit(
      `waitlist-edge:${body.action}:${ipKey}`,
      body.action === 'CREATE' ? 10 : 20,
      600,
      request,
    );

    if (body.action === 'CREATE') {
      const { data, error } = await serverClient(request).rpc('create_waitlist_entry', {
        p_venue: body.venue_id,
        p_service: body.service_id,
        p_date: body.date,
        p_preferred_start: body.preferred_start,
        p_preferred_end: body.preferred_end,
        p_party: body.party_size,
        p_customer_name: body.customer_name,
        p_customer_phone: body.customer_phone,
        p_notes: body.notes,
        p_key: body.idempotency_key,
        p_rate_key: ipKey,
      });
      if (error) throw new Error(error.message);
      // The SQL rate limiter may return a structured denial rather than throw.
      if (data && typeof data === 'object' && 'error' in data && data.error === 'RATE_LIMITED')
        throw new Error('RATE_LIMITED');
      return waitlistCreateResult.parse(data);
    }

    const { data, error } = await serverClient(request).rpc('accept_waitlist_offer', {
      p_entry: body.entry_id,
      p_access_token: body.access_token,
      p_key: body.idempotency_key,
    });
    if (error) throw new Error(error.message);
    return waitlistAcceptResult.parse(data);
  }),
);
