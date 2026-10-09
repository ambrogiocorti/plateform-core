import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Shared authoritative plan for the real installer and embedded regression tests.
 * The bootstrap repairs documented historical drift; it is application SQL,
 * never an implicit test fixture or a rewrite of applied migration statements.
 */
export async function cleanInstallPlan(root = process.cwd()) {
  const bootstrapManifest = JSON.parse(
    await readFile(resolve(root, 'supabase/clean-install/manifest.json'), 'utf8'),
  );
  if (
    bootstrapManifest.version !== 1 ||
    bootstrapManifest.bootstrap_file !== 'supabase/clean-install/bootstrap.sql' ||
    !Array.isArray(bootstrapManifest.tables) ||
    bootstrapManifest.tables.length !== 7 ||
    new Set(bootstrapManifest.tables).size !== 7
  )
    throw new Error('INVALID_CLEAN_INSTALL_BOOTSTRAP_MANIFEST');
  const bootstrap = await readFile(resolve(root, bootstrapManifest.bootstrap_file), 'utf8');
  if (sha256(bootstrap) !== bootstrapManifest.bootstrap_sha256)
    throw new Error('CLEAN_INSTALL_BOOTSTRAP_DIGEST_MISMATCH');
  if (bootstrapManifest.postlude_file !== 'supabase/clean-install/postlude.sql')
    throw new Error('INVALID_CLEAN_INSTALL_POSTLUDE_MANIFEST');
  const postlude = await readFile(resolve(root, bootstrapManifest.postlude_file), 'utf8');
  if (sha256(postlude) !== bootstrapManifest.postlude_sha256)
    throw new Error('CLEAN_INSTALL_POSTLUDE_DIGEST_MISMATCH');
  if (
    bootstrapManifest.release_test_catalog_file !==
    'supabase/clean-install/release-test-catalog.json'
  )
    throw new Error('INVALID_CLEAN_INSTALL_RELEASE_CATALOG_REFERENCE');
  const releaseTestCatalog = JSON.parse(
    await readFile(resolve(root, bootstrapManifest.release_test_catalog_file), 'utf8'),
  );
  if (
    !Array.isArray(releaseTestCatalog) ||
    releaseTestCatalog.length !== bootstrapManifest.release_test_catalog_count ||
    new Set(releaseTestCatalog.map((row) => row.key)).size !== releaseTestCatalog.length ||
    releaseTestCatalog.some(
      (row) =>
        typeof row.key !== 'string' ||
        typeof row.category !== 'string' ||
        typeof row.required !== 'boolean' ||
        typeof row.description !== 'string',
    ) ||
    sha256(JSON.stringify(releaseTestCatalog)) !== bootstrapManifest.release_test_catalog_sha256
  )
    throw new Error('CLEAN_INSTALL_RELEASE_CATALOG_DIGEST_MISMATCH');
  const manifest = JSON.parse(
    await readFile(resolve(root, 'supabase/migration-manifest.json'), 'utf8'),
  );
  const files = (await readdir(resolve(root, 'supabase/migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const rows = manifest.migrations;
  if (
    !Array.isArray(rows) ||
    files.length !== rows.length ||
    new Set(rows.map((row) => row.version)).size !== rows.length ||
    files.some((name, i) => name !== rows[i]?.filename || !/^\d{14}_[a-z0-9_]+\.sql$/.test(name))
  )
    throw new Error('CLEAN_INSTALL_MIGRATION_INVENTORY_MISMATCH');
  const migrations = [];
  for (const row of rows) {
    if (row.filename !== `${row.version}_${row.name}.sql`)
      throw new Error('CLEAN_INSTALL_MIGRATION_NAME_MISMATCH');
    const sql = (
      await readFile(resolve(root, 'supabase/migrations', row.filename), 'utf8')
    ).replace(/\r\n/g, '\n');
    if (sha256(sql) !== row.sha256)
      throw new Error(`CLEAN_INSTALL_APPLIED_MIGRATION_CHANGED:${row.filename}`);
    migrations.push({ ...row, sql });
  }
  const historical = migrations.slice(0, bootstrapManifest.historical_count);
  const fingerprint = sha256(
    historical.map((row) => `${row.version}:${row.name}:${row.sha256}`).join('\n'),
  );
  if (
    historical.length !== bootstrapManifest.historical_count ||
    fingerprint !== bootstrapManifest.historical_inventory_sha256
  )
    throw new Error('CLEAN_INSTALL_HISTORICAL_INVENTORY_CHANGED');
  const inventorySha256 = sha256(
    migrations.map((row) => `${row.version}:${row.name}:${row.sha256}`).join('\n'),
  );
  return {
    bootstrap,
    postlude,
    bootstrapManifest,
    releaseTestCatalog,
    migrations,
    inventorySha256,
  };
}
