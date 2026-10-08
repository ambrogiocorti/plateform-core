import { z } from 'npm:zod@4.6.5';
import { endpoint, rateLimit, secret, serverClient, userClient } from '../_shared/http.ts';
Deno.serve(
  endpoint(z.object({}).strict(), async (_body, request) => {
    const caller = userClient(request);
    const { data: identity, error } = await caller.auth.getUser();
    if (error || !identity.user) throw new Error('UNAUTHORIZED');
    await rateLimit(`offline-snapshot:${identity.user.id}`, 10, 600, request);
    const { data, error: claimsError } = await caller.rpc('prepare_offline_authorization');
    if (claimsError) throw new Error('FORBIDDEN');
    const prepared = z
      .object({ challenge_id: z.uuid(), claims: z.object({ user_id: z.uuid() }).passthrough() })
      .parse(data);
    if (prepared.claims.user_id !== identity.user.id) throw new Error('FORBIDDEN');
    const jwk = z
      .object({
        kty: z.literal('EC'),
        crv: z.literal('P-256'),
        x: z.string(),
        y: z.string(),
        d: z.string(),
      })
      .parse(JSON.parse(secret('OFFLINE_SIGNING_PRIVATE_JWK')));
    const signingKey = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, ext: true, key_ops: ['sign'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const payload = JSON.stringify(prepared.claims);
    const signature = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            signingKey,
            new TextEncoder().encode(payload),
          ),
        ),
      ),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const { data: id, error: storeError } = await serverClient(request).rpc(
      'store_offline_authorization',
      { p_challenge: prepared.challenge_id, p_claims: payload, p_signature: signature },
    );
    if (storeError) throw new Error('REQUEST_FAILED');
    return {
      id: z.uuid().parse(id),
      payload,
      signature,
      public_key: {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
        ext: true,
        key_ops: ['verify'],
      },
    };
  }),
);
