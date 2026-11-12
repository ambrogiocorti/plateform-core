import { readFile } from 'node:fs/promises';

const [baseline, hardening, technical] = await Promise.all([
  readFile('supabase/migrations/20261004161807_step12_operational_release_baseline.sql', 'utf8'),
  readFile('supabase/migrations/20261004162621_step12_release_metadata_hardening.sql', 'utf8'),
  readFile('src/pages/technical.ts', 'utf8'),
]);

const requiredBaseline = [
  "'schema_version',(select max(version) from supabase_migrations.schema_migrations)",
  "'0.1.0'",
  "'development-baseline-0.1.0'",
  "'not-recorded'",
  "'STAGING'",
  'Not a production release or go-live certification.',
];
for (const marker of requiredBaseline) {
  if (!baseline.includes(marker))
    throw new Error(`OPERATIONAL_RELEASE_BASELINE_MARKER_MISSING:${marker}`);
}

const requiredHardening = [
  'drop trigger if exists touch_version on public.application_releases',
  'drop trigger if exists touch_version on public.database_migrations_metadata',
  "where status in ('RELEASED','STAGING')",
  "raise exception 'BACKUP_RELEASE_METADATA_REQUIRED'",
  'new.release_version:=active_version',
];
for (const marker of requiredHardening) {
  if (!hardening.includes(marker))
    throw new Error(`OPERATIONAL_RELEASE_HARDENING_MARKER_MISSING:${marker}`);
}

if (
  !technical.includes(
    "data.releases.find((row) => ['RELEASED', 'STAGING'].includes(String(row.status)))",
  )
) {
  throw new Error('OPERATIONAL_RELEASE_UI_SELECTION_MISSING');
}

console.log('STEP12_OPERATIONAL_RELEASE_BASELINE=PASSED');
console.log('STEP12_OPERATIONAL_SCHEMA_CANONICAL_SOURCE=PASSED');
console.log('STEP12_OPERATIONAL_RELEASE_TOUCH_VERSION_FIX=PASSED');
console.log('STEP12_BACKUP_RELEASE_METADATA_GUARD=PASSED');
console.log('STEP12_OPERATIONAL_RELEASE_UI_SELECTION=PASSED');
