import { describe, expect, it } from 'vitest';
import {
  excludedCoreSections,
  requiredCoreIntegrationChecks,
  requiredIntegrationChecks,
  releaseProblems,
  roadmapProblems,
} from '../../scripts/check-release.mjs';
const digest = 'a'.repeat(64);
const matrix = {
  sections: Array.from({ length: 151 }, (_, section) => ({ section, status: 'verified' })),
};
function evidence() {
  return {
    source_digest: digest,
    version: '1.0.0',
    local_checks: Object.fromEntries(
      ['typecheck', 'lint', 'edge', 'unit_database', 'browser', 'build'].map((name) => [
        name,
        'passed',
      ]),
    ),
    integration_checks: Object.fromEntries(
      requiredIntegrationChecks.map((name: string) => [
        name,
        { status: 'passed', evidence: ['report:test-evidence'] },
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
  };
}
describe('commercial release gate', () => {
  it('permits only explicitly excluded provider/driver sections for CORE', () => {
    const reduced = structuredClone(matrix);
    for (const section of excludedCoreSections) reduced.sections[section]!.status = 'out_of_scope_core';
    const record = evidence();
    Object.assign(record, { edition: 'CORE' });
    Object.assign(record.local_checks, {
      core_edition_contract: 'passed', core_server_policy_source: 'passed', core_release_profile: 'passed',
    });
    record.integration_checks = Object.fromEntries(
      requiredCoreIntegrationChecks.map((name) => [
        name,
        { status: 'passed', evidence: ['report:verified-core-scope'] },
      ]),
    );
    expect(releaseProblems(reduced, record, digest)).toEqual([]);
    delete record.local_checks.core_server_policy_source;
    expect(releaseProblems(reduced, record, digest)).toContain(
      'Verifica locale mancante: core_server_policy_source.',
    );
    record.local_checks.core_server_policy_source = 'passed';
    delete record.integration_checks.server_denies_stripe_satispay_and_epson;
    expect(releaseProblems(reduced, record, digest)).toContain(
      'Collaudo reale mancante: server_denies_stripe_satispay_and_epson.',
    );
    reduced.sections[91]!.status = 'out_of_scope_core';
    expect(releaseProblems(reduced, record, digest)).toContain(
      'Le 151 sezioni del master devono risultare verificate con evidenze.',
    );
  });
  it('requires all roadmap steps, including unresolved integration checks', () => {
    const steps = Array.from({ length: 14 }, (_, step) => ({
      step,
      status: 'DONE',
      open: [] as string[],
      evidence: ['report:verified-step'],
      checks: { integration: 'PASSED' },
    }));
    expect(roadmapProblems({ steps })).toEqual([]);
    steps[0]!.checks.integration = 'BLOCKED';
    steps[0]!.open.push('Runtime configuration not verified');
    expect(roadmapProblems({ steps })).toContain(
      'Step 0 non completato e verificato integralmente.',
    );
  });
  it('rejects missing or duplicated roadmap steps', () => {
    expect(roadmapProblems({ steps: [] }).length).toBeGreaterThan(0);
    expect(
      roadmapProblems({ steps: Array.from({ length: 14 }, () => ({ step: 0 })) }).length,
    ).toBeGreaterThan(0);
  });
  it('blocks packaging when a single requirement is still pending', () => {
    const incomplete = structuredClone(matrix);
    incomplete.sections[71]!.status = 'partial';
    expect(releaseProblems(incomplete, evidence(), digest)).toContain(
      'Le 151 sezioni del master devono risultare verificate con evidenze.',
    );
  });
  it('blocks packaging after source changes despite previously passing reviews', () => {
    expect(releaseProblems(matrix, evidence(), 'b'.repeat(64)).length).toBeGreaterThan(0);
  });
  it('requires actual provider and restore evidence independently of local test results', () => {
    const record = evidence();
    delete record.integration_checks.stripe_satispay_sandbox;
    delete record.integration_checks.backup_restore_database_auth_storage;
    expect(releaseProblems(matrix, record, digest)).toContain(
      'Collaudo reale mancante: stripe_satispay_sandbox.',
    );
    expect(releaseProblems(matrix, record, digest)).toContain(
      'Collaudo reale mancante: backup_restore_database_auth_storage.',
    );
  });
  it('blocks packaging until all three complete reviews have no unresolved findings', () => {
    const record = evidence();
    record.clean_reviews[2]!.unresolved_findings = 1;
    expect(releaseProblems(matrix, record, digest).length).toBeGreaterThan(0);
  });
});
