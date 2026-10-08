import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/pages/technical.ts', import.meta.url), 'utf8');
const checks = [
  ['schema-expired', source.includes('expired_unpurged_count: z.number().int()')],
  ['schema-purge-progress', source.includes('purge_in_progress_count: z.number().int()')],
  ['schema-purge-failed', source.includes('purge_failed_count: z.number().int()')],
  ['schema-last-purged', source.includes('last_artifacts_purged_at: z.string().nullable()')],
  ['schema-purge-error', source.includes('latest_purge_error_code: z.string().nullable()')],
  ['expired-visible', source.includes('Backup scaduti con artefatti ancora presenti')],
  ['purge-errors-visible', source.includes('Errori retention aperti')],
  ['purged-backup-not-restorable', source.includes('!row.artifacts_purged_at')],
  ['cutover-not-double-counted', !source.includes('restore_pending_count + cutoverPendingCount')],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`STATIC:${failed.join(',')}`);
console.log('STEP12_RETENTION_UI_CONTRACT=PASSED');
