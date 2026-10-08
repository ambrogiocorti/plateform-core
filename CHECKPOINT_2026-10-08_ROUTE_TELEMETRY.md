# Plateform — checkpoint 2026-10-08 — Routing e telemetria pubblica

Stato: **IN PROGRESS** — non production-ready. Base recuperata da Library: commit `771a19dfad3d173f513ea39fbeb853811ed419df` (archivio pre-sales-security 2026-10-08).

## Modifiche di questa sessione

- Il click router intercetta soltanto route proprie del sito pubblico. I percorsi staff, le API, i documenti SEO e i percorsi sconosciuti sono demandati alla navigazione browser/server.
- `normalizePublicPath` riconosce `/menu/:slug`, salvaguardando i percorsi dinamici dei menu pubblici e normalizzando la telemetry senza includere i nomi dei menu.
- Lo schema `public-telemetry` accetta `/menu/:slug`. La Edge Function `public-telemetry` è stata distribuita su **plateform-development** ed è risultata ACTIVE v3 in lettura successiva.
- Aggiunti regression test di routing e una verifica statica del contratto della telemetria.

## Gate effettivamente eseguiti

- `check-step11-static.mjs` — PASS
- `check-step11-public-runtime.mjs` — PASS
- `check-step11-prerender.mjs` — PASS (15 assertions)
- `check-step11-build-assembly.mjs` — PASS (16 assertions)
- `check-vercel-config.mjs` — PASS (33 assertions)
- `git diff --check` — PASS
- Typecheck/lint/full build/Playwright E2E — NON eseguiti; runtime locale Node 22.16, `npm ci` non completato per mancanza di accesso completo alle dipendenze.

## Stato remoto osservato

- Supabase development ACTIVE_HEALTHY con 453 migrazioni; archivio sorgente ha 130 migrazioni. **Non applicare la directory locale direttamente al database remoto**: va riconciliata con i testi SQL realmente applicati, preservando divergences storiche.
- `release_test_gate`: 197/197 PASS secondo registro database, non equiparare a Playwright E2E.
- `release_database_regression_gate`: PASS al momento del controllo.
- `beta_readiness_report`: `IN PROGRESS`, `beta_ready=false`, `production_ready=false`, sette gate beta bloccanti.

## Prossimo intervento

1. Riconciliare in modo verificabile la storia migrazioni SQL 130 vs 453 con il database, senza riscrivere migrazioni divergenti.
2. Portare i sorgenti su un runner Node >=24.13 e completare `npm ci`, format, typecheck, lint, test, build.
3. Verificare in browser reale le route `/menu/:slug`, `/staff`, prenotazione e dati telemetry end-to-end su hosting HTTPS staging.
4. Rieseguire controlli autorizzativi/cross-venue e stabilizzazione Step 11, poi riprendere gli altri gate seguendo la roadmap.

Non consegnare questo checkpoint come ZIP commerciale definitivo.
