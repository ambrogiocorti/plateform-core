import { readFile } from 'node:fs/promises';

const technical = await readFile(new URL('../src/pages/technical.ts', import.meta.url), 'utf8');
const restore = await readFile(
  new URL('../tools/restore-worker/start.mjs', import.meta.url),
  'utf8',
);

const compact = (value) => value.replace(/\s+/g, '');
const contains = (value, marker) => compact(value).includes(compact(marker));

const requiredTechnical = [
  "row.status === 'CUTOVER_REQUIRED'",
  "'confirm_restore_cutover'",
  "'abort_restore_cutover'",
  "stepUp('RESTORE', restoreId.data)",
  'p_target_reference: targetReference',
  "'Cutover replacement verificato in attesa'",
];
const requiredRestore = ["status:'CUTOVER_REQUIRED'", 'requiresCutover:true'];

for (const marker of requiredTechnical) {
  if (!contains(technical, marker)) throw new Error(`CUTOVER_UI_MARKER_MISSING:${marker}`);
}
for (const marker of requiredRestore) {
  if (!contains(restore, marker)) throw new Error(`CUTOVER_WORKER_MARKER_MISSING:${marker}`);
}

console.log('STEP12_RESTORE_CUTOVER_STATIC_GATE=PASSED');
