# Staging Supabase reale — catena migrazioni e A.1 (19 ottobre 2026)

Progetto: `plateform-staging` (ref `qfgoatdabgnzozxuzxku`, eu-west-1, piano Free, PostgreSQL 17.11,
ruolo `postgres` **non superuser**). Development (`abdxvlykasqmknexxhjo`) e production non sono
stati toccati. Accesso: Supabase Management API (`POST /v1/projects/{ref}/database/query`) con
token personale iniettato dal proxy dell'ambiente cloud, mai visibile nei log o nel repository.

Base: branch `plateform/migrations-reconciliation-4dgntr` (PR #47, commit `6adb208`, 485 migrazioni)
più la nuova migrazione `20261019090000_installation_edge_function_urls.sql` (branch locale
`plateform/staging-edge-url-fix`).

## Esito

| Verifica                                                    | Risultato                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay da database vuoto, in ordine                         | **486/486** applicate, nessun errore                                                                                                                                |
| Storico `supabase_migrations.schema_migrations`             | 486 righe, sha256 di ogni file **identico** al manifest                                                                                                             |
| A.1 audit append-only (`tools/staging-api/verify_audit.py`) | **63/63 PASS** (9 partizioni, rotazione inclusa, smoke test incluso)                                                                                                |
| Event trigger DDL come `postgres` non superuser             | **installati e attivi** (`plateform_audit_ddl_guard`, `plateform_audit_drop_guard`): DROP partizione/trigger respinti con `AUDIT_APPEND_ONLY_DDL_REJECTED`          |
| Trigger `plateform_dev_pause_audit`                         | assente                                                                                                                                                             |
| Sonde sicurezza `supabase/tests/security/10…19`             | **10/10 PASS** su Supabase reale, ognuna in `BEGIN … ROLLBACK`; canary di fallimento verificato                                                                     |
| Security Advisor                                            | 0 ERROR; 10 WARN anon = sole RPC pubbliche del sito/prenotazioni; 225 WARN authenticated `SECURITY DEFINER` (modello RPC-only); 66 INFO RLS senza policy (deny-all) |
| Performance Advisor                                         | 83 FK non indicizzate, 199 indici inutilizzati (database vuoto: non indicativo)                                                                                     |

## Difetto trovato e corretto

Sei chiamate del database verso le Edge Functions avevano l'URL di **Development scritto nel
codice** (`invoke_reservation_message_worker`, `invoke_reservation_deposit_no_show_worker`,
`invoke_database_unavailable_chaos_probe`, `private.dispatch_continuity_retention_worker` e i job
cron `plateform-audit-archive-encrypted` / `plateform-audit-archive-recovery-verify`). Ogni nuova
installazione cliente avrebbe inviato i propri worker a Development. Inoltre la catena non creava
`pg_net` (su Development era stato abilitato a mano), quindi su un'installazione nuova quei job
fallivano con `schema "net" does not exist`.

La migrazione `20261019090000` (additiva):

- crea `pg_net` dove disponibile;
- aggiunge `private.edge_function_url(nome)`, non eseguibile da `anon`/`authenticated`/`service_role`,
  che legge la base URL dal secret Vault `plateform_edge_functions_base_url` oppure la ricava da
  `private.continuity_worker_runtime_config.function_url`; senza configurazione fallisce con
  `EDGE_FUNCTIONS_BASE_URL_NOT_CONFIGURED`, mai verso un altro progetto; rifiuta URL non `https`;
- ridefinisce le sei chiamate cambiando solo l'URL;
- fallisce se resta un URL di progetto fisso in funzioni o job cron.

Verificato su staging: errore senza configurazione, URL corretto con secret (transazione annullata),
URL `http://` rifiutato, `authenticated` senza permesso.

**Passo di installazione nuovo** (ogni cliente, anche Development alla promozione):

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'plateform_edge_functions_base_url');
```

Fino a quel momento il job `plateform-reservation-deposit-no-show-refunds` registra
`EDGE_FUNCTIONS_BASE_URL_NOT_CONFIGURED` ogni minuto (atteso su staging, dove le Edge Functions non
sono ancora pubblicate).

## Note e scostamenti

- **80 righe di test permanenti nell'audit di staging.** Una prima versione dello script di verifica
  inseriva le righe fixture nella stessa transazione delle sonde UPDATE/DELETE; sulle 4 partizioni
  future vuote quelle sonde non trovavano righe, non fallivano e la transazione veniva confermata.
  Le righe (`action='A1_FIXTURE'`, `resource_type='test'`) sono immutabili per costruzione e restano
  nello staging. Lo script ora inserisce una riga in ogni partizione e termina ogni sonda con
  un'eccezione di guardia, quindi nessuna sonda può più confermare dati. Lo script locale
  `tools/audit-local-pg/verify.sh` inserisce 5 righe permanenti per progetto e va usato solo su
  database usa e getta.
- I vecchi test `supabase/tests/*.live.sql` (3 ottobre) non sono più allineati alla catena
  (allowlist RPC anon superata, fixture con ID di Development) e falliscono su un database nuovo;
  le sonde `security/1*.sql` li sostituiscono.
- I gate di `get_audit_certification_gates()` restano bloccati su staging per motivi attesi:
  nessun login/MFA fallito osservato tramite Edge auth gateway, nessun record Auth nativo, nessuna
  prova di archivio, WORM esterno, custodia chiavi e policy di retention non certificati. Append-only,
  DDL guard e legal hold risultano conformi.
- Lo schema temporaneo `staging_loader` usato per il caricamento è stato eliminato.
- Le migrazioni della PR #48 (`20261018130000`…`20261018140000`) non sono applicate sullo staging.

## Edge Functions e flusso reale (pomeriggio 19/10)

- Pubblicate sullo staging le 13 Edge Functions del repository con
  `tools/staging-api/deploy_functions.sh` (import locali risolti in modo transitivo, `verify_jwt` da
  `supabase/config.toml`). Segreti di staging impostati (`ENVIRONMENT=staging`, `PAYMENTS_MODE=test`,
  `RATE_LIMIT_SECRET` casuale); secret Vault `plateform_edge_functions_base_url` creato.
- Suite `tests/e2e-staging` (`playwright.staging.config.ts`): frontend staff locale su Vite contro
  GoTrue, PostgREST, RPC ed Edge Functions reali dello staging. Ristorante "Trattoria E2E" con 5
  utenti di prova; password casuale a ogni esecuzione.

| Test                                                                                                                                                       | Esito                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Servizio completo a 4 dispositivi: tavolo, ordine, cucina, Pass, consegna, cassa, chiusura conto, quadratura e chiusura postazione, tavolo riapparecchiato | **PASS**, due esecuzioni consecutive |
| Admin: password, iscrizione TOTP reale, codice errato rifiutato, accesso `aal2`                                                                            | **PASS**                             |
| Prenotazione online: disponibilità anon, Edge Function `reservation`, idempotenza, gruppo `REQUESTED`, payload non valido 400                              | **PASS**                             |

Difetti trovati e corretti (commit `8e64e98`): dopo un codice MFA errato il messaggio copriva il
pulsante "Verifica e accedi" e non diceva che il codice era sbagliato (ora è in linea); un tavolo
chiuso (`TO_RESET`) mostrava "Nuovo conto" che falliva con un errore di connessione generico (ora
la scheda offre "Tavolo riapparecchiato" e l'errore `TABLE_NEEDS_RESET` è spiegato).

**Lacuna:** il database invoca 7 Edge Functions senza sorgente nel repository
(`reservation-message-worker`, `reservation-deposit-no-show-worker`, `continuity-retention-worker`,
`continuity-backup-worker`, `audit-archive-worker`, `audit-archive-verify`,
`database-unavailable-chaos-probe`); su una nuova installazione quei lavori automatici non possono
girare.

## Prove mancanti

Le 7 Edge Functions senza sorgente, pagamenti Stripe/Satispay in sandbox, Storage (upload logo e
foto), Realtime senza ricarica pagina, backup/restore su Supabase ospitato, frontend pubblicato in
HTTPS e dispositivi reali. Il rilascio resta **NO-GO**.
