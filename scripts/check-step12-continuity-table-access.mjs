import { readFile } from 'node:fs/promises';

const auth = await readFile(
  new URL('../supabase/migrations/20261003165459_authorization.sql', import.meta.url),
  'utf8',
);

const technicalLoop =
  auth.match(/foreach t in array array\['audit_log'[\s\S]*?end loop;/)?.[0] ?? '';
const checks = [
  [technicalLoop.includes("'backup_metadata'"), 'backup_metadata technical table'],
  [technicalLoop.includes("'restore_jobs'"), 'restore_jobs technical table'],
  [technicalLoop.includes('grant select on public.%I to authenticated'), 'select-only grant'],
  [technicalLoop.includes('create policy technical_read'), 'technical_read policy'],
  [technicalLoop.includes("private.current_role()=''SUPER_ADMIN''"), 'SUPER_ADMIN predicate'],
  [!technicalLoop.includes('grant insert'), 'no insert grant'],
  [!technicalLoop.includes('grant update'), 'no update grant'],
  [!technicalLoop.includes('grant delete'), 'no delete grant'],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`STEP12_CONTINUITY_TABLE_ACCESS_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log(`STEP12_CONTINUITY_TABLE_ACCESS_GATE=PASSED_${checks.length}_OF_${checks.length}`);
