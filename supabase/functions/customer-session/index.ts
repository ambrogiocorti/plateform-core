import { z } from 'npm:zod@4.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { endpoint, rateKey, rateLimit, secret, serverClient } from '../_shared/http.ts';

const schema = z
  .object({ public_table_id: z.uuid(), code: z.string().regex(/^\d{6}$/), device_id: z.uuid() })
  .strict();

async function accessBucket(parts: readonly string[]): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret('RATE_LIMIT_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(JSON.stringify(['plateform-customer-access-v1', ...parts])),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

Deno.serve(
  endpoint(schema, async (body, request) => {
    const ip = await rateKey(request);
    await rateLimit(`customer-ip:${ip}`, 20, 600, request);
    await rateLimit(`customer-device:${ip}:${body.device_id}`, 5, 300, request);
    const admin = serverClient(request);
    const [ipBucket, deviceBucket] = await Promise.all([
      accessBucket([body.public_table_id, 'ip', ip]),
      accessBucket([body.public_table_id, 'device', body.device_id]),
    ]);
    const checkBucket = async (bucket: string): Promise<number> => {
      const { data, error } = await admin.rpc('check_customer_access_backoff', {
        p_bucket: bucket,
      });
      if (error) throw new Error('REQUEST_FAILED');
      return z.number().int().nonnegative().parse(data);
    };
    const blocked = Math.max(
      ...(await Promise.all([checkBucket(ipBucket), checkBucket(deviceBucket)])),
    );
    if (blocked > 0) throw new Error('RATE_LIMITED');

    const { data: verified, error } = await admin.rpc('verify_customer_code', {
      p_public_table: body.public_table_id,
      p_code: body.code,
    });
    if (error || !verified) {
      const record = async (bucket: string): Promise<void> => {
        const { error: recordError } = await admin.rpc('record_customer_access_failure', {
          p_bucket: bucket,
        });
        if (recordError) throw new Error('REQUEST_FAILED');
      };
      await Promise.all([record(ipBucket), record(deviceBucket)]);
      throw new Error('UNAUTHORIZED');
    }
    const clear = async (bucket: string): Promise<void> => {
      const { error: clearError } = await admin.rpc('clear_customer_access_backoff', {
        p_bucket: bucket,
      });
      if (clearError) throw new Error('REQUEST_FAILED');
    };
    await Promise.all([clear(ipBucket), clear(deviceBucket)]);

    const account = z
      .object({ account_id: z.uuid(), table_id: z.uuid(), access_epoch: z.number().int() })
      .parse(verified);
    const email = `${crypto.randomUUID()}@customer.plateform.invalid`;
    const password = Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { kind: 'CUSTOMER_SESSION' },
    });
    if (createError || !created.user) throw new Error('REQUEST_FAILED');
    const { error: retentionError } = await admin.rpc('register_customer_identity_retention', {
      p_user: created.user.id,
    });
    if (retentionError) {
      await admin.auth.admin.deleteUser(created.user.id);
      throw new Error('REQUEST_FAILED');
    }
    const customer = createClient(secret('SUPABASE_URL'), secret('SUPABASE_ANON_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let completed = false;
    try {
      const { data: session, error: loginError } = await customer.auth.signInWithPassword({
        email,
        password,
      });
      if (loginError || !session.session) throw new Error('REQUEST_FAILED');
      const { error: attachError } = await admin.rpc('attach_customer_session', {
        p_user: created.user.id,
        p_account: account.account_id,
        p_table: account.table_id,
        p_epoch: account.access_epoch,
      });
      if (attachError) throw new Error('UNAUTHORIZED');
      completed = true;
      return {
        access_token: session.session.access_token,
        refresh_token: session.session.refresh_token,
      };
    } finally {
      if (!completed) await admin.auth.admin.deleteUser(created.user.id);
    }
  }),
);
