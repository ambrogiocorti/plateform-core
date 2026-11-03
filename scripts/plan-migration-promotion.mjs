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
 */
export function classifyMigrationPromotion(appliedRows, candidateRows) {
  const applied = inventory(appliedRows, 'APPLIED');
  const candidate = inventory(candidateRows, 'CANDIDATE');
  const byVersion = new Map(candidate.map((row) => [row.version, row]));
  const conflicts = applied
    .filter((row) => {
      const target = byVersion.get(row.version);
      return !target || target.name !== row.name || target.sha256 !== row.sha256;
    })
    .map((row) => row.version);
  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = candidate
    .filter((row) => !appliedVersions.has(row.version))
    .sort((a, b) => a.version.localeCompare(b.version));
  const latestApplied = applied.reduce((max, row) => (row.version > max ? row.version : max), '');
  const backfilled = pending.filter((row) => row.version <= latestApplied);
  const status = conflicts.length
    ? 'BLOCKED_APPLIED_HISTORY_DIVERGENCE'
    : backfilled.length
      ? 'BLOCKED_BACKDATED_MIGRATIONS'
      : 'READY_FOR_DISPOSABLE_STAGING_ONLY';
  return {
    status,
    applied_count: applied.length,
    candidate_count: candidate.length,
    latest_applied_version: latestApplied || null,
    pending_count: pending.length,
    pending_versions: pending.map((row) => row.version),
    backdated_versions: backfilled.map((row) => row.version),
    divergent_applied_versions: conflicts,
    deploy_authorized: false,
    live_database_modified: false,
  };
}

async function run() {
  const manifest = JSON.parse(
    await readFile(resolve('supabase/migration-manifest.json'), 'utf8'),
  ).migrations;
  if (process.argv[2] === '--self-test') {
    // Fixed histories exercise the classifier independently of future source
    // migrations. Never print a synthetic fixture as the current remote state.
    const row = (version, name) => ({ version, name, sha256: 'a'.repeat(64) });
    const prospective = new Set(['20261006100100', '20261012075300']);
    const remoteFixture = [
      row('20261003165439', 'foundation'),
      row('20261021090000', 'licensed_deposits'),
    ];
    const candidateFixture = [
      remoteFixture[0],
      row('20261006100100', 'historical_repair_one'),
      row('20261012075300', 'historical_repair_two'),
      remoteFixture[1],
      row('20261027183000', 'forward_waitlist'),
      row('20261103161146', 'forward_printing'),
    ];
    const baseline = classifyMigrationPromotion(remoteFixture, candidateFixture);
    assert.equal(baseline.status, 'BLOCKED_BACKDATED_MIGRATIONS');
    assert.deepEqual(baseline.backdated_versions, [...prospective]);
    assert.equal(baseline.deploy_authorized, false);
    assert.equal(
      classifyMigrationPromotion(
        remoteFixture.map((row, i) => (i === 0 ? { ...row, sha256: '0'.repeat(64) } : row)),
        candidateFixture,
      ).status,
      'BLOCKED_APPLIED_HISTORY_DIVERGENCE',
    );
    assert.equal(
      classifyMigrationPromotion(
        [...remoteFixture, { version: '20261013120000', name: 'unknown', sha256: '1'.repeat(64) }],
        candidateFixture,
      ).status,
      'BLOCKED_APPLIED_HISTORY_DIVERGENCE',
    );
    assert.equal(
      classifyMigrationPromotion(remoteFixture, [
        ...candidateFixture.filter((row) => !prospective.has(row.version)),
        {
          version: '20261104100000',
          name: 'future',
          sha256: '2'.repeat(64),
        },
      ]).status,
      'READY_FOR_DISPOSABLE_STAGING_ONLY',
    );
    assert.throws(
      () =>
        classifyMigrationPromotion(
          [{ ...remoteFixture[0] }, { ...remoteFixture[0] }],
          candidateFixture,
        ),
      /APPLIED_INVALID_OR_DUPLICATE/,
    );
    console.log('MIGRATION_PROMOTION_FAIL_CLOSED_SELF_TEST=PASSED');
    console.log('SYNTHETIC_PROMOTION_CLASSIFICATION=' + JSON.stringify(baseline));
    return;
  }
  if (process.argv[2] !== '--applied-json' || !process.argv[3]) {
    throw new Error('READ_ONLY_APPLIED_INVENTORY_REQUIRED: --applied-json <path>');
  }
  const data = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
  const applied = Array.isArray(data) ? data : data.migrations;
  const result = classifyMigrationPromotion(applied, manifest);
  console.log(JSON.stringify(result, null, 2));
  // The script never runs DDL and never issues an approval for production.
  if (result.status !== 'READY_FOR_DISPOSABLE_STAGING_ONLY') process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await run();
}
