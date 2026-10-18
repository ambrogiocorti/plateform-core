import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const validVersion = /^\d{14}$/;
const validSha = /^[a-f0-9]{64}$/;
const validName = /^[a-z0-9_]+$/;

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
    versions.add(row.version);
    return { version: row.version, name: row.name, sha256: row.sha256 };
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
 * cliHistorySha256 maps a version to the history digest the Supabase CLI
 * records for it (statements split, trailing semicolons dropped), so a
 * version pushed or repaired by the CLI is not mistaken for divergence.
 */
export function classifyMigrationPromotion(
  appliedRows,
  candidateRows,
  compatRows = [],
  cliHistorySha256 = {},
) {
  const applied = inventory(appliedRows, 'APPLIED');
  const candidate = inventory(candidateRows, 'CANDIDATE');
  const byVersion = new Map(candidate.map((row) => [row.version, row]));
  const conflicts = applied
    .filter((row) => {
      const target = byVersion.get(row.version);
      return (
        !target ||
        target.name !== row.name ||
        (target.sha256 !== row.sha256 && cliHistorySha256[row.version] !== row.sha256)
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
  const manifest = JSON.parse(
    await readFile(resolve('supabase/migration-manifest.json'), 'utf8'),
  ).migrations;
  const compatRows = JSON.parse(
    await readFile(resolve('supabase/migration-bootstrap-compat.json'), 'utf8'),
  ).migrations;
  const cliHistory = JSON.parse(
    await readFile(resolve('supabase/migration-cli-history-hashes.json'), 'utf8'),
  ).history_sha256;
  if (process.argv[2] === '--self-test') {
    assert.equal(manifest.length, 483, 'expected candidate migration count');
    const prospective = new Set(['20261006100100', '20261012075300']);
    // Forward-dated candidate migrations, not yet applied anywhere.
    const forward = new Set(['20261018103000']);
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
    // History written by `supabase migration repair` / `db push` (CLI digests).
    const cliRecorded = classifyMigrationPromotion(
      [
        ...remoteFixture,
        ...[...prospective, ...forward].map((version) => ({
          ...manifest.find((row) => row.version === version),
          sha256: cliHistory[version],
        })),
      ],
      manifest,
      compatRows,
      cliHistory,
    );
    assert.equal(cliRecorded.status, 'READY_FOR_DISPOSABLE_STAGING_ONLY');
    assert.equal(cliRecorded.pending_count, 0);
    assert.equal(
      classifyMigrationPromotion(
        [
          ...remoteFixture,
          { ...manifest.find((row) => row.version === '20261018103000'), sha256: '4'.repeat(64) },
        ],
        manifest,
        compatRows,
        cliHistory,
      ).status,
      'BLOCKED_APPLIED_HISTORY_DIVERGENCE',
    );
    // Fresh installation: empty history replays everything in order.
    const fresh = classifyMigrationPromotion([], manifest, compatRows);
    assert.equal(fresh.status, 'READY_FOR_DISPOSABLE_STAGING_ONLY');
    assert.equal(fresh.pending_count, manifest.length);
    assert.equal(
      classifyMigrationPromotion(
        remoteFixture.map((row, i) => (i === 0 ? { ...row, sha256: '0'.repeat(64) } : row)),
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
  const result = classifyMigrationPromotion(applied, manifest, compatRows, cliHistory);
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
