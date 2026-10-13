# Reconciliation of Supabase migration sources — 2026-10-13

## Scope
Recovered the exact SQL text stored in `supabase_migrations.schema_migrations.statements` on Plateform's *development* database (`abdxvlykasqmknexxhjo`), written only to the isolated Git branch `plateform/two-phase-completion-20261013`.

No production or development database migration, DDL, data deletion, or deployment was performed by this recovery.

## Before
- Applied remote migrations: **480**.
- Local tracked manifest: **134** SQL migrations.
- In remote history but absent from Git: **347**.
- Same version/name but different SHA-256: **24**.
- In Git but not yet in remote history: **1**.
- Current remote last version: `20261012075338`.
- Comparison used SHA-256 of PostgreSQL `array_to_string(statements, E'\\n')` converted to UTF-8.

## Recovery
- Committed all **371** remote SQL variants missing or differing from Git's tracked files, on a feature branch only.
- Kept unchanged local SQL files when their SHA-256 matched remote.
- Regenerated `supabase/migration-manifest.json` from all **480** remote versions, names, and SHA-256 digests.
- Moved the unapplied local-only migration `20261012120000_staff_identifier_custom_email_domain.sql` out of the automatically applied `supabase/migrations` tree to `supabase/pending-migrations/`. This file MUST NOT be silently treated as applied or dropped; inspect whether its effects are already included in the remote migration `20261011221212_staff_identifier_custom_email_domain`, and only then decide whether to create a new migration or archive the redundant pending file.
- The original 134 tracked files and previous manifest remain recoverable by checking out commit `5c5dde901d9494b99d4abb19443582045b8f4fe5`.
- A simple high-risk secret-pattern scan of the remote SQL history identified no matches for secret keys, live Stripe keys, private-key headers or embedded PostgreSQL credential URLs. This is not a substitute for secret scanning in CI.

## Files with different SQL SHA-256 despite matching version/name
- `20261004224216_step11_branding_accessibility_contrast.sql`
- `20261004224445_step11_branding_theme_default_contrast_fix.sql`
- `20261004231459_step9_analytics_station_throughput_fix.sql`
- `20261004231739_step9_analytics_booking_semantics.sql`
- `20261005062508_step10_venue_lifecycle_management.sql`
- `20261005062556_step10_venue_idempotent_step_up_retry.sql`
- `20261005140800_step6_refund_reopens_balance.sql`
- `20261005142447_registered_device_heartbeat_realtime.sql`
- `20261005144849_operational_settings_unrelated_feature_save_fix.sql`
- `20261005152701_step7_return_approval_refund_and_notification_fix.sql`
- `20261005155412_step7_pdf_invoice_output.sql`
- `20261005155543_step7_document_snapshot_refunds.sql`
- `20261005163939_kitchen_board_allergen_snapshot.sql`
- `20261005165352_host_operational_summary.sql`
- `20261005170110_kitchen_admin_operational_overview.sql`
- `20261005170559_admin_operational_overview.sql`
- `20261005221652_step12_continuity_worker_heartbeat.sql`
- `20261005222521_api_permission_manifest_alignment.sql`
- `20261005223140_step12_continuity_worker_health.sql`
- `20261005223814_api_permission_manifest_legacy_cleanup.sql`
- `20261006044128_step12_audit_error_code_visibility.sql`
- `20261006045641_step12_restore_reference_indexes.sql`
- `20261006050249_step12_restore_actor_indexes.sql`
- `20261006051256_step12_backup_requester_index.sql`

## Required verification before release
1. Run `npm ci`, `npm run check:migrations`, `npm run local:verify` on a trusted checkout of this branch (Node >=24.13.0).
2. Run `npm run reconcile:migrations` against the same development database via a **read-only** PostgreSQL account, and confirm `SYNCED` with 480 versions and no mismatches.
3. Provision a disposable independent staging project and replay the 480 SQL files **in order**; check extensions, roles, RLS, grants, Edge Functions, Auth and Storage. Certain remote migrations may depend on historical state or Supabase-managed objects; merely matching the stored SQL and hash is not a successful bootstrap test.
4. Confirm backup/export and a real restore of current DB/Auth/Storage, with checksums. Existing `backup_metadata` table had zero rows at the beginning of this work.
5. No automatic release-gate PASS or production deploy as a consequence of recovery.

**Status:** SOURCE HISTORY RECOVERED IN FEATURE BRANCH; BOOTSTRAP / RESTORE / GO-LIVE NOT CERTIFIED.
