import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import { commercialScopeForEdition } from '../shared/commercial-edition.ts';

const edition = loadEnv('production', process.cwd(), 'VITE_').VITE_PLATEFORM_EDITION || 'CORE';
assert.ok(edition === 'CORE' || edition === 'FULL', 'Unknown commercial build edition');
for (const area of ['public', 'staff']) {
  const actual = JSON.parse(await readFile(`dist/${area}/edition.json`, 'utf8'));
  assert.deepEqual(actual, commercialScopeForEdition(edition), `${area} build edition mismatch`);
}
console.log(`BUILD_EDITION_PROFILE=PASS (${edition}; public and staff)`);
