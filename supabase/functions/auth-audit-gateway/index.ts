import { z } from 'npm:zod@4.6.5';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { endpoint, rateKey, rateLimit, secret, serverClient, userClient } from '../_shared/http.ts';

const login = z.object({
  action: z.literal('PASSWORD_LOGIN'),
  identifier: z.email().max(254),
  password: z.string().min(1).max(1024),
}).strict();
const mfa = z.object({
  action: z.literal('MFA_VERIFY'),
  factor_id: z.uuid(),
  code: z.string().regex(/^[0-9]{6}$/),
}).strict();
const schema = z.discriminatedUnion('action', [login, mfa]);

async function reportVerifiedDenial(request: Request, action: 'AUTH_LOGIN_FAILED' | 'MFA_VERIFICATION_FAILED',
  userId: string | null = null, sessionId: string | null = null): Promise<void> {
  const { data, error } = await serverClient(request).rpc('record_auth_gateway_failure', {
    p_action: action,
    p_user: userId,
    p_session: sessionId,
  });
  if (error || data !== true) {
    console.error('AUTH_AUDIT_DENIAL_RECORD_FAILED');
    throw new Error('REQUEST_FAILED');
  }
}

function verifiedSessionId(bearer: string): string {
  try {
    const jwt = bearer.split('.')[1] ?? '';
    const decoded = JSON.parse(atob(jwt.replace(/-/g, '+').replace(/_/g, '/')));
    return z.object({ session_id: z.uuid() }).parse(decoded).session_id;
  } catch {
    throw new Error('UNAUTHORIZED');
  }
}

Deno.serve(endpoint(schema, async (body, request) => {
  // One shared, privacy-preserving rate limit per trusted ingress address:
  // no email, password, factor ID, OTP, bearer or IP is persisted in audit.
  const ipKey = await rateKey(request);
  if (body.action === 'PASSWORD_LOGIN') {
    await rateLimit('auth-password-gateway:' + ipKey, 10, 600, request);
    const verifier = createClient(secret('SUPABASE_URL'), secret('SUPABASE_ANON_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await verifier.auth.signInWithPassword({
      email: body.identifier.trim(),
      password: body.password,
    });
    if (error) {
      if (error.code !== 'invalid_credentials') {
        // Outage, disabled login or rate-limiting errors are not credential failures.
        throw new Error('REQUEST_FAILED');
      }
      await reportVerifiedDenial(request, 'AUTH_LOGIN_FAILED');
      return { status: 'REJECTED' };
    }
    if (!data.session?.access_token || !data.session.refresh_token) {
      throw new Error('REQUEST_FAILED');
    }
    return {
      status: 'ACCEPTED',
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    };
  }

  const bearer = request.headers.get('authorization') ?? '';
  if (!bearer.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');
  const caller = userClient(request);
  const { data: identity, error: identityError } = await caller.auth.getUser();
  if (identityError || !identity.user) throw new Error('UNAUTHORIZED');
  const sessionId = verifiedSessionId(bearer.slice(7));

  await rateLimit('auth-mfa-gateway:' + identity.user.id + ':' + ipKey, 8, 600, request);
  const totpFactors = await caller.auth.mfa.listFactors();
  if (totpFactors.error ||
      !totpFactors.data.totp.some(factor =>
        factor.id === body.factor_id && factor.status === 'verified')) {
    throw new Error('FORBIDDEN');
  }
  // The server verifies the OTP outcome directly with GoTrue, not a client claim.
  const authBase = secret('SUPABASE_URL') + '/auth/v1';
  const headers = {
    apikey: secret('SUPABASE_ANON_KEY'),
    authorization: bearer,
    'content-type': 'application/json',
  };
  const challenged = await fetch(authBase + '/factors/' + body.factor_id + '/challenge', {
    method: 'POST',
    headers,
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  if (!challenged.ok) throw new Error('REQUEST_FAILED');
  const challenge = z.object({ id: z.uuid() }).parse(await challenged.json());
  const verified = await fetch(authBase + '/factors/' + body.factor_id + '/verify', {
    method: 'POST',
    headers,
    body: JSON.stringify({ challenge_id: challenge.id, code: body.code }),
    signal: AbortSignal.timeout(15000),
  });
  if (!verified.ok) {
    if (verified.status !== 400 && verified.status !== 422) throw new Error('REQUEST_FAILED');
    await reportVerifiedDenial(request, 'MFA_VERIFICATION_FAILED', identity.user.id, sessionId);
    return { status: 'REJECTED' };
  }
  const session = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
  }).parse(await verified.json());
  return {
    status: 'ACCEPTED',
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  };
}, { maxBytes: 4096 }));
