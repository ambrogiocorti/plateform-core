// Venue hub → cloud ingest (ADR-0001). The hub authenticates with its own
// secret (Authorization: Bearer); only its SHA-256 reaches the database, which
// decides everything else in public.ingest_venue_hub_batch: venue scope,
// allowed tables, exactly-once by sequence and generation fencing.
import { z } from 'npm:zod@4.6.7';
import { endpoint, serverClient } from '../_shared/http.ts';

const change = z.object({
  seq: z.number().int().positive(),
  generation: z.number().int().positive(),
  txid: z.number().int().nonnegative(),
  table_name: z.string().max(128),
  op: z.enum(['INSERT', 'UPDATE', 'DELETE']),
  pk: z.record(z.string(), z.unknown()),
  row_data: z.record(z.string(), z.unknown()).nullable(),
});

const batch = z
  .object({
    hub_id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
    generation: z.number().int().positive(),
    changes: z.array(change).min(1).max(500),
  })
  .strict();

const DATABASE_CODES = new Set([
  'UNAUTHORIZED',
  'HUB_REVOKED',
  'HUB_GENERATION_FENCED',
  'HUB_GENERATION_NOT_PROMOTED',
  'INVALID_PAYLOAD',
]);

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(
  endpoint(
    batch,
    async (body, request) => {
      const secret = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
        request.headers.get('authorization') ?? '',
      )?.[1];
      if (!secret) throw new Error('UNAUTHORIZED');
      const { data, error } = await serverClient(request).rpc('ingest_venue_hub_batch', {
        p_hub: body.hub_id,
        p_token_sha256: await sha256(secret),
        p_generation: body.generation,
        p_changes: body.changes,
      });
      if (error)
        throw new Error(DATABASE_CODES.has(error.message) ? error.message : 'REQUEST_FAILED');
      return data;
    },
    { maxBytes: 2_000_000 },
  ),
);
