import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { installPlatformShim, replayMigrations } from './platform-schema.ts';
import {
  LAN_FILTER_COLUMN,
  LAN_PAYMENT_METHODS,
  LAN_RPCS,
  LAN_TABLES,
} from '../../shared/lan-contract.ts';

export { LAN_RPCS, LAN_TABLES } from '../../shared/lan-contract.ts';

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

// Identity under which an operation runs: the user and the staff session whose
// policies (role, venue, PIN unlock window) the database checks.
export type Actor = { user_id: string; session_id: string };

export type HubOptions = {
  dataDir?: string; // undefined = in-memory (tests only)
  migrationsDir?: string;
  hubId: string;
  generation: number;
  devices: DeviceBinding[];
};

export type HubSignal = {
  id: string;
  topic: string;
  venue_id: string | null;
  recipient_user_id: string | null;
};

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
-- Staff sessions opened on the hub with a PIN. Only the SHA-256 of the token is
-- stored; a session is bound to the paired device that opened it.
create table if not exists hub.local_sessions(
  token_sha256 text primary key,
  user_id uuid not null,
  session_id uuid not null,
  device_sha256 text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
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

  /**
   * Resolves who acts for a request. With a staff session token the person who
   * unlocked with their PIN on this device acts; otherwise the device's own
   * binding (single-purpose screens such as a kitchen display).
   */
  async actor(device: DeviceBinding, sessionToken?: string, now = new Date()): Promise<Actor> {
    if (!sessionToken) return device;
    if (sessionToken.length < 32 || sessionToken.length > 256)
      throw new HubError('STAFF_SESSION_INVALID', 401);
    const row = (
      await this.db.query<{ user_id: string; session_id: string }>(
        `select user_id::text, session_id::text from hub.local_sessions
         where token_sha256 = $1 and device_sha256 = $2 and revoked_at is null and expires_at > $3`,
        [tokenDigest(sessionToken), device.token_sha256, now.toISOString()],
      )
    ).rows[0];
    if (!row) throw new HubError('STAFF_SESSION_INVALID', 401);
    return row;
  }

  /** Active staff who share a venue with the paired device (names and roles only). */
  async staffFor(device: DeviceBinding) {
    const rows = await this.db.query<{ id: string; display_name: string; role: string }>(
      `select distinct p.id::text, p.display_name, p.role::text
       from public.staff_profiles p
       join public.staff_venue_assignments a on a.user_id = p.id
       where p.active and p.role <> 'SUPER_ADMIN'
         and a.venue_id in (select venue_id from public.staff_venue_assignments where user_id = $1)
       order by p.display_name`,
      [device.user_id],
    );
    return rows.rows;
  }

  /**
   * Opens a staff session with the PIN, using the database's own unlock rules
   * (attempt counter, exponential lock, full-authentication window). The hub
   * never creates a full authentication: it reuses the most recent valid staff
   * session of that person replicated from the cloud.
   */
  async openSession(device: DeviceBinding, userId: string, pin: string, now = new Date()) {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HubError('INVALID_STAFF', 400);
    const allowed = await this.staffFor(device);
    if (!allowed.some((staff) => staff.id === userId)) throw new HubError('INVALID_STAFF', 403);
    const session = (
      await this.db.query<{ session_id: string }>(
        `select session_id::text from private.staff_sessions
         where user_id = $1 and revoked_at is null
         order by full_auth_at desc nulls last limit 1`,
        [userId],
      )
    ).rows[0];
    if (!session) throw new HubError('FULL_AUTH_REQUIRED', 401);
    const actor = { user_id: userId, session_id: session.session_id };
    const outcome = await this.asUser(actor, async (tx) => {
      const result = await tx.query<{
        r: { ok: boolean; expires_at?: string; password_required?: boolean };
      }>('select public.unlock_staff_session($1) as r', [pin]);
      return result.rows[0]!.r;
    });
    if (!outcome.ok || !outcome.expires_at)
      throw new HubError(outcome.password_required ? 'FULL_AUTH_REQUIRED' : 'PIN_INVALID', 401);
    const token = randomBytes(32).toString('base64url');
    const maxHours = 12;
    const expires = new Date(
      Math.min(Date.parse(outcome.expires_at), now.getTime() + maxHours * 3600_000),
    ).toISOString();
    await this.db.query(
      `insert into hub.local_sessions(token_sha256, user_id, session_id, device_sha256, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [tokenDigest(token), userId, session.session_id, device.token_sha256, expires],
    );
    return { token, user_id: userId, expires_at: expires };
  }

  async closeSession(device: DeviceBinding, sessionToken: string) {
    await this.db.query(
      `update hub.local_sessions set revoked_at = now()
       where token_sha256 = $1 and device_sha256 = $2 and revoked_at is null`,
      [tokenDigest(sessionToken), device.token_sha256],
    );
  }

  async rpc(device: Actor, name: string, args: Record<string, unknown>) {
    const spec = Object.prototype.hasOwnProperty.call(LAN_RPCS, name) ? LAN_RPCS[name] : undefined;
    if (!spec) throw new HubError('RPC_NOT_AVAILABLE_ON_LAN', 404);
    if (args === null || typeof args !== 'object' || Array.isArray(args))
      throw new HubError('RPC_ARGUMENTS_REQUIRED', 400);
    const names = Object.keys(args);
    if (names.some((key) => !spec.params.includes(key)))
      throw new HubError('RPC_UNKNOWN_ARGUMENT', 400);
    // Online providers cannot be confirmed without the cloud (ADR-0001).
    if (name === 'create_payment' && !LAN_PAYMENT_METHODS.has(String(args.p_method)))
      throw new HubError('PAYMENT_METHOD_UNAVAILABLE_ON_LAN', 409);
    const params = names.map((key) => {
      const value = args[key];
      return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    });
    // PostgreSQL named notation: parameter names come from the contract, never from input.
    const call = names.map((key, i) => `${key} => $${i + 1}`).join(', ');
    return this.asUser(device, async (tx) => {
      await tx.exec('reset role');
      const before = spec.write ? await this.lastSeq(tx) : 0;
      await tx.exec('set local role authenticated');
      const result = await tx.query<{ result: unknown }>(
        `select public.${name}(${call}) as result`,
        params,
      );
      // The change log is private to the hub owner: leave the caller role first.
      await tx.exec('reset role');
      const seq = spec.write ? await this.lastSeq(tx) : null;
      const signals =
        seq !== null && seq > before
          ? (
              await tx.query<HubSignal>(
                `select row_data->>'id' as id, row_data->>'topic' as topic,
                        row_data->>'venue_id' as venue_id,
                        row_data->>'recipient_user_id' as recipient_user_id
                 from hub.changelog
                 where seq > $1 and seq <= $2 and op = 'INSERT'
                   and table_name = 'public.realtime_signals'
                 order by seq`,
                [before, seq],
              )
            ).rows
          : [];
      // PostgREST returns null for `returns void`; PGlite yields ''. Keep the cloud contract.
      const value = (await this.returnsVoid(tx, name)) ? null : (result.rows[0]?.result ?? null);
      return { result: value, seq, write: spec.write, signals };
    });
  }

  private voidCache = new Map<string, boolean>();
  private async returnsVoid(tx: Pick<PGlite, 'query'>, name: string) {
    const known = this.voidCache.get(name);
    if (known !== undefined) return known;
    const rows = await tx.query<{ v: boolean }>(
      `select bool_and(p.prorettype = 'void'::regtype) as v from pg_proc p
       where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
      [name],
    );
    const value = rows.rows[0]?.v === true;
    this.voidCache.set(name, value);
    return value;
  }

  private async lastSeq(tx: Pick<PGlite, 'query'>) {
    return Number(
      (await tx.query<{ seq: string | null }>('select max(seq)::text as seq from hub.changelog'))
        .rows[0]?.seq ?? 0,
    );
  }

  /**
   * Working context of the person acting, read under their RLS: own profile,
   * visible venues, licensed features and, with MULTI_VENUE, the device's
   * current venue as decided by get_staff_venue_context.
   */
  async context(actor: Actor) {
    return this.asUser(actor, async (tx) => {
      const profile = (
        await tx.query<Record<string, unknown>>(
          `select id::text, display_name, role::text, scope::text, active, version
           from public.staff_profiles where id = auth.uid()`,
        )
      ).rows[0];
      if (!profile || profile.active !== true) throw new HubError('STAFF_SESSION_INVALID', 401);
      const venues = (
        await tx.query<Record<string, unknown>>(
          `select id::text, name, slug, address, phone, email, opening_hours, timezone,
                  currency, locale, version
           from public.venues order by name`,
        )
      ).rows;
      const flags = (
        await tx.query<{ name: string; licensed: boolean }>(
          'select name::text, licensed from public.feature_flags order by name',
        )
      ).rows;
      const multiVenue = flags.some((flag) => flag.name === 'MULTI_VENUE' && flag.licensed);
      const current = multiVenue
        ? ((
            await tx.query<{ c: { current_venue_id?: string } }>(
              'select public.get_staff_venue_context() as c',
            )
          ).rows[0]?.c.current_venue_id ?? null)
        : null;
      return { profile, venues, feature_flags: flags, current_venue_id: current };
    });
  }

  /** Venues for which a user may receive venue-wide signals (owner query, never over HTTP). */
  async venuesOf(userId: string) {
    const rows = await this.db.query<{ venue_id: string }>(
      `select v.id as venue_id from public.venues v
       where exists (select 1 from public.staff_profiles p where p.id = $1 and p.scope = 'CHAIN')
          or exists (select 1 from public.staff_venue_assignments a
                     where a.user_id = $1 and a.venue_id = v.id)`,
      [userId],
    );
    return new Set(rows.rows.map((r) => r.venue_id));
  }

  async read(
    device: Actor,
    table: string,
    options: { filters?: Record<string, string>; after?: string; limit?: number } = {},
  ) {
    if (!LAN_TABLES.has(table)) throw new HubError('TABLE_NOT_AVAILABLE_ON_LAN', 404);
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1001)
      throw new HubError('INVALID_LIMIT', 400);
    const filters = Object.entries(options.filters ?? {});
    if (
      filters.length > 8 ||
      filters.some(([k, v]) => !LAN_FILTER_COLUMN.test(k) || v.length > 200)
    )
      throw new HubError('INVALID_FILTER', 400);
    if (options.after !== undefined && options.after.length > 200)
      throw new HubError('INVALID_FILTER', 400);
    return this.asUser(device, async (tx) => {
      const columns = new Set(
        (
          await tx.query<{ name: string }>(
            `select attname as name from pg_attribute
             where attrelid = $1::regclass and attnum > 0 and not attisdropped`,
            [`public.${table}`],
          )
        ).rows.map((r) => r.name),
      );
      if (filters.some(([k]) => !columns.has(k))) throw new HubError('INVALID_FILTER', 400);
      const key = columns.has('id') ? 'id' : null;
      const where = filters.map(([k], i) => `"${k}"::text = $${i + 1}`);
      const values: unknown[] = filters.map(([, v]) => v);
      if (options.after !== undefined && key) {
        values.push(options.after);
        where.push(`${key}::text > $${values.length}`);
      }
      const rows = await tx.query<Record<string, unknown>>(
        `select * from public.${table}${where.length ? ` where ${where.join(' and ')}` : ''}
         ${key ? `order by ${key}::text` : ''} limit ${limit}`,
        values,
      );
      return rows.rows;
    });
  }

  private async asUser<T>(
    device: Actor,
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
