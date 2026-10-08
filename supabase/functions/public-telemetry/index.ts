import { z } from 'npm:zod@4.6.5';
import { endpoint, rateKey, rateLimit, serverClient } from '../_shared/http.ts';

const schema = z
  .object({
    event: z.enum(['PUBLIC_PAGE_VIEW', 'PUBLIC_PERFORMANCE']),
    path: z.enum([
      '/',
      '/menu',
      '/menu/:slug',
      '/ristorante',
      '/gallery',
      '/sedi',
      '/sedi/:venue',
      '/prenota',
      '/contatti',
    ]),
    venue_id: z.uuid().nullable().optional(),
    metric: z.enum(['TTFB', 'FCP', 'LCP', 'CLS', 'INP']).optional(),
    value: z.number().finite().nonnegative().max(60000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.event === 'PUBLIC_PERFORMANCE' &&
      (value.metric === undefined || value.value === undefined)
    )
      context.addIssue({ code: 'custom', message: 'INVALID_PERFORMANCE_EVENT' });
    if (
      value.event === 'PUBLIC_PAGE_VIEW' &&
      (value.metric !== undefined || value.value !== undefined)
    )
      context.addIssue({ code: 'custom', message: 'INVALID_PAGE_VIEW_EVENT' });
    if (value.metric === 'CLS' && value.value !== undefined && value.value > 100)
      context.addIssue({ code: 'custom', message: 'INVALID_CLS' });
  });

Deno.serve(
  endpoint(schema, async (body, request) => {
    const source = await rateKey(request);
    await rateLimit(`public-telemetry:${source}`, 120, 60, request);
    const server = serverClient(request);
    let venueId: string | null = null;
    if (body.venue_id) {
      const { data, error } = await server
        .from('venues')
        .select('id')
        .eq('id', body.venue_id)
        .eq('active', true)
        .maybeSingle();
      if (error) throw new Error('REQUEST_FAILED');
      if (!data) throw new Error('INVALID_PAYLOAD');
      venueId = data.id;
    }
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    const correlationId = request.headers.get('x-correlation-id') ?? requestId;
    const properties: Record<string, string | number> = { path: body.path };
    if (body.metric !== undefined) properties.metric = body.metric;
    if (body.value !== undefined) properties.value = body.value;
    const { error } = await server.from('telemetry_events').insert({
      venue_id: venueId,
      event: body.event,
      environment: Deno.env.get('ENVIRONMENT') ?? 'development',
      release_version: Deno.env.get('RELEASE_VERSION') ?? '0.1.0',
      request_id: requestId,
      correlation_id: correlationId,
      properties,
    });
    if (error) throw new Error('REQUEST_FAILED');
    return { accepted: true };
  }),
);
