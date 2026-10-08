import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';
const room = 'd0000000-0000-4000-8000-000000000001',
  layout = 'd0000000-0000-4000-8000-000000000002',
  table = 'd0000000-0000-4000-8000-000000000003',
  hiddenLayout = 'd0000000-0000-4000-8000-000000000004',
  hiddenTable = 'd0000000-0000-4000-8000-000000000005';
describe('configuration and operational floor boundaries', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','Sala');
      insert into public.room_layouts(id,venue_id,room_id,name,active) values('${layout}','${ids.venue}','${room}','Attivo',true),('${hiddenLayout}','${ids.venue}','${room}','Bozza',false);
      insert into public.tables(id,venue_id,room_id,layout_id,name,number,seats) values('${table}','${ids.venue}','${room}','${layout}','Tavolo 1',1,4),('${hiddenTable}','${ids.venue}','${room}','${hiddenLayout}','Bozza 2',2,4);
      insert into public.table_assignments(venue_id,waiter_id,mode,table_id) values('${ids.venue}','${ids.waiter}','TABLE','${table}');`);
  });
  beforeEach(async () => {
    await db.exec('reset role; begin');
    await identity(db, ids.admin);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });
  it('Host sees active layout occupancy without account names, balance or payment data', async () => {
    await identity(db, ids.waiter);
    await db.query("select public.create_account($1,'Private group',3,null,$2)", [
      table,
      crypto.randomUUID(),
    ]);
    await identity(db, ids.host);
    const data = (
      await db.query<{
        r: {
          tables: {
            id: string;
            covers: number;
            open_accounts: number;
            can_open_account: boolean;
          }[];
          rooms: unknown[];
        };
      }>('select public.get_floor_workspace($1) r', [ids.venue])
    ).rows[0]!.r;
    expect(data.tables.map((t) => t.id)).toEqual([table]);
    expect(data.tables[0]).toMatchObject({ covers: 3, open_accounts: 1, can_open_account: false });
    expect(JSON.stringify(data)).not.toMatch(
      /Private group|amount_cents|total_cents|payments|access_code/,
    );
    expect(data.rooms).toHaveLength(1);
  });
  it('does not disclose a floor from an unassigned venue', async () => {
    await expect(
      db.query('select public.get_floor_workspace($1)', [ids.otherVenue]),
    ).rejects.toThrow('VENUE_FORBIDDEN');
  });
  it('reserves an upload once, detects a changed retry and keeps quota server authoritative', async () => {
    const key = crypto.randomUUID(),
      hash = 'a'.repeat(64);
    const args = ['gallery', null, ids.venue, 100, 'image/png', hash, key];
    const first = (
      await db.query<{ r: { id: string } }>(
        'select public.reserve_asset_upload_command($1,$2,$3,$4,$5,$6,$7) r',
        args,
      )
    ).rows[0]!.r;
    expect(
      (
        await db.query<{ r: { id: string } }>(
          'select public.reserve_asset_upload_command($1,$2,$3,$4,$5,$6,$7) r',
          args,
        )
      ).rows[0]!.r.id,
    ).toBe(first.id);
    await expect(
      db.query('select public.reserve_asset_upload_command($1,$2,$3,$4,$5,$6,$7)', [
        ...args.slice(0, 5),
        'b'.repeat(64),
        key,
      ]),
    ).rejects.toThrow('IDEMPOTENCY_MISMATCH');
  });
  it('forbids Host uploads', async () => {
    await identity(db, ids.host);
    await expect(
      db.query(
        "select public.reserve_asset_upload_command('gallery',null,$1,100,'image/png',$2,$3)",
        [ids.venue, 'a'.repeat(64), crypto.randomUUID()],
      ),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('forbids global brand changes from a venue Admin', async () => {
    await expect(
      db.query(
        "select public.reserve_asset_upload_command('branding',null,null,100,'image/png',$1,$2)",
        ['a'.repeat(64), crypto.randomUUID()],
      ),
    ).rejects.toThrow('CHAIN_SCOPE_REQUIRED');
  });
  it('persists notification priority while keeping the summary recipient scoped', async () => {
    const version = (
      await db.query<{ version: number }>(
        'select version from public.venue_settings where venue_id=$1',
        [ids.venue],
      )
    ).rows[0]!.version;
    await db.query('select public.save_operational_settings($1,$2,$3,$4)', [
      ids.venue,
      version,
      JSON.stringify({
        sounds: {
          CUSTOMER_CALL: { sound: 'DOUBLE', priority: 'WARNING', enabled: true, badge: true },
        },
      }),
      crypto.randomUUID(),
    ]);
    await db.exec('reset role');
    await db.query(
      "insert into public.notifications(venue_id,recipient_user_id,category,title,resource_type,resource_id) values($1,$2,'CUSTOMER_CALL','Call','tables',$3)",
      [ids.venue, ids.waiter, table],
    );
    await identity(db, ids.host);
    const host = (
      await db.query<{ r: { new_count: number; alerts: unknown[] } }>(
        'select public.get_notification_summary($1) r',
        [ids.venue],
      )
    ).rows[0]!.r;
    expect(host.new_count).toBe(0);
    expect(host.alerts).toEqual([]);
    await identity(db, ids.waiter);
    const waiter = (
      await db.query<{ r: { new_count: number; alerts: { priority: string }[] } }>(
        'select public.get_notification_summary($1) r',
        [ids.venue],
      )
    ).rows[0]!.r;
    expect(waiter.new_count).toBe(1);
    expect(waiter.alerts[0]!.priority).toBe('WARNING');
  });
  it('saves a printer once and rejects endpoints that could be used to post an arbitrary payload', async () => {
    const key = crypto.randomUUID(),
      args = [null, ids.venue, null, 'Cassa', 'BROWSER', null, '{CASHIER}', true, key];
    const save = () =>
      db.query<{ r: { id: string; version: number } }>(
        'select public.save_print_device($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
        args,
      );
    const first = (await save()).rows[0]!.r;
    expect((await save()).rows[0]!.r).toEqual(first);
    await expect(
      db.query('select public.save_print_device($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        null,
        ids.venue,
        null,
        'Unsafe',
        'BRIDGE',
        'https://attacker.invalid/collect',
        '{CASHIER}',
        true,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('PRINT_DRIVER_NOT_INCLUDED');
  });
  it('does not allow online methods without the technical license', async () => {
    const version = (
      await db.query<{ version: number }>(
        'select version from public.venue_settings where venue_id=$1',
        [ids.venue],
      )
    ).rows[0]!.version;
    await expect(
      db.query(
        "select public.save_financial_settings($1,$2,array['STRIPE']::public.payment_method[],'DISABLED','DISABLED',$3)",
        [ids.venue, version, crypto.randomUUID()],
      ),
    ).rejects.toThrow('FEATURE_NOT_LICENSED');
  });
  it('does not give Super Admin access to financial statistics', async () => {
    await identity(db, ids.superAdmin);
    await expect(
      db.query('select public.get_operational_statistics($1,current_date,current_date)', [
        ids.venue,
      ]),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('exposes technical counts and real probe history without financial amounts', async () => {
    await identity(db, ids.superAdmin);
    const data = (
      await db.query<{
        r: { health: unknown[]; queues: Record<string, number>; usage: Record<string, number> };
      }>('select public.get_technical_workspace() r')
    ).rows[0]!.r;
    expect(data.health).toEqual([]);
    expect(data.usage.users).toBe(5);
    expect(data.queues.provider_pending).toBe(0);
    expect(JSON.stringify(data)).not.toMatch(/amount_cents|tip_cents|cash_actual|payments.*\[/);
  });
  it('allows only the server to record health results', async () => {
    await identity(db, ids.superAdmin);
    await expect(
      db.query("select public.record_health_probe('AUTH','HEALTHY',12,'PROBE_OK',$1)", [
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('permission denied');
  });
  it('records an unavailable probe without converting it into success', async () => {
    await db.exec('reset role; set role service_role');
    await db.query(
      "select public.record_health_probe('STORAGE','UNAVAILABLE',25,'PROBE_FAILED',$1)",
      [crypto.randomUUID()],
    );
    await identity(db, ids.superAdmin);
    const data = (
      await db.query<{ r: { health: { component: string; status: string }[] } }>(
        'select public.get_technical_workspace() r',
      )
    ).rows[0]!.r;
    expect(data.health).toEqual([
      expect.objectContaining({ component: 'STORAGE', status: 'UNAVAILABLE' }),
    ]);
  });
  it('uses null for metrics that have no actual events', async () => {
    const data = (
      await db.query<{
        r: {
          average_check_cents: number | null;
          no_show_percent: number | null;
          call_acceptance_seconds: number | null;
          categories: unknown[];
        };
      }>('select public.get_operational_statistics($1,current_date,current_date) r', [ids.venue])
    ).rows[0]!.r;
    expect(data.average_check_cents).toBeNull();
    expect(data.no_show_percent).toBeNull();
    expect(data.call_acceptance_seconds).toBeNull();
    expect(data.categories).toEqual([]);
  });
  it('cannot bypass the table quota by reactivating an archived table', async () => {
    await db.exec('reset role');
    await db.query('update public.tables set active=false where id=$1', [hiddenTable]);
    await db.exec('update public.system_limits set max_tables_per_venue=1 where id');
    await identity(db, ids.admin);
    const version = (
      await db.query<{ version: number }>('select version from public.tables where id=$1', [
        hiddenTable,
      ])
    ).rows[0]!.version;
    await expect(
      db.query("select public.save_configuration('tables',$1,$2,'{\"active\":true}',$3)", [
        ids.venue,
        hiddenTable,
        version,
      ]),
    ).rejects.toThrow('TABLE_LIMIT');
  });
  it('cannot reduce Storage quota below an outstanding reserved upload', async () => {
    await db.query(
      "select public.reserve_asset_upload_command('gallery',null,$1,1000,'image/png',$2,$3)",
      [ids.venue, 'a'.repeat(64), crypto.randomUUID()],
    );
    await db.exec('reset role');
    await expect(
      db.exec('update public.system_limits set max_storage_bytes=999 where id'),
    ).rejects.toThrow('LIMIT_BELOW_CURRENT_USAGE');
  });
  it('does not let an application user insert telemetry or forge server health', async () => {
    await expect(
      db.query(
        "select public.ingest_edge_telemetry('HTTP_SUCCESS','staging','0.1.0','reservation',12,'OK',200,$1)",
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow('permission denied');
  });
  it('keeps measured error rates unknown until real observations exist', async () => {
    await identity(db, ids.superAdmin);
    const data = (
      await db.query<{
        r: {
          metrics: {
            requests: number;
            error_percent: number | null;
            latency_p95_ms: number | null;
          };
        };
      }>('select public.get_technical_workspace() r')
    ).rows[0]!.r;
    expect(data.metrics).toMatchObject({ requests: 0, error_percent: null, latency_p95_ms: null });
  });
  it('derives technical error rate from sanitized actual request events', async () => {
    await db.exec('reset role; set role service_role');
    await db.query(
      "select public.ingest_edge_telemetry('HTTP_SUCCESS','staging','0.1.0','reservation',10,'OK',200,$1)",
      [crypto.randomUUID()],
    );
    await db.query(
      "select public.ingest_edge_telemetry('HTTP_FAILURE','staging','0.1.0','reservation',30,'REQUEST_FAILED',500,$1)",
      [crypto.randomUUID()],
    );
    await identity(db, ids.superAdmin);
    const data = (
      await db.query<{
        r: { metrics: { requests: number; failures: number; error_percent: number } };
      }>('select public.get_technical_workspace() r')
    ).rows[0]!.r;
    expect(data.metrics).toMatchObject({ requests: 2, failures: 1, error_percent: 50 });
  });
  it('ignores malformed legacy telemetry instead of breaking the technical dashboard', async () => {
    await db.exec('reset role');
    await db.query(
      "insert into public.telemetry_events(event,environment,release_version,request_id,properties) values('HTTP_FAILURE','staging','0.1.0',$1,'{\"status\":\"invalid\",\"duration_ms\":\"invalid\"}'),('HTTP_SUCCESS','staging','0.1.0',$2,'{\"status\":200,\"duration_ms\":\"invalid\"}')",
      [crypto.randomUUID(), crypto.randomUUID()],
    );
    await identity(db, ids.superAdmin);
    const result = (
      await db.query<{
        r: { metrics: { requests: number; failures: number; latency_p95_ms: number | null } };
      }>('select public.get_technical_workspace() r')
    ).rows[0]!.r;
    expect(result.metrics).toMatchObject({ requests: 1, failures: 0, latency_p95_ms: null });
  });
});
