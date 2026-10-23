import assert from 'node:assert/strict';
import {
  releaseProblems,
  requiredCoreIntegrationChecks,
  requiredIntegrationChecks,
  excludedCoreSections,
} from './check-release.mjs';

const digest = 'a'.repeat(64);
const allVerified = {
  sections: Array.from({ length: 151 }, (_, section) => ({ section, status: 'verified' })),
};
const evidence = (edition = 'CORE') => ({
  edition,
  source_digest: digest,
  version: '1.0.0',
  local_checks: Object.fromEntries(
    [
      'typecheck',
      'lint',
      'edge',
      'unit_database',
      'browser',
      'build',
      ...(edition === 'CORE'
        ? [
            'core_edition_contract',
            'core_server_policy_source',
            'core_edge_guard_source',
            'core_release_profile',
          ]
        : []),
    ].map((key) => [key, 'passed']),
  ),
  integration_checks: Object.fromEntries(
    (edition === 'CORE' ? requiredCoreIntegrationChecks : requiredIntegrationChecks).map((key) => [
      key,
      {
        status: 'passed',
        evidence: ['qa:verified-session'],
      },
    ]),
  ),
  clean_reviews: ['2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'].map(
    (completed_at) => ({
      source_digest: digest,
      scope: 'full_master',
      unresolved_findings: 0,
      completed_at,
    }),
  ),
});
let count = 0;
const check = (cb) => {
  cb();
  count++;
};
const core = structuredClone(allVerified);
for (const section of excludedCoreSections) core.sections[section].status = 'out_of_scope_core';
check(() => assert.deepEqual(excludedCoreSections, [90]));
// Deposits are licence-gated since 2026-10-21: the old "always denied" gate must not come back,
// and both the licence/provider denial and the sandbox flow are required evidence.
check(() =>
  assert.ok(!requiredCoreIntegrationChecks.includes('server_denies_online_booking_deposits')),
);
for (const gate of [
  'server_gates_booking_deposits_by_licence_and_provider',
  'large_group_deposit_sandbox_e2e',
  'core_booking_without_deposit_sql_live',
  'server_denies_unlicensed_providers_and_epson',
])
  check(() => assert.ok(requiredCoreIntegrationChecks.includes(gate), gate));
check(() => assert.equal(releaseProblems(core, evidence(), digest).length, 0));
check(() => assert.ok(releaseProblems(core, evidence('FULL'), digest).length > 0));
const altered = structuredClone(core);
altered.sections[91].status = 'out_of_scope_core';
check(() =>
  assert.ok(releaseProblems(altered, evidence(), digest).some((x) => x.includes('151 sezioni'))),
);
for (const required of requiredCoreIntegrationChecks) {
  const record = evidence();
  delete record.integration_checks[required];
  check(() => assert.ok(releaseProblems(core, record, digest).some((x) => x.includes(required))));
}
const forged = evidence();
forged.edition = 'UNKNOWN';
check(() =>
  assert.ok(releaseProblems(core, forged, digest).some((x) => x.includes('sconosciuta'))),
);
const stale = evidence();
stale.local_checks.browser = 'not-run';
check(() => assert.ok(releaseProblems(core, stale, digest).some((x) => x.includes('browser'))));
const missingCore = evidence();
delete missingCore.local_checks.core_edition_contract;
check(() =>
  assert.ok(
    releaseProblems(core, missingCore, digest).some((x) => x.includes('core_edition_contract')),
  ),
);
const missingPolicy = evidence();
delete missingPolicy.local_checks.core_server_policy_source;
check(() =>
  assert.ok(
    releaseProblems(core, missingPolicy, digest).some((x) =>
      x.includes('core_server_policy_source'),
    ),
  ),
);
const missingEdgeGuard = evidence();
delete missingEdgeGuard.local_checks.core_edge_guard_source;
check(() =>
  assert.ok(
    releaseProblems(core, missingEdgeGuard, digest).some((x) =>
      x.includes('core_edge_guard_source'),
    ),
  ),
);
const reviews = evidence();
reviews.clean_reviews[2].unresolved_findings = 1;
check(() => assert.ok(releaseProblems(core, reviews, digest).some((x) => x.includes('revisioni'))));
console.log(
  `CORE_RELEASE_GATE_CONTRACT=PASS (${count}/${count} assertions; no release evidence issued)`,
);
