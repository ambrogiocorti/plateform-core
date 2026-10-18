# Step 12 — Backup e ripristino: prova locale completa (18 ottobre 2026)

**Decisione: IN PROGRESS.** Il ciclo backup → distruzione → ripristino è dimostrato su PostgreSQL 16 locale con il codice reale dei worker. Il gate commerciale `backup_restore_database_auth_storage` **resta aperto**: manca la stessa prova su progetti Supabase di staging.

## Branch e commit

- Branch: `plateform/backup-restore-bwio3d`, basato su `plateform/a1-audit-append-only-inbac1` (PR #42, `759c8fe`).
- Codice provato: commit `c7a0802` (worktree pulito). Evidenza: [`docs/evidence/LOCAL_DR_REHEARSAL_2026-10-18.json`](evidence/LOCAL_DR_REHEARSAL_2026-10-18.json).
- Ambiente: PostgreSQL 16.15 usa-e-getta (solo socket Unix, cancellato a fine prova), Node 22.22.0. Nessun database remoto contattato.

## Requisito e step

Roadmap Step 12 (continuità): backup DB/Auth/Storage cifrato e replicato, restore test isolato, ripristino dopo perdita totale, integrità dei dati e dell'audit append-only (A.1).

## Cosa è stato provato (18/18 gate superati)

| Fase                     | Risultato                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installazione sorgente   | 484 migrazioni applicate; dati inseriti tramite RPC reali (conto, ordine, sessione cassa, pagamento contanti 36,00 € + mancia 3,00 €, chiusura conto); 74 eventi audit generati dall'applicazione |
| Backup                   | Pipeline reale del worker: dump, AES-256-GCM, manifest HMAC, replica verificata (11 file), `finish_backup_job` → `SUCCEEDED`, `integrity_verified=true`                                           |
| Restore test             | Pipeline reale del worker su target vuoto separato, 16 gate, `finish_restore_job` → `SUCCEEDED` registrato sul control plane sorgente                                                             |
| Integrità restore test   | 161 tabelle / 1.547 righe identiche (SHA-256 del contenuto), audit identico (74 eventi, stesso hash), superficie di sicurezza identica                                                            |
| Disastro                 | Eliminati database sorgente, byte Storage e copia **primaria** del backup                                                                                                                         |
| Ripristino da disastro   | Dalla sola replica in un'installazione vuota: 16 gate superati; backup finalizzato `SUCCEEDED` e job `RESTORE` in `CUTOVER_REQUIRED` registrati nell'installazione ripristinata                   |
| Audit dopo il ripristino | I 74 eventi originali identici; 5 eventi nuovi solo di control plane; 0 violazioni append-only; UPDATE/DELETE/TRUNCATE rifiutati su tutte le 5 partizioni (7/7)                                   |
| RPO                      | Un evento scritto dopo il backup è assente dopo il ripristino, come atteso                                                                                                                        |
| Sicurezza                | Grant, default privileges, RLS, policy, trigger, event trigger e publication identici alla sorgente; sessioni staff/Auth e refresh token azzerati                                                 |
| Applicazione             | Menu pubblico servito come `anon` sull'installazione ripristinata                                                                                                                                 |
| Fail-closed              | Rifiutati: target occupato, chiave errata, manifest manomesso, cifrato manomesso                                                                                                                  |
| Cutover                  | 14 schedulazioni `plateform-*` riattivate solo su comando esplicito                                                                                                                               |

Tempo locale distruzione → ripristino verificato e registrato: circa 2,3 s su un database piccolo. **Non è un RTO di produzione.**

## Difetti trovati dalla prova e corretti

1. **Ogni backup reale falliva** (`tools/backup-worker/private-state.mjs`): il fingerprint dello stato `private` usava i nomi tabella come identificatori SQL invece che come stringhe. Nessun controllo statico eseguiva quella query.
2. **Privilegi riaperti dal restore** (`tools/restore-test-worker/database.mjs`): un progetto Supabase nuovo concede per default tutto ad `anon`/`authenticated` sugli oggetti nuovi di `public`. `pg_dump` scrive i grant rispetto ai default di PostgreSQL, quindi il restore riapriva privilegi revocati dalle migrazioni (anche TRUNCATE e EXECUTE su funzioni SECURITY DEFINER). Il guard audit A.1 lo bloccava facendo fallire il restore. Ora i default del target vengono azzerati nella transazione di restore e lo schema ripristina quelli della sorgente.
3. **Policy Storage e trigger di guardia persi** (`tools/backup-worker/managed-surface.mjs`): le policy RLS su `storage.objects` e il trigger `continuity_bucket_private_guard` stanno in schemi gestiti esclusi dal dump. Ora sono salvati come _managed overlay_ cifrato e riapplicati.
4. **Schedulazioni `pg_cron` perse**: salvate nello stesso overlay e riattivabili solo al cutover.
5. **Metadati Storage riscritti dall'upload** (`tools/restore-test-worker/storage.mjs`): dopo il caricamento dei byte il restore riapplica le righe `storage.objects` ripristinate.
6. **Restore reale sempre in errore** (`tools/restore-worker/start.mjs`): non passava `latest_version` alla verifica della history migrazioni.

## Cambiamenti per file

- `tools/backup-worker/`: `managed-surface.mjs` (overlay + fingerprint di sicurezza), `start.mjs` (overlay cifrato e `security_surface` nel manifest, controllo di stabilità durante il dump), `private-state.mjs` (fix SQL), `replica.mjs` (export di `directoryProof`).
- `tools/restore-test-worker/`: `database.mjs` (reset default privileges, overlay, verifiche), `storage.mjs` (riapplicazione metadati), `start.mjs` (gate `managed_overlay` e `security_surface`, nomi dei gate falliti nel log).
- `tools/restore-worker/start.mjs`: stessi gate e fix `latest_version`.
- `tools/disaster-restore/`: ripristino offline da copia primaria o replica, CLI con conferme esplicite.
- `tools/local-dr-rehearsal/`: prova completa (`npm run continuity:local-dr`).
- `supabase/migrations/20261018114500_continuity_offline_disaster_restore_registration.sql` + manifest.
- `tests/database/continuity-sql.test.ts`: esegue sullo schema completo le query inviate dai worker.
- `BACKUP_RESTORE.md`: sezione sulla prova e sui difetti.

## Schema, API, RLS

- Nuova RPC `public.record_disaster_restore(...)`, `SECURITY DEFINER`, eseguibile solo da `service_role`. Finalizza il backup tramite `finish_backup_job` (tutti i guard esistenti restano attivi) e registra il job `RESTORE` passando da `VERIFYING` a `CUTOVER_REQUIRED`, così scattano i guard di `restore_jobs`. Richiede un Super Admin attivo come operatore. Il go-live richiede sempre `confirm_restore_cutover` con step-up.
- Nuova voce di catalogo audit `DISASTER_RESTORE_VERIFIED`.
- Migrazione **non applicata** a nessun database remoto.

## Test eseguiti

| Comando                                                                                    | Esito                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `npm run continuity:local-dr` (commit `c7a0802`)                                           | PASSED, 18/18 gate                    |
| `npx vitest run` (unit + database PGlite)                                                  | 35 file, 301 test superati, 4 saltati |
| `tests/database/continuity-sql.test.ts` con il bug reintrodotto                            | fallisce come atteso                  |
| `npm run typecheck`, `npm run lint`                                                        | superati                              |
| `npm run check:migrations`                                                                 | 484 migrazioni verificate             |
| `prettier --check` sui file toccati                                                        | superato                              |
| 19 controlli statici Step 12 (`check-backup-*`, `check-restore-*`, `check-step12-*`, ecc.) | tutti superati                        |
| `tools/audit-local-pg/replay.sh` (A.1) con la nuova migrazione                             | 43/43                                 |

Non eseguiti: `npm run test:e2e`, `npm run release:check`, `npm run build` (nessun file frontend toccato). Node 24 richiesto da `package.json` non disponibile nel container: usato Node 22.

## Prove mancanti e rischi

- **Staging Supabase reale**: `supabase db dump` vero, servizio Storage ospitato, GoTrue, Vault. In particolare va confermato che l'upsert Storage ospitato riscriva i metadati come modellato e che `postgres` possa aggiornare `storage.objects` e azzerare i default privileges sul progetto ospitato.
- I backup creati prima di questo formato non superano più il restore test (manca `managed_overlay`): serve un backup nuovo appena il worker aggiornato è in esecuzione.
- RPO/RTO di produzione non misurati; la prova locale non li sostituisce.
- Cutover reale (secrets, Edge Functions, Auth, domini, provider) non provato.
- Il thread di riconciliazione migrazioni deve includere `20261018114500` nella sequenza canonica.

## Release gate interessati

`backup_restore_database_auth_storage` (resta aperto), restore test periodico, gate audit append-only A.1 (verificato anche dopo il ripristino).

## Prossimo task

Eseguire `backup:once`, `restore-test:once` e `tools/disaster-restore` su due progetti Supabase di staging dedicati e vuoti, con autorizzazione esplicita, e misurare RPO/RTO reali.
