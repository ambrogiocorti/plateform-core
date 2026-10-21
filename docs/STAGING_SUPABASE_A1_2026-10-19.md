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

**Lacuna:** il database invoca 6 Edge Functions senza sorgente nel repository
(`reservation-message-worker`, `reservation-deposit-no-show-worker`, `continuity-retention-worker`, `audit-archive-worker`, `audit-archive-verify`,
`database-unavailable-chaos-probe`); su una nuova installazione quei lavori automatici non possono
girare.
Il backup vero e proprio non è fra queste: gira sull'host continuity (`tools/backup-worker`) e il
suo indirizzo è configurato per installazione in `continuity_worker_runtime_config.function_url`.

## Pagamenti in sandbox (20/10)

- Stripe in modalità test (chiavi `sk_test_` e segreto webhook nei segreti delle Edge Functions,
  mai nel repository). Satispay sandbox attivato con un codice di attivazione: chiave RSA generata
  in locale, registrata su `staging.authservices.satispay.com` (verifica firma: ruolo `DEVICE`),
  `SATISPAY_KEY_ID` e `SATISPAY_PRIVATE_KEY_PKCS8` salvati come segreti senza mostrarli. Il primo
  codice è stato rifiutato da Satispay (403, già usato o scaduto); il secondo ha funzionato.
- Suite `tests/e2e-staging/payments-stripe.spec.ts`, **PASS due volte di fila**: licenza `STRIPE`
  attivata dal Super Admin con TOTP e conferma password (Edge Function `step-up`), cassa con
  Stripe, Checkout Session reale pagata con la carta di prova 4242, esito confermato dal **webhook
  firmato** e dalla rilettura della sessione, conto chiuso, rimborso parziale di 5,00 € autorizzato
  dall'Admin con conferma password e confermato da Stripe (`PARTIALLY_REFUNDED`).
- `payments-satispay.spec.ts` (in due passaggi, perché il QR va pagato da una persona con l'app
  Satispay sandbox), **PASS**: licenza `SATISPAY_API`, pagamento `MATCH_CODE` creato dal server con
  firma RSA, QR pagato da Ambrogio con l'app sandbox, esito confermato in automatico dalla
  **callback Satispay** (senza intervento della cassa), conto chiuso, rimborso parziale di 5,00 €
  autorizzato dall'Admin con conferma password e confermato da Satispay (`PARTIALLY_REFUNDED`).
  Un primo QR lasciato scadere è stato registrato correttamente come `FAILED`.

Difetti trovati:

- `payment-return` non era in `supabase/config.toml`, quindi veniva pubblicata con `verify_jwt`
  attivo: dopo aver pagato il cliente vedeva `Missing authorization header`. Corretto.
- Supabase ospitato restituisce le risposte delle funzioni su `*.supabase.co` come testo semplice:
  la pagina HTML di ritorno appariva come codice. Ora è un messaggio in testo semplice; per una
  pagina curata serve un dominio personalizzato o il sito pubblico.
- `finish_provider_operation`: una seconda verifica con esito invariato lascia l'operazione
  `IN_FLIGHT` con il lease attivo per 45 secondi, quindi webhook e callback in quell'intervallo
  ricevono `OPERATION_IN_PROGRESS` e Stripe ritarda il nuovo tentativo. Segnalato al thread
  "Completare gli step dal 7 al 12", corretto con la migrazione `20261020090000` (applicata e
  verificata sullo staging, 493/493).
- Con la valuta adattiva di Stripe attiva, un browser non italiano vede l'importo in dollari: da
  valutare nelle impostazioni Stripe del ristorante.
- Supabase limita gli accessi con password per indirizzo IP (HTTP 429): la suite, che accede con
  molti utenti dalla stessa macchina, attende e riprova.
- La conferma password (`step-up`) accetta 5 conferme per utente ogni 10 minuti: è una protezione
  voluta, quindi due giri completi della suite vanno distanziati.
- Durante i giri ravvicinati sono comparsi alcuni errori generici e passeggeri ("Operazione non
  completata") su creazione conto e riapparecchio tavolo; rilanciati, gli stessi passaggi sono
  riusciti. La causa non è stata isolata: ora la suite registra il codice di ogni rifiuto del
  server.
- Ogni sessione di prova registra un dispositivo: la suite revoca quelli delle esecuzioni precedenti
  per non raggiungere il limite dell'installazione.

## Storage (20/10)

`tests/e2e-staging/assets.spec.ts`, **PASS** su Supabase Storage reale: l'Admin carica logo, foto
della galleria e foto del piatto tramite l'Edge Function `asset-upload`; un file falso viene
rifiutato prima dello storage; gli URL pubblici restituiscono esattamente i byte caricati; il menu
pubblico (anon) espone la foto del piatto; anonimi e staff non possono scrivere direttamente nei
bucket e il cameriere non può caricare file nemmeno tramite la funzione. L'Admin di prova dello
staging ora ha visibilità di catena, come nel fixture locale (il sito del brand è della catena).

## Funzioni automatiche (20/10)

Le 6 Edge Functions riscritte nel repo (head e604f30, migrazioni 495/495) sono pubblicate su staging. Chiavi generate e salvate
solo in Vault e nei secret delle funzioni, mai stampate.

| Funzione                           | Esito                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tutte e 6                          | senza chiave o con chiave sbagliata: **401** (continuity-retention-worker risponde 400 se il corpo non è valido, 401 se il corpo è valido)                                                     |
| reservation-message-worker         | coda vuota **IDLE**; job EMAIL con adattatore MOCK **SENT** (`tests/e2e-staging/messages.spec.ts`, licenza RESERVATION_MESSAGING data dal super admin con conferma password); cron ogni minuto |
| reservation-deposit-no-show-worker | **IDLE** dal cron (caparre non in licenza)                                                                                                                                                     |
| continuity-retention-worker        | **IDLE** con stato avvisi (`continuity_active` 4, nessun ritardo)                                                                                                                              |
| audit-archive-worker               | 5 lotti sigillati, 2041 righe; arretrato oltre la tolleranza 0                                                                                                                                 |
| audit-archive-verify               | **PASS** su 5 lotti / 2041 righe; condizione `archive_recovery_current` vera                                                                                                                   |
| database-unavailable-chaos-probe   | **PASS** registrato in `private.release_test_results`                                                                                                                                          |

Nota per la configurazione: `MESSAGE_DELIVERY_MODE` va impostato (`dry_run` o `live`). Se manca, il worker si ferma di proposito
e risponde 400 SERVICE_UNAVAILABLE senza prendere job. Su staging è `dry_run`: nessun provider reale viene contattato, i job MOCK
risultano inviati. In produzione andrà messo `live` solo quando ogni ristorante collega il proprio canale.

## Realtime (21/10)

`tests/e2e-staging/realtime.spec.ts`, PASS 3 volte (2 di fila con pulizia finale). Cucina e Pass restano aperti senza ricaricare
né navigare: l'ordine del cameriere compare in cucina e lo step pronto compare al Pass entro 10 s, sotto il controllo di riserva
ogni 30 s di `src/realtime/live.ts`, quindi arriva dal segnale Realtime. Entrambi gli schermi mostrano "Aggiornamenti connessi".
Il test incassa e chiude il proprio conto e chiude la giornata, così lo staging resta pulito.

## Caparra gruppi numerosi (21/10)

Head 249819e, migrazione 20261021090000 applicata (496/496); pubblicate reservation-deposit, reservation, stripe-webhook,
satispay-callback. `DEPOSIT_RETURN_URL` punta per ora alla pagina `payment-return` (manca il sito pubblico HTTPS): dopo il
pagamento l'ospite vede "pagamento in fase di verifica" e non torna da solo a `/prenota`.

- `supabase/tests/core_booking.live.sql` (id staging al posto di quelli Development): **PASS**, tutto in ROLLBACK.
- Licenza BOOKING_DEPOSITS data dal super admin con conferma password; regola dall'Admin in Pianificazione: 25 € da 6 persone,
  rimborso se cancellano 24 h prima (servizio di prova "Cena gruppi", conferma automatica fino a 12).
- `tests/e2e-staging/deposits-stripe.spec.ts`, Stripe test: gruppo di 8 dal sito pubblico → PENDING_DEPOSIT → Checkout con
  carta 4242 → webhook → RESERVED/COMPLETED (`cs_test_`); ARRIVED → SEATED → worker → **REFUNDED 25 €**, azione COMPLETED;
  no-show → **RETAINED**, nessun rimborso; caparra non pagata → dopo i 45 minuti reali **EXPIRED/EXPIRED** (la scadenza non è
  modificabile, by design). Tutti PASS.
- `tests/e2e-staging/deposits-satispay.spec.ts`: la creazione del pagamento Satispay sandbox funziona (pagina QR); manca il
  pagamento con l'app da parte di Ambrogio, poi conferma e rimborso.

## Prove mancanti

Backup/restore (rinviato da Ambrogio il 21/10: si fa sul server del ristorante; fino ad allora la pubblicazione resta bloccata su questo punto), frontend pubblicato in
HTTPS e dispositivi reali. Il rilascio resta **NO-GO**.
