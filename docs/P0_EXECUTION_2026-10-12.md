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


## Update 12 Oct 2026 — real self-hosted Windows CI and SQL replay blocker

- **Runner/quick verified:** Windows self-hosted runner executed on trusted `main` SHA `ff0dc38f7a28f91dbad88d0465989c7b93bbd84c`. GitHub Actions [quick #38245707499](https://github.com/ambrogiocorti/plateform-core/actions/runs/38245707499) passed Prettier, local 134-migration manifest digest check, TypeScript, ESLint, 76/76 unit tests including real localhost HTTPS print-bridge tests, and public/staff production builds. This **supersedes only the earlier CI runner diagnosis**, not the incomplete release evidence.
- **Full CI still blocked:** GitHub Actions [full #38246436076](https://github.com/ambrogiocorti/plateform-core/actions/runs/38246436076) failed in `npm run check` while replaying `20261008163112_step11_public_rpc_permission_manifest.sql` in a disposable PGlite PostgreSQL engine: `PUBLIC_RPC_SECURITY_CONTRACT_CHANGED`. Playwright, complete DB, Edge and build suite were not reached. The failing test is not currently evidence of compromised live authorization.
- **Independently checked root cause:** Development's live PostgreSQL catalog has all four public RPC signatures and they are `SECURITY DEFINER` with fixed search paths. Seven predecessor migrations dated 8 Oct 2026, including the original function definitions, are present in the authoritative remote 480-entry history but **not** in the local Git manifest. See the read-only version/name/SQL-byte/SHA-256 evidence file `docs/evidence/p0-full-ci-missing-public-rpc-migrations-2026-10-12.json`.
- **Detailed historical digest investigation:** `docs/evidence/p0-migration-digests-2026-10-12.json` verifies 109 exact matching migration SQL hashes, 12 additional hashes accounted for by one trailing LF, 12 still differing after that normalization, and one local-only migration. Remote-only versions remain 347. At least one materially divergent definition involves a step-up security call. The local `check:migrations` PASS validates local internal consistency **only**.
- **Release decision remains BLOCKED:** Never bypass the RPC security assertion, add mock RPCs to make PGlite green, change historical migrations in place or infer that remote schema is reconstructible from the current repository. Recover independently fingerprinted original SQL history, back up all divergent local history, replay in isolation, and only then retry full CI, Playwright, restore and staging gates. No production release authorized.

## P0 checkpoint — canonical SQL recovery and isolated replay (12 Oct 2026)

- Canonical SQL recovered into **draft PR #32**: all 480 Development versions captured under a quarantine path; 480/480 remote-computed Git blob hashes matched the corresponding GitHub blobs; no edits to live database or main migrations.
- Replay candidate **draft PR #33**: full 480 canonical SQL blobs staged under `supabase/migrations` on a separate branch, with **one local-only pending** migration left pending. All **134 prior Git SQL originals and their manifest** are preserved separately.
- First actual Windows PGlite replay **run #38258766430**: `check:migrations` PASS (481/481); failure at the final remote audit recovery migration `20261012075338_restore_dev_audit_capture_keep_immutability.sql`, because `plateform_dev_pause_audit` trigger exists on Development but **was created out of band** rather than by any canonical SQL migration. This **proves strict clean replay is still blocked**.
- Independently inspected live Development DDL: `plateform_dev_pause_audit` is a disabled `BEFORE INSERT` trigger on `public.audit_log`, calling `private.plateform_dev_skip_audit()` (returns NULL); immutable/no-truncate audit triggers remain enabled. This is not a portable or desirable deployment prerequisite.
- The candidate's disposable PGlite **development-parity-only fixture** reproduces this exact out-of-band object immediately before the original migration, then validates that canonical SQL disables the pause trigger and preserves both audit protections. It does **not** weaken the live database or modify the 480 recovered SQL bodies.
- **PR #35** updates a trusted-main, manually triggered, read-only CI workflow to pin the new exact candidate and rerun Step 11 + database suites. Await actual evidence. The workflow cannot certify clean installation, Auth/Storage/Realtime parity, recoverability or go-live even if it passes.
- Required separate resolution: document and remove the nonportable out-of-band dependencies through an audited installation design, prove clean migration replay with no Development-only objects, and complete restore/staging/security E2E.
