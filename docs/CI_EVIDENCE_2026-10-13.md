# Plateform candidate CI evidence — 13 October 2026

## Candidate and scope

Branch: `plateform/two-phase-completion-20261013`.
The checks run on an ephemeral Ubuntu 24.04 GitHub-hosted runner on the exact pushed commit, without Supabase or payment secrets, and do not deploy or mutate any live environment.

## Verified GitHub runs

| Run                                                                                     | Commit         | Result  | Evidence                                                                                                  |
| --------------------------------------------------------------------------------------- | -------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| [38415522418](https://github.com/ambrogiocorti/plateform-core/actions/runs/38415522418) | `24a1070bf57e` | FAIL    | 13/19 browser tests passed; 6 exposed drift in UI selectors and HTTP fixtures. Unit/database/build passed |
| [38417257620](https://github.com/ambrogiocorti/plateform-core/actions/runs/38417257620) | `7ac57fc8e4eb` | SUCCESS | 90 unit, 164 executed database, 19 real Chromium tests                                                    |
| [38418065831](https://github.com/ambrogiocorti/plateform-core/actions/runs/38418065831) | `a90c80d537a1` | SUCCESS | 90 unit, 165 database, 13 Deno Edge, 19 Chromium; 4 database cases remain skipped                         |

Both SUCCESS runs validated 482 _candidate_ SQL file SHA-256s, Node 24.13, locked npm dependencies, dependency advisories, source contract, cross-venue fixture, and bundled public/staff build. In the latest run the public site assembly was also independently checked using headless Chromium with JavaScript disabled.

### Real browser failure analysis and remedy

Six previous failures resulted from selectors for older cashier/host UI and incomplete HTTP fixture data after Step 11/12 updates, **not** from missing source paths. All six were kept and corrected; no test case was deleted or skipped. Screenshots/traces remain in the failed run's 3-day artifact retention.

### Boundaries

- PGlite fixture SQL and Playwright with simulated HTTP responses are **not** production PostgreSQL or live Supabase E2E.
- `supabase_migrations.schema_migrations` has 480 applied migrations; the branch has 482 files. A disposable fresh-project install remains PENDING.
- Independent PostgreSQL/Auth/Storage backup with real restore is PENDING.
- Stripe/Satispay sandbox, physical printers, true cross-device/offline tests, public domain, staging and production remain PENDING.
- Leak-password protection in Supabase Auth remains disabled until configured and rechecked. No compliance claim is made.
- Runner success is **not** a release authorization. Draft PR #41 stays NO-GO.

### Next CI expansion

Run `npm run format:check` as a required command on the exact candidate. The canonical historical SQL tree and its digest manifest are intentionally excluded from automatic formatting. Record an actual green run after this change; do not retroactively attribute formatting success to earlier commits.
