import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runbook = readFileSync(resolve(root, 'RUNBOOK.md'), 'utf8');
const backup = readFileSync(resolve(root, 'BACKUP_RESTORE.md'), 'utf8');

const checks = [
  ['runbook section', /## Riconciliazione operativa post-restore/],
  ['provider reconciliation', /Pagamenti e rimborsi provider[\s\S]{0,1200}idempotency key/],
  ['no provider duplicate', /non deve essere ripetuto[\s\S]{0,300}record locale/],
  [
    'sessions remain invalidated',
    /Sessioni, codici e autorizzazioni[\s\S]{0,1000}non copiare dal sorgente snapshot di sicurezza temporanei/,
  ],
  [
    'print uncertain fail safe',
    /Print job con esito incerto[\s\S]{0,900}Non trasformare automaticamente un job incerto in una nuova stampa/,
  ],
  [
    'offline event id reconciliation',
    /Device e queue offline[\s\S]{0,1400}get_offline_sync_statuses/,
  ],
  ['offline terminal states', /preservando `SYNCED`, `REJECTED` e `CONFLICT`/],
  ['cutover remains gated', /Gate di cutover[\s\S]{0,900}`CUTOVER_REQUIRED`/],
  [
    'abort rollback if ambiguous',
    /usare abort\/rollback invece di dichiarare il restore `SUCCEEDED`/,
  ],
  [
    'external effects invariant',
    /un restore del database non autorizza mai la ripetizione automatica di un effetto esterno/,
  ],
  [
    'backup doc marks runbook implemented',
    /Implementato nel runbook:[\s\S]{0,500}provider, sessioni\/codici, print job e device offline/,
  ],
];

const failures = [];
for (const [name, pattern] of checks) {
  const haystack = name.startsWith('backup doc') ? backup : runbook;
  if (!pattern.test(haystack)) failures.push(name);
}
if (failures.length) {
  console.error(JSON.stringify({ status: 'FAILED', failures }, null, 2));
  process.exit(1);
}
console.log(`STEP12_RUNBOOK_RECONCILIATION_GATE=PASSED_${checks.length}_OF_${checks.length}`);
