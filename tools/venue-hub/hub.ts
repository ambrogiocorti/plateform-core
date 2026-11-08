import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { installPlatformShim, replayMigrations } from './platform-schema.ts';

// Venue hub core. One hub per venue is the single write authority for service
// operations (ADR docs/adr/ADR-0001-continuita-lan-hub-di-sede.md). It executes
// the same versioned migrations, RLS policies and RPCs used by Supabase, inside
// a persistent embedded PostgreSQL. Browsers are never authoritative.

export type DeviceBinding = {
  // SHA-256 (hex) of the opaque device token issued at pairing time.
  token_sha256: string;
  user_id: string;
  session_id: string;
  label: string;
  // Absolute expiry: a stale binding is refused even when the cloud is unreachable.
  expires_at: string;
};

export type HubOptions = {
  dataDir?: string; // undefined = in-memory (tests only)
  migrationsDir?: string;
  hubId: string;
  generation: number;
  devices: DeviceBinding[];
};

// Allowlist of RPCs reachable from LAN clients, with exact arity. Everything
// else (administration, credentials, restore, provider payments) is refused by
// the hub: those operations require the cloud and a full authentication.
export const LAN_RPCS: Record<string, { arity: number; write: boolean }> = {
  create_account: { arity: 5, write: true },
  create_order: { arity: 4, write: true },
  get_kitchen_board: { arity: 1, write: false },
  transition_order_item: { arity: 3, write: true },
  mark_step_ready: { arity: 1, write: true },
  deliver_step: { arity: 2, write: true },
  open_service_session: { arity: 5, write: true },
  create_payment: { arity: 7, write: true },
  confirm_manual_payment: { arity: 2, write: true },
  get_account_balance: { arity: 1, write: false },
  close_account: { arity: 1, write: true },
};

// Tables readable over the LAN, always under the caller's RLS policies.
export const LAN_TABLES = new Set(['accounts', 'orders', 'tables', 'payments']);

export class HubError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

const HUB_SCHEMA_SQL = `
create schema if not exists hub;
revoke all on schema hub from public, anon, authenticated, service_role;
create table if not exists hub.identity(
  id boolean primary key default true check (id),
  hub_id text not null,
  generation integer not null check (generation > 0)
);
-- Durable, ordered change log of every committed row change in the public schema.
-- It is the outbox replicated to the cloud: seq is assigned inside the same
-- transaction as the business change, so a crash can never lose or reorder it.
create table if not exists hub.changelog(
  seq bigserial primary key,
  generation integer not null,
  txid bigint not null default txid_current(),
  table_name text not null,
  op text not null check (op in ('INSERT','UPDATE','DELETE')),
  pk jsonb not null,
  row_data jsonb,
  recorded_at timestamptz not null default clock_timestamp()
);
create table if not exists hub.sync_state(
  id boolean primary key default true check (id),
  acknowledged_seq bigint not null default 0
);
insert into hub.sync_state(id) values(true) on conflict do nothing;
create or replace function hub.capture() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb;
  keys jsonb;
begin
  rec := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  select coalesce(jsonb_object_agg(a.attname, rec -> a.attname), '{}'::jsonb) into keys
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = tg_relid and i.indisprimary;
  insert into hub.changelog(generation, table_name, op, pk, row_data)
  values (
    (select generation from hub.identity),
    tg_table_schema || '.' || tg_table_name,
    tg_op,
    keys,
    case when tg_op = 'DELETE' then null else rec end
  );
  return null;
end $$;
revoke all on function hub.capture() from public, anon, authenticated, service_role;
`;

// Attach capture triggers to every base table in public that has a primary key.
// Partitioned parents propagate row triggers to their partitions. The audit log
// is excluded on purpose: its append-only guard (private.assert_audit_append_only)
// forbids any extra trigger. Audit rows are replicated by an append-only cursor
// instead of row triggers (ADR-0001, open item AUD-SYNC).
const ATTACH_CAPTURE_SQL = `
do $$
declare t record;
begin
  for t in
    select c.oid::regclass as rel, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition
      and c.relname !~ '^audit_log'
      and exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary)
  loop
    execute format('drop trigger if exists zz_hub_capture on %s', t.rel);
    execute format('create trigger zz_hub_capture after insert or update or delete on %s for each row execute function hub.capture()', t.rel);
  end loop;
end $$;
`;

export class VenueHub {
  private constructor(
    readonly db: PGlite,
    private devices: Map<string, DeviceBinding>,
    readonly hubId: string,
    readonly generation: number,
  ) {}

  static async open(options: HubOptions) {
    const fresh = !options.dataDir || !existsSync(join(options.dataDir, 'PG_VERSION'));
    let db: PGlite;
    if (fresh) {
      // First installation: build the schema in memory (fast), then persist the
      // complete data directory in one step. A crash before the final write
      // leaves no partial data directory behind.
      const staging = new PGlite({ extensions: { pgcrypto } });
      await installPlatformShim(staging);
      await replayMigrations(staging, {
        ...(options.migrationsDir ? { directory: options.migrationsDir } : {}),
      });
      if (options.dataDir) {
        const image = await staging.dumpDataDir('none');
        await staging.close();
        db = new PGlite(options.dataDir, { extensions: { pgcrypto }, loadDataDir: image });
      } else db = staging;
    } else db = new PGlite(options.dataDir!, { extensions: { pgcrypto } });
    // Upgrades: apply only migrations not yet recorded, each atomically.
    await replayMigrations(db, {
      transactional: true,
      ...(options.migrationsDir ? { directory: options.migrationsDir } : {}),
    });
    await db.exec(HUB_SCHEMA_SQL);
    const current = (
      await db.query<{ hub_id: string; generation: number }>(
        'select hub_id, generation from hub.identity',
      )
    ).rows[0];
    if (current && current.hub_id !== options.hubId) {
      await db.close();
      throw new HubError('HUB_DATA_BELONGS_TO_ANOTHER_HUB', 500);
    }
    if (current && current.generation > options.generation) {
      // Never run with an older authority generation than the data already carries.
      await db.close();
      throw new HubError('HUB_GENERATION_REGRESSION', 500);
    }
    await db.query(
      `insert into hub.identity(id, hub_id, generation) values(true, $1, $2)
       on conflict (id) do update set generation = excluded.generation`,
      [options.hubId, options.generation],
    );
    await db.exec(ATTACH_CAPTURE_SQL);
    const devices = new Map(options.devices.map((d) => [d.token_sha256, d]));
    return new VenueHub(db, devices, options.hubId, options.generation);
  }

  /** Seed/maintenance SQL executed as the database owner. Never reachable over HTTP. */
  async admin(sql: string) {
    await this.db.exec(sql);
  }

  authenticate(token: string | undefined, now = new Date()) {
    if (!token || token.length < 32) throw new HubError('DEVICE_TOKEN_REQUIRED', 401);
    const digest = createHash('sha256').update(token).digest('hex');
    const device = this.devices.get(digest);
    if (!device) throw new HubError('DEVICE_NOT_PAIRED', 401);
    if (Date.parse(device.expires_at) <= now.getTime())
      throw new HubError('DEVICE_BINDING_EXPIRED', 401);
    return device;
  }

  revoke(tokenSha256: string) {
    this.devices.delete(tokenSha256);
  }

  async rpc(device: DeviceBinding, name: string, args: unknown[]) {
    const spec = LAN_RPCS[name];
    if (!spec) throw new HubError('RPC_NOT_AVAILABLE_ON_LAN', 404);
    if (!Array.isArray(args) || args.length !== spec.arity)
      throw new HubError('RPC_ARITY_MISMATCH', 400);
    const params = args.map((value) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
    );
    const placeholders = params.map((_, i) => `$${i + 1}`).join(',');
    return this.asUser(device, async (tx) => {
      const result = await tx.query<{ result: unknown }>(
        `select public.${name}(${placeholders}) as result`,
        params,
      );
      // The change log is private to the hub owner: leave the caller role first.
      await tx.exec('reset role');
      const seq = spec.write
        ? Number(
            (
              await tx.query<{ seq: string | null }>(
                'select max(seq)::text as seq from hub.changelog',
              )
            ).rows[0]?.seq ?? 0,
          )
        : null;
      return { result: result.rows[0]?.result ?? null, seq, write: spec.write };
    });
  }

  async read(device: DeviceBinding, table: string, id?: string) {
    if (!LAN_TABLES.has(table)) throw new HubError('TABLE_NOT_AVAILABLE_ON_LAN', 404);
    if (id !== undefined && !/^[0-9a-f-]{36}$/i.test(id)) throw new HubError('INVALID_ID', 400);
    return this.asUser(device, async (tx) => {
      const rows = await tx.query<Record<string, unknown>>(
        `select * from public.${table}${id ? ' where id = $1' : ''} limit 200`,
        id ? [id] : [],
      );
      return rows.rows;
    });
  }

  private async asUser<T>(
    device: DeviceBinding,
    work: (tx: Parameters<Parameters<PGlite['transaction']>[0]>[0]) => Promise<T>,
  ) {
    const claims = JSON.stringify({
      sub: device.user_id,
      aal: 'aal2',
      iat: Math.floor(Date.now() / 1000),
      session_id: device.session_id,
      amr: [{ method: 'hub_device', timestamp: Math.floor(Date.now() / 1000) }],
    });
    try {
      return await this.db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.exec('set local role authenticated');
        return work(tx);
      });
    } catch (error) {
      if (error instanceof HubError) throw error;
      // Business rule violations surface as stable codes from the RPCs.
      const message = error instanceof Error ? error.message : String(error);
      if (process.env.PLATEFORM_HUB_DEBUG) console.error('[hub]', message);
      throw new HubError(/^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'RPC_FAILED', 409);
    }
  }

  async pendingChanges(limit = 500) {
    const acknowledged = await this.acknowledgedSeq();
    const rows = await this.db.query<{
      seq: string;
      generation: number;
      txid: string;
      table_name: string;
      op: 'INSERT' | 'UPDATE' | 'DELETE';
      pk: Record<string, unknown>;
      row_data: Record<string, unknown> | null;
    }>(
      `select seq::text, generation, txid::text, table_name, op, pk, row_data
       from hub.changelog c where c.seq > $1 order by c.seq limit $2`,
      [acknowledged, limit],
    );
    return rows.rows.map((r) => ({ ...r, seq: Number(r.seq), txid: Number(r.txid) }));
  }

  async acknowledgedSeq() {
    return Number(
      (await this.db.query<{ s: string }>('select acknowledged_seq::text as s from hub.sync_state'))
        .rows[0]?.s ?? 0,
    );
  }

  async acknowledge(seq: number) {
    // Monotonic: a late or replayed acknowledgement can never move backwards.
    await this.db.query(
      'update hub.sync_state set acknowledged_seq = greatest(acknowledged_seq, $1)',
      [seq],
    );
  }

  async close() {
    await this.db.close();
  }
}

export function tokenDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
