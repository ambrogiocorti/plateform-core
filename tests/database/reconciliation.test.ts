import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed, sessionId } from './harness';

const room = 'a0000000-0000-4000-8000-000000000001',
  layout = 'a0000000-0000-4000-8000-000000000002',
  table = 'a0000000-0000-4000-8000-000000000003',
  station = 'a0000000-0000-4000-8000-000000000004',
  category = 'a0000000-0000-4000-8000-000000000005',
  dish = 'a0000000-0000-4000-8000-000000000006',
  account = 'a0000000-0000-4000-8000-000000000007',
  order = 'a0000000-0000-4000-8000-000000000008',
  step = 'a0000000-0000-4000-8000-000000000009',
  register = 'a0000000-0000-4000-8000-000000000010';

describe('Cash journal and immutable service reconciliation', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`
      insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','Sala');
      insert into public.room_layouts(id,venue_id,room_id,name,active) values('${layout}','${ids.venue}','${room}','Servizio',true);
      insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats) values('${table}','${ids.venue}','${room}','${layout}',1,'Tavolo 1',4);
      insert into public.stations(id,venue_id,name) values('${station}','${ids.venue}','Cucina');
      insert into public.categories(id,name) values('${category}','Piatti');
      insert into public.dishes(id,category_id,name,price_cents) values('${dish}','${category}','Piatto',1000);
      insert into public.accounts(id,venue_id,table_id,account_name,covers,created_by) values('${account}','${ids.venue}','${table}','Conto test',2,'${ids.waiter}');
      insert into public.orders(id,venue_id,account_id,origin,created_by,status) values('${order}','${ids.venue}','${account}','WAITER','${ids.waiter}','SERVED');
      insert into public.order_steps(id,venue_id,order_id,step_number,status) values('${step}','${ids.venue}','${order}',1,'SERVED');
      insert into public.order_items(venue_id,order_id,step_id,dish_id,station_id,quantity,unit_price_cents,dish_name,category_name,ingredient_snapshot,allergen_snapshot,status)
        values('${ids.venue}','${order}','${step}','${dish}','${station}',1,1000,'Piatto','Piatti','[]','[]','SERVED');
      insert into public.cash_registers(id,venue_id,name,code,status) values('${register}','${ids.venue}','Cassa','C1','OPEN');
      insert into public.cashier_assignments(venue_id,cash_register_id,user_id) values('${ids.venue}','${register}','${ids.cashier}');
    `);
  });
  beforeEach(async () => {
    await db.exec('begin');
    await identity(db, ids.cashier);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });
  async function open(float = 2000) {
    return (
      await db.query<{ result: { id: string } }>(
        'select public.open_service_session($1,null,$2,$3,$4) as result',
        [ids.venue, register, float, crypto.randomUUID()],
      )
    ).rows[0]!.result.id;
  }
  async function pay(complete = true, tip = 100) {
    const id = (
      await db.query<{ result: { id: string } }>(
        "select public.create_payment($1,$2,1000,$3,'CASH',$4) as result",
        [account, register, tip, crypto.randomUUID()],
      )
    ).rows[0]!.result.id;
    if (complete) await db.query('select public.confirm_manual_payment($1,true)', [id]);
    return id;
  }
  async function close(service: string, actual: number, key = crypto.randomUUID()) {
    return (
      await db.query<{ result: { id: string; status: string; request_id?: string } }>(
        'select public.request_service_close($1,$2,$3) as result',
        [service, JSON.stringify([{ cash_register_id: register, cash_actual_cents: actual }]), key],
      )
    ).rows[0]!.result;
  }
  async function grant(action: string, resource: string) {
    await db.exec('reset role');
    const id = crypto.randomUUID();
    await db.query(
      "insert into private.step_up_grants(id,user_id,session_id,action,resource_id,expires_at) values($1,$2,$3,$4,$5,now()+interval '1 minute')",
      [id, ids.admin, sessionId(ids.admin), action, resource],
    );
    await identity(db, ids.admin);
    return id;
  }
  it('counts cash and tips separately and closes a balanced service exactly once', async () => {
    const service = await open();
    await pay();
    await db.query('select public.close_account($1)', [account]);
    const preview = (
      await db.query<{
        result: {
          registers: { cash_theoretical_cents: number; amount_cents: number; tip_cents: number }[];
          closed_accounts: number;
        };
      }>('select public.get_service_reconciliation($1) as result', [service])
    ).rows[0]!.result;
    expect(preview.registers[0]).toMatchObject({
      cash_theoretical_cents: 3100,
      amount_cents: 1000,
      tip_cents: 100,
    });
    expect(preview.closed_accounts).toBe(1);
    const key = crypto.randomUUID();
    expect((await close(service, 3100, key)).status).toBe('CLOSED');
    expect((await close(service, 3100, key)).status).toBe('CLOSED');
    expect(
      (await db.query('select difference_cents from public.cash_reconciliations')).rows,
    ).toEqual([{ difference_cents: 0 }]);
    await db.exec('reset role');
    await expect(
      db.exec('update public.cash_reconciliations set cash_actual_cents=0'),
    ).rejects.toThrow('IMMUTABLE_RECORD');
  });
  it('requires an Admin grant for a difference and retains the cashier identity in the final snapshot', async () => {
    const service = await open();
    await pay();
    const request = await close(service, 3090);
    expect(request.status).toBe('AWAITING_APPROVAL');
    await db.exec('savepoint cashier_approval');
    await expect(
      db.query(
        "select public.resolve_service_reconciliation($1,true,'Conteggio verificato',$2,$3)",
        [request.request_id, crypto.randomUUID(), crypto.randomUUID()],
      ),
    ).rejects.toThrow('FORBIDDEN');
    await db.exec('rollback to savepoint cashier_approval');
    const proof = await grant('CASH_RECONCILIATION', request.request_id!);
    await db.query(
      "select public.resolve_service_reconciliation($1,true,'Conteggio verificato',$2,$3)",
      [request.request_id, proof, crypto.randomUUID()],
    );
    expect(
      (
        await db.query(
          'select difference_cents,created_by,authorized_by from public.cash_reconciliations',
        )
      ).rows,
    ).toEqual([{ difference_cents: -10, created_by: ids.cashier, authorized_by: ids.admin }]);
  });
  it('blocks closure with a pending payment without changing service state', async () => {
    const service = await open();
    await pay(false);
    await db.exec('savepoint pending');
    await expect(close(service, 2000)).rejects.toThrow('PENDING_PAYMENT_RECONCILIATION_REQUIRED');
    await db.exec('rollback to savepoint pending');
    expect((await db.query('select status from public.service_sessions')).rows).toEqual([
      { status: 'OPEN' },
    ]);
  });
  it('posts a later refund to the new service without changing the old immutable reconciliation', async () => {
    const first = await open();
    const payment = await pay();
    await close(first, 3100);
    const second = await open();
    const proof = await grant('REFUND', payment);
    await db.query("select public.create_refund($1,400,50,'Rimborso concordato',$2,$3)", [
      payment,
      proof,
      crypto.randomUUID(),
    ]);
    const result = (
      await db.query<{
        result: {
          registers: {
            cash_theoretical_cents: number;
            refund_cents: number;
            refund_tip_cents: number;
          }[];
        };
      }>('select public.get_service_reconciliation($1) as result', [second])
    ).rows[0]!.result;
    expect(result.registers[0]).toMatchObject({
      cash_theoretical_cents: 1550,
      refund_cents: 400,
      refund_tip_cents: 50,
    });
    expect(
      (
        await db.query(
          'select cash_theoretical_cents from public.cash_reconciliations where service_session_id=$1',
          [first],
        )
      ).rows,
    ).toEqual([{ cash_theoretical_cents: 3100 }]);
    expect(
      (await db.query('select amount_cents,tip_cents from public.payments where id=$1', [payment]))
        .rows,
    ).toEqual([{ amount_cents: 1000, tip_cents: 100 }]);
  });
  it('records a reversal after account closure in the current service and requires Admin password proof', async () => {
    const first = await open();
    const payment = await pay();
    await db.query('select public.close_account($1)', [account]);
    await close(first, 3100);
    const second = await open();
    await db.exec('savepoint reversal');
    await expect(
      db.query("select public.cancel_manual_payment($1,'Errore operatore')", [payment]),
    ).rejects.toThrow('FORBIDDEN');
    await db.exec('rollback to savepoint reversal');
    const proof = await grant('CANCEL_PAYMENT', payment);
    await db.query("select public.cancel_manual_payment($1,'Errore operatore',$2)", [
      payment,
      proof,
    ]);
    expect(
      (
        await db.query(
          'select amount_cents,tip_cents from public.cash_journal where service_session_id=$1',
          [second],
        )
      ).rows,
    ).toEqual([{ amount_cents: -1000, tip_cents: -100 }]);
    expect(
      (await db.query('select status from public.accounts where id=$1', [account])).rows,
    ).toEqual([{ status: 'AT_CASHIER' }]);
    await db.exec('reset role');
    expect(
      (
        await db.query(
          "select account_id,payment_id,cash_register_id,service_session_id,new_values->>'reason' as reason from public.audit_log where resource_type='payment_reversals'",
        )
      ).rows[0],
    ).toMatchObject({
      account_id: account,
      payment_id: payment,
      cash_register_id: register,
      service_session_id: second,
      reason: 'Errore operatore',
    });
  });
  it('protects posted amounts, journal entries and an unreconciled register from mutation', async () => {
    await open();
    const payment = await pay();
    await db.exec('reset role; savepoint guard');
    await expect(
      db.query('update public.payments set amount_cents=1 where id=$1', [payment]),
    ).rejects.toThrow('IMMUTABLE_PAYMENT_DETAILS');
    await db.exec('rollback to savepoint guard');
    await expect(db.exec('delete from public.cash_journal')).rejects.toThrow('IMMUTABLE_RECORD');
    await db.exec('rollback to savepoint guard');
    await expect(
      db.query('update public.cash_registers set active=false where id=$1', [register]),
    ).rejects.toThrow('REGISTER_SERVICE_UNRECONCILED');
  });
  it('returns an authorized account snapshot and payment history with the refundable remainder', async () => {
    await open();
    const payment = await pay();
    const proof = await grant('REFUND', payment);
    await db.query("select public.create_refund($1,300,40,'Rettifica parziale',$2,$3)", [
      payment,
      proof,
      crypto.randomUUID(),
    ]);
    const result = (
      await db.query<{
        result: {
          account: { id: string };
          balance: { total_cents: number; paid_cents: number; remaining_cents: number };
          orders: { items: { dish_name: string }[] }[];
        };
      }>('select public.get_account_workspace($1) as result', [account])
    ).rows[0]!.result;
    expect(result.account.id).toBe(account);
    // A completed 300-cent refund reduces effective paid principal from
    // 1,000 to 700. The original sale remains 1,000 and 300 becomes due again.
    expect(result.balance).toMatchObject({
      total_cents: 1000,
      paid_cents: 700,
      remaining_cents: 300,
    });
    expect(result.orders[0]!.items[0]!.dish_name).toBe('Piatto');
    const history = (
      await db.query<{
        result: {
          items: {
            id: string;
            refunded_cents: number;
            refunded_tip_cents: number;
            refunds: unknown[];
          }[];
        };
      }>('select public.get_account_payments($1) as result', [account])
    ).rows[0]!.result;
    expect(history.items[0]).toMatchObject({
      id: payment,
      amount_cents: 1000,
      tip_cents: 100,
      refunded_cents: 300,
      refunded_tip_cents: 40,
    });
    expect(history.items[0]!.refunds).toHaveLength(1);
    const registers = (
      await db.query<{ result: { id: string }[] }>(
        'select public.get_payment_registers($1) as result',
        [ids.venue],
      )
    ).rows[0]!.result;
    expect(registers.map((row) => row.id)).toEqual([register]);
  });
  it('denies account and payment snapshots to Host and technical Super Admin', async () => {
    for (const user of [ids.host, ids.superAdmin]) {
      await identity(db, user);
      await db.exec('savepoint denied');
      await expect(db.query('select public.get_account_workspace($1)', [account])).rejects.toThrow(
        'FORBIDDEN',
      );
      await db.exec('rollback to savepoint denied');
      await expect(db.query('select public.get_account_payments($1)', [account])).rejects.toThrow(
        'FORBIDDEN',
      );
      await db.exec('rollback to savepoint denied');
    }
  });
  it('keeps new guests untouched when an old paid account is reopened and closed again', async () => {
    await open();
    await pay();
    await db.query('select public.close_account($1)', [account]);
    const proof = await grant('REOPEN_ACCOUNT', account);
    const key = crypto.randomUUID();
    await db.query("select public.reopen_account($1,'Verifica amministrativa',$2,$3)", [
      account,
      proof,
      key,
    ]);
    await db.query('select public.set_table_available($1)', [table]);
    await db.exec('reset role');
    await db.query("update public.tables set technical_status='OCCUPIED' where id=$1", [table]);
    await identity(db, ids.admin);
    await db.query('select public.close_account($1)', [account]);
    await db.query("select public.reopen_account($1,'Verifica amministrativa',$2,$3)", [
      account,
      proof,
      key,
    ]);
    expect(
      (await db.query('select status from public.accounts where id=$1', [account])).rows[0],
    ).toEqual({ status: 'CLOSED' });
    expect(
      (await db.query('select technical_status from public.tables where id=$1', [table])).rows[0],
    ).toEqual({ technical_status: 'OCCUPIED' });
  });
  it('releases every member of a merged table group when its final active account closes', async () => {
    await db.exec('reset role');
    const secondary = 'a0000000-0000-4000-8000-000000000099';
    await db.query(
      "insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats,technical_status) values($1,$2,$3,$4,2,'Tavolo 2',4,'OCCUPIED')",
      [secondary, ids.venue, room, layout],
    );
    await db.query(
      'insert into public.table_merges(venue_id,primary_table_id,secondary_table_id) values($1,$2,$3)',
      [ids.venue, table, secondary],
    );
    await identity(db, ids.cashier);
    await open();
    await pay();
    await db.query('select public.close_account($1)', [account]);
    expect(
      (
        await db.query('select technical_status from public.tables where id=any($1)', [
          [table, secondary],
        ])
      ).rows,
    ).toEqual([{ technical_status: 'TO_RESET' }, { technical_status: 'TO_RESET' }]);
  });
  it('searches active and closed accounts separately with server filters', async () => {
    const active = (
      await db.query<{ result: { items: { id: string }[] } }>(
        "select public.search_accounts($1,p_search=>'test',p_status=>'ACTIVE') as result",
        [ids.venue],
      )
    ).rows[0]!.result;
    expect(active.items.map((row) => row.id)).toEqual([account]);
    await open();
    await pay();
    await db.query('select public.close_account($1)', [account]);
    const history = (
      await db.query<{ result: { items: { id: string }[] } }>(
        "select public.search_accounts($1,p_search=>'Tavolo 1',p_status=>'CLOSED') as result",
        [ids.venue],
      )
    ).rows[0]!.result;
    expect(history.items.map((row) => row.id)).toEqual([account]);
  });
  it('audits an unpaid forced closure and does not repeat it after an authorized reopening', async () => {
    const proof = await grant('FORCE_CLOSE', account),
      key = crypto.randomUUID();
    await db.query("select public.force_close_account($1,'Saldo contestato dal cliente',$2,$3)", [
      account,
      proof,
      key,
    ]);
    await db.exec('reset role');
    expect(
      (
        await db.query(
          "select old_values->>'remaining_cents' as remaining,new_values->>'reason' as reason from public.audit_log where action='ACCOUNT_FORCE_CLOSED'",
        )
      ).rows,
    ).toEqual([{ remaining: '1000', reason: 'Saldo contestato dal cliente' }]);
    const reopenProof = await grant('REOPEN_ACCOUNT', account);
    await db.query("select public.reopen_account($1,'Verifica saldo contestato',$2,$3)", [
      account,
      reopenProof,
      crypto.randomUUID(),
    ]);
    await db.query("select public.force_close_account($1,'Saldo contestato dal cliente',$2,$3)", [
      account,
      proof,
      key,
    ]);
    expect(
      (await db.query('select status from public.accounts where id=$1', [account])).rows[0],
    ).toEqual({ status: 'AT_CASHIER' });
  });
  it('keeps a prepaid closed account in the kitchen and prevents table reuse until delivery', async () => {
    await db.exec('reset role');
    const target = 'a0000000-0000-4000-8000-000000000098';
    await db.query(
      "insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats) values($1,$2,$3,$4,3,'Tavolo destinazione',4)",
      [target, ids.venue, room, layout],
    );
    await db.query("update public.tables set technical_status='OCCUPIED' where id=$1", [table]);
    await db.query("update public.orders set status='READY' where id=$1", [order]);
    await db.query("update public.order_steps set status='READY' where id=$1", [step]);
    await db.query("update public.order_items set status='READY' where order_id=$1", [order]);
    await db.query(
      "insert into public.table_assignments(venue_id,waiter_id,mode,table_id) values($1,$2,'TABLE',$3)",
      [ids.venue, ids.waiter, table],
    );
    await identity(db, ids.cashier);
    await open();
    await pay();
    await db.query('select public.close_account($1)', [account]);
    expect(
      (
        await db.query('select status,floor_released_at from public.accounts where id=$1', [
          account,
        ])
      ).rows[0],
    ).toEqual({ status: 'CLOSED', floor_released_at: null });
    await identity(db, ids.admin);
    const kitchen = (
      await db.query<{ result: { order_id: string }[] }>(
        'select public.get_kitchen_board($1) as result',
        [ids.venue],
      )
    ).rows[0]!.result;
    expect(kitchen.map((item) => item.order_id)).toEqual([order]);
    await db.exec('savepoint busy');
    await expect(db.query('select public.set_table_available($1)', [table])).rejects.toThrow(
      'TABLE_STILL_IN_USE',
    );
    await db.exec('rollback to savepoint busy');
    await db.query('select public.move_table($1,$2,true)', [table, target]);
    expect(
      (await db.query('select table_id from public.accounts where id=$1', [account])).rows[0],
    ).toEqual({ table_id: target });
    await identity(db, ids.waiter);
    await db.query('select public.deliver_step($1,true)', [step]);
    expect(
      (await db.query('select technical_status from public.tables where id=$1', [target])).rows[0],
    ).toEqual({ technical_status: 'TO_RESET' });
    expect(
      (
        await db.query(
          'select floor_released_at is not null as released from public.accounts where id=$1',
          [account],
        )
      ).rows[0],
    ).toEqual({ released: true });
  });
});
