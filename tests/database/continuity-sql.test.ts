import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, seed } from './harness';
import {
  DURABLE_PRIVATE_TABLES,
  durablePrivateStateSql,
  securityStateSql,
} from '../../tools/backup-worker/private-state.mjs';
import {
  MANAGED_OVERLAY_SQL,
  SECURITY_SURFACE_KEYS,
  SECURITY_SURFACE_SQL,
} from '../../tools/backup-worker/managed-surface.mjs';
import { RESET_TARGET_DEFAULT_PRIVILEGES_SQL } from '../../tools/restore-test-worker/database.mjs';

// The continuity workers send this SQL through psql to hosted Postgres; static
// gates never executed it. Run it against the full migrated schema.
describe('Continuity worker SQL (Step 12)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  async function scalar<T>(sql: string): Promise<T> {
    const results = await db.exec(sql);
    await db.exec('reset search_path');
    const rows = results.at(-1)?.rows ?? [];
    return Object.values(rows[0] ?? {})[0] as T;
  }

  it('fingerprints durable private state with valid SQL literals', async () => {
    await db.exec('set search_path to public, extensions');
    const durable = await scalar<{ table_count: number; aggregate_sha256: string }>(
      `select ${durablePrivateStateSql()} as v`,
    );
    expect(durable.table_count).toBe(DURABLE_PRIVATE_TABLES.length);
    expect(durable.aggregate_sha256).toMatch(/^[0-9a-f]{64}$/);
    // securityStateSql() also reads managed auth tables absent from this fixture;
    // it runs in tools/local-dr-rehearsal against the full managed surface.
    expect(securityStateSql()).toContain('private.staff_sessions');
  });

  it('captures Storage policies, managed triggers and schedules lost by a logical dump', async () => {
    const overlay = await scalar<{
      policies: { ddl: string }[];
      triggers: { ddl: string }[];
      schedules: { name: string }[];
    }>(MANAGED_OVERLAY_SQL);
    expect(overlay.policies.map((p) => p.ddl).join('\n')).toContain('plateform_public_assets');
    expect(overlay.triggers.map((t) => t.ddl).join('\n')).toContain(
      'continuity_bucket_private_guard',
    );
    expect(overlay.schedules.map((s) => s.name)).toContain('plateform-daily-backup');

    const before = await scalar<Record<string, string>>(SECURITY_SURFACE_SQL);
    for (const key of SECURITY_SURFACE_KEYS) expect(typeof before[key]).toBe('string');
    // Re-applying the overlay is idempotent and reproduces the same surface.
    await db.exec([...overlay.policies, ...overlay.triggers].map((row) => row.ddl).join('\n'));
    expect(await scalar<Record<string, string>>(SECURITY_SURFACE_SQL)).toEqual(before);
  });

  it('clears target default privileges that would re-grant revoked objects on restore', async () => {
    await db.exec(`alter default privileges in schema public grant all on tables to anon;
      alter default privileges in schema public grant execute on functions to anon`);
    await db.exec(RESET_TARGET_DEFAULT_PRIVILEGES_SQL);
    const leaked = await db.query<{ n: number }>(
      `select count(*)::int n from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
        where d.defaclrole=current_user::regrole and a.grantee in ('anon'::regrole,'authenticated'::regrole)`,
    );
    expect(leaked.rows[0]?.n).toBe(0);
  });
});
