# Riconciliazione e replay delle migrazioni — 18 ottobre 2026

Branch `plateform/migrations-reconciliation-4dgntr`, basato su `plateform/a1-audit-append-only-inbac1` (PR #42, impilata sulla PR #41). Nessun database remoto è stato letto o modificato; nessun merge o deploy.

## Esito

| Verifica                                                                          | Ambiente                          | Risultato                                                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Replay da zero di `main` (134 migrazioni)                                         | PostgreSQL 16.15 locale           | **Fallisce** alla #131 `20261008163112_step11_public_rpc_permission_manifest.sql` (`PUBLIC_RPC_SECURITY_CONTRACT_CHANGED`) |
| Replay da zero del candidato (483 migrazioni)                                     | PostgreSQL 16.15 locale           | **PASS**, 483/483, nessuna violazione append-only                                                                          |
| Replay da zero del candidato                                                      | PGlite (harness `tests/database`) | **PASS**, 483/483                                                                                                          |
| Upgrade simulato dallo stato Development (480 versioni) con repair                | PostgreSQL 16.15 e PGlite         | **PASS**: preflight positivo, schema invariato dal repair, A.1 applicata, audit persistito                                 |
| Stesso upgrade con la Supabase CLI 2.120.0 reale (`migration repair` + `db push`) | PostgreSQL 16.15 locale           | **PASS**: 483 versioni, trigger di pausa rimosso, inserimento audit persistito, nessuna violazione                         |
| `db push` senza repair sullo stato Development                                    | Supabase CLI 2.120.0, PG16 locale | **Rifiutato** (`DbPushMissingRemoteError`), come atteso: è il blocco della promozione                                      |

Node.js 24.22.0. Il replay su PostgreSQL usa un fixture degli oggetti ospitati da Supabase (`supabase/tests/host-fixture.sql`), condiviso con PGlite: **non** prova GoTrue, PostgREST, Storage, Realtime, Vault o pg_cron reali. Lo stato Development è simulato, non letto.

## Perché `main` non è riproducibile

Il file `20261008163112` è identico byte per byte su `main` e sul candidato. Su `main` fallisce perché mancano 347 migrazioni applicate su Development e 24 file divergono dallo storico applicato: il contratto di sicurezza delle RPC pubbliche che quel file verifica non corrisponde allo schema prodotto dalle sole 134 migrazioni locali. Sul candidato lo stesso file passa. La correzione è quindi la catena canonica della PR #41, non una modifica del file.

## PR #32 e #33

Confronto per SHA-256 dei file:

- PR #32 (`supabase/recovery/remote-2026-10-12/`, 480 file): **tutti identici** ai corrispondenti in `supabase/migrations/` del candidato.
- PR #33 (481 file): 480 identici; il 481° (`20261012120000_staff_identifier_custom_email_domain.sql`) è la copia locale non applicata, già rimossa come ridondante nella PR #41 (commit `4efaa4d`) perché coperta da `20261011221212`.

Il lavoro delle PR #32/#33 è quindi **interamente assorbito** dal candidato; restano da chiudere come superate dopo l'integrazione della PR #41 (decisione del proprietario).

## Le due migrazioni retrodatate

| Versione         | Precede          | Ricrea oggetti creati fuori banda su Development                        |
| ---------------- | ---------------- | ----------------------------------------------------------------------- |
| `20261006100100` | `20261006100248` | sette tabelle `private.continuity_rehearsal_*`                          |
| `20261012075300` | `20261012075338` | trigger `plateform_dev_pause_audit` (creato disabilitato, pass-through) |

Sono indispensabili per una nuova installazione (una per cliente) e non possono avere un numero successivo a quello che compensano. Le migrazioni già applicate restano immutabili.

**Decisione:** su un'installazione esistente non si eseguono fuori ordine (`db push --include-all`), si registrano soltanto. Motivo: `20261006100100` esegue `REVOKE ALL ... FROM service_role` sulle tabelle di prova, che su Development potrebbero avere permessi diversi da quelli simulati; il repair non tocca lo schema.

Componenti:

- `supabase/migration-bootstrap-compat.json`: elenco delle due versioni con nome, SHA-256 e versione che precedono.
- `scripts/plan-migration-promotion.mjs`: una versione retrodatata è accettata solo se è nell'elenco con lo stesso SHA-256 e la versione che precede è già applicata. Stato `READY_FOR_DISPOSABLE_STAGING_AFTER_COMPAT_REPAIR`, exit code 3. Qualsiasi altra retrodatazione resta `BLOCKED_BACKDATED_MIGRATIONS`. Il self-test copre: elenco assente, hash alterato, migrazione compensata mancante, storico dopo repair, installazione nuova.
- `supabase/tests/bootstrap-compat-preflight.sql`: controlli in transazione READ ONLY (storico, presenza tabelle, RLS, nessun privilegio anon/authenticated, trigger di pausa non abilitato). Il repair è ammesso solo con `BOOTSTRAP_COMPAT_REPAIR_ALLOWED = t`.
- `supabase/migration-cli-history-hashes.json`: la CLI registra le istruzioni separate e senza `;` finale, quindi l'hash dello storico differisce da quello del file. I valori per le tre migrazioni non provenienti da Development sono misurati con la CLI 2.120.0 reale; il planner li accetta come equivalenti. Senza questo file, dopo il primo `db push` il planner avrebbe segnalato una falsa divergenza.

## Procedura per Development (da eseguire solo con autorizzazione esplicita e backup)

1. Esportare lo storico in sola lettura (query in `docs/MIGRATION_PROMOTION_PREFLIGHT_2026-10-13.md`) e lanciare `node scripts/plan-migration-promotion.mjs --applied-json <file>`; atteso exit code 3 con `compat_repair_versions = [20261006100100, 20261012075300]`.
2. Eseguire `supabase/tests/bootstrap-compat-preflight.sql`; tutte le righe `t`.
3. `supabase migration repair --status applied 20261006100100 20261012075300`.
4. `supabase db push --dry-run`: deve elencare solo `20261018103000` (e successive).
5. Ripetere il punto 1: atteso `READY_FOR_DISPOSABLE_STAGING_ONLY`.

Nuova installazione: `supabase db push` su storico vuoto applica le 483 migrazioni in ordine.

## Replay riproducibile

```sh
# PostgreSQL 16 locale (socket o loopback), database usa e getta creati e rimossi dallo script
PGHOST=/var/run/postgresql npm run check:migration-replay-pg
npx vitest run tests/database/migration-upgrade.test.ts
```

Lo script rifiuta host non locali e variabili come `DATABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_ACCESS_TOKEN`.

## Test eseguiti su questo commit (Node 24.22.0)

- `npm run check:migrations`: 483 migrazioni verificate.
- `npm run check:migration-promotion`: PASS.
- `npm run check:migration-replay-pg`: PASS (clean 483 in 38 s; upgrade con repair; upgrade con include-all, lasciato come evidenza).
- `npm run typecheck`, `npm run lint`, `npm run format:check`: PASS.
- `npm run test:unit`: 121/121.
- `npm run test:db`: 182 superati, 4 saltati (16 file).
- `npm run build`: PASS.
- `check-continuity-bootstrap-recovery`, `check-migration-recovery`, `check:local-bootstrap`: PASS.

## Prove mancanti e rischi

- Nessuna lettura dello storico reale di Development: lo stato è simulato. Il preflight va eseguito sul database vero prima del repair.
- Nessun replay su un progetto Supabase ospitato (estensioni, ruoli e grant della piattaforma reali): resta necessario lo staging indipendente.
- `scripts/reconcile-migrations.mjs` confronta ancora l'hash dello storico con quello del file; per le migrazioni inviate con la CLI va allineato a `migration-cli-history-hashes.json`.
- Nessun workflow CI esegue ancora `check:migration-replay-pg`: va aggiunto dal thread CI (job ubuntu con servizio `postgres:16`).

**Decisione:** IN PROGRESS. La catena è riproducibile da zero e la promozione ha una procedura verificata localmente; la certificazione richiede staging e Development reali.
