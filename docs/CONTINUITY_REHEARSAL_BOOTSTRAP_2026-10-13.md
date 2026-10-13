# Continuity rehearsal bootstrap — 13 October 2026

## Verified problem
The Development database contains seven `private.continuity_rehearsal_*` tables used by step-12/13 SQL. The old PGlite harness created them **before** `20261006100248_step13_rehearsal_private_rls_hardening.sql`, because the historical migration set had no `CREATE TABLE` for them. This could produce false-positive test results and block clean bootstraps.

## Implemented change
- Added **prospective** migration `supabase/migrations/20261006100100_continuity_rehearsal_schema_recovery.sql` between 20261006095341 and 20261006100248. This is a new local migration, not a rewrite of any of the 480 applied SQL blobs.
- Its seven table shapes, constraints, defaults and scopes were checked against the real Development system catalog. RLS is enabled and all grants to PUBLIC, anon, authenticated and service_role are revoked. Uses IF NOT EXISTS and never deletes existing data.
- Removed the out-of-band table injection in `tests/database/harness.ts`.
- Updated `supabase/migration-manifest.json` to **481** prospective migrations and excluded immutable migration SQL from Prettier.
- Added an isolated static guard `node scripts/check-continuity-bootstrap-recovery.mjs` to branch CI.

## Mandatory next validation
1. Run Node 24.13 `npm ci`, `npm run check:migrations`, `npm run test:db` and browser E2E against this **exact commit**.
2. Run a strict clean replay on a **fresh disposable Supabase project** (not `plateform-development` and not `plateform-restore-test`).
3. Check for *other* missing historical DDL and classify failures; PGlite is not equivalent to full Supabase Auth/Storage/Vault.
4. Verify application on the new installation and the remote upgrade path, including the older-version insertion. Do not apply to the existing remote database before backup+restore is certified.
5. No release gate can be closed on the basis of this static change.

**Status: candidate repair committed, fresh install and all runtime regression tests still PENDING.**
