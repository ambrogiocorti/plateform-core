import { z } from 'zod';
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const verificationKeySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: coordinate,
    y: coordinate,
    ext: z.boolean().optional(),
    key_ops: z.array(z.literal('verify')).optional(),
  })
  .strict();
export const authorizationSchema = z.object({
  id: z.uuid(),
  payload: z.string().max(65536),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  public_key: verificationKeySchema,
});
export const claimsSchema = z.object({
  user_id: z.uuid(),
  role: z.enum(['ADMIN', 'HOST', 'WAITER', 'KITCHEN_ADMIN', 'KITCHEN_STAFF', 'PASS']),
  scope: z.enum(['CHAIN', 'VENUE']),
  device_id: z.uuid(),
  issued_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
  venue_ids: z.array(z.uuid()),
  operational_assignments: z.object({
    tables: z.array(
      z.object({
        venue_id: z.uuid(),
        table_id: z.uuid().nullable(),
        zone_id: z.uuid().nullable(),
        mode: z.enum(['TABLE', 'ZONE', 'RUNNER']),
      }),
    ),
    stations: z.array(z.object({ venue_id: z.uuid(), station_id: z.uuid() })),
  }),
});
export function offlineVerificationKeys(): z.infer<typeof verificationKeySchema>[] {
  try {
    return z
      .array(verificationKeySchema)
      .min(1)
      .max(3)
      .parse(JSON.parse(import.meta.env.VITE_OFFLINE_PUBLIC_KEYS_JWK ?? '[]'));
  } catch {
    return [];
  }
}
export async function verifyOfflineAuthorization(
  record: z.infer<typeof authorizationSchema>,
  trustedKeys: z.infer<typeof verificationKeySchema>[],
  now = Date.now(),
  highWater = 0,
): Promise<z.infer<typeof claimsSchema> | undefined> {
  try {
    const trusted = trustedKeys.find(
      (key) => key.x === record.public_key.x && key.y === record.public_key.y,
    );
    if (!trusted) return undefined;
    const key = await crypto.subtle.importKey(
      'jwk',
      {
        kty: trusted.kty,
        crv: trusted.crv,
        x: trusted.x,
        y: trusted.y,
        ext: true,
        key_ops: ['verify'],
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const signature = Uint8Array.from(
      atob(record.signature.replaceAll('-', '+').replaceAll('_', '/')),
      (char) => char.charCodeAt(0),
    );
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        signature,
        new TextEncoder().encode(record.payload),
      ))
    )
      return undefined;
    const claims = claimsSchema.parse(JSON.parse(record.payload));
    if (
      now < highWater - 60000 ||
      now < Date.parse(claims.issued_at) - 60000 ||
      now >= Date.parse(claims.expires_at) ||
      Date.parse(claims.expires_at) <= Date.parse(claims.issued_at)
    )
      return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
