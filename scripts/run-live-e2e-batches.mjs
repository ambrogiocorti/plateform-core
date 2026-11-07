// Run each small set of real GoTrue/PostgREST/PostgreSQL/Edge/Storage browser
// scenarios in a fresh Playwright process to bound the memory footprint.
// Each spec retains its own reset() fixture; none are silently excluded.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specDir = join(root, 'tests/e2e-live');
const specs = readdirSync(specDir)
  .filter((name) => name.endsWith('.spec.ts'))
  .sort()
  .map((name) => `tests/e2e-live/${name}`);
if (!specs.length) throw new Error('LIVE_E2E_NO_SPECS');
const batchSize = 4;
// Playwright cleans its outputDir at each process start. Keep design evidence
// outside that directory before the next batch begins.
const reviewDir = join(root, '.local/design-review');
mkdirSync(reviewDir, { recursive: true });
let totalFiles = 0;
const failedBatches = [];
for (let i = 0; i < specs.length; i += batchSize) {
  const batch = specs.slice(i, i + batchSize);
  console.log(
    `LIVE_E2E_BATCH=${Math.floor(i / batchSize) + 1}/${Math.ceil(specs.length / batchSize)} (${batch.join(', ')})`,
  );
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      '-c',
      'playwright.live.config.ts',
      ...batch,
      '--reporter=list',
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );
  if (result.error) throw new Error(`LIVE_E2E_BATCH_LAUNCH_FAILED:${result.error.message}`);
  const resultsDir = join(root, 'test-results');
  if (existsSync(resultsDir)) {
    for (const file of readdirSync(resultsDir, { withFileTypes: true })) {
      if (file.isFile() && /^plateform-v5-[\w-]+\.png$/.test(file.name))
        copyFileSync(join(resultsDir, file.name), join(reviewDir, file.name));
    }
  }
  if (result.status !== 0)
    failedBatches.push(`${Math.floor(i / batchSize) + 1}:${result.signal ?? result.status}`);
  totalFiles += batch.length;
}
if (failedBatches.length) throw new Error(`LIVE_E2E_FAILED_BATCHES:${failedBatches.join(',')}`);
console.log(
  `LIVE_E2E_ALL_BATCHES_PASS (files=${totalFiles}, batches=${Math.ceil(specs.length / batchSize)})`,
);
console.log(`LIVE_E2E_DESIGN_SCREENSHOTS=${readdirSync(reviewDir).length}`);
