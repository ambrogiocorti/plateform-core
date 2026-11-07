# Supply-chain remediation — Plateform, 13 October 2026

## Verified finding

Vercel `npm ci` on the two-phase candidate showed **one HIGH npm vulnerability**. A safe JSON audit confirmed the only HIGH package was the transitive, development-marked `source-map-js@1.2.1`. This is CVE-2026-93749 / GHSA-68fv-2mgg-jv7q, an availability DoS issue from unvalidated indexed source map offsets.

## Applied fix

- Updated the locked transitive `source-map-js` package to **1.2.2**. Preserved the official registry URL and SHA-512 SRI digest.
- Did not change unrelated locked dependencies or upgrade broad ranges.
- Added `scripts/report-dependency-audit.mjs` to `build:pages`. Output is a structured, bounded package/severity summary without credentials.
- Upgraded that check from advisory-only to a **fail-closed build gate** for HIGH/CRITICAL npm vulnerabilities. Audit service unavailable or unreadable also fails the build.

## Verification evidence

- Vercel preview of commit `69058246bee91c4dcc822674a332154b0d37027d`, deployment `dpl_13tWc31H8skeKjBBNwy5oneST4cp`, installed pinned dependencies with `npm ci`.
- The build reported `found 0 vulnerabilities` and `PLATEFORM_NPM_AUDIT={"status":"NO_HIGH_OR_CRITICAL","high":0,"critical":0,"affected":[]}`.
- The same deployment verified all 481 candidate SQL manifest hashes, the continuity rehearsal bootstrap guard, the fail-closed restore preflight guard, TypeScript and both frontend bundles; state READY.

Security references: https://github.com/advisories/GHSA-68fv-2mgg-jv7q and https://advisories.gitlab.com/npm/source-map-js/CVE-2026-93749/

**Remaining:** confirm the subsequent _blocking-mode_ build also succeeds; GitHub self-hosted browser/DB regression is still queued. Zero npm vulnerabilities in this build is not a full security review or release GO.
