import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

function gate(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

const staticGate = gate('scripts/check-step12-static.mjs');
if (!staticGate.ok) {
  console.error(JSON.stringify({ status: 'BLOCKED', stage: 'STEP12_STATIC', detail: staticGate.stderr.slice(-1200) }, null, 2));
  process.exit(2);
}
const rehearsalGate = gate('scripts/check-step12-real-rehearsal.mjs');
if (!rehearsalGate.ok) {
  console.error(JSON.stringify({ status: 'BLOCKED', stage: 'STEP12_REAL_REHEARSAL', detail: rehearsalGate.stderr.slice(-2400) }, null, 2));
  process.exit(3);
}

const roadmapPath = 'docs/ROADMAP_STATUS.json';
const requirementsPath = 'docs/REQUIREMENTS.json';
const checkpointPath = 'STATO_CHECKPOINT.txt';
const roadmap = JSON.parse(await readFile(roadmapPath, 'utf8'));
const requirements = JSON.parse(await readFile(requirementsPath, 'utf8'));
const checkpoint = await readFile(checkpointPath, 'utf8');

const step12 = roadmap.steps.find((entry) => entry.step === 12);
if (!step12) throw new Error('STEP12_ROADMAP_ENTRY_MISSING');
step12.status = 'COMPLETE';
step12.checks.real_rehearsal_certification_gate = 'PASSED_CURRENT_BASELINE';
step12.checks.real_verified_backup = 'PASSED';
step12.checks.real_restore_test = 'PASSED';
step12.open = [];
roadmap.updated_at = new Date().toISOString();

for (const sectionNumber of [115, 116]) {
  const section = requirements.sections.find((entry) => entry.section === sectionNumber);
  if (!section) throw new Error(`REQUIREMENT_SECTION_MISSING:${sectionNumber}`);
  section.status = 'verified';
  const note = 'Step 12 certificato tramite scripts/check-step12-real-rehearsal.mjs sulla migration baseline corrente.';
  if (!section.verification_notes.includes(note)) section.verification_notes.push(note);
}

const nextCheckpoint = checkpoint.replace(
  /Step 12 Backup\/Restore\/Continuità: IN_PROGRESS\.[^\n]*/,
  'Step 12 Backup/Restore/Continuità: COMPLETE. Static regression e rehearsal reale sulla baseline corrente superati.',
);

await writeFile(roadmapPath, `${JSON.stringify(roadmap, null, 2)}\n`);
await writeFile(requirementsPath, `${JSON.stringify(requirements, null, 2)}\n`);
await writeFile(checkpointPath, nextCheckpoint);
console.log('STEP12_FINALIZATION=COMPLETE');
