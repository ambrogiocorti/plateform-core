export interface PrintAuthorization {
  audience: 'plateform-print-bridge';
  issuer: string;
  bridge_origin: string;
  staff_origin: string;
  job_id: string;
  device_id: string;
  lease_id: string;
  document_sha256: string;
  issued_at: string;
  expires_at: string;
}
export interface PrintToken {
  payload: string;
  signature: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function publicPrintKey(key: JsonWebKey): boolean {
  return (
    key.kty === 'EC' &&
    key.crv === 'P-256' &&
    typeof key.x === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(key.x) &&
    typeof key.y === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(key.y) &&
    !Object.hasOwn(key, 'd')
  );
}
export async function documentHash(document: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function signPrintAuthorization(
  claims: PrintAuthorization,
  key: JsonWebKey,
): Promise<PrintToken> {
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const payload = JSON.stringify(claims),
    signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      new TextEncoder().encode(payload),
    );
  return {
    payload,
    signature: btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', ''),
  };
}
export async function verifyPrintAuthorization(
  token: PrintToken,
  keys: JsonWebKey[],
  expected: { issuer: string; bridge_origin: string; staff_origin: string },
  now = Date.now(),
): Promise<PrintAuthorization> {
  if (
    typeof token?.payload !== 'string' ||
    token.payload.length > 4096 ||
    typeof token?.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(token.signature) ||
    !keys.length ||
    keys.length > 3 ||
    keys.some((key) => !publicPrintKey(key))
  )
    throw new Error('INVALID_PRINT_AUTHORIZATION');
  const signature = Uint8Array.from(
    atob(token.signature.replaceAll('-', '+').replaceAll('_', '/') + '=='),
    (c) => c.charCodeAt(0),
  );
  let verified = false;
  for (const key of keys) {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    if (
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        signature,
        new TextEncoder().encode(token.payload),
      )
    ) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new Error('INVALID_PRINT_AUTHORIZATION');
  const value: unknown = JSON.parse(token.payload);
  if (!value || typeof value !== 'object') throw new Error('INVALID_PRINT_AUTHORIZATION');
  const c = value as Record<string, unknown>;
  if (
    Object.keys(c).length !== 10 ||
    c.audience !== 'plateform-print-bridge' ||
    c.issuer !== expected.issuer ||
    c.bridge_origin !== expected.bridge_origin ||
    c.staff_origin !== expected.staff_origin ||
    !['job_id', 'device_id', 'lease_id'].every(
      (field) => typeof c[field] === 'string' && uuid.test(c[field] as string),
    ) ||
    typeof c.document_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(c.document_sha256) ||
    typeof c.issued_at !== 'string' ||
    typeof c.expires_at !== 'string'
  )
    throw new Error('INVALID_PRINT_AUTHORIZATION');
  const issued = Date.parse(c.issued_at),
    expires = Date.parse(c.expires_at);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    expires - issued > 120000 ||
    now < issued - 5000 ||
    now >= expires
  )
    throw new Error('PRINT_AUTHORIZATION_EXPIRED');
  return c as unknown as PrintAuthorization;
}
