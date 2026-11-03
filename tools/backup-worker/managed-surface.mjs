import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// `supabase db dump` excludes the managed schemas (auth, storage, cron, ...).
// Objects that Plateform migrations add ON managed tables are therefore lost by a
// logical restore: the storage.objects RLS policies and the storage.buckets
// privacy guard trigger, plus every pg_cron schedule. The backup captures them as
// a separate "managed overlay"; restore re-applies policies/triggers and keeps
// schedules aside until cutover (restored automation stays quiesced).
//
// The security surface fingerprint lets restore prove that grants, default
// privileges, RLS, policies, triggers, event triggers and publications match the
// source exactly. ACLs are compared semantically (NULL == acldefault).

const q = (sql) => sql.replace(/\s+/g, ' ').trim();

export const MANAGED_OVERLAY_SQL = q(`
set search_path = '';
select json_build_object(
  'policies',(select coalesce(json_agg(json_build_object('name',p.polname,'table',c.oid::regclass::text,'ddl',
      format('drop policy if exists %I on %s; create policy %I on %s as %s for %s to %s%s%s;',
        p.polname,c.oid::regclass,p.polname,c.oid::regclass,
        case when p.polpermissive then 'permissive' else 'restrictive' end,
        case p.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end,
        coalesce((select string_agg(case when r=0 then 'public' else quote_ident(r::regrole::text) end,',') from unnest(p.polroles) r),'public'),
        case when p.polqual is null then '' else ' using ('||pg_get_expr(p.polqual,p.polrelid)||')' end,
        case when p.polwithcheck is null then '' else ' with check ('||pg_get_expr(p.polwithcheck,p.polrelid)||')' end))
      order by c.oid::regclass::text,p.polname),'[]')
    from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('auth','storage')),
  'triggers',(select coalesce(json_agg(json_build_object('name',t.tgname,'table',c.oid::regclass::text,'ddl',
      format('drop trigger if exists %I on %s; %s;%s',t.tgname,c.oid::regclass,pg_get_triggerdef(t.oid),
        case t.tgenabled when 'D' then format(' alter table %s disable trigger %I;',c.oid::regclass,t.tgname)
          when 'A' then format(' alter table %s enable always trigger %I;',c.oid::regclass,t.tgname)
          when 'R' then format(' alter table %s enable replica trigger %I;',c.oid::regclass,t.tgname) else '' end))
      order by c.oid::regclass::text,t.tgname),'[]')
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname in ('auth','storage')),
  'schedules',(select coalesce(json_agg(json_build_object('name',jobname,'schedule',schedule,'active',active,
      'ddl',format('select cron.schedule(%L,%L,%L);',jobname,schedule,command)) order by jobname),'[]')
    from cron.job where jobname like 'plateform-%')
);`);

// Each line is sorted by its own text so the hash is independent of catalog order.
const agg = (expression, from) =>
  `(select coalesce(string_agg(line,E'\\n' order by line),'') from (select ${expression} as line ${from}) s)`;

export const SECURITY_SURFACE_SQL = q(`
set search_path = '';
select json_build_object(
  'relation_acl',${agg(
    `c.oid::regclass::text||'='||coalesce(c.relacl,acldefault((case when c.relkind='S' then 's' else 'r' end)::"char",c.relowner))::text`,
    `from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','S','f')`,
  )},
  'function_acl',${agg(
    `p.oid::regprocedure::text||'='||coalesce(p.proacl,acldefault('f'::"char",p.proowner))::text||'|'||p.prosecdef::text`,
    `from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')`,
  )},
  'schema_acl',${agg(
    `nspname::text||'='||coalesce(nspacl,acldefault('n'::"char",nspowner))::text`,
    `from pg_namespace where nspname in ('public','private')`,
  )},
  'default_acl',${agg(
    `defaclrole::regrole::text||'|'||defaclnamespace::regnamespace::text||'|'||defaclobjtype::text||'|'||defaclacl::text`,
    `from pg_default_acl`,
  )},
  'rls',${agg(
    `c.oid::regclass::text||'='||c.relrowsecurity::text||'/'||c.relforcerowsecurity::text`,
    `from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage') and c.relkind in ('r','p')`,
  )},
  'policies',${agg(
    `schemaname::text||'.'||tablename::text||'.'||policyname::text||'|'||permissive||'|'||roles::text||'|'||cmd||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'')`,
    `from pg_catalog.pg_policies`,
  )},
  'triggers',${agg(
    `tgrelid::regclass::text||'.'||tgname::text||'|'||tgenabled::text||'|'||pg_get_triggerdef(oid)`,
    `from pg_trigger where not tgisinternal`,
  )},
  'event_triggers',${agg(
    `evtname::text||'|'||evtenabled::text||'|'||evtevent::text||'|'||evtfoid::regproc::text`,
    `from pg_event_trigger`,
  )},
  'publications',${agg(
    `pubname::text||'|'||schemaname::text||'.'||tablename::text`,
    `from pg_catalog.pg_publication_tables`,
  )}
);`);

export const SECURITY_SURFACE_KEYS = [
  'relation_acl',
  'function_acl',
  'schema_acl',
  'default_acl',
  'rls',
  'policies',
  'triggers',
  'event_triggers',
  'publications',
];

function query(psql, databaseUrl, sql, code) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [
        '-X',
        '-A',
        '-t',
        '-q',
        '--set',
        'ON_ERROR_STOP=1',
        '--dbname',
        databaseUrl,
        '--command',
        sql,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', reject);
    child.once('exit', (exit) => {
      if (exit !== 0)
        return reject(
          new Error(
            `${code}:${exit}:${stderr.replaceAll(databaseUrl, '[REDACTED]').slice(0, 400)}`,
          ),
        );
      resolve(stdout.trim());
    });
  });
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export async function securitySurfaceState(psql, databaseUrl) {
  const raw = JSON.parse(
    await query(psql, databaseUrl, SECURITY_SURFACE_SQL, 'SECURITY_SURFACE_QUERY_FAILED'),
  );
  const out = {};
  for (const key of SECURITY_SURFACE_KEYS) {
    if (typeof raw[key] !== 'string') throw new Error('SECURITY_SURFACE_STATE_INVALID');
    out[key] = sha256(raw[key]);
  }
  out.aggregate_sha256 = sha256(SECURITY_SURFACE_KEYS.map((k) => `${k}|${out[k]}`).join('\n'));
  return { hashes: out, text: raw };
}

export async function captureManagedOverlay(psql, databaseUrl, overlayPath, schedulesPath) {
  const raw = JSON.parse(
    await query(psql, databaseUrl, MANAGED_OVERLAY_SQL, 'MANAGED_OVERLAY_QUERY_FAILED'),
  );
  if (![raw.policies, raw.triggers, raw.schedules].every(Array.isArray))
    throw new Error('MANAGED_OVERLAY_STATE_INVALID');
  const overlay = [
    '-- Plateform managed-schema overlay: policies and triggers on auth/storage tables.',
    ...raw.policies.map((row) => row.ddl),
    ...raw.triggers.map((row) => row.ddl),
    '',
  ].join('\n');
  const schedules = [
    '-- Plateform pg_cron schedules. Apply ONLY at cutover of the restored installation.',
    ...raw.schedules.map((row) => row.ddl),
    '',
  ].join('\n');
  await writeFile(overlayPath, overlay, { mode: 0o600 });
  await writeFile(schedulesPath, schedules, { mode: 0o600 });
  return {
    policy_count: raw.policies.length,
    trigger_count: raw.triggers.length,
    schedule_count: raw.schedules.length,
    schedules: raw.schedules.map(({ name, schedule, active }) => ({ name, schedule, active })),
  };
}

export async function applyManagedOverlay(psql, databaseUrl, overlayPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [
        '-X',
        '-q',
        '--single-transaction',
        '--set',
        'ON_ERROR_STOP=1',
        '--dbname',
        databaseUrl,
        '--file',
        overlayPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', reject);
    child.once('exit', (exit) =>
      exit === 0
        ? resolve()
        : reject(
            new Error(
              `RESTORE_MANAGED_OVERLAY_FAILED:${exit}:${stderr.replaceAll(databaseUrl, '[REDACTED]').slice(0, 400)}`,
            ),
          ),
    );
  });
}

export async function managedOverlayCounts(psql, databaseUrl) {
  return JSON.parse(
    await query(
      psql,
      databaseUrl,
      `select json_build_object(
        'policy_count',(select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage')),
        'trigger_count',(select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('auth','storage')),
        'schedule_count',(select count(*) from cron.job where jobname like 'plateform-%'))`,
      'MANAGED_OVERLAY_QUERY_FAILED',
    ),
  );
}
