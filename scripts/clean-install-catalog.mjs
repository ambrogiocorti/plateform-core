export const applicationCatalogQueries = {
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

// PostgreSQL versions/search_path may deparse optional schema qualifications
// differently. Never normalize object identities, data types or role names.
const canonical = (row) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
          key,
          ['definition', 'default_expression', 'qual', 'with_check'].includes(key) &&
          typeof value === 'string'
            ? value.replace(/\b(?:extensions|public)\./g, '')
            : value,
        ]),
    ),
  );

export function compareCleanInstallCatalog({ plan, reference, actual, substrate }) {
  const excluded = new Set(
    plan.bootstrapManifest.excluded_development_diagnostics.map((row) => row.signature),
  );
  const report = {
    substrate,
    application_fixtures: [],
    hosted_supabase_certified: false,
    missing: {},
    added: {},
    changed: {},
    counts: {},
    not_null_semantics: 'Compared for every column; PG18-only contype=n catalog entries excluded',
  };
  const normalizeSignature = (identity) =>
    identity.replace(
      /\(.*\)/,
      identity.slice(identity.indexOf('(')).replace(/\b\w+ (?=(?:uuid|integer|text)\b)/g, ''),
    );
  for (const [kind, referenceRows] of Object.entries(reference)) {
    const observed = new Map((actual[kind] || []).map((row) => [row.identity, row]));
    const expected = new Map(referenceRows.map((row) => [row.identity, row]));
    report.counts[kind] = { reference: expected.size, replayed: observed.size };
    report.missing[kind] = [...expected.keys()].filter(
      (key) =>
        !observed.has(key) && !(kind === 'routines' && excluded.has(normalizeSignature(key))),
    );
    const allowedAdded = new Set(plan.bootstrapManifest.forward_catalog_objects[kind] || []);
    report.added[kind] = [...observed.keys()].filter(
      (key) => !expected.has(key) && !allowedAdded.has(key),
    );
    report.changed[kind] = [...expected.keys()].filter(
      (key) => observed.has(key) && canonical(observed.get(key)) !== canonical(expected.get(key)),
    );
  }
  report.ok = !['missing', 'added', 'changed'].some((type) =>
    Object.values(report[type]).some((rows) => rows.length),
  );
  return report;
}
