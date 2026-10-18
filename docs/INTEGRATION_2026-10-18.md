# Integrazione delle PR #43–#47 — 18 ottobre 2026

Branch `plateform/migrations-reconciliation-4dgntr` (PR #47), base `plateform/a1-audit-append-only-inbac1` (PR #42), proposto verso `plateform/two-phase-completion-20261013` (PR #41). Le PR #43, #44, #45 e #46 restano aperte. Nessun merge su `main`, nessun database remoto, nessun segreto.

## PR unite (merge commit, nessuna riscrittura)

| PR  | Branch                                       | Conflitti                                                                                          |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| #47 | `plateform/migrations-reconciliation-4dgntr` | base                                                                                               |
| #43 | `plateform/ci-restore-2dwsvm`                | nessuno                                                                                            |
| #44 | `plateform/rls-security-63oe51`              | conteggi fissi 483→484 in 4 file: tenuti i valori derivati dal manifest di #47                     |
| #45 | `plateform/backup-restore-bwio3d`            | stessi conteggi; `supabase/migration-manifest.json` rigenerato con le righe di #44 e #45 in ordine |
| #46 | `plateform/e2e-service-flow-ncceyo`          | nessuno                                                                                            |

Catena risultante: **485 migrazioni** (`20261018114500` di #45, `20261018120000` di #44), nessuna retrodatata nuova.

## Correzioni di integrazione

Il fixture Supabase condiviso introdotto da #47 (`supabase/tests/host-fixture.sql`) aveva rotto due strumenti che estraevano l'SQL da `tests/database/harness.ts`:

- `tools/local-dr-rehearsal/fixture.mjs` (#45): `relation "public.restaurant_profile" does not exist` al primo seed. Ora legge il fixture condiviso.
- `tools/audit-local-pg/replay.sh` (#42): stesso problema. Ora legge il fixture condiviso.

## Test eseguiti sul risultato (Node 24.22.0, PostgreSQL 16.15 locale)

| Comando                                                                                     | Risultato                                          |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `npm run format:check`, `typecheck`, `lint`, `build`                                        | PASS                                               |
| `npm run check:migrations`                                                                  | 485 migrazioni verificate                          |
| `check:migration-promotion`, `check:local-bootstrap`, `check-continuity-bootstrap-recovery` | PASS                                               |
| `npm run test:unit`                                                                         | 121/121                                            |
| `npm run test:db` (PGlite)                                                                  | 190 superati, 4 saltati (18 file)                  |
| `npm run check:migration-replay-pg`                                                         | PASS: replay 485, upgrade con repair e include-all |
| `npm run check:security-pg`                                                                 | 10/10 probe                                        |
| `npm run continuity:local-dr`                                                               | 18/18 gate, `failed=0`                             |
| `tools/audit-local-pg/replay.sh` (cluster usa e getta, auth trust)                          | 43/43                                              |
| `npm run test:e2e` (Playwright)                                                             | 21/21                                              |
| `npm run test:e2e:live` (stack locale PG16 + GoTrue + PostgREST)                            | 2/2                                                |

Note ambiente: Playwright richiede `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` in questo container. Lo script audit richiede un cluster con autenticazione `trust` sul socket: con `peer` fallisce solo il caso `non-superuser fallback`.

## Ancora da provare

Staging Supabase ospitato (Auth, Storage, Realtime e Vault reali), lettura dello storico reale di Development prima del repair delle due migrazioni compatibili, backup/restore e RPO/RTO su progetti reali. Il rilascio resta NO-GO fino a queste prove.
