import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL(
    '../supabase/migrations/20261006051256_step12_backup_requester_index.sql',
    import.meta.url,
  ),
  'utf8',
);
const checks = [
  [migration.includes('create index backup_metadata_requested_by_idx'), 'requested_by index'],
  [migration.includes('on public.backup_metadata(requested_by)'), 'requested_by target'],
  [migration.includes('where requested_by is not null'), 'requested_by partial predicate'],
];
const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`STEP12_BACKUP_REQUESTER_INDEX_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log(`STEP12_BACKUP_REQUESTER_INDEX_GATE=PASSED_${checks.length}_OF_${checks.length}`);
