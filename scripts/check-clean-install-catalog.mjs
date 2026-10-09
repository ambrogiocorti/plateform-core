import { readFile } from 'node:fs/promises';
import { database } from '../tests/database/harness.ts';
import { cleanInstallPlan } from './clean-install-plan.mjs';
import { extendedCatalogQuery } from './clean-install-extended-catalog-query.mjs';
import { applicationCatalogQueries, compareCleanInstallCatalog } from './clean-install-catalog.mjs';

// Read-only catalog comparison; native transport/platform services run in the
// separate isolated Supabase Docker CI job using the same plan and comparator.
const reference = {
  ...JSON.parse(
    await readFile('docs/evidence/clean-install-application-catalog-2026-10-09.json', 'utf8'),
  ),
  ...JSON.parse(
    await readFile('docs/evidence/clean-install-extended-catalog-2026-10-09.json', 'utf8'),
  ),
};
const plan = await cleanInstallPlan();
const db = await database();
try {
  const actual = {};
  for (const [kind, query] of Object.entries(applicationCatalogQueries)) {
    actual[kind] = (await db.query(query)).rows;
  }
  Object.assign(actual, (await db.query(extendedCatalogQuery)).rows[0].catalog);
  const report = compareCleanInstallCatalog({
    plan,
    reference,
    actual,
    substrate: 'PGlite PostgreSQL WASM',
  });
  console.log(JSON.stringify(report));
  if (!report.ok) throw new Error('CLEAN_INSTALL_APPLICATION_CATALOG_DRIFT');
} finally {
  await db.close();
}
