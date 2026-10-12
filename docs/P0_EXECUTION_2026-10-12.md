# Plateform P0 remediation — 2026-10-12

**Status: NO-GO.** This file records actual evidence and remaining prerequisites; it is not a release dossier.

## Changes applied

1. **Development audit capture:** managed Supabase migration `20261012075338_restore_dev_audit_capture_keep_immutability` disabled the development-only audit suppression trigger after verifying parent-table immutable and no-truncate guards. Subsequent catalog query confirmed the disabled state on the parent and existing partitions. Non-persistent SQL smoke tests confirmed audit insert/visibility and rejected UPDATE/DELETE, then rolled back the synthetic test row. Application-triggered audit, archiving, privacy lifecycle and future partitions are not yet certified.
2. **Release gate source coverage:** updated checks, mocks, unit tests and `docs/REQUIREMENTS.json` to cover all Master Prompt sections 0–157. Sections 151–157 are not marked verified. FULL releases require named end-to-end integration evidence for food cost, menu engineering, menu/QR promotions, messaging, deposits, waitlist and takeaway. CORE can exclude 151–156 only under explicit edition scope; server-side license-denial evidence is required.
3. **Migration inventory:** read-only version/name comparison archived in `docs/evidence/p0-migration-inventory-2026-10-12.json`: 480 versions in Development, 134 in repository manifest, 347 remote-only, 1 local-only. SQL SHA-256 comparison NOT performed. No remote history was forged or truncated.

## P0 still open

- **Canonical migrations:** preserve and export all 480 remote SQL statements in a secure environment, compare `version:name:SHA-256` against Git, back up local differences, dry-run the existing `scripts/reconcile-migrations.mjs`, reconcile non-destructively, then install a clean isolated Supabase project from Git and compare schemas/privileges/policies/Edge/cron.
- **Recoverability:** Development has zero `public.backup_metadata` records. Existing `plateform-restore-test` has 137 migration rows and is not a validated clone of Development. Do not overwrite or repurpose it without its own independent verified backup. Verify backup of DB, Auth, Storage objects and migration history, plus restore, hashes, RPO/RTO, retention and independence.
- **Auth leaked-password gate:** Supabase organization plan is Free; official Supabase documentation states its native leaked-password protection is available on Pro and above. An appropriate paid production plan / independent enforcement and acceptance decision must be arranged; the gate remains PENDING.
- **CI:** GitHub Actions workflows exist, but recent run jobs report `failure` within seconds, no assigned runner and zero executed steps. Investigate account Actions availability/runner/billing before interpreting this as code-test failure or CI success. No local full test suite was run through this environment.
- **Staging:** separate HTTPS/DB/Auth/Storage configuration and real browser/JWT users still absent. The restore-test project is not a verified staging copy.
- **Security:** advisor counts 10 anonymous callable SECURITY DEFINER functions (public read/booking endpoints that may be intended), 227 authenticated functions, 62 RLS deny-all/no-policy tables, and `pg_net` extension located in public. `pg_net` is non-relocatable; do not attempt blind ALTER EXTENSION SET SCHEMA or revoke all read APIs. Review authorization/privilege boundaries case by case.
- **Operations:** application end-to-end order-to-payment, chaos, accessibility, and rollback require staging/real hardware/provider tests; no release gate was marked PASS.

## Scope and controls

Production deployment, restore target destruction, license activation, data purges, synthetic `PASS` states and broad privilege revocation were **not** performed.

Current draft PR is for review and validation. GitHub workflow failure, database drift and missing restore evidence continue to block merge as a commercial release.
