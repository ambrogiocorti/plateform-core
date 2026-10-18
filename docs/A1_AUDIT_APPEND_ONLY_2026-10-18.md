# Macro-step A.1 — Audit append-only (18 ottobre 2026)

Stato: **IN PROGRESS**. Correzione implementata nel sorgente e verificata localmente;
**NON VERIFICATA** su Supabase Development, staging o production. Nessuna migrazione è
stata applicata a database remoti. Rilascio commerciale: **NO-GO**.

## Base di lavoro

- Branch: `plateform/a1-audit-append-only-inbac1`, creato dalla punta della PR #41
  (`plateform/two-phase-completion-20261013`, commit `9781525`).
- `main` al 18/10: `eb8dddd` (solo documenti di handoff sopra `a36da14`).
- Dal branch `fix/p0-audit-recovery-20261012` sono stati recuperati
  `docs/P0_AUDIT_RECOVERY_2026-10-12.md` e `supabase/tests/audit-capture-smoke.sql`
  (commit `134034c`, `1a7a219`, `30f1278`). Le modifiche ai gate di release §§151–157
  dello stesso branch non sono incluse: cambiano il perimetro Core e vanno decise a parte.

## Percorsi che potevano perdere o scartare eventi (sorgente PR #41)

Verificati con replay completo delle migrazioni su PGlite e su PostgreSQL 16 reale:

| Percorso                                                                                    | Effetto                                                                                               |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Trigger `plateform_dev_pause_audit` presente (disabilitato) su padre e 5 partizioni         | Un solo `ENABLE TRIGGER` lo riattiva; su Development la funzione remota scartava gli INSERT           |
| Partizioni mensili senza trigger `audit_no_truncate`                                        | Il proprietario poteva svuotarle con `TRUNCATE`                                                       |
| `service_role` con `TRUNCATE, UPDATE, DELETE, REFERENCES, TRIGGER` sulle partizioni mensili | `TRUNCATE` diretto riuscito su PostgreSQL 16; `TRIGGER` consentiva di agganciare un trigger di scarto |
| Protezioni in modalità `ORIGIN`                                                             | Disattivate da `session_replication_role=replica`                                                     |
| Nessun controllo su regole, `DETACH`/`DROP` di partizioni, trigger aggiunti                 | Manomissioni silenziose non rilevate dai gate                                                         |

## Correzione: migrazione `20261018103000_audit_append_only_partition_guards`

1. Rimuove `plateform_dev_pause_audit` da padre e partizioni e la funzione che lo
   eseguiva (qualunque sia il nome remoto), se non usata da altri trigger.
2. `private.guard_audit_table()`: revoca privilegi impropri, crea `audit_no_truncate`
   dove manca, imposta `audit_immutable` e `audit_no_truncate` in `ENABLE ALWAYS`,
   abilita RLS. Applicata al padre e a ogni partizione esistente.
3. `private.ensure_audit_monthly_partitions()` applica le stesse protezioni alle nuove
   partizioni e verifica le invarianti nella stessa transazione.
4. `private.audit_append_only_violations()` (sola lettura) e
   `private.assert_audit_append_only()`; `get_audit_certification_gates` espone
   `append_only_violations`, `ddl_guard_installed` e i motivi
   `AUDIT_APPEND_ONLY_GUARD_VIOLATED` / `AUDIT_DDL_GUARD_NOT_INSTALLED`.
5. Event trigger `plateform_audit_ddl_guard` e `plateform_audit_drop_guard`: rifiutano
   disattivazione o rimozione delle protezioni, trigger non previsti o `BEFORE INSERT`,
   regole, privilegi impropri, `DETACH` e `DROP` delle partizioni. Se la piattaforma
   nega gli event trigger al ruolo che applica la migrazione, la migrazione prosegue con
   un `NOTICE` e il gate di certificazione resta bloccato con
   `AUDIT_DDL_GUARD_NOT_INSTALLED`. Un superuser può sempre aggirarli: sono difesa in
   profondità, non sostituiscono privilegi e copie esterne WORM.

Nessuna riga di audit viene modificata, spostata o eliminata. I trigger osservatori
`AFTER INSERT` esistenti restano in allowlist; ogni nuovo trigger sull'audit richiede
una migrazione che aggiorni l'allowlist.

## Test eseguiti (Node.js 24.22.0)

| Comando                                                                                     | Risultato                                                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run test:db` su PR #41 prima delle modifiche                                           | 166 superati, 4 saltati                                                          |
| `npm run test:db` dopo A.1                                                                  | 177 superati, 4 saltati (11 nuovi)                                               |
| `npm run test:unit`                                                                         | 121/121                                                                          |
| `npm run format:check`, `typecheck`, `lint`, `build`                                        | superati                                                                         |
| `npm run check:migrations`                                                                  | 483 migrazioni allineate al manifest                                             |
| `check:migration-promotion`, `check:local-bootstrap`, `check-continuity-bootstrap-recovery` | superati                                                                         |
| `check:operational-readiness`, `check:core-*`, `check:step8/10/11`                          | superati                                                                         |
| `tools/audit-local-pg/replay.sh` su PostgreSQL 16.15 locale                                 | 483 migrazioni, 43/43 verifiche audit                                            |
| Stesso script sul sorgente PR #41                                                           | 482 migrazioni; `TRUNCATE` da `service_role` riuscito, trigger di pausa presente |
| `npm run requirements`, `npm run release:check`                                             | falliscono come previsto: sezioni pending e dossier di collaudo assente          |

`tests/database/audit-append-only.test.ts` esegue anche lo smoke test recuperato
`supabase/tests/audit-capture-smoke.sql`. PGlite e PostgreSQL locale girano come
superuser: i privilegi effettivi del ruolo `postgres` di Supabase e il supporto agli
event trigger vanno provati sull'istanza reale.

## Prove mancanti

- Applicazione su un progetto Supabase usa e getta (o branch) e poi Development, con
  backup e piano di rollback approvati; lettura di `get_audit_certification_gates`.
- Conferma che gli event trigger vengano creati dal ruolo di migrazione Supabase.
- Eventi reali generati da comandi staff autenticati (login, ordine, pagamento).
- Archivio esterno WORM, custodia chiavi, retention approvata (già nei gate esistenti).

## Rischi e note per l'applicazione

- La migrazione `20261012075300` (compatibilità del trigger di pausa) resta
  **retrodatata** rispetto alla storia remota e continua a bloccare la promozione:
  va risolta nella riconciliazione delle migrazioni (PR #32/#33), non qui.
- Sul Development remoto il trigger di pausa usa una funzione non presente in Git:
  la migrazione la rimuove solo se non è usata da altri trigger.
- Le partizioni non sono più accessibili direttamente a `service_role`: letture e
  scritture passano dalla tabella padre, come già fanno le funzioni del repository.
- Dopo la migrazione, una nuova partizione creata a mano senza
  `private.guard_audit_table()` fa fallire le successive istruzioni DDL monitorate
  finché non viene protetta (comportamento fail-closed voluto).

## Prossimo step

Applicare `20261018103000` a un ambiente Supabase usa e getta, verificare gate e
event trigger con i ruoli reali, poi proseguire con il macro-step successivo della
Roadmap: riconciliazione riproducibile delle migrazioni (PR #32/#33) e backup/restore
DB+Auth+Storage certificato.
