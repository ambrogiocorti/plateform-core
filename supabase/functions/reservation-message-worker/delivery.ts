// Pure delivery logic for reservation-message-worker: no Supabase client, no Deno.serve.
// Provider calls go through an injected fetch so the module is unit-testable without network.
import { z } from 'npm:zod@4.6.5';

export type Env = (name: string) => string | undefined;
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

// Shape returned by public.claim_message_job(p_lease_seconds integer) (20261007175252).
export const claimSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('IDLE') }),
  z.object({
    status: z.literal('CLAIMED'),
    id: z.uuid(),
    lease_token: z.uuid(),
    attempt: z.number().int(),
    max_attempts: z.number().int(),
    venue_id: z.uuid(),
    reservation_id: z.uuid().nullable(),
    resource_type: z.string().nullable(),
    resource_id: z.uuid().nullable(),
    event_type: z.enum(['RESERVATION_CONFIRMATION', 'RESERVATION_REMINDER', 'WAITLIST_OFFER']),
    channel: z.enum(['WHATSAPP', 'SMS', 'TELEGRAM', 'EMAIL']),
    adapter: z.enum(['TWILIO', 'TELEGRAM', 'RESEND', 'MOCK']),
    unknown_outcome_policy: z.enum(['RECONCILE', 'AUTO_RETRY']),
    sender_ref: z.string().nullable(),
    destination: z.string(),
    locale: z.string(),
    template_key: z.string(),
    body_template: z.string().nullable(),
    provider_template_ref: z.string().nullable(),
    template_data: z.record(z.string(), z.unknown()),
  }),
]);
export type ClaimedJob = Extract<z.infer<typeof claimSchema>, { status: 'CLAIMED' }>;

// SENT: provider accepted the message. RETRY: known not sent, safe to try again.
// FAILED: known not sent, retrying cannot help. UNKNOWN: provider may have sent it.
export type Outcome =
  | { kind: 'SENT'; providerMessageId: string }
  | { kind: 'RETRY'; code: string; providerMessageId?: string }
  | { kind: 'FAILED'; code: string; providerMessageId?: string }
  | { kind: 'UNKNOWN'; code: string };

export type Mode = 'live' | 'dry_run';

/** MESSAGE_DELIVERY_MODE must be set explicitly; anything else keeps the worker disabled. */
export function deliveryMode(env: Env): Mode | null {
  const value = env('MESSAGE_DELIVERY_MODE')?.trim().toLowerCase();
  return value === 'live' || value === 'dry_run' ? value : null;
}

const encoder = new TextEncoder();
/** Constant-time comparison of the x-plateform-worker-token header with MESSAGE_WORKER_TOKEN. */
export async function workerTokenValid(
  expected: string | undefined,
  provided: string | null,
): Promise<boolean> {
  // invoke_reservation_message_worker refuses Vault tokens shorter than 32 characters.
  if (!expected || expected.length < 32 || expected.length > 1024) return false;
  if (!provided || provided.length > 1024) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
  ]);
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i]! ^ y[i]!;
  return difference === 0;
}

/** Per-venue override NAME_<VENUE_UUID_WITHOUT_HYPHENS_UPPERCASE>, then the installation-wide NAME. */
export function venueEnv(env: Env, name: string, venue: string): string | undefined {
  const scoped = env(`${name}_${venue.replaceAll('-', '').toUpperCase()}`)?.trim();
  if (scoped) return scoped;
  const global = env(name)?.trim();
  return global || undefined;
}

// Variables accepted by private.message_template_variables_valid (20261007175252).
export const TEMPLATE_VARIABLES = [
  'customer_name',
  'venue_name',
  'reservation_date',
  'reservation_time',
  'party_size',
  'service_name',
  'deposit_amount',
  'waitlist_offer_time',
  'waitlist_offer_expires_at',
  'waitlist_accept_url',
] as const;
const PLACEHOLDER = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g;

export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

function formatDate(value: unknown, locale: string): string {
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(`${text}T00:00:00Z`));
  } catch {
    return text;
  }
}
function formatTime(value: unknown): string {
  const text = String(value);
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text);
  return match ? `${match[1]}:${match[2]}` : text;
}
function formatTimestamp(value: unknown, locale: string, timeZone: string): string {
  const text = String(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return text;
  }
}

/** Accept link for a waitlist offer; the access token stays in the fragment, out of server logs. */
export function waitlistAcceptUrl(
  base: string | undefined,
  entry: unknown,
  token: unknown,
): string {
  if (!base) throw new DeliveryError('PUBLIC_BASE_URL_REQUIRED', true);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new DeliveryError('PUBLIC_BASE_URL_REQUIRED', true);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new DeliveryError('PUBLIC_BASE_URL_REQUIRED', true);
  if (!z.uuid().safeParse(entry).success || typeof token !== 'string' || token.length < 32)
    throw new DeliveryError('MESSAGE_PAYLOAD_INVALID', false);
  url.searchParams.set('waitlist_offer', String(entry));
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

/** Render {{variable}} placeholders. Unknown placeholders are refused, never left in the text. */
export function variables(job: ClaimedJob, env: Env): Record<string, string> {
  const data = job.template_data,
    locale = job.locale || 'it-IT',
    timeZone = env('MESSAGE_TIME_ZONE')?.trim() || 'Europe/Rome';
  const plain = (value: unknown) =>
    value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);
  const result: Record<string, string> = {
    customer_name: plain(data.customer_name),
    venue_name: plain(data.venue_name),
    reservation_date:
      data.reservation_date == null ? '' : formatDate(data.reservation_date, locale),
    reservation_time: data.reservation_time == null ? '' : formatTime(data.reservation_time),
    party_size: plain(data.party_size),
    service_name: plain(data.service_name),
    deposit_amount: plain(data.deposit_amount),
    waitlist_offer_time:
      data.waitlist_offer_time == null ? '' : formatTime(data.waitlist_offer_time),
    waitlist_offer_expires_at:
      data.waitlist_offer_expires_at == null
        ? ''
        : formatTimestamp(data.waitlist_offer_expires_at, locale, timeZone),
  };
  return result;
}

export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

export function renderBody(job: ClaimedJob, env: Env): string | null {
  if (job.body_template === null) return null;
  const used = placeholders(job.body_template);
  if (used.some((name) => !(TEMPLATE_VARIABLES as readonly string[]).includes(name)))
    throw new DeliveryError('MESSAGE_TEMPLATE_INVALID', false);
  const values = variables(job, env);
  if (used.includes('waitlist_accept_url')) {
    if (job.event_type !== 'WAITLIST_OFFER')
      throw new DeliveryError('MESSAGE_TEMPLATE_INVALID', false);
    values.waitlist_accept_url = waitlistAcceptUrl(
      env('PUBLIC_BASE_URL')?.trim(),
      job.template_data.waitlist_entry_id,
      job.template_data.waitlist_access_token,
    );
  }
  const body = job.body_template.replace(PLACEHOLDER, (_all, name: string) => values[name] ?? '');
  if (!body.trim()) throw new DeliveryError('MESSAGE_BODY_EMPTY', false);
  return body;
}

export function emailSubject(job: ClaimedJob): string {
  const venue = String(job.template_data.venue_name ?? '').trim();
  const english = job.locale.toLowerCase().startsWith('en');
  const label =
    job.event_type === 'RESERVATION_CONFIRMATION'
      ? english
        ? 'Reservation confirmed'
        : 'Conferma prenotazione'
      : job.event_type === 'RESERVATION_REMINDER'
        ? english
          ? 'Reservation reminder'
          : 'Promemoria prenotazione'
        : english
          ? 'A table is available'
          : 'Si è liberato un posto';
  return (venue ? `${venue} - ${label}` : label).slice(0, 200);
}

const E164 = /^\+[0-9]{7,15}$/;
const EMAIL =
  /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TELEGRAM_CHAT = /^(?:-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const TWILIO_CONTENT = /^HX[0-9a-fA-F]{32}$/;
const TWILIO_SERVICE = /^MG[0-9a-fA-F]{32}$/;

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw.length > 262144) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function call(fetcher: Fetch, url: string, init: RequestInit, timeoutMs: number) {
  try {
    return { response: await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }) };
  } catch {
    // Timeout or connection reset after the request may have reached the provider.
    return { response: null };
  }
}

/** Generic HTTP classification shared by the adapters. */
export function classifyStatus(status: number): 'RETRY' | 'FAILED' | 'UNKNOWN' {
  if (status === 401 || status === 403 || status === 404) return 'RETRY'; // credentials/config: fixable
  if (status === 408 || status === 409 || status === 425 || status === 429) return 'RETRY';
  if (status >= 500) return 'UNKNOWN';
  return 'FAILED';
}

// Twilio errors that mean the destination itself cannot receive the message.
const TWILIO_PERMANENT = new Set([21211, 21212, 21408, 21610, 21612, 21614, 63003, 63024]);

async function sendTwilio(
  job: ClaimedJob,
  body: string | null,
  env: Env,
  fetcher: Fetch,
  timeoutMs: number,
): Promise<Outcome> {
  const sid = venueEnv(env, 'TWILIO_ACCOUNT_SID', job.venue_id),
    token = venueEnv(env, 'TWILIO_AUTH_TOKEN', job.venue_id);
  if (!sid || !/^AC[0-9a-fA-F]{32}$/.test(sid) || !token)
    return { kind: 'RETRY', code: 'PROVIDER_NOT_CONFIGURED' };
  const destination = job.destination.trim();
  if (!E164.test(destination)) return { kind: 'FAILED', code: 'MESSAGE_DESTINATION_INVALID' };
  const whatsapp = job.channel === 'WHATSAPP',
    form = new URLSearchParams(),
    sender =
      job.sender_ref?.trim() || venueEnv(env, 'TWILIO_MESSAGING_SERVICE_SID', job.venue_id) || '';
  form.set('To', whatsapp ? `whatsapp:${destination}` : destination);
  if (TWILIO_SERVICE.test(sender)) form.set('MessagingServiceSid', sender);
  else {
    const number = sender.replace(/^whatsapp:/, '');
    if (!E164.test(number) && !(!whatsapp && /^[A-Za-z0-9 ]{1,11}$/.test(number)))
      return { kind: 'RETRY', code: 'MESSAGE_SENDER_MISSING' };
    form.set('From', whatsapp ? `whatsapp:${number}` : number);
  }
  const contentSid = job.provider_template_ref?.trim();
  if (whatsapp && contentSid && TWILIO_CONTENT.test(contentSid)) {
    form.set('ContentSid', contentSid);
    const values = variables(job, env);
    if (job.event_type === 'WAITLIST_OFFER') {
      try {
        values.waitlist_accept_url = waitlistAcceptUrl(
          env('PUBLIC_BASE_URL')?.trim(),
          job.template_data.waitlist_entry_id,
          job.template_data.waitlist_access_token,
        );
      } catch (error) {
        if (error instanceof DeliveryError)
          return error.retryable
            ? { kind: 'RETRY', code: error.code }
            : { kind: 'FAILED', code: error.code };
        throw error;
      }
    }
    form.set('ContentVariables', JSON.stringify(values));
  } else if (body !== null) {
    if (body.length > 1600) return { kind: 'FAILED', code: 'MESSAGE_BODY_TOO_LONG' };
    form.set('Body', body);
  } else return { kind: 'FAILED', code: 'MESSAGE_TEMPLATE_UNSUPPORTED' };
  const { response } = await call(
    fetcher,
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    },
    timeoutMs,
  );
  if (!response) return { kind: 'UNKNOWN', code: 'REMOTE_OUTCOME_UNKNOWN' };
  const payload = (await readJson(response)) as Record<string, unknown> | null;
  if (response.ok) {
    const id = typeof payload?.sid === 'string' ? payload.sid : '';
    if (!/^(SM|MM)[0-9a-fA-F]{32}$/.test(id))
      return { kind: 'UNKNOWN', code: 'PROVIDER_RESPONSE_INVALID' };
    if (payload?.status === 'failed' || payload?.status === 'undelivered')
      return { kind: 'FAILED', code: 'PROVIDER_REJECTED', providerMessageId: id };
    return { kind: 'SENT', providerMessageId: id };
  }
  const code = typeof payload?.code === 'number' ? payload.code : null;
  if (response.status === 400 && code !== null && TWILIO_PERMANENT.has(code))
    return { kind: 'FAILED', code: `TWILIO_${code}` };
  const verdict = classifyStatus(response.status);
  const label = code !== null ? `TWILIO_${code}` : `PROVIDER_HTTP_${response.status}`;
  return verdict === 'UNKNOWN' ? { kind: 'UNKNOWN', code: label } : { kind: verdict, code: label };
}

async function sendResend(
  job: ClaimedJob,
  body: string | null,
  env: Env,
  fetcher: Fetch,
  timeoutMs: number,
): Promise<Outcome> {
  const key = venueEnv(env, 'RESEND_API_KEY', job.venue_id);
  if (!key) return { kind: 'RETRY', code: 'PROVIDER_NOT_CONFIGURED' };
  const from = job.sender_ref?.trim() || venueEnv(env, 'RESEND_FROM', job.venue_id) || '';
  if (!from || from.length > 200 || /[\r\n]/.test(from))
    return { kind: 'RETRY', code: 'MESSAGE_SENDER_MISSING' };
  const destination = job.destination.trim();
  if (!EMAIL.test(destination) || destination.length > 240)
    return { kind: 'FAILED', code: 'MESSAGE_DESTINATION_INVALID' };
  if (body === null) return { kind: 'FAILED', code: 'MESSAGE_TEMPLATE_UNSUPPORTED' };
  const { response } = await call(
    fetcher,
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Same key on every attempt: Resend refuses to send the job twice within 24 hours.
        'Idempotency-Key': `message-job:${job.id}`,
      },
      body: JSON.stringify({ from, to: [destination], subject: emailSubject(job), text: body }),
    },
    timeoutMs,
  );
  if (!response) return { kind: 'UNKNOWN', code: 'REMOTE_OUTCOME_UNKNOWN' };
  const payload = (await readJson(response)) as Record<string, unknown> | null;
  if (response.ok) {
    const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
    if (!id || id.length > 240) return { kind: 'UNKNOWN', code: 'PROVIDER_RESPONSE_INVALID' };
    return { kind: 'SENT', providerMessageId: id };
  }
  const verdict = classifyStatus(response.status),
    code = `PROVIDER_HTTP_${response.status}`;
  return verdict === 'UNKNOWN' ? { kind: 'UNKNOWN', code } : { kind: verdict, code };
}

async function sendTelegram(
  job: ClaimedJob,
  body: string | null,
  env: Env,
  fetcher: Fetch,
  timeoutMs: number,
): Promise<Outcome> {
  const token = venueEnv(env, 'TELEGRAM_BOT_TOKEN', job.venue_id);
  if (!token || !/^[0-9]{5,20}:[A-Za-z0-9_-]{30,64}$/.test(token))
    return { kind: 'RETRY', code: 'PROVIDER_NOT_CONFIGURED' };
  const chat = job.destination.trim();
  if (!TELEGRAM_CHAT.test(chat)) return { kind: 'FAILED', code: 'MESSAGE_DESTINATION_INVALID' };
  if (body === null) return { kind: 'FAILED', code: 'MESSAGE_TEMPLATE_UNSUPPORTED' };
  if (body.length > 4096) return { kind: 'FAILED', code: 'MESSAGE_BODY_TOO_LONG' };
  const { response } = await call(
    fetcher,
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: body,
        link_preview_options: { is_disabled: true },
      }),
    },
    timeoutMs,
  );
  if (!response) return { kind: 'UNKNOWN', code: 'REMOTE_OUTCOME_UNKNOWN' };
  const payload = (await readJson(response)) as {
    ok?: unknown;
    result?: { message_id?: unknown; chat?: { id?: unknown } };
  } | null;
  if (response.ok && payload?.ok === true) {
    const message = payload.result?.message_id;
    if (typeof message !== 'number') return { kind: 'UNKNOWN', code: 'PROVIDER_RESPONSE_INVALID' };
    const chatId = payload.result?.chat?.id;
    return {
      kind: 'SENT',
      providerMessageId: `${typeof chatId === 'number' ? chatId : chat}:${message}`,
    };
  }
  // Telegram 400 (chat not found) and 403 (bot blocked by the user) cannot succeed on retry.
  if (response.status === 400 || response.status === 403)
    return { kind: 'FAILED', code: `PROVIDER_HTTP_${response.status}` };
  const verdict = classifyStatus(response.status),
    code = `PROVIDER_HTTP_${response.status}`;
  return verdict === 'UNKNOWN' ? { kind: 'UNKNOWN', code } : { kind: verdict, code };
}

export type DeliveryOptions = { mode: Mode; env: Env; fetch: Fetch; timeoutMs?: number };

/** Deliver one claimed job. Never throws: every path ends in an Outcome the worker records. */
export async function deliver(job: ClaimedJob, options: DeliveryOptions): Promise<Outcome> {
  const { env, mode } = options,
    timeoutMs = options.timeoutMs ?? 10000;
  let body: string | null;
  try {
    body = renderBody(job, env);
  } catch (error) {
    if (error instanceof DeliveryError)
      return error.retryable
        ? { kind: 'RETRY', code: error.code }
        : { kind: 'FAILED', code: error.code };
    return { kind: 'FAILED', code: 'MESSAGE_PAYLOAD_INVALID' };
  }
  if (job.adapter === 'MOCK') {
    // A venue explicitly configured the simulated adapter; never accept it in production.
    if ((env('ENVIRONMENT') ?? 'development').trim().toLowerCase() === 'production')
      return { kind: 'FAILED', code: 'MOCK_ADAPTER_DISABLED' };
    return { kind: 'SENT', providerMessageId: `mock:${job.id}` };
  }
  // Dry run never contacts a provider and never pretends a real message was sent.
  if (mode === 'dry_run') return { kind: 'RETRY', code: 'DELIVERY_DRY_RUN' };
  try {
    if (job.adapter === 'TWILIO') {
      if (job.channel !== 'SMS' && job.channel !== 'WHATSAPP')
        return { kind: 'FAILED', code: 'MESSAGE_CHANNEL_UNSUPPORTED' };
      return await sendTwilio(job, body, env, options.fetch, timeoutMs);
    }
    if (job.adapter === 'RESEND') {
      if (job.channel !== 'EMAIL') return { kind: 'FAILED', code: 'MESSAGE_CHANNEL_UNSUPPORTED' };
      return await sendResend(job, body, env, options.fetch, timeoutMs);
    }
    if (job.channel !== 'TELEGRAM') return { kind: 'FAILED', code: 'MESSAGE_CHANNEL_UNSUPPORTED' };
    return await sendTelegram(job, body, env, options.fetch, timeoutMs);
  } catch {
    return { kind: 'UNKNOWN', code: 'REMOTE_OUTCOME_UNKNOWN' };
  }
}

// Adapters whose send is idempotent per job, so an unknown outcome can be retried safely.
const IDEMPOTENT_ADAPTERS = new Set(['RESEND', 'MOCK']);

export type Settlement =
  | {
      rpc: 'finish_message_job';
      args: {
        p_job: string;
        p_lease: string;
        p_provider_message_id: string | null;
        p_state: 'SENT' | 'FAILED';
        p_event_id: string;
        p_retryable: boolean;
        p_error_code: string | null;
      };
      result: 'SENT' | 'RETRY' | 'FAILED';
    }
  | {
      rpc: 'release_message_job_unknown';
      args: { p_job: string; p_lease: string };
      result: 'RECONCILIATION_REQUIRED';
    };

/**
 * Map an outcome to the canonical RPC. All seven named arguments are passed to
 * finish_message_job so PostgREST resolves the (uuid,uuid,text,text,text,boolean,text)
 * overload unambiguously (the 6-argument wrapper has the same parameter names minus p_retryable).
 */
export function settlement(job: ClaimedJob, outcome: Outcome): Settlement {
  const base = { p_job: job.id, p_lease: job.lease_token },
    eventId = `worker:${job.id}:${job.attempt}`;
  const code = (value: string) => value.toUpperCase().slice(0, 120);
  switch (outcome.kind) {
    case 'SENT':
      return {
        rpc: 'finish_message_job',
        args: {
          ...base,
          p_provider_message_id: outcome.providerMessageId.slice(0, 240),
          p_state: 'SENT',
          p_event_id: eventId,
          p_retryable: false,
          p_error_code: null,
        },
        result: 'SENT',
      };
    case 'RETRY':
    case 'FAILED':
      return {
        rpc: 'finish_message_job',
        args: {
          ...base,
          p_provider_message_id: outcome.providerMessageId?.slice(0, 240) ?? null,
          p_state: 'FAILED',
          p_event_id: eventId,
          p_retryable: outcome.kind === 'RETRY',
          p_error_code: code(outcome.code),
        },
        result: outcome.kind,
      };
    case 'UNKNOWN':
      if (job.unknown_outcome_policy === 'AUTO_RETRY' || IDEMPOTENT_ADAPTERS.has(job.adapter))
        return {
          rpc: 'finish_message_job',
          args: {
            ...base,
            p_provider_message_id: null,
            p_state: 'FAILED',
            p_event_id: eventId,
            p_retryable: true,
            p_error_code: code(outcome.code),
          },
          result: 'RETRY',
        };
      return {
        rpc: 'release_message_job_unknown',
        args: base,
        result: 'RECONCILIATION_REQUIRED',
      };
  }
}
