import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const manifest = await readFile('SHA256SUMS.txt', 'utf8');
const names = new Set();
for (const line of manifest.trim().split('\n')) {
  const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_./-]+)$/.exec(line);
  assert.ok(match, 'INVALID_HANDOFF_CHECKSUM');
  const [, expected, file] = match;
  assert.ok(!file.startsWith('/') && !file.split('/').includes('..'), 'INVALID_HANDOFF_PATH');
  assert.ok(!names.has(file), 'DUPLICATE_HANDOFF_FILE');
  names.add(file);
  const actual = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  assert.equal(actual, expected, `Original handoff changed: ${file}`);
}
assert.ok(names.size > 0, 'EMPTY_HANDOFF_MANIFEST');
console.log(`ORIGINAL_HANDOFF_INTEGRITY=PASS (${names.size} files)`);
