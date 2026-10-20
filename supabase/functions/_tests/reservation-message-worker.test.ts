import {
  claimSchema,
  deliver,
  deliveryMode,
  renderBody,
  settlement,
  venueEnv,
  waitlistAcceptUrl,
  workerTokenValid,
  type ClaimedJob,
  type Env,
  type Fetch,
} from '../reservation-message-worker/delivery.ts';
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
const VENUE = '11111111-2222-4333-8444-555555555555';
const JOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LEASE = '99999999-8888-4777-8666-555555555555';
const TWILIO_SID = `AC${'a'.repeat(32)}`;
function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return claimSchema.parse({
    status: 'CLAIMED',
    id: JOB,
    provider_idempotency_key: JOB,
    lease_token: LEASE,
    lease_until: '2026-10-20T10:01:00Z',
    attempt: 1,
    max_attempts: 3,
    venue_id: VENUE,
    reservation_id: '12345678-1234-4234-8234-123456789012',
    resource_type: null,
    resource_id: null,
    event_type: 'RESERVATION_CONFIRMATION',
    channel: 'SMS',
    adapter: 'TWILIO',
    unknown_outcome_policy: 'RECONCILE',
    sender_ref: '+390212345678',
    destination: '+393331234567',
    locale: 'it-IT',
    template_key: 'confirm',
    body_template:
      'Ciao {{customer_name}}, {{ venue_name }} ti aspetta il {{reservation_date}} alle {{reservation_time}} ({{party_size}}).',
    provider_template_ref: null,
    template_data: {
      reservation_id: '12345678-1234-4234-8234-123456789012',
      customer_name: 'Mario Rossi',
      venue_name: 'Trattoria',
      reservation_date: '2026-10-21',
      reservation_time: '20:30:00',
      party_size: 4,
      service_name: 'Cena',
      deposit_amount: null,
    },
    ...overrides,
  }) as ClaimedJob;
}
const envOf =
  (values: Record<string, string>): Env =>
  (name) =>
    values[name];
const live = envOf({
  ENVIRONMENT: 'staging',
  TWILIO_ACCOUNT_SID: TWILIO_SID,
  TWILIO_AUTH_TOKEN: 'twilio-token',
  RESEND_API_KEY: 're_test',
  TELEGRAM_BOT_TOKEN: `123456:${'A'.repeat(35)}`,
  PUBLIC_BASE_URL: 'https://prenota.example.it/',
});
type Call = { url: string; init: RequestInit };
function fakeFetch(response: () => Response | Promise<Response>, calls: Call[] = []): Fetch {
  return (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(response());
  };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noNetwork: Fetch = () => {
  throw new Error('network must not be used');
};

Deno.test('worker token is required, long enough and compared exactly', async () => {
  const token = 'x'.repeat(40);
  assert(await workerTokenValid(token, token), 'matching token accepted');
  assert(!(await workerTokenValid(token, `${token}y`)), 'different token refused');
  assert(!(await workerTokenValid(token, null)), 'missing header refused');
  assert(!(await workerTokenValid(undefined, token)), 'unset env fails closed');
  assert(!(await workerTokenValid('short', 'short')), 'short secret fails closed');
});

Deno.test('delivery mode must be explicit', () => {
  equal(deliveryMode(envOf({})), null, 'unset');
  equal(deliveryMode(envOf({ MESSAGE_DELIVERY_MODE: 'yes' })), null, 'invalid');
  equal(deliveryMode(envOf({ MESSAGE_DELIVERY_MODE: 'LIVE' })), 'live', 'live');
  equal(deliveryMode(envOf({ MESSAGE_DELIVERY_MODE: 'dry_run' })), 'dry_run', 'dry run');
});

Deno.test('venue scoped secrets override installation secrets', () => {
  const scoped = `TWILIO_AUTH_TOKEN_${VENUE.replaceAll('-', '').toUpperCase()}`;
  equal(
    venueEnv(envOf({ TWILIO_AUTH_TOKEN: 'a', [scoped]: 'b' }), 'TWILIO_AUTH_TOKEN', VENUE),
    'b',
    'scoped',
  );
  equal(venueEnv(envOf({ TWILIO_AUTH_TOKEN: 'a' }), 'TWILIO_AUTH_TOKEN', VENUE), 'a', 'global');
});

Deno.test('templates render allowed variables and refuse unknown ones', () => {
  equal(
    renderBody(job(), live),
    'Ciao Mario Rossi, Trattoria ti aspetta il 21/10/2026 alle 20:30 (4).',
    'rendered',
  );
  let refused = '';
  try {
    renderBody(job({ body_template: 'Token {{waitlist_access_token}}' }), live);
  } catch (error) {
    refused = (error as Error).message;
  }
  equal(refused, 'MESSAGE_TEMPLATE_INVALID', 'raw token placeholder refused');
});

Deno.test('waitlist accept link keeps the token in the fragment', () => {
  const entry = '22222222-3333-4444-8555-666666666666',
    token = 'f'.repeat(64);
  const url = new URL(waitlistAcceptUrl('https://prenota.example.it/', entry, token));
  equal(url.searchParams.get('waitlist_offer'), entry, 'entry in query');
  equal(url.hash, `#token=${token}`, 'token in fragment');
  assert(!url.search.includes(token), 'token not in query');
  let code = '';
  try {
    waitlistAcceptUrl('http://insecure.example', entry, token);
  } catch (error) {
    code = (error as Error).message;
  }
  equal(code, 'PUBLIC_BASE_URL_REQUIRED', 'https required');
  const offer = job({
    event_type: 'WAITLIST_OFFER',
    channel: 'WHATSAPP',
    reservation_id: null,
    resource_type: 'waitlist_entries',
    resource_id: entry,
    body_template: 'Posto alle {{waitlist_offer_time}}: {{waitlist_accept_url}}',
    template_data: {
      waitlist_entry_id: entry,
      waitlist_access_token: token,
      waitlist_offer_time: '21:00:00',
    },
  });
  const body = renderBody(offer, live)!;
  assert(body.startsWith('Posto alle 21:00: https://prenota.example.it/?waitlist_offer='), body);
});

Deno.test('Twilio SMS send maps to finish_message_job SENT', async () => {
  const calls: Call[] = [];
  const sid = `SM${'b'.repeat(32)}`;
  const outcome = await deliver(job(), {
    mode: 'live',
    env: live,
    fetch: fakeFetch(() => json(201, { sid, status: 'queued' }), calls),
  });
  equal(outcome, { kind: 'SENT', providerMessageId: sid }, 'outcome');
  equal(
    calls[0]!.url,
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    'url',
  );
  const form = new URLSearchParams(String(calls[0]!.init.body));
  equal(form.get('To'), '+393331234567', 'to');
  equal(form.get('From'), '+390212345678', 'from');
  const plan = settlement(job(), outcome);
  equal(plan.rpc, 'finish_message_job', 'rpc');
  equal(
    plan.args,
    {
      p_job: JOB,
      p_lease: LEASE,
      p_provider_message_id: sid,
      p_state: 'SENT',
      p_event_id: `worker:${JOB}:1`,
      p_retryable: false,
      p_error_code: null,
    },
    'args name all seven parameters',
  );
});

Deno.test('Twilio WhatsApp prefixes addresses and uses Content templates', async () => {
  const calls: Call[] = [];
  const content = `HX${'c'.repeat(32)}`;
  await deliver(job({ channel: 'WHATSAPP', body_template: null, provider_template_ref: content }), {
    mode: 'live',
    env: live,
    fetch: fakeFetch(() => json(201, { sid: `SM${'d'.repeat(32)}`, status: 'queued' }), calls),
  });
  const form = new URLSearchParams(String(calls[0]!.init.body));
  equal(form.get('To'), 'whatsapp:+393331234567', 'to');
  equal(form.get('From'), 'whatsapp:+390212345678', 'from');
  equal(form.get('ContentSid'), content, 'content sid');
  equal(JSON.parse(form.get('ContentVariables')!).customer_name, 'Mario Rossi', 'variables');
  assert(!form.has('Body'), 'no body with content template');
});

Deno.test('provider failures are classified without guessing', async () => {
  const run = (response: () => Response) =>
    deliver(job(), { mode: 'live', env: live, fetch: fakeFetch(response) });
  equal(
    await run(() => json(400, { code: 21211 })),
    { kind: 'FAILED', code: 'TWILIO_21211' },
    'bad number',
  );
  equal(
    await run(() => json(429, { code: 20429 })),
    { kind: 'RETRY', code: 'TWILIO_20429' },
    'throttled',
  );
  equal(
    await run(() => json(401, { code: 20003 })),
    { kind: 'RETRY', code: 'TWILIO_20003' },
    'credentials',
  );
  equal(
    await run(() => json(503, {})),
    { kind: 'UNKNOWN', code: 'PROVIDER_HTTP_503' },
    '5xx unknown',
  );
  const timeout = await deliver(job(), {
    mode: 'live',
    env: live,
    fetch: () => Promise.reject(new Error('timeout')),
  });
  equal(timeout, { kind: 'UNKNOWN', code: 'REMOTE_OUTCOME_UNKNOWN' }, 'timeout unknown');
});

Deno.test('unknown outcome follows the venue policy', () => {
  const unknown = { kind: 'UNKNOWN', code: 'REMOTE_OUTCOME_UNKNOWN' } as const;
  const reconcile = settlement(job(), unknown);
  equal(reconcile.rpc, 'release_message_job_unknown', 'reconcile');
  equal(reconcile.args, { p_job: JOB, p_lease: LEASE }, 'release args');
  const retry = settlement(job({ unknown_outcome_policy: 'AUTO_RETRY' }), unknown);
  equal(retry.rpc, 'finish_message_job', 'auto retry rpc');
  assert(retry.rpc === 'finish_message_job' && retry.args.p_retryable, 'retryable');
  // Resend sends with an idempotency key, so a retry cannot duplicate the email.
  const resend = settlement(job({ adapter: 'RESEND', channel: 'EMAIL' }), unknown);
  equal(resend.result, 'RETRY', 'resend retry');
  const failed = settlement(job(), { kind: 'FAILED', code: 'twilio_21211' });
  assert(failed.rpc === 'finish_message_job' && !failed.args.p_retryable, 'permanent');
  equal(
    failed.rpc === 'finish_message_job' && failed.args.p_error_code,
    'TWILIO_21211',
    'code upper',
  );
});

Deno.test('Resend email uses the job idempotency key', async () => {
  const calls: Call[] = [];
  const outcome = await deliver(
    job({
      adapter: 'RESEND',
      channel: 'EMAIL',
      destination: 'mario@example.it',
      sender_ref: 'Trattoria <noreply@example.it>',
    }),
    { mode: 'live', env: live, fetch: fakeFetch(() => json(200, { id: 'email-1' }), calls) },
  );
  equal(outcome, { kind: 'SENT', providerMessageId: 'email-1' }, 'sent');
  const headers = new Headers(calls[0]!.init.headers);
  equal(headers.get('Idempotency-Key'), `message-job:${JOB}`, 'idempotency');
  const payload = JSON.parse(String(calls[0]!.init.body));
  equal(payload.to, ['mario@example.it'], 'to');
  equal(payload.subject, 'Trattoria - Conferma prenotazione', 'subject');
});

Deno.test('Telegram sends to the chat and builds a unique provider id', async () => {
  const calls: Call[] = [];
  const outcome = await deliver(
    job({
      adapter: 'TELEGRAM',
      channel: 'TELEGRAM',
      destination: '123456789',
      sender_ref: 'plateform_bot',
    }),
    {
      mode: 'live',
      env: live,
      fetch: fakeFetch(
        () => json(200, { ok: true, result: { message_id: 42, chat: { id: 123456789 } } }),
        calls,
      ),
    },
  );
  equal(outcome, { kind: 'SENT', providerMessageId: '123456789:42' }, 'sent');
  assert(calls[0]!.url.startsWith('https://api.telegram.org/bot123456:'), 'bot url');
  const blocked = await deliver(
    job({ adapter: 'TELEGRAM', channel: 'TELEGRAM', destination: '123456789' }),
    { mode: 'live', env: live, fetch: fakeFetch(() => json(403, { ok: false })) },
  );
  equal(blocked, { kind: 'FAILED', code: 'PROVIDER_HTTP_403' }, 'blocked bot');
});

Deno.test('missing provider configuration fails clearly and never calls the network', async () => {
  const outcome = await deliver(job(), { mode: 'live', env: envOf({}), fetch: noNetwork });
  equal(outcome, { kind: 'RETRY', code: 'PROVIDER_NOT_CONFIGURED' }, 'twilio unset');
  const email = await deliver(
    job({ adapter: 'RESEND', channel: 'EMAIL', destination: 'a@example.it' }),
    {
      mode: 'live',
      env: envOf({}),
      fetch: noNetwork,
    },
  );
  equal(email, { kind: 'RETRY', code: 'PROVIDER_NOT_CONFIGURED' }, 'resend unset');
});

Deno.test('dry run never contacts providers and never reports a fake send', async () => {
  equal(
    await deliver(job(), { mode: 'dry_run', env: live, fetch: noNetwork }),
    { kind: 'RETRY', code: 'DELIVERY_DRY_RUN' },
    'real adapter not sent',
  );
  equal(
    await deliver(job({ adapter: 'MOCK' }), { mode: 'dry_run', env: live, fetch: noNetwork }),
    { kind: 'SENT', providerMessageId: `mock:${JOB}` },
    'mock adapter simulated',
  );
  equal(
    await deliver(job({ adapter: 'MOCK' }), {
      mode: 'live',
      env: envOf({ ENVIRONMENT: 'production' }),
      fetch: noNetwork,
    }),
    { kind: 'FAILED', code: 'MOCK_ADAPTER_DISABLED' },
    'mock refused in production',
  );
});

Deno.test('idle claim parses', () => {
  equal(claimSchema.parse({ status: 'IDLE' }), { status: 'IDLE' }, 'idle');
});
