import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { decryptVerified } from '../backup-worker/crypto.mjs';
import { resolveBackupArtifact } from '../backup-worker/filesystem.mjs';
import {
  SECURITY_SURFACE_KEYS,
  applyManagedOverlay,
  managedOverlayCounts,
  securitySurfaceState,
} from '../backup-worker/managed-surface.mjs';
import {
  DURABLE_PRIVATE_TABLES,
  durablePrivateStateSql,
  securityStateSql,
  sanitizeSecuritySql,
} from '../backup-worker/private-state.mjs';

function run(command, args, secrets = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve(stdout);
      let safe = stderr;
      for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[REDACTED]');
      reject(new Error(`RESTORE_DATABASE_FAILED:${code}:${safe.slice(0, 400)}`));
    });
  });
}

// A fresh Supabase project ships ALTER DEFAULT PRIVILEGES that grant ALL on new
// public tables/functions/sequences to anon and authenticated. pg_dump writes ACLs
// relative to the built-in defaults, so without this reset every restored object
// would silently regain privileges the migrations revoked (anon TRUNCATE, EXECUTE
// on SECURITY DEFINER functions, ...). Clear the defaults the restoring role owns
// inside the restore transaction; schema.sql re-applies the source defaults last.
export const RESET_TARGET_DEFAULT_PRIVILEGES_SQL = `do $reset$
declare r record;
begin
  for r in
    select d.defaclnamespace,n.nspname,d.defaclobjtype,a.grantee
      from pg_default_acl d
      left join pg_namespace n on n.oid=d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
     where d.defaclrole=current_user::regrole
       and a.grantee<>d.defaclrole
  loop
    execute format(
      'alter default privileges %s revoke all on %s from %s',
      case when r.defaclnamespace=0 then '' else 'in schema '||quote_ident(r.nspname) end,
      case r.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
        when 'f' then 'functions' when 'T' then 'types' when 'n' then 'schemas' end,
      case when r.grantee=0 then 'public' else quote_ident(r.grantee::regrole::text) end
    );
  end loop;
end $reset$;`;

export async function restoreDatabase(config, files) {
  // Match Supabase's documented logical restore sequence. Auth data and Storage
  // metadata are already part of data.sql; Storage object bytes are restored later.
  await run(
    config.psql,
    [
      '--single-transaction',
      '--variable',
      'ON_ERROR_STOP=1',
      '--file',
      files.roles,
      '--command',
      RESET_TARGET_DEFAULT_PRIVILEGES_SQL,
      '--file',
      files.schema,
      '--command',
      'SET session_replication_role = replica',
      '--file',
      files.data,
      '--dbname',
      config.targetDatabaseUrl,
    ],
    [config.targetDatabaseUrl],
  );
  await run(
    config.psql,
    [
      '--single-transaction',
      '--variable',
      'ON_ERROR_STOP=1',
      '--file',
      files.historySchema,
      '--file',
      files.historyData,
      '--dbname',
      config.targetDatabaseUrl,
    ],
    [config.targetDatabaseUrl],
  );
}

async function targetJson(config, sql) {
  const output = await run(
    config.psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sql,
    ],
    [config.targetDatabaseUrl],
  );
  return JSON.parse(output.trim() || 'null');
}

// The Storage upload API rewrites storage.objects metadata (eTag timestamps,
// lastModified, owner) on upsert. data.sql already restored the authoritative
// rows, so capture them before the byte upload and re-apply them afterwards;
// bytes are proven separately by SHA-256 and metadata by its fingerprint.
const OBJECT_COLUMNS = 'owner uuid,owner_id text,metadata jsonb,user_metadata jsonb';
export async function captureStorageObjectRows(config) {
  return (
    (await targetJson(
      config,
      `select coalesce(jsonb_agg(jsonb_build_object('bucket_id',bucket_id,'name',name,'owner',owner,'owner_id',owner_id,'metadata',metadata,'user_metadata',user_metadata)),'[]') from storage.objects`,
    )) ?? []
  );
}
export async function reapplyStorageObjectRows(config, rows) {
  if (!rows.length) return 0;
  const tag = `$rows${randomBytes(8).toString('hex')}$`;
  const payload = JSON.stringify(rows);
  if (payload.includes(tag)) throw new Error('RESTORE_STORAGE_METADATA_PAYLOAD_INVALID');
  const updated = await targetJson(
    config,
    `with r as (select * from jsonb_to_recordset(${tag}${payload}${tag}::jsonb) as x(bucket_id text,name text,${OBJECT_COLUMNS})),
     u as (update storage.objects o set owner=r.owner,owner_id=r.owner_id,metadata=r.metadata,user_metadata=r.user_metadata
             from r where o.bucket_id=r.bucket_id and o.name=r.name returning 1)
     select count(*) from u`,
  );
  if (Number(updated) !== rows.length) throw new Error('RESTORE_STORAGE_METADATA_REAPPLY_FAILED');
  return rows.length;
}

export async function verifyDatabase(config) {
  const sql = `select json_build_object(
    'database',true,
    'auth',to_regclass('auth.users') is not null,
    'auth_user_count',(select count(*) from auth.users),
    'rls',not exists(
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
    ),
    'accounts',to_regclass('public.accounts') is not null,
    'payments',to_regclass('public.payments') is not null,
    'audit',to_regclass('public.audit_log') is not null,
    'sessions',to_regclass('auth.sessions') is not null,
    'devices',to_regclass('public.registered_devices') is not null
  );`;
  const output = await run(
    config.psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sql,
    ],
    [config.targetDatabaseUrl],
  );
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error('RESTORE_DATABASE_VERIFICATION_INVALID');
  }
}

export async function verifyMigrationHistory(config, expected) {
  if (
    !expected ||
    !Number.isInteger(expected.count) ||
    expected.count < 0 ||
    !/^[0-9]{14}$/.test(String(expected.latest_version ?? '')) ||
    !/^[0-9a-f]{64}$/.test(String(expected.aggregate_sha256 ?? ''))
  )
    throw new Error('RESTORE_MIGRATION_MANIFEST_INVALID');
  const sql = `select json_build_object(
    'count',count(*),
    'latest_version',max(version),
    'aggregate_sha256',encode(digest(coalesce(string_agg(
      version||'|'||name||'|'||encode(digest(array_to_string(statements,E'\\n\\n'),'sha256'),'hex'),
      E'\\n' order by version
    ),''),'sha256'),'hex')
  ) from supabase_migrations.schema_migrations;`;
  const output = await run(
    config.psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sql,
    ],
    [config.targetDatabaseUrl],
  );
  let actual;
  try {
    actual = JSON.parse(output.trim());
  } catch {
    throw new Error('RESTORE_MIGRATION_VERIFICATION_INVALID');
  }
  const count = Number(actual.count);
  const latestVersion = String(actual.latest_version ?? '');
  const aggregateSha256 = String(actual.aggregate_sha256 ?? '');
  return {
    migrations:
      count === expected.count &&
      latestVersion === expected.latest_version &&
      aggregateSha256 === expected.aggregate_sha256,
    migration_count: count,
    migration_latest_version: latestVersion,
    migration_hash: aggregateSha256,
  };
}

export async function quiesceTargetAutomation(config) {
  const sql = `do $$
declare r record;
begin
  if to_regclass('cron.job') is not null then
    for r in select jobname from cron.job where jobname like 'plateform-%' loop
      perform cron.unschedule(r.jobname);
    end loop;
  end if;
exception when undefined_function or undefined_table then null;
end $$;`;
  await run(
    config.psql,
    ['-X', '--set', 'ON_ERROR_STOP=1', '--dbname', config.targetDatabaseUrl, '--command', sql],
    [config.targetDatabaseUrl],
  );
}

export async function sanitizeRestoredSecurityState(config) {
  await run(
    config.psql,
    [
      '-X',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sanitizeSecuritySql(),
    ],
    [config.targetDatabaseUrl],
  );
}

export async function verifyPrivateState(config, expected) {
  if (
    !expected ||
    expected.policy !== 'durable-private-v1' ||
    expected.security_sanitization !== 'invalidate-runtime-security-state-v1' ||
    !Number.isInteger(Number(expected.durable_table_count)) ||
    Number(expected.durable_table_count) !== DURABLE_PRIVATE_TABLES.length ||
    !Number.isInteger(Number(expected.durable_row_count)) ||
    Number(expected.durable_row_count) < 0 ||
    !/^[0-9a-f]{64}$/.test(String(expected.durable_aggregate_sha256 ?? ''))
  )
    throw new Error('RESTORE_PRIVATE_STATE_MANIFEST_INVALID');
  const sql = `select json_build_object('durable',${durablePrivateStateSql()},'security',${securityStateSql()});`;
  const output = await run(
    config.psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sql,
    ],
    [config.targetDatabaseUrl],
  );
  let actual;
  try {
    actual = JSON.parse(output.trim());
  } catch {
    throw new Error('RESTORE_PRIVATE_STATE_VERIFICATION_INVALID');
  }
  const durable = actual?.durable ?? {};
  const security = actual?.security ?? {};
  const privateCounts = Array.isArray(security.private) ? security.private : [];
  const authCounts = Array.isArray(security.auth) ? security.auth : [];
  const sessionsSanitized = [...privateCounts, ...authCounts].every(
    (row) => Number(row?.count) === 0,
  );
  const stateOk =
    Number(durable.table_count) === Number(expected.durable_table_count) &&
    Number(durable.row_count) === Number(expected.durable_row_count) &&
    String(durable.aggregate_sha256 ?? '') === String(expected.durable_aggregate_sha256);
  return {
    private_state: stateOk,
    private_durable_rows: Number(durable.row_count ?? -1),
    private_durable_hash: String(durable.aggregate_sha256 ?? ''),
    sessions: sessionsSanitized,
  };
}

function overlayManifest(manifest) {
  const overlay = manifest.components?.managed_overlay;
  const surface = manifest.components?.security_surface;
  if (
    overlay?.policy !== 'managed-overlay-v1' ||
    !Array.isArray(overlay.files) ||
    !Number.isInteger(overlay.policy_count) ||
    !Number.isInteger(overlay.trigger_count) ||
    surface?.policy !== 'security-surface-v1' ||
    !SECURITY_SURFACE_KEYS.every((key) => /^[0-9a-f]{64}$/.test(String(surface[key] ?? '')))
  )
    // Backups taken before managed-overlay-v1 cannot prove Storage policies,
    // managed triggers or grants after restore: fail closed.
    throw new Error('BACKUP_MANAGED_OVERLAY_MISSING');
  return { overlay, surface };
}

// Re-applies policies/triggers that Plateform adds on Supabase-managed tables
// (dropped by the managed-schema exclusions of the logical dump). pg_cron
// schedules are deliberately NOT applied here: restored automation stays
// quiesced until cutover.
export async function restoreManagedOverlay(config, manifest, backupDir, tempDir, encryptionKey) {
  const { overlay } = overlayManifest(manifest);
  const meta = overlay.files.find((row) => row.file === 'managed_overlay.sql.enc');
  if (!meta) throw new Error('BACKUP_ARTIFACT_MISSING:managed_overlay.sql');
  const target = join(tempDir, 'managed_overlay.sql');
  await decryptVerified(
    await resolveBackupArtifact(backupDir, meta.file),
    target,
    encryptionKey,
    meta,
  );
  await applyManagedOverlay(config.psql, config.targetDatabaseUrl, target);
}

export async function verifyManagedSurface(config, manifest) {
  const { overlay, surface } = overlayManifest(manifest);
  const counts = await managedOverlayCounts(config.psql, config.targetDatabaseUrl);
  const actual = await securitySurfaceState(config.psql, config.targetDatabaseUrl);
  const mismatch = SECURITY_SURFACE_KEYS.filter((key) => actual.hashes[key] !== surface[key]);
  return {
    managed_overlay:
      Number(counts.policy_count) === overlay.policy_count &&
      Number(counts.trigger_count) === overlay.trigger_count,
    managed_policy_count: Number(counts.policy_count),
    managed_trigger_count: Number(counts.trigger_count),
    schedules_quiesced: Number(counts.schedule_count) === 0,
    security_surface: mismatch.length === 0,
    security_surface_hash: actual.hashes.aggregate_sha256,
    ...(mismatch.length ? { security_surface_mismatch: mismatch } : {}),
  };
}
