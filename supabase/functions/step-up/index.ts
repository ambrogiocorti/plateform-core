import { z } from 'npm:zod@4.6.5';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { endpoint, rateKey, rateLimit, secret, serverClient, userClient } from '../_shared/http.ts';

const schema = z
  .object({
    password: z.string().min(1).max(1024),
    action: z.string().min(1).max(50),
    resource_id: z.uuid().nullable().default(null),
  })
  .strict();
Deno.serve(
  endpoint(schema, async (body, request) => {
    const user = userClient(request, body.action === 'IMPERSONATION');
    const { data: identity, error: identityError } = await user.auth.getUser();
    if (identityError || !identity.user?.email) throw new Error('UNAUTHORIZED');
    await rateLimit(`step-up:${identity.user.id}:${await rateKey(request)}`, 5, 600, request);
    const { data: allowed, error: permissionError } = await user.rpc('authorize_sensitive_action', {
      p_action: body.action,
      p_resource: body.resource_id,
    });
    if (permissionError) throw new Error('FORBIDDEN');
    const authorization = z.object({ user_id: z.uuid(), session_id: z.uuid() }).parse(allowed);
    const verifier = createClient(secret('SUPABASE_URL'), secret('SUPABASE_ANON_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    try {
      const { data, error } = await verifier.auth.signInWithPassword({
        email: identity.user.email,
        password: body.password,
      });
      if (error || data.user?.id !== identity.user.id || authorization.user_id !== identity.user.id)
        throw new Error('UNAUTHORIZED');
      const { data: grant, error: grantError } = await serverClient(request).rpc(
        'issue_step_up_grant',
        {
          p_user: identity.user.id,
          p_session: authorization.session_id,
          p_action: body.action,
          p_resource: body.resource_id,
        },
      );
      if (grantError) throw new Error('REQUEST_FAILED');
      return { grant_id: z.uuid().parse(grant) };
    } finally {
      await verifier.auth.signOut({ scope: 'local' });
    }
  }),
);
