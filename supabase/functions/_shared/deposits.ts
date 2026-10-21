// Large-group booking deposit (owner decision 2026-10-21): pure checkout/confirmation logic with
// every side effect injected, so it can be unit tested without a provider or a database.
//
// DB contract (service_role only, 20261007035037 + 20261021090000):
//   begin_reservation_deposit(p_deposit,p_access_token,p_provider,p_key)   licence/provider gate
//   get_reservation_deposit_status(p_deposit,p_access_token)               guest view (token hash)
//   get_reservation_deposit_for_provider(p_deposit)                        webhook lookup
//   bind_reservation_deposit_provider_reference(p_deposit,p_provider,p_provider_reference)
//   apply_reservation_deposit_callback(p_provider,p_event_id,p_provider_reference,p_state)
//   record_reservation_deposit_late_payment(p_deposit,p_provider,p_provider_reference)
// Only an authoritative provider read (create/GET, never the browser or a redirect) moves a deposit.
import { z } from 'npm:zod@4.6.5';

export type DepositProvider = 'STRIPE' | 'SATISPAY';
export type PaymentState = 'WAITING' | 'COMPLETED' | 'FAILED';

export const depositRecordSchema = z
  .object({
    deposit_id: z.uuid(),
    reservation_id: z.uuid(),
    venue_id: z.uuid(),
    venue_slug: z.string().min(1),
    deposit_status: z.enum([
      'PENDING',
      'COMPLETED',
      'FAILED',
      'EXPIRED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
    ]),
    reservation_status: z.string().optional(),
    provider: z.enum(['STRIPE', 'SATISPAY']).nullable(),
    provider_reference: z.string().min(1).max(240).nullable(),
    amount_cents: z.number().int().positive(),
    currency: z.literal('EUR'),
    expires_at: z.string(),
    providers: z.array(z.enum(['STRIPE', 'SATISPAY'])).optional(),
    service_date: z.string().optional(),
    slot_time: z.string().nullable().optional(),
    party_size: z.number().int().optional(),
  })
  .passthrough();
export type DepositRecord = z.infer<typeof depositRecordSchema>;

/** A provider payment as read from the provider itself. */
export interface ProviderPayment {
  reference: string;
  state: PaymentState;
  amountCents: number;
  currency: string;
  /** Our deposit id echoed back by the provider (metadata / external_code). */
  depositReference: string | null;
  checkoutUrl: string | null;
}

export interface DepositGateway {
  create(provider: DepositProvider, deposit: DepositRecord): Promise<ProviderPayment>;
  read(
    provider: DepositProvider,
    deposit: DepositRecord,
    reference: string,
  ): Promise<ProviderPayment>;
}

type Rpc = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

export interface DepositDeps {
  rpc: Rpc;
  gateway: DepositGateway;
}

export const startSchema = z
  .object({
    action: z.literal('start').default('start'),
    deposit_id: z.uuid(),
    access_token: z.string().regex(/^[0-9a-f]{64}$/),
    provider: z.enum(['STRIPE', 'SATISPAY']),
    idempotency_key: z.uuid(),
  })
  .strict();
export const statusSchema = z
  .object({
    action: z.literal('status'),
    deposit_id: z.uuid(),
    access_token: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const requestSchema = z.union([statusSchema, startSchema]);
export type DepositRequest = z.infer<typeof requestSchema>;

/** Codes the browser may see (allowed by _shared/http.ts endpoint()). */
const passThrough = new Set([
  'DEPOSIT_EXPIRED',
  'DEPOSIT_NOT_PENDING',
  'BOOKING_DEPOSITS_DISABLED',
  'DEPOSIT_PROVIDER_UNAVAILABLE',
  'DEPOSIT_PROVIDER_ALREADY_SELECTED',
  'IDEMPOTENCY_MISMATCH',
]);

const message = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message: unknown }).message)
    : '';

function databaseError(error: unknown): Error {
  const code = message(error);
  if (code === 'DEPOSIT_ACCESS_DENIED') return new Error('FORBIDDEN');
  return new Error(passThrough.has(code) ? code : 'REQUEST_FAILED');
}

async function call(deps: DepositDeps, name: string, args: Record<string, unknown>) {
  const { data, error } = await deps.rpc(name, args);
  if (error) throw databaseError(error);
  return data;
}

/** Checks the provider answer against the deposit before the database ever sees it. */
export function verifyPayment(deposit: DepositRecord, payment: ProviderPayment): boolean {
  return (
    payment.reference.length >= 1 &&
    payment.reference.length <= 240 &&
    payment.amountCents === deposit.amount_cents &&
    payment.currency.toUpperCase() === 'EUR' &&
    payment.depositReference === deposit.deposit_id &&
    (deposit.provider_reference === null || deposit.provider_reference === payment.reference)
  );
}

export type SettleOutcome = PaymentState | 'RECONCILIATION_REQUIRED';

/** Applies a verified provider state. A paid deposit the DB refuses (it expired first) is
 *  recorded for the admin instead of being lost. */
export async function settle(
  deps: DepositDeps,
  deposit: DepositRecord,
  provider: DepositProvider,
  payment: ProviderPayment,
): Promise<SettleOutcome> {
  if (!verifyPayment(deposit, payment)) throw new Error('PROVIDER_VERIFICATION_FAILED');
  if (payment.state === 'WAITING') return 'WAITING';
  const { error } = await deps.rpc('apply_reservation_deposit_callback', {
    p_provider: provider,
    p_event_id: `read:${payment.reference}:${payment.state}`.slice(0, 240),
    p_provider_reference: payment.reference,
    p_state: payment.state,
  });
  if (!error) return payment.state;
  const code = message(error);
  if (
    payment.state === 'COMPLETED' &&
    ['DEPOSIT_EXPIRED', 'DEPOSIT_CALLBACK_OUT_OF_ORDER'].includes(code)
  ) {
    await call(deps, 'record_reservation_deposit_late_payment', {
      p_deposit: deposit.deposit_id,
      p_provider: provider,
      p_provider_reference: payment.reference,
    });
    return 'RECONCILIATION_REQUIRED';
  }
  if (payment.state === 'FAILED' && code === 'DEPOSIT_CALLBACK_OUT_OF_ORDER') return 'FAILED';
  throw new Error('PROVIDER_VERIFICATION_FAILED');
}

async function guestRecord(deps: DepositDeps, id: string, token: string): Promise<DepositRecord> {
  return depositRecordSchema.parse(
    await call(deps, 'get_reservation_deposit_status', { p_deposit: id, p_access_token: token }),
  );
}

const paid = (status: DepositRecord['deposit_status']) =>
  ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(status);

export interface CheckoutResponse {
  deposit_id: string;
  provider: DepositProvider;
  state: PaymentState;
  checkout_url: string | null;
}

/** Guest starts (or resumes) paying: the licence/provider gate runs in the DB first. */
export async function startCheckout(
  deps: DepositDeps,
  body: z.infer<typeof startSchema>,
): Promise<CheckoutResponse> {
  const { error } = await deps.rpc('begin_reservation_deposit', {
    p_deposit: body.deposit_id,
    p_access_token: body.access_token,
    p_provider: body.provider,
    p_key: body.idempotency_key,
  });
  if (error) {
    if (message(error) !== 'DEPOSIT_NOT_PENDING') throw databaseError(error);
    // Already settled (webhook first): report the server's outcome, never a new checkout.
    const settled = await guestRecord(deps, body.deposit_id, body.access_token);
    if (settled.provider !== body.provider) throw new Error('DEPOSIT_NOT_PENDING');
    return {
      deposit_id: settled.deposit_id,
      provider: body.provider,
      state: paid(settled.deposit_status) ? 'COMPLETED' : 'FAILED',
      checkout_url: null,
    };
  }
  let deposit = await guestRecord(deps, body.deposit_id, body.access_token);
  if (deposit.provider !== body.provider) throw new Error('DEPOSIT_PROVIDER_ALREADY_SELECTED');
  let payment: ProviderPayment;
  if (deposit.provider_reference) {
    payment = await deps.gateway.read(body.provider, deposit, deposit.provider_reference);
  } else {
    payment = await deps.gateway.create(body.provider, deposit);
    if (!verifyPayment(deposit, payment)) throw new Error('PROVIDER_VERIFICATION_FAILED');
    await call(deps, 'bind_reservation_deposit_provider_reference', {
      p_deposit: deposit.deposit_id,
      p_provider: body.provider,
      p_provider_reference: payment.reference,
    });
    deposit = { ...deposit, provider_reference: payment.reference };
  }
  const outcome = await settle(deps, deposit, body.provider, payment);
  return {
    deposit_id: deposit.deposit_id,
    provider: body.provider,
    state: outcome === 'RECONCILIATION_REQUIRED' ? 'FAILED' : outcome,
    checkout_url: outcome === 'WAITING' ? payment.checkoutUrl : null,
  };
}

export type GuestOutcome =
  'CONFIRMED' | 'PENDING' | 'FAILED' | 'EXPIRED' | 'RECONCILIATION_REQUIRED';

export interface StatusResponse {
  deposit_id: string;
  outcome: GuestOutcome;
  deposit_status: DepositRecord['deposit_status'];
  reservation_status: string;
  amount_cents: number;
  currency: 'EUR';
  expires_at: string;
  provider: DepositProvider | null;
  providers: DepositProvider[];
  service_date: string | null;
  slot_time: string | null;
  party_size: number | null;
}

export function guestOutcome(record: DepositRecord): GuestOutcome {
  if (paid(record.deposit_status))
    return record.reservation_status === 'EXPIRED' ? 'RECONCILIATION_REQUIRED' : 'CONFIRMED';
  if (record.deposit_status === 'EXPIRED' || record.reservation_status === 'EXPIRED')
    return 'EXPIRED';
  if (record.deposit_status === 'FAILED') return 'FAILED';
  return 'PENDING';
}

/** Guest returns from the provider: re-read the provider (authoritative), then the DB. */
export async function depositStatus(
  deps: DepositDeps,
  body: z.infer<typeof statusSchema>,
): Promise<StatusResponse> {
  let record = await guestRecord(deps, body.deposit_id, body.access_token);
  let late = false;
  if (record.deposit_status === 'PENDING' && record.provider && record.provider_reference) {
    const payment = await deps.gateway.read(record.provider, record, record.provider_reference);
    late = (await settle(deps, record, record.provider, payment)) === 'RECONCILIATION_REQUIRED';
    record = await guestRecord(deps, body.deposit_id, body.access_token);
  } else if (record.deposit_status === 'EXPIRED' && record.provider && record.provider_reference) {
    // Paid after the expiry runner released the table: the admin must refund or reinstate it.
    const payment = await deps.gateway.read(record.provider, record, record.provider_reference);
    if (verifyPayment(record, payment) && payment.state === 'COMPLETED') {
      await call(deps, 'record_reservation_deposit_late_payment', {
        p_deposit: record.deposit_id,
        p_provider: record.provider,
        p_provider_reference: payment.reference,
      });
      late = true;
    }
  }
  return {
    deposit_id: record.deposit_id,
    outcome: late ? 'RECONCILIATION_REQUIRED' : guestOutcome(record),
    deposit_status: record.deposit_status,
    reservation_status: record.reservation_status ?? 'PENDING_DEPOSIT',
    amount_cents: record.amount_cents,
    currency: 'EUR',
    expires_at: record.expires_at,
    provider: record.provider,
    providers: record.providers ?? [],
    service_date: record.service_date ?? null,
    slot_time: record.slot_time ?? null,
    party_size: record.party_size ?? null,
  };
}

/** Webhook / callback path: the event only names the deposit; the provider read decides. */
export async function reconcileDeposit(
  deps: DepositDeps,
  depositId: string,
  provider: DepositProvider,
  eventReference?: string,
): Promise<SettleOutcome | 'IGNORED'> {
  const data = await call(deps, 'get_reservation_deposit_for_provider', { p_deposit: depositId });
  if (data === null) throw new Error('PROVIDER_VERIFICATION_FAILED');
  const record = depositRecordSchema.parse(data);
  if (record.provider !== provider || !record.provider_reference)
    throw new Error('PROVIDER_VERIFICATION_FAILED');
  if (eventReference !== undefined && eventReference !== record.provider_reference)
    throw new Error('PROVIDER_VERIFICATION_FAILED');
  if (record.deposit_status !== 'PENDING' && record.deposit_status !== 'EXPIRED') return 'IGNORED';
  const payment = await deps.gateway.read(provider, record, record.provider_reference);
  if (record.deposit_status === 'EXPIRED') {
    if (!verifyPayment(record, payment) || payment.state !== 'COMPLETED') return 'IGNORED';
    await call(deps, 'record_reservation_deposit_late_payment', {
      p_deposit: record.deposit_id,
      p_provider: provider,
      p_provider_reference: payment.reference,
    });
    return 'RECONCILIATION_REQUIRED';
  }
  return await settle(deps, record, provider, payment);
}

/** Where the guest lands after the provider: the public booking page, never a receipt. */
export function depositReturnUrl(base: string | undefined, deposit: DepositRecord): string {
  if (!base) throw new Error('SERVER_CONFIGURATION_REQUIRED');
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('SERVER_CONFIGURATION_REQUIRED');
  url.searchParams.set('sede', deposit.venue_slug);
  url.searchParams.set('deposito', deposit.deposit_id);
  return url.toString();
}
