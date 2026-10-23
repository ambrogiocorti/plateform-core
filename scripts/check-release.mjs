import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const requiredIntegrationChecks = [
  'supabase_auth_rls_realtime_storage',
  'concurrent_booking_stock_payments',
  'stripe_satispay_sandbox',
  'printing_physical_and_unknown_outcomes',
  'pwa_offline_revocation_and_conflicts',
  'backup_restore_database_auth_storage',
  'accessibility_mobile_and_load',
];
/** The CORE edition still requires real end-to-end cash/POS/PDF testing and
 * *negative* server-side tests proving the absent integrations cannot run.
 * It is not sufficient to hide the Epson controls in the UI. Stripe and Satispay
 * are in the first release (owner decision, 2026-10-19): they need the sandbox
 * test and proof that the server refuses them without the installation licence.
 * The large-group booking deposit is in the release too (owner decision, 2026-10-21):
 * staging must prove it is refused without the BOOKING_DEPOSITS licence or a licensed
 * provider offered by the venue, and that a licensed sandbox deposit confirms, refunds
 * on an honoured booking and is retained on a no-show.
 */
export const requiredCoreIntegrationChecks = [
  'supabase_auth_rls_realtime_storage',
  'concurrent_booking_stock_payments',
  'cash_pos_manual_payment_and_refund_e2e',
  'stripe_satispay_sandbox',
  'server_denies_unlicensed_providers_and_epson',
  'core_edge_functions_http_jwt_denial',
  'server_gates_booking_deposits_by_licence_and_provider',
  'large_group_deposit_sandbox_e2e',
  'core_booking_without_deposit_sql_live',
  'browser_pdf_output_verified',
  'pwa_offline_revocation_and_conflicts',
  'backup_restore_database_auth_storage',
  'accessibility_mobile_and_load',
];
export const excludedCoreSections = [90];
export const requiredDocuments = [
  'README.md',
  'ARCHITECTURE.md',
  'DATABASE.md',
  'SECURITY.md',
  'PRIVACY.md',
  'AUDIT.md',
  'OBSERVABILITY.md',
  'OFFLINE.md',
  'DEPLOYMENT.md',
  'OPERATIONS.md',
  'RUNBOOK.md',
  'BACKUP_RESTORE.md',
  'INCIDENT_RESPONSE.md',
  'TESTING.md',
  'CHANGELOG.md',
];

export async function sourceDigest(root = process.cwd()) {
  const entries = [];
  const roots = [
    'src',
    'apps',
    'shared',
    'tools',
    'styles',
    'assets',
    'supabase',
    'scripts',
    '.github',
    'tests',
    'docs',
    ...requiredDocuments,
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'eslint.config.js',
    'playwright.config.ts',
    'vitest.config.ts',
    'vite.public.config.ts',
    'vite.staff.config.ts',
    'vite.pwa.ts',
    'vite.security.ts',
    'hosting',
    '.env.example',
    '.env.staging.example',
    '.env.production.example',
    'MASTER_PROMPT_PLATEFORM_COMMERCIALE.md',
  ];
  const files = new Set();
  async function collect(path) {
    try {
      const { lstat } = await import('node:fs/promises');
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('A release source cannot be a symbolic link.');
      if (info.isDirectory()) {
        for (const name of (await readdir(path)).sort()) await collect(resolve(path, name));
      } else if (info.isFile()) files.add(path);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
  for (const path of roots) await collect(resolve(root, path));
  for (const path of [...files].sort()) {
    const name = relative(root, path).replaceAll('\\', '/');
    if (name === 'docs/REVIEWS.md') continue;
    entries.push(
      `${name}\0${createHash('sha256')
        .update(await readFile(path))
        .digest('hex')}`,
    );
  }
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}
export function roadmapProblems(roadmap) {
  const steps = roadmap?.steps;
  if (
    !Array.isArray(steps) ||
    steps.length !== 14 ||
    new Set(steps.map((row) => row.step)).size !== 14 ||
    Array.from({ length: 14 }, (_, i) => i).some((i) => !steps.some((row) => row.step === i))
  )
    return ['Il registro deve includere tutti gli step 0–13 della Roadmap.'];
  return steps.flatMap((row) =>
    row.status !== 'DONE' ||
    !Array.isArray(row.open) ||
    row.open.length !== 0 ||
    !Array.isArray(row.evidence) ||
    row.evidence.length === 0 ||
    row.evidence.some((ref) => typeof ref !== 'string' || !ref.trim()) ||
    !row.checks ||
    Object.keys(row.checks).length === 0 ||
    Object.values(row.checks).some((status) => status !== 'PASSED')
      ? [`Step ${row.step} non completato e verificato integralmente.`]
      : [],
  );
}
export function releaseProblems(matrix, evidence, digest, now = Date.now()) {
  const errors = [];
  const coreEdition = evidence.edition === 'CORE';
  const expectedSections = coreEdition
    ? (row) =>
        row.status === 'verified' ||
        (excludedCoreSections.includes(row.section) && row.status === 'out_of_scope_core')
    : (row) => row.status === 'verified';
  if (
    !Array.isArray(matrix.sections) ||
    matrix.sections.length !== 151 ||
    new Set(matrix.sections.map((row) => row.section)).size !== 151 ||
    Array.from({ length: 151 }, (_, i) => i).some(
      (i) => !matrix.sections.some((row) => row.section === i && expectedSections(row)),
    )
  )
    errors.push('Le 151 sezioni del master devono risultare verificate con evidenze.');
  if (evidence.source_digest !== digest)
    errors.push('Le evidenze non corrispondono ai sorgenti attuali.');
  const requiredLocalSuites = [
    'typecheck',
    'lint',
    'edge',
    'unit_database',
    'browser',
    'build',
    ...(coreEdition
      ? [
          'core_edition_contract',
          'core_server_policy_source',
          'core_edge_guard_source',
          'core_release_profile',
        ]
      : []),
  ];
  for (const suite of requiredLocalSuites)
    if (evidence.local_checks?.[suite] !== 'passed')
      errors.push(`Verifica locale mancante: ${suite}.`);
  if (evidence.edition && evidence.edition !== 'CORE' && evidence.edition !== 'FULL')
    errors.push('Edizione commerciale sconosciuta.');
  for (const name of coreEdition ? requiredCoreIntegrationChecks : requiredIntegrationChecks) {
    const check = evidence.integration_checks?.[name];
    if (
      !check ||
      check.status !== 'passed' ||
      !Array.isArray(check.evidence) ||
      check.evidence.length === 0 ||
      check.evidence.some((ref) => typeof ref !== 'string' || !ref.trim())
    )
      errors.push(`Collaudo reale mancante: ${name}.`);
  }
  const reviews = evidence.clean_reviews;
  if (
    !Array.isArray(reviews) ||
    reviews.length !== 3 ||
    reviews.some(
      (row) =>
        row.source_digest !== digest ||
        row.scope !== 'full_master' ||
        row.unresolved_findings !== 0 ||
        !Number.isFinite(Date.parse(row.completed_at)) ||
        Date.parse(row.completed_at) > now,
    ) ||
    !(
      Date.parse(reviews?.[0]?.completed_at) < Date.parse(reviews?.[1]?.completed_at) &&
      Date.parse(reviews?.[1]?.completed_at) < Date.parse(reviews?.[2]?.completed_at)
    )
  )
    errors.push(
      'Servono tre revisioni integrali consecutive, senza modifiche ai sorgenti e senza rilievi aperti.',
    );
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(evidence.version ?? ''))
    errors.push('Versione release non valida.');
  return errors;
}
export async function checkRelease(
  root = process.cwd(),
  evidencePath = '.local/release/evidence.json',
) {
  const matrix = JSON.parse(await readFile(resolve(root, 'docs/REQUIREMENTS.json'), 'utf8'));
  const roadmap = JSON.parse(await readFile(resolve(root, 'docs/ROADMAP_STATUS.json'), 'utf8'));
  let evidence;
  try {
    evidence = JSON.parse(await readFile(resolve(root, evidencePath), 'utf8'));
  } catch {
    throw new Error(
      'Release bloccata: manca il dossier dei collaudi reali e delle tre revisioni integrali.',
    );
  }
  for (const name of requiredDocuments) await readFile(resolve(root, name), 'utf8');
  const digest = await sourceDigest(root),
    problems = [...roadmapProblems(roadmap), ...releaseProblems(matrix, evidence, digest)];
  if (problems.length) throw new Error(`Release bloccata:\n${problems.join('\n')}`);
  return { evidence, digest };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { digest } = await checkRelease();
  console.log(`Release verificata per i sorgenti ${digest}.`);
}
