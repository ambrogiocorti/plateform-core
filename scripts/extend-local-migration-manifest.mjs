#!/usr/bin/env node
/**
 * Repairs the LOCAL versioned migration manifest after an intentional SQL addition.
 * Historical recorded digests must match the local files exactly: no rehashing
 * edited applied migrations, no database access, no claim of remote reconciliation.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';

const manifestFile = 'supabase/migration-manifest.json';
const dir = 'supabase/migrations';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const current = JSON.parse(await readFile(manifestFile, 'utf8'));
if (!Array.isArray(current.migrations)) throw new Error('INVALID_EXISTING_MANIFEST');
const local = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
const old = new Map(current.migrations.map((item) => [item.filename, item]));
if (old.size !== current.migrations.length) throw new Error('DUPLICATE_MANIFEST_FILE');
const entries = [];
let additions = 0;
for (const filename of local) {
  const parsed = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename);
  if (!parsed) throw new Error('INVALID_MIGRATION_NAME:' + filename);
  const bytes = await readFile(dir + '/' + filename);
  const raw = sha(bytes);
  const canonical = sha(bytes.toString('utf8').replace(/\r\n/g, '\n'));
  const existing = old.get(filename);
  if (existing) {
    if (
      existing.version !== parsed[1] ||
      existing.name !== parsed[2] ||
      ![raw, canonical].includes(existing.sha256)
    )
      throw new Error('EXISTING_MIGRATION_CHANGED:' + filename);
    entries.push(existing);
  } else {
    additions++;
    entries.push({ filename, version: parsed[1], name: parsed[2], sha256: raw });
  }
}
for (const name of old.keys()) {
  if (!local.includes(name)) throw new Error('HISTORIC_MIGRATION_MISSING:' + name);
}
if (new Set(entries.map((entry) => entry.version)).size !== entries.length)
  throw new Error('DUPLICATE_MIGRATION_VERSION');
if (additions === 0) {
  console.log('Local migration manifest already up to date: ' + entries.length);
} else {
  await writeFile(
    manifestFile,
    JSON.stringify({ ...current, migrations: entries }, null, 2) + '\n',
  );
  console.log(
    'Local migration manifest extended to ' +
      entries.length +
      ' files; new entries=' +
      additions +
      '. Remote reconciliation NOT certified.',
  );
}
