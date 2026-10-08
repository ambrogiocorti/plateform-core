import { readFile } from 'node:fs/promises';

const references = await readFile(
  new URL('../supabase/migrations/20261006045641_step12_restore_reference_indexes.sql', import.meta.url),
  'utf8',
);
const actors = await readFile(
  new URL('../supabase/migrations/20261006050249_step12_restore_actor_indexes.sql', import.meta.url),
  'utf8',
);

const checks = [
  [references.includes('create index restore_jobs_backup_id_idx'), 'backup_id index'],
  [references.includes('on public.restore_jobs(backup_id)'), 'backup_id target'],
  [references.includes('create index restore_jobs_pre_restore_backup_id_idx'), 'pre_restore_backup_id index'],
  [references.includes('on public.restore_jobs(pre_restore_backup_id)'), 'pre_restore target'],
  [references.includes('where pre_restore_backup_id is not null'), 'pre_restore partial predicate'],
  [actors.includes('create index restore_jobs_requested_by_idx'), 'requested_by index'],
  [actors.includes('on public.restore_jobs(requested_by)'), 'requested_by target'],
  [actors.includes('create index restore_jobs_cutover_confirmed_by_idx'), 'cutover_confirmed_by index'],
  [actors.includes('where cutover_confirmed_by is not null'), 'cutover partial predicate'],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`STEP12_RESTORE_REFERENCE_INDEX_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log(`STEP12_RESTORE_REFERENCE_INDEX_GATE=PASSED_${checks.length}_OF_${checks.length}`);
