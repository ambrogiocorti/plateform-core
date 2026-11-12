// Content fingerprint of every application table (one row per table, partitions
// folded into their parent) plus the append-only audit trail. Used to prove that
// what comes back after the disaster is byte-for-byte what was backed up.
import {
  EPHEMERAL_AUTH_TABLES,
  EPHEMERAL_PRIVATE_TABLES,
} from '../backup-worker/private-state.mjs';
import { securitySurfaceState } from '../backup-worker/managed-surface.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const EPHEMERAL = new Set([
  ...EPHEMERAL_PRIVATE_TABLES.map((t) => `private.${t}`),
  ...EPHEMERAL_AUTH_TABLES.map((t) => `auth.${t}`),
]);

export async function tableFingerprint(cluster, database) {
  const tables = (
    await cluster.psql(
      database,
      `select n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname in ('public','private','auth','storage','supabase_migrations')
         and c.relkind in ('r','p') and not c.relispartition order by 1`,
    )
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  const durable = tables.filter((t) => !EPHEMERAL.has(t));
  const select = durable
    .map((t) => {
      const [s, r] = t.split('.');
      return `select '${t}' t,(select count(*) from "${s}"."${r}") n,encode(extensions.digest(coalesce((select string_agg(to_jsonb(x)::text,E'\\n' order by to_jsonb(x)::text) from "${s}"."${r}" x),''),'sha256'),'hex') h`;
    })
    .join('\nunion all\n');
  const rows = (
    await cluster.psql(
      database,
      `select json_agg(json_build_object('table',t,'rows',n,'sha256',h) order by t) from (${select}) q`,
    )
  ).stdout.trim();
  const list = JSON.parse(rows);
  return Object.fromEntries(list.map((r) => [r.table, { rows: Number(r.rows), sha256: r.sha256 }]));
}

export async function auditState(cluster, database) {
  const out = (
    await cluster.psql(
      database,
      `select json_build_object(
        'events',(select count(*) from public.audit_log),
        'sha256',encode(extensions.digest(coalesce((select string_agg(to_jsonb(a)::text,E'\\n' order by a.timestamp,a.id) from public.audit_log a),''),'sha256'),'hex'),
        'partitions',(select count(*) from pg_partition_tree('public.audit_log') where isleaf),
        'violations',(select cardinality(private.audit_append_only_violations(true))),
        'event_triggers',(select count(*) from pg_event_trigger where evtname like 'plateform_audit_%' and evtenabled<>'D'),
        'pause_trigger',(select count(*) from pg_trigger where tgname='plateform_dev_pause_audit'),
        'actions',(select json_object_agg(action,n) from (select action,count(*) n from public.audit_log group by action) x)
      )`,
    )
  ).stdout.trim();
  return JSON.parse(out);
}

// Proves the restored audit trail still refuses mutation on every partition.
export async function auditImmutabilityProbe(cluster, database) {
  const leaves = (
    await cluster.psql(
      database,
      `select relid::regclass from pg_partition_tree('public.audit_log') where isleaf order by 1`,
    )
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  const attempts = [
    `update public.audit_log set action='TAMPERED'`,
    `delete from public.audit_log`,
  ];
  for (const leaf of leaves) attempts.push(`truncate ${leaf}`);
  const rejected = [];
  for (const statement of attempts) {
    const result = await cluster.psql(database, `begin; ${statement}; rollback;`, {
      allowFailure: true,
    });
    rejected.push({
      statement,
      rejected: result.code !== 0 && /IMMUTABLE_RECORD/.test(result.stderr),
    });
  }
  return {
    attempts: rejected.length,
    rejected: rejected.filter((r) => r.rejected).length,
    details: rejected,
  };
}

// Security surface (grants, default privileges, RLS, policies, triggers, event
// triggers, publications) as the backup worker records it, plus pg_cron jobs.
export async function securitySurface(cluster, database) {
  const { text } = await securitySurfaceState(join(cluster.bin, 'psql'), cluster.url(database));
  const cron = (
    await cluster.psql(
      database,
      `select coalesce(string_agg(jobname||'|'||schedule,E'\\n' order by 1),'') from cron.job`,
    )
  ).stdout.trim();
  const out = {};
  for (const [key, value] of Object.entries({ ...text, cron_jobs: cron }))
    out[key] = {
      lines: value ? value.split('\n').length : 0,
      sha256: createHash('sha256').update(value).digest('hex'),
      text: value,
    };
  return out;
}

export function surfaceDiff(a, b) {
  const out = {};
  for (const key of Object.keys(a)) {
    const x = a[key],
      y = b[key];
    if (x.sha256 === y.sha256) continue;
    const left = new Set(String(x.text ?? '').split('\n'));
    const right = new Set(String(y.text ?? '').split('\n'));
    out[key] = {
      missing_after_restore: [...left].filter((l) => l && !right.has(l)).slice(0, 25),
      added_after_restore: [...right].filter((l) => l && !left.has(l)).slice(0, 25),
    };
  }
  return out;
}
