import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';

// Large-group booking deposit (owner decision 2026-10-21): a guarantee the venue admin sets per
// service, required only from the threshold up, licence- and provider-gated, refunded when the
// booking is honoured or cancelled in time, retained on a no-show. No provider is ever called:
// provider results enter through the same service_role RPCs the verified webhook paths use.
const service = '70000000-0000-4000-8000-0000000000d1';
type Deposit = {
  id: string;
  amount_cents: number;
  access_token: string;
  providers: string[];
};
type Booking = { id: string; status: string; deposit?: Deposit };

describe('Large-group booking deposit', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`
      update public.restaurant_profile
        set public_content=public_content || '{"privacy_url":"https://restaurant.test/privacy"}'::jsonb;
      update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}';
      insert into public.services(id,venue_id,name,starts_at,ends_at) values('${service}','${ids.venue}','Cena','19:00','23:00');
      insert into public.service_booking_rules(venue_id,service_id,max_covers_service,max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm)
        values('${ids.venue}','${service}',200,10,100,12);
    `);
  });
  beforeEach(async () => {
    await db.exec('begin');
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  async function licence(names: string[]) {
    await db.exec('reset role');
    for (const name of names)
      await db.query('update public.feature_flags set licensed=true where name=$1', [name]);
  }
  async function offerStripe() {
    await db.exec('reset role');
    await db.query(
      "update public.venue_settings set payment_methods=array['CASH','CARD_POS','STRIPE']::public.payment_method[] where venue_id=$1",
      [ids.venue],
    );
  }
  async function version() {
    await db.exec('reset role');
    return Number(
      (
        await db.query<{ version: string }>(
          'select version from public.service_booking_rules where service_id=$1',
          [service],
        )
      ).rows[0]!.version,
    );
  }
  async function configure(
    enabled: boolean,
    minParty: number | null = 6,
    amount: number | null = 2000,
    hours = 0,
  ) {
    const current = await version();
    await identity(db, ids.admin);
    return (
      await db.query<{ r: Record<string, unknown> }>(
        'select public.configure_large_group_deposit($1,$2,$3,$4,$5,$6,$7,$8) r',
        [ids.venue, service, current, enabled, minParty, amount, hours, crypto.randomUUID()],
      )
    ).rows[0]!.r;
  }
  async function ready() {
    await licence(['STRIPE', 'BOOKING_DEPOSITS']);
    await offerStripe();
    await configure(true);
    await db.exec('reset role');
  }
  async function book(party: number, time = '19:00') {
    await db.exec('reset role');
    return (
      await db.query<{ r: Booking }>(
        `select public.create_public_reservation($1,$2,(now() at time zone 'Europe/Rome')::date+2,$3,'Cliente','Gruppo',$4,$5,'{}',$6,$7) r`,
        [
          ids.venue,
          service,
          time,
          `+3900000${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
          party,
          crypto.randomUUID(),
          crypto.randomUUID().replaceAll('-', '').repeat(2),
        ],
      )
    ).rows[0]!.r;
  }
  async function slot(party: number, time = '19:00') {
    await db.exec('reset role');
    const result = (
      await db.query<{ r: { slots: Record<string, unknown>[] } }>(
        `select public.get_public_booking_availability($1,$2,(now() at time zone 'Europe/Rome')::date+2,$3) r`,
        [ids.venue, service, party],
      )
    ).rows[0]!.r;
    return result.slots.find((entry) => entry.time === time)!;
  }
  /** What stripe-webhook / payment re-read do after verifying the provider. */
  async function providerConfirms(
    deposit: Deposit,
    reference = `cs_test_${deposit.id.slice(0, 8)}`,
  ) {
    await db.exec('reset role; set role service_role');
    await db.query("select public.begin_reservation_deposit($1,$2,'STRIPE',$3)", [
      deposit.id,
      deposit.access_token,
      crypto.randomUUID(),
    ]);
    await db.query("select public.bind_reservation_deposit_provider_reference($1,'STRIPE',$2)", [
      deposit.id,
      reference,
    ]);
    const applied = (
      await db.query<{ r: { deposit_status: string; reservation_status: string } }>(
        "select public.apply_reservation_deposit_callback('STRIPE',$1,$2,'COMPLETED') r",
        [`read:${reference}:COMPLETED`, reference],
      )
    ).rows[0]!.r;
    await db.exec('reset role');
    return applied;
  }
  async function confirmedBooking() {
    await ready();
    const booking = await book(8);
    expect(booking.status).toBe('PENDING_DEPOSIT');
    await providerConfirms(booking.deposit!);
    return booking;
  }
  async function actions(reservation: string) {
    await db.exec('reset role');
    return (
      await db.query<{
        reason: string;
        policy: string;
        state: string;
        requested_refund_cents: number;
        last_error_code: string | null;
      }>(
        'select reason,policy,state,requested_refund_cents,last_error_code from private.reservation_deposit_no_show_actions where reservation_id=$1 order by created_at',
        [reservation],
      )
    ).rows;
  }

  it('licenses deposits only together with a licensed provider', async () => {
    await db.exec('reset role');
    await db.exec('savepoint no_provider');
    await expect(
      db.query("update public.feature_flags set licensed=true where name='BOOKING_DEPOSITS'"),
    ).rejects.toThrow('BOOKING_DEPOSITS_PROVIDER_LICENCE_REQUIRED');
    await db.exec('rollback to savepoint no_provider');
    await licence(['SATISPAY_API', 'BOOKING_DEPOSITS']);
    await db.exec('savepoint last_provider');
    await expect(
      db.query("update public.feature_flags set licensed=false where name='SATISPAY_API'"),
    ).rejects.toThrow('BOOKING_DEPOSITS_STILL_LICENSED');
    await db.exec('rollback to savepoint last_provider');
    // With a second provider licensed, the first one can go.
    await licence(['STRIPE']);
    await db.query("update public.feature_flags set licensed=false where name='SATISPAY_API'");
  });

  it('keeps the Epson and unlicensed-provider guards', async () => {
    await licence(['STRIPE', 'BOOKING_DEPOSITS']);
    await db.exec('savepoint epson');
    await expect(
      db.query("insert into public.print_devices(venue_id,name,driver) values($1,'Epson','EPOS')", [
        ids.venue,
      ]),
    ).rejects.toThrow('PRINT_DRIVER_NOT_INCLUDED');
    await db.exec('rollback to savepoint epson');
    await expect(
      db.query(
        "update public.venue_settings set payment_methods=array['SATISPAY_API']::public.payment_method[] where venue_id=$1",
        [ids.venue],
      ),
    ).rejects.toThrow('CORE_REGISTER_PAYMENT_METHODS_FORBIDDEN');
  });

  it('lets only an admin set the rule, and only when it can be paid', async () => {
    await db.exec('savepoint unlicensed');
    await expect(configure(true)).rejects.toThrow('FEATURE_NOT_LICENSED');
    await db.exec('rollback to savepoint unlicensed');
    await licence(['STRIPE', 'BOOKING_DEPOSITS']);
    await db.exec('savepoint no_provider');
    await expect(configure(true)).rejects.toThrow('DEPOSIT_PROVIDER_UNAVAILABLE');
    await db.exec('rollback to savepoint no_provider');
    await offerStripe();
    await db.exec('savepoint above_auto');
    await expect(configure(true, 13)).rejects.toThrow('DEPOSIT_THRESHOLD_ABOVE_AUTO_CONFIRM');
    await db.exec('rollback to savepoint above_auto');
    await db.exec('savepoint bad_amount');
    await expect(configure(true, 6, 50)).rejects.toThrow('INVALID_LARGE_GROUP_DEPOSIT');
    await db.exec('rollback to savepoint bad_amount');
    const current = await version();
    await identity(db, ids.host);
    await db.exec('savepoint host');
    await expect(
      db.query('select public.configure_large_group_deposit($1,$2,$3,true,6,2000,24,$4)', [
        ids.venue,
        service,
        current,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow();
    await db.exec('rollback to savepoint host');
    const saved = await configure(true, 6, 2500, 48);
    expect(saved).toMatchObject({
      enabled: true,
      min_party_size: 6,
      amount_cents: 2500,
      cancel_refund_hours: 48,
    });
    await identity(db, ids.admin);
    const settings = (
      await db.query<{ r: Record<string, unknown> }>(
        'select public.get_large_group_deposit_settings($1) r',
        [ids.venue],
      )
    ).rows[0]!.r;
    expect(settings).toMatchObject({ licensed: true, ready: true, providers: ['STRIPE'] });
    await db.exec('reset role');
    expect(
      (
        await db.query<{ deposit_no_show_action: string; deposit_policy: string }>(
          'select deposit_no_show_action,deposit_policy from public.service_booking_rules where service_id=$1',
          [service],
        )
      ).rows[0],
    ).toEqual({ deposit_no_show_action: 'RETAIN', deposit_policy: 'CONDITIONAL' });
    // Turning it off also switches the venue feature off.
    await configure(false, null, null, 48);
    await db.exec('reset role');
    expect(
      (
        await db.query<{ enabled: boolean }>(
          "select enabled from public.venue_features where venue_id=$1 and name='BOOKING_DEPOSITS'",
          [ids.venue],
        )
      ).rows[0]!.enabled,
    ).toBe(false);
  });

  it('asks the deposit only from the threshold up, with the payable providers', async () => {
    await ready();
    expect(await slot(2)).toMatchObject({ available: true, status_if_booked: 'RESERVED' });
    expect((await slot(2)).deposit).toBeUndefined();
    expect(await slot(6)).toMatchObject({
      available: true,
      status_if_booked: 'PENDING_DEPOSIT',
      deposit: { amount_cents: 2000, currency: 'EUR', providers: ['STRIPE'] },
    });
    const small = await book(5);
    expect(small.status).toBe('RESERVED');
    expect(small.deposit).toBeUndefined();
    const large = await book(6);
    expect(large.status).toBe('PENDING_DEPOSIT');
    expect(large.deposit).toMatchObject({ amount_cents: 2000, providers: ['STRIPE'] });
    // Above the automatic confirmation limit the host decides first, as before.
    expect((await book(13)).status).toBe('REQUESTED');
  });

  it('fails closed when the provider or the licence disappears', async () => {
    await ready();
    await db.exec(
      "update public.venue_settings set payment_methods=array['CASH','CARD_POS']::public.payment_method[] where venue_id='" +
        ids.venue +
        "'",
    );
    expect(await slot(6)).toMatchObject({ available: false, reason: 'BOOKING_DEPOSITS_DISABLED' });
    await db.exec('savepoint closed');
    await expect(book(6)).rejects.toThrow('BOOKING_DEPOSITS_DISABLED');
    await db.exec('rollback to savepoint closed');
    expect((await book(2)).status).toBe('RESERVED');
  });

  it('confirms only through the verified provider result, never through the token alone', async () => {
    await ready();
    const booking = await book(7);
    const deposit = booking.deposit!;
    await db.exec('set role service_role');
    await db.exec('savepoint satispay');
    await expect(
      db.query("select public.begin_reservation_deposit($1,$2,'SATISPAY',$3)", [
        deposit.id,
        deposit.access_token,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('DEPOSIT_PROVIDER_UNAVAILABLE');
    await db.exec('rollback to savepoint satispay');
    await db.exec('savepoint wrong_token');
    await expect(
      db.query('select public.get_reservation_deposit_status($1,$2)', [deposit.id, 'f'.repeat(64)]),
    ).rejects.toThrow('DEPOSIT_ACCESS_DENIED');
    await db.exec('rollback to savepoint wrong_token');
    const pending = (
      await db.query<{ r: Record<string, unknown> }>(
        'select public.get_reservation_deposit_status($1,$2) r',
        [deposit.id, deposit.access_token],
      )
    ).rows[0]!.r;
    expect(pending).toMatchObject({
      deposit_status: 'PENDING',
      reservation_status: 'PENDING_DEPOSIT',
      amount_cents: 2000,
    });
    expect(await providerConfirms(deposit)).toMatchObject({
      deposit_status: 'COMPLETED',
      reservation_status: 'RESERVED',
    });
    await db.exec('set role service_role');
    const done = (
      await db.query<{ r: Record<string, unknown> }>(
        'select public.get_reservation_deposit_status($1,$2) r',
        [deposit.id, deposit.access_token],
      )
    ).rows[0]!.r;
    expect(done).toMatchObject({ deposit_status: 'COMPLETED', reservation_status: 'RESERVED' });
    for (const role of ['anon', 'authenticated'])
      expect(
        (
          await db.query<{ ok: boolean }>(
            "select has_function_privilege($1,'public.get_reservation_deposit_status(uuid,text)','EXECUTE') ok",
            [role],
          )
        ).rows[0]!.ok,
      ).toBe(false);
  });

  it('expires an unpaid deposit and frees the table', async () => {
    await ready();
    const booking = await book(6);
    await db.exec(
      'alter table public.reservation_deposits disable trigger reservation_deposit_guard',
    );
    await db.query(
      "update public.reservation_deposits set expires_at=clock_timestamp()-interval '1 minute' where id=$1",
      [booking.deposit!.id],
    );
    await db.exec(
      'alter table public.reservation_deposits enable trigger reservation_deposit_guard',
    );
    await db.query('select public.run_reservation_deposit_expiry(10)');
    expect(
      (
        await db.query<{ s: string }>(
          "select r.status::text||'/'||d.status s from public.reservations r join public.reservation_deposits d on d.reservation_id=r.id where r.id=$1",
          [booking.id],
        )
      ).rows[0]!.s,
    ).toBe('EXPIRED/EXPIRED');
  });

  it('refunds the guarantee automatically once the guests are seated', async () => {
    const booking = await confirmedBooking();
    await db.query("update public.reservations set status='ARRIVED' where id=$1", [booking.id]);
    expect(await actions(booking.id)).toEqual([]);
    await db.query("update public.reservations set status='SEATED' where id=$1", [booking.id]);
    await db.query("update public.reservations set status='COMPLETED' where id=$1", [booking.id]);
    expect(await actions(booking.id)).toEqual([
      {
        reason: 'HONOURED',
        policy: 'REFUND_FULL',
        state: 'QUEUED',
        requested_refund_cents: 2000,
        last_error_code: null,
      },
    ]);
    // The existing refund worker contract settles it after a verified provider refund.
    await db.exec('set role service_role');
    const claim = (
      await db.query<{ r: { id: string; lease_token: string; amount_cents: number } }>(
        'select public.claim_reservation_deposit_no_show_action(90) r',
      )
    ).rows[0]!.r;
    expect(claim.amount_cents).toBe(2000);
    await db.query(
      "select public.finish_reservation_deposit_no_show_action($1,$2,'re_test_1','COMPLETED',2000,'EUR','no-show:read:re_test_1:COMPLETED',null)",
      [claim.id, claim.lease_token],
    );
    await db.exec('reset role');
    expect(
      (
        await db.query<{ status: string; refunded_amount_cents: number }>(
          'select status,refunded_amount_cents from public.reservation_deposits where reservation_id=$1',
          [booking.id],
        )
      ).rows[0],
    ).toEqual({ status: 'REFUNDED', refunded_amount_cents: 2000 });
  });

  it('retains the guarantee on a no-show and never queues a refund', async () => {
    const booking = await confirmedBooking();
    const current = (
      await db.query<{ version: string }>('select version from public.reservations where id=$1', [
        booking.id,
      ])
    ).rows[0]!.version;
    await identity(db, ids.host);
    await db.query("select public.transition_reservation($1,'NO_SHOW',$2)", [booking.id, current]);
    expect(await actions(booking.id)).toEqual([
      {
        reason: 'NO_SHOW',
        policy: 'RETAIN',
        state: 'RETAINED',
        requested_refund_cents: 0,
        last_error_code: null,
      },
    ]);
    expect(
      (
        await db.query<{ status: string }>(
          'select status from public.reservation_deposits where reservation_id=$1',
          [booking.id],
        )
      ).rows[0]!.status,
    ).toBe('COMPLETED');
  });

  it('refunds a cancellation inside the window and hands a late one to the admin', async () => {
    const early = await confirmedBooking();
    const cancel = async (id: string) => {
      const current = (
        await db.query<{ version: string }>('select version from public.reservations where id=$1', [
          id,
        ])
      ).rows[0]!.version;
      await identity(db, ids.host);
      await db.query("select public.transition_reservation($1,'CANCELLED',$2)", [id, current]);
      await db.exec('reset role');
    };
    await cancel(early.id);
    expect((await actions(early.id))[0]).toMatchObject({
      reason: 'CANCELLED',
      policy: 'REFUND_FULL',
      state: 'QUEUED',
    });
    // 720 hours: any cancellation of a booking two days ahead is late.
    await configure(true, 6, 2000, 720);
    const late = await book(9, '20:00');
    await providerConfirms(late.deposit!, 'cs_test_late');
    await cancel(late.id);
    expect((await actions(late.id))[0]).toMatchObject({
      reason: 'CANCELLED',
      policy: 'MANUAL',
      state: 'MANUAL_REQUIRED',
      last_error_code: 'LATE_CANCELLATION',
    });
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from public.notifications where category='DEPOSIT_RELEASE_ACTION_REQUIRED' and recipient_role='ADMIN'",
        )
      ).rows[0]!.n,
    ).toBe(1);
  });

  it('records a provider payment that arrives after the deposit expired', async () => {
    await ready();
    const booking = await book(6);
    await db.exec('set role service_role');
    await db.query("select public.begin_reservation_deposit($1,$2,'STRIPE',$3)", [
      booking.deposit!.id,
      booking.deposit!.access_token,
      crypto.randomUUID(),
    ]);
    await db.query(
      "select public.bind_reservation_deposit_provider_reference($1,'STRIPE','cs_test_slow')",
      [booking.deposit!.id],
    );
    await db.query(
      "select public.record_reservation_deposit_late_payment($1,'STRIPE','cs_test_slow')",
      [booking.deposit!.id],
    );
    await db.query(
      "select public.record_reservation_deposit_late_payment($1,'STRIPE','cs_test_slow')",
      [booking.deposit!.id],
    );
    await db.exec('reset role');
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from public.notifications where category='DEPOSIT_REFUND_RECONCILIATION' and resource_id=$1",
          [booking.deposit!.id],
        )
      ).rows[0]!.n,
    ).toBe(1);
  });
});
