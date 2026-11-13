// Prints which security-surface lines differ between the production source and a
// restore-test target. Read-only on both sides; output is catalog metadata
// (object names, ACLs, policy/trigger definitions), never row data or secrets.
import {
  SECURITY_SURFACE_KEYS,
  securitySurfaceState,
} from '../tools/backup-worker/managed-surface.mjs';

const psql = process.env.PSQL_BIN?.trim() || 'psql';
const source = process.env.SOURCE_DB_URL?.trim();
const target = process.env.TARGET_DB_URL?.trim();
if (!source || !target) throw new Error('SOURCE_DB_URL and TARGET_DB_URL are required');

const [a, b] = await Promise.all([
  securitySurfaceState(psql, source),
  securitySurfaceState(psql, target),
]);
let differing = 0;
for (const key of SECURITY_SURFACE_KEYS) {
  if (a.hashes[key] === b.hashes[key]) {
    console.log(`= ${key}`);
    continue;
  }
  differing += 1;
  const left = new Set(String(a.text[key]).split('\n'));
  const right = new Set(String(b.text[key]).split('\n'));
  const onlySource = [...left].filter((line) => !right.has(line));
  const onlyTarget = [...right].filter((line) => !left.has(line));
  console.log(`! ${key}: ${onlySource.length} only in source, ${onlyTarget.length} only in target`);
  for (const line of onlySource.slice(0, 40)) console.log(`  - ${line}`);
  for (const line of onlyTarget.slice(0, 40)) console.log(`  + ${line}`);
}
console.log(JSON.stringify({ status: differing ? 'DIFFERENT' : 'IDENTICAL', differing }));
