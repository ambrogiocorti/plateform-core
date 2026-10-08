import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8'));
const files = (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();
const rows = manifest.migrations;
if (
  !Array.isArray(rows) ||
  files.length !== rows.length ||
  new Set(rows.map((row) => row.version)).size !== rows.length ||
  files.some((name, i) => name !== rows[i]?.filename || !/^\d{14}_[a-z0-9_]+\.sql$/.test(name))
)
  throw new Error('Migration inventory mismatch: reconcile version history before deployment.');
for (const row of rows) {
  if (row.filename !== `${row.version}_${row.name}.sql`)
    throw new Error(`Migration version mismatch: ${row.filename}`);
  const hash = createHash('sha256')
    .update(await readFile(`supabase/migrations/${row.filename}`))
    .digest('hex');
  if (hash !== row.sha256)
    throw new Error(`Applied migration changed: ${row.filename}. Add a new migration instead.`);
}
console.log(`${rows.length} versioned migrations verified against the applied manifest.`);
