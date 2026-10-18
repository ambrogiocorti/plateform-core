import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const validVersion = /^\d{14}$/;
const validSha = /^[a-f0-9]{64}$/;
const validName = /^[a-z0-9_]+$/;

// The Supabase CLI records a migration as separate statements without their
// trailing semicolons, so array_to_string(statements, E'\n') never equals the
// file bytes (0/485 on CLI 2.120.0). Removing every semicolon and ASCII
// whitespace on both sides makes the two comparable (485/485). SQL equivalent:
// translate(array_to_string(statements, ''), ';'||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||' ', '')
const ignored = /[;\t\n\v\f\r ]/g;
export function normalizedSha256(sql) {
  return createHash('sha256').update(String(sql).replace(ignored, ''), 'utf8').digest('hex');
}

function inventory(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`${label}_ARRAY_REQUIRED`);
  const versions = new Set();
  return rows.map((row) => {
    if (
      !row ||
      !validVersion.test(String(row.version ?? '')) ||
      !validName.test(String(row.name ?? '')) ||
      !validSha.test(String(row.sha256 ?? '')) ||
      versions.has(row.version)
    ) {
      throw new Error(`${label}_INVALID_OR_DUPLICATE`);
    }
    if (row.normalized_sha256 !== undefined && !validSha.test(String(row.normalized_sha256)))
      throw new Error(`${label}_INVALID_OR_DUPLICATE`);
    versions.add(row.version);
    return {
      version: row.version,
      name: row.name,
      sha256: row.sha256,
      normalized_sha256: row.normalized_sha256,
    };
  });
}

/**
 * This classifier is intentionally read-only. READY_FOR_STAGING_REPLAY
 * is NOT a permission to push to a linked or production database.
 *
 * compatRows lists replay-only bootstrap migrations (migration-bootstrap-compat.json).
 * A backdated version is accepted only if it is listed there with the same
 * name and SHA-256 and the version it must precede is already applied; it is
 * then recorded with `migration repair`, never executed out of order.
 *
 * An applied row matches its file by exact SHA-256 (history written as one
 * statement, as on Development) or by normalized_sha256 (history written by
 * the Supabase CLI), when both sides carry it.
 */
export function classifyMigrationPromotion(appliedRows, candidateRows, compatRows = []) {
  const applied = inventory(appliedRows, 'APPLIED');
  const candidate = inventory(candidateRows, 'CANDIDATE');
  const byVersion = new Map(candidate.map((row) => [row.version, row]));
  const conflicts = applied
    .filter((row) => {
      const target = byVersion.get(row.version);
      return (
        !target ||
        target.name !== row.name ||
        (target.sha256 !== row.sha256 &&
          !(row.normalized_sha256 && target.normalized_sha256 === row.normalized_sha256))
      );
    })
    .map((row) => row.version);
  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = candidate
    .filter((row) => !appliedVersions.has(row.version))
    .sort((a, b) => a.version.localeCompare(b.version));
  const latestApplied = applied.reduce((max, row) => (row.version > max ? row.version : max), '');
  const backfilled = pending.filter((row) => row.version <= latestApplied);
  const compat = new Map(
    inventory(
      compatRows.map(({ version, name, sha256 }) => ({ version, name, sha256 })),
      'COMPAT',
    ).map((row, i) => [row.version, { ...row, required_before: compatRows[i].required_before }]),
  );
  const repairable = backfilled.filter((row) => {
    const entry = compat.get(row.version);
    return (
      entry &&
      entry.name === row.name &&
      entry.sha256 === row.sha256 &&
      validVersion.test(String(entry.required_before ?? '')) &&
      row.version < entry.required_before &&
      appliedVersions.has(entry.required_before)
    );
  });
  const status = conflicts.length
    ? 'BLOCKED_APPLIED_HISTORY_DIVERGENCE'
    : repairable.length < backfilled.length
      ? 'BLOCKED_BACKDATED_MIGRATIONS'
      : repairable.length
        ? 'READY_FOR_DISPOSABLE_STAGING_AFTER_COMPAT_REPAIR'
        : 'READY_FOR_DISPOSABLE_STAGING_ONLY';
  return {
    status,
    applied_count: applied.length,
    candidate_count: candidate.length,
    latest_applied_version: latestApplied || null,
    pending_count: pending.length,
    pending_versions: pending.map((row) => row.version),
    backdated_versions: backfilled.map((row) => row.version),
    compat_repair_versions: repairable.map((row) => row.version),
    divergent_applied_versions: conflicts,
    deploy_authorized: false,
    live_database_modified: false,
  };
}

async function run() {
  const manifest = await Promise.all(
    JSON.parse(await readFile(resolve('supabase/migration-manifest.json'), 'utf8')).migrations.map(
      async (row) => ({
        ...row,
        normalized_sha256: normalizedSha256(
          await readFile(resolve('supabase/migrations', row.filename), 'utf8'),
        ),
      }),
    ),
  );
  const compatRows = JSON.parse(
    await readFile(resolve('supabase/migration-bootstrap-compat.json'), 'utf8'),
  ).migrations;
  if (process.argv[2] === '--self-test') {
    const prospective = new Set(['20261006100100', '20261012075300']);
    // Forward-dated candidate migrations: everything after the last version
    // applied on Development, so new migrations need no edit here.
    const lastDevelopmentVersion = '20261012075338';
    const forward = new Set(
      manifest.map((row) => row.version).filter((version) => version > lastDevelopmentVersion),
    );
    assert.ok(forward.has('20261018103000'), 'expected candidate migration');
    const remoteFixture = manifest.filter(
      (row) => !prospective.has(row.version) && !forward.has(row.version),
    );
    assert.equal(remoteFixture.length, 480);
    assert.deepEqual(compatRows.map((row) => row.version).sort(), [...prospective]);
    // Without the hash-pinned compatibility list a backdated file stays blocked.
    const strict = classifyMigrationPromotion(remoteFixture, manifest);
    assert.equal(strict.status, 'BLOCKED_BACKDATED_MIGRATIONS');
    assert.deepEqual(strict.backdated_versions, [...prospective]);
    assert.deepEqual(strict.compat_repair_versions, []);
    const baseline = classifyMigrationPromotion(remoteFixture, manifest, compatRows);
    assert.equal(baseline.status, 'READY_FOR_DISPOSABLE_STAGING_AFTER_COMPAT_REPAIR');
    assert.deepEqual(baseline.backdated_versions, [...prospective]);
    assert.deepEqual(baseline.compat_repair_versions, [...prospective]);
    assert.deepEqual(baseline.pending_versions, [...prospective, ...forward]);
    assert.equal(baseline.deploy_authorized, false);
    // A compatibility entry whose bytes changed is not trusted.
    assert.equal(
      classifyMigrationPromotion(
        remoteFixture,
        manifest,
        compatRows.map((row, i) => (i === 0 ? { ...row, sha256: '3'.repeat(64) } : row)),
      ).status,
      'BLOCKED_BACKDATED_MIGRATIONS',
    );
    // Nor one whose compensated migration is absent from the applied history.
    assert.equal(
      classifyMigrationPromotion(
        remoteFixture.filter((row) => row.version !== compatRows[0].required_before),
        manifest,
        compatRows,
      ).status,
      'BLOCKED_BACKDATED_MIGRATIONS',
    );
    // Once both are recorded (migration repair), only the forward migration remains.
    const repaired = classifyMigrationPromotion(
      manifest.filter((row) => !forward.has(row.version)),
      manifest,
      compatRows,
    );
    assert.equal(repaired.status, 'READY_FOR_DISPOSABLE_STAGING_ONLY');
    assert.deepEqual(repaired.pending_versions, [...forward]);
    // History written by `supabase migration repair` / `db push`: the raw digest
    // differs from the file (statements split, no semicolons), the normalized one
    // matches. A real statement change still diverges.
    const cliRow = (version, normalized) => ({
      ...manifest.find((row) => row.version === version),
      sha256: '5'.repeat(64),
      normalized_sha256:
        normalized ?? manifest.find((row) => row.version === version).normalized_sha256,
    });
    const cliRecorded = classifyMigrationPromotion(
      [...remoteFixture, ...[...prospective, ...forward].map((version) => cliRow(version))],
      manifest,
      compatRows,
    );
    assert.equal(cliRecorded.status, 'READY_FOR_DISPOSABLE_STAGING_ONLY');
    assert.equal(cliRecorded.pending_count, 0);
    assert.equal(
      classifyMigrationPromotion(
        [...remoteFixture, cliRow('20261018103000', '4'.repeat(64))],
        manifest,
        compatRows,
      ).status,
      'BLOCKED_APPLIED_HISTORY_DIVERGENCE',
    );
    assert.equal(
      normalizedSha256('BEGIN;\nSELECT 1;\nCOMMIT;\n'),
      normalizedSha256(['BEGIN', 'SELECT 1', 'COMMIT'].join('\n')),
    );
    assert.notEqual(normalizedSha256('SELECT 1'), normalizedSha256('SELECT 2'));
    // Fresh installation: empty history replays everything in order.
    const fresh = classifyMigrationPromotion([], manifest, compatRows);
    assert.equal(fresh.status, 'READY_FOR_DISPOSABLE_STAGING_ONLY');
    assert.equal(fresh.pending_count, manifest.length);
    assert.equal(
      classifyMigrationPromotion(
        remoteFixture.map((row, i) =>
          i === 0 ? { ...row, sha256: '0'.repeat(64), normalized_sha256: '0'.repeat(64) } : row,
        ),
        manifest,
      ).status,
      'BLOCKED_APPLIED_HISTORY_DIVERGENCE',
    );
    assert.equal(
      classifyMigrationPromotion(
        [...remoteFixture, { version: '20261013120000', name: 'unknown', sha256: '1'.repeat(64) }],
        manifest,
      ).status,
      'BLOCKED_APPLIED_HISTORY_DIVERGENCE',
    );
    assert.equal(
      classifyMigrationPromotion(remoteFixture, [
        ...manifest.filter((row) => !prospective.has(row.version)),
        {
          version: '20261013180000',
          name: 'future',
          sha256: '2'.repeat(64),
        },
      ]).status,
      'READY_FOR_DISPOSABLE_STAGING_ONLY',
    );
    assert.throws(
      () =>
        classifyMigrationPromotion([{ ...remoteFixture[0] }, { ...remoteFixture[0] }], manifest),
      /APPLIED_INVALID_OR_DUPLICATE/,
    );
    console.log('MIGRATION_PROMOTION_FAIL_CLOSED_SELF_TEST=PASSED');
    console.log('CURRENT_SOURCE_PROMOTION_CLASSIFICATION=' + JSON.stringify(baseline));
    return;
  }
  if (process.argv[2] !== '--applied-json' || !process.argv[3]) {
    throw new Error('READ_ONLY_APPLIED_INVENTORY_REQUIRED: --applied-json <path>');
  }
  const data = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
  const applied = Array.isArray(data) ? data : data.migrations;
  const result = classifyMigrationPromotion(applied, manifest, compatRows);
  console.log(JSON.stringify(result, null, 2));
  // The script never runs DDL and never issues an approval for production.
  // Exit 3: run supabase/tests/bootstrap-compat-preflight.sql, then record
  // compat_repair_versions with `supabase migration repair --status applied`.
  if (result.status === 'READY_FOR_DISPOSABLE_STAGING_AFTER_COMPAT_REPAIR') process.exitCode = 3;
  else if (result.status !== 'READY_FOR_DISPOSABLE_STAGING_ONLY') process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await run();
}
