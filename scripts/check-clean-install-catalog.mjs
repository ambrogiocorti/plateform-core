import { readFile } from 'node:fs/promises';
import { database } from '../tests/database/harness.ts';
import { cleanInstallPlan } from './clean-install-plan.mjs';
import { extendedCatalogQuery } from './clean-install-extended-catalog-query.mjs';

// Read-only catalog comparison. SQL transport, hosted extensions and native
// concurrent connections require an isolated Supabase rehearsal separately.
const reference = JSON.parse(
  await readFile('docs/evidence/clean-install-application-catalog-2026-10-09.json', 'utf8'),
);
const plan = await cleanInstallPlan();
const excluded = new Set(
  plan.bootstrapManifest.excluded_development_diagnostics.map((row) => row.signature),
);
const extendedReference = JSON.parse(
  await readFile('docs/evidence/clean-install-extended-catalog-2026-10-09.json', 'utf8'),
);
const queries = {
  relations: `select n.nspname||'.'||c.relname as identity,c.relkind,c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','v','m','S')
      and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass
        and d.objid=c.oid and d.deptype='e') order by identity`,
  routines: `select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'
      as identity,p.prosecdef as security_definer from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')
      and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass
        and d.objid=p.oid and d.deptype='e') order by identity`,
  triggers: `select n.nspname||'.'||c.relname||'.'||t.tgname as identity,
      pg_get_triggerdef(t.oid) as definition from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and not t.tgisinternal order by identity`,
};
const db = await database();
const report = {
  substrate: 'PGlite PostgreSQL WASM',
  application_fixtures: [],
  hosted_supabase_certified: false,
  missing: {},
  added: {},
  changed: {},
  counts: {},
  not_null_semantics: 'Compared for every column; PG18-only contype=n catalog entries excluded',
};
// Deparsing search_path differs between native PG17 and PGlite. Normalize only
// optional public/extension qualification in SQL expressions, never identities.
const canonical = (row) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        ['definition', 'default_expression', 'qual', 'with_check'].includes(key) &&
        typeof value === 'string'
          ? value.replace(/\b(?:extensions|public)\./g, '')
          : value,
      ]),
    ),
  );
const compare = (kind, rows, referenceRows) => {
  const actual = new Map(rows.map((row) => [row.identity, row]));
  const expected = new Map(referenceRows.map((row) => [row.identity, row]));
  report.counts[kind] = { reference: expected.size, replayed: actual.size };
  const normalizeSignature = (identity) =>
    identity.replace(
      /\(.*\)/,
      identity.slice(identity.indexOf('(')).replace(/\b\w+ (?=(?:uuid|integer|text)\b)/g, ''),
    );
  report.missing[kind] = [...expected.keys()].filter(
    (key) => !actual.has(key) && !(kind === 'routines' && excluded.has(normalizeSignature(key))),
  );
  const allowedAdded = new Set(plan.bootstrapManifest.forward_catalog_objects[kind] || []);
  report.added[kind] = [...actual.keys()].filter(
    (key) => !expected.has(key) && !allowedAdded.has(key),
  );
  report.changed[kind] = [...expected.keys()].filter(
    (key) => actual.has(key) && canonical(actual.get(key)) !== canonical(expected.get(key)),
  );
};
try {
  for (const [kind, query] of Object.entries(queries)) {
    compare(kind, (await db.query(query)).rows, reference[kind]);
  }
  const extended = (await db.query(extendedCatalogQuery)).rows[0].catalog;
  for (const [kind, rows] of Object.entries(extended)) compare(kind, rows, extendedReference[kind]);
  console.log(JSON.stringify(report));
  if (
    ['missing', 'added', 'changed'].some((type) =>
      Object.values(report[type]).some((rows) => rows.length),
    )
  )
    throw new Error('CLEAN_INSTALL_APPLICATION_CATALOG_DRIFT');
} finally {
  await db.close();
}
