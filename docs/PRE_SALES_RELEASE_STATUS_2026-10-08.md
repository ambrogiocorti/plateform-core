# Plateform — pre-sales release evidence (2026-10-08)

**Verdict: BLOCKED for a commercial production release.** This document is an
engineering checkpoint, not a statement of conformity, a release certificate,
or an installable customer deliverable.

## Verified in the integrated source

- Public booking checkout redirection now accepts only the precise Stripe
  Checkout or Satispay production/staging checkout hostnames permitted by the
  server integration; no wildcard brand-domain redirects.
- `scripts/check-step11-booking-client.mjs`: 33 offline contract assertions passed.
- `scripts/check-vercel-config.mjs`: 33 offline checks passed, including a CI
  contract requiring full source checks, browser checks, Node 24, reproducible
  npm installation, live migration drift inspection and an HTTPS staging smoke.
- Other dependency-free tests passed: public runtime/static, prerender,
  public build assembly, recovery contract and simulated HTTP staging checks.
- Checked without external packages: Step 8 static (16), Step 9 advanced UI
  (16), Step 10 multivenue UI (12), Step 12 static (34).
- Existing 130 on-disk migration files pass their original local manifest.

## Authoritative Supabase development data already verified

- Remote schema migration count was **453** during this review (not 450).
- The checkpoint includes the first **130** version numbers; **323** subsequent
  migrations have not been recovered to disk.
- Comparing SHA-256 digests of the applied migration SQL with on-disk SQL,
  entries 1–106 coincide, but the final **24** local historical migration files
  differ; at least one difference changes statement ordering. Do NOT silently
  overwrite the old files or substitute normalized checksums. Treat the
  source installation/upgrade process as blocked until reconciled.
- The development reservation SQL write-and-rollback regression previously
  verified RESERVED, REQUESTED, PENDING_DEPOSIT, idempotent replay, and the
  deposit row; this is **not** equivalent to a browser/Edge/provider E2E.

## Hard commercial release blockers

1. A private authoritative source repository and reconciliation of **all 453**
   applied migration versions, including an explicit reviewed disposition for
   the 24 historical mismatches, with clean install and upgrade tests.
2. A real Node 24.13+ / `npm ci` build with PGlite, Deno, Playwright and both
   frontend applications; npm registry is inaccessible in the present host.
3. Staging HTTPS site deployed from that source; live browser and Edge CORS,
   booking checkout, multi-venue, offline/realtime and printing tests.
4. Provider sandbox (including Satispay) and device/hardware E2E evidence.
5. Backup/restore recovery rehearsal and recovery metrics, privacy-retention
   and leaked-password protection, critical RBAC/RLS/security hardening.
6. Master Prompt requirement coverage **0–150**, followed by **three complete
   clean revisions** on the same digest, per docs/REVIEWS.md. Currently 0/3.

No production credentials, payment flows or production tenant data were used
or changed in this source-side review. The database of development was not
reset and no commercial archive was generated.

## Additional CORE source checkpoint (8 October, evening)

- Resolved conflicting `/sedi/{slug}?sede=other` and duplicate `?sede=` selectors consistently in detail views, menus and booking eligibility; no cross-venue substitution on invalid or disabled explicit selection.
- Prevented arbitrary URL query strings from being retained in public telemetry observer keys. Confirmed first-document TTFB remains measured when extra URL parameters are present.
- Reran dependency-free public smoke checks and Chromium desktop/mobile static HTML validation (31 checks with JavaScript disabled). These are **not** authenticated browser E2E and do **not** validate the Vite production bundles.
- Continued to observe the existing blocking release prerequisites. Do not interpret this checkpoint as a shipping/production approval.
