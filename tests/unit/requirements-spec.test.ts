import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { masterSections, specificationProblems } from '../../scripts/requirements-spec.mjs';
import { releaseProblems, requiredCoreIntegrationChecks } from '../../scripts/check-release.mjs';

describe('updated commercial specification', () => {
  it('covers every source section including all advanced requirements', async () => {
    const master = await readFile('MASTER_PROMPT_PLATEFORM_COMMERCIALE.md', 'utf8');
    const matrix = JSON.parse(await readFile('docs/REQUIREMENTS.json', 'utf8'));
    expect(masterSections(master).map((row: { section: number }) => row.section)).toEqual(
      Array.from({ length: 158 }, (_, i) => i),
    );
    expect(specificationProblems(matrix, master)).toEqual([]);
    expect(
      matrix.sections.slice(151).every((row: { status: string }) => row.status === 'pending'),
    ).toBe(true);
  });

  it('refuses a stale or truncated requirements matrix', async () => {
    const master = await readFile('MASTER_PROMPT_PLATEFORM_COMMERCIALE.md', 'utf8');
    const matrix = JSON.parse(await readFile('docs/REQUIREMENTS.json', 'utf8'));
    matrix.sections.pop();
    expect(specificationProblems(matrix, master).length).toBeGreaterThan(0);
    expect(() => masterSections(master.split('# 157.')[0]!)).toThrow(
      'MASTER_SECTION_INVENTORY_MISMATCH',
    );
  });

  it('keeps every new pending section as a commercial blocker', () => {
    const digest = 'a'.repeat(64);
    const matrix = {
      sections: Array.from({ length: 158 }, (_, section) => ({ section, status: 'verified' })),
    };
    const record = {
      edition: 'CORE',
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
          'core_edition_contract',
          'core_server_policy_source',
          'core_edge_guard_source',
          'core_release_profile',
        ].map((key) => [key, 'passed']),
      ),
      integration_checks: Object.fromEntries(
        requiredCoreIntegrationChecks.map((key) => [
          key,
          { status: 'passed', evidence: ['fixture-only-test'] },
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
    expect(releaseProblems(matrix, record, digest)).toEqual([]);
    for (let section = 151; section <= 157; section++) {
      const pending = structuredClone(matrix);
      pending.sections[section]!.status = 'pending';
      expect(releaseProblems(pending, record, digest)).toContain(
        'Le 158 sezioni del master devono risultare verificate con evidenze.',
      );
    }
  });
});
