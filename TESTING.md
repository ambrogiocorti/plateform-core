# Verifica Plateform

## Stato attuale

Al 6 ottobre 2026 il repository contiene **130 migrations** allineate al Supabase development. I gate sorgente ripetibili `local:source-gates` coprono migrations, resi STEP 7, vault/causalità/reconnect/PWA STEP 8, Room Editor STEP 9, isolamento cross-venue STEP 10, sito pubblico/asset boundary STEP 11, continuity STEP 12, TypeScript, ESLint e Prettier.

Nella sandbox corrente questi gate sono verdi. Vitest/Vite/Playwright release restano da rieseguire su installazione pulita Node >=24.13 perché la `node_modules` recuperata qui contiene binding nativi Windows mentre il container è Linux. Questo è classificato `BLOCKED_ENVIRONMENT`, non PASS né FAIL del prodotto.

La procedura pre-GitHub è in `docs/LOCAL_RELEASE.md`; i collaudi manuali richiesti sono in `docs/LOCAL_MANUAL_TEST_CHECKLIST.md`. Revisioni complete pulite per il release gate commerciale: **0/3**.

## Comandi

| Comando                | Verifica                                                                |
| ---------------------- | ----------------------------------------------------------------------- |
| `npm run typecheck`    | TypeScript strict del client, bridge, codice condiviso e test Node      |
| `npm run lint`         | ESLint frontend/test/script; Edge Deno escluse da questa configurazione |
| `npm run format:check` | Prettier; specifica originale e SQL esclusi dalla riscrittura           |
| `npm test`             | Servizi puri e PostgreSQL PGlite                                        |
| `npm run build`        | Build separate pubblico/staff                                           |
| `npm run test:e2e`     | Contratti browser con fixture HTTP e server Vite dedicati               |
| `npm run check:edge`   | Controllo strict Deno delle Edge Functions                              |
| `npm run test:edge`    | CORS/payload, correlazione, hashing IP, firme provider e tipi asset     |
| `npm run requirements` | Gate di completezza: fallisce con requisiti incompleti                  |

## PostgreSQL locale incorporato

`tests/database/harness.ts` crea un database PGlite nuovo, ruoli anon/authenticated/service_role
e uno schema Auth di test. Applica in ordine tutti i file SQL di `supabase/migrations`.
I test eseguono davvero policy, PL/pgSQL, vincoli e transazioni PostgreSQL.

Copertura corrente: singleton e sedi, grant delle funzioni, RLS, MFA claim, sessioni revocate,
PIN, prezzi storici, stock atomico, idempotenza, audit, ordini, cucina/Pass/consegne,
sessioni cliente, cassa/pagamenti/mance, booking pacing, Host e isolamento tra sedi.
Quadrature: saldo esatto/differenza, blocco pending, rimborsi e storni sul servizio successivo,
immutabilità e contesto audit. Ricerca audit: filtri combinati, cursori con timestamp uguali e RBAC.
Conti: snapshot ordini paginato, storico pagamenti, rimborsi parziali, rilascio dei gruppi tavoli,
riaperture contabili che preservano i nuovi ospiti, retry di forzatura e riapertura.
Addebiti: distribuzione dei resti di sconto, coperture parziali per importo/prodotti,
rilascio delle selezioni fallite, approvazioni Admin e migrazione di incassi già presenti.
Servizio prepagato: visibilità KDS dopo chiusura, divieto di riutilizzare il tavolo,
spostamento e rilascio dopo consegna. Verifica UI del messaggio sul conto ancora in servizio.

I test della riserva di saldo e dell'ultima porzione verificano l'invariante transazionale.
PGlite serializza l'accesso: **non provano contesa simultanea su connessioni PostgreSQL separate**.
Questa prova deve essere aggiunta sul server PostgreSQL/Supabase completo.

## Browser

`tests/e2e/` usa Chromium e fixture HTTP esplicite.
Verifica il contratto frontend e la navigazione, non un backend simulato nell'applicazione.
Gli screenshot sono generati in `test-results/`, ignorata da Git.

Le schermate di login, home mobile, accoglienza mobile e quadratura mobile sono state ispezionate visivamente.
MFA, Auth, REST, Realtime, Storage e Edge devono ancora essere collaudati end-to-end
contro Supabase di sviluppo/staging.

## Edge e realtime

Deno 2.9.6 è fissato nel lockfile npm. `scripts/run-edge.mjs` usa una cache nel progetto;
le dipendenze server sono fissate anche in `supabase/functions/deno.lock`.
I test HTTP non richiedono rete e non chiamano Auth/Admin API: quelle integrazioni restano da verificare.

Il database verifica la pubblicazione di soli INSERT di `realtime_signals`, le RLS per ruolo,
il divieto di scrittura dal browser e l'assenza di eventi economici per Host/Super Admin/anon.
I test unitari coprono deduplica, ordine invertito, refresh in corso e recupero dopo errore.
Il test cliente genera una riconnessione e verifica che il carrello mantenga le quantità.
La distribuzione websocket di Supabase non è stata eseguita nell'ambiente disponibile.

## Gate prima di una release commerciale

Servono tutte le categorie §129–131 e §139, inclusi test di provider sandbox, duplicati
e fuori ordine, concorrenza tra casse e device, timeout dopo commit, revoca offline,
stampa indisponibile, ripristino backup e riconciliazione realtime.
Nessun test deve essere marcato passato soltanto perché manca la configurazione esterna.
Il gate production deve fallire se mancano credenziali/configurazione per un test obbligatorio.

Ogni revisione integrale rilegge i §§0–150, confronta UX/API/database/permessi/tests/docs,
registra difetti ed evidenze, corregge e riparte. Tre test run verdi non sono tre revisioni.

## Completamento locale aggiunto

- Configurazione/pianta: layout attivi, capienza e autorizzazioni senza dati dei conti per Host;
  upload idempotenti, quote su inserimento/riattivazione, notifiche pertinenti e priorità,
  regole cassa/provider e dispositivi stampa.
- Governance: statistiche economiche negate al tecnico, probe solo server, stato non verificato
  in assenza di misure, metriche nulle senza eventi e resilienza a telemetry legacy malformata.
- Provider: firma Stripe HMAC su byte esatti/scadenza e firma RSA Satispay; nessun account
  sandbox usato, nessun vero addebito o rimborso effettuato.
- Stampa: escape XML, mance separate, endpoint limitati, firme P-256 vincolate alle origini,
  deduplica SQLite durabile e ripresa dei SENT come UNKNOWN. Test HTTPS con certificato
  temporaneo e servizio ePOS simulato, non una stampante fisica.
- Offline: trust anchor, firme contraffatte/scadute, AES-GCM in IndexedDB di test, coda per
  ruolo/risorsa/versione, nessuna sovrascrittura di code altrui o corrotte, tre comandi SQL
  sicuri/idempotenti e rifiuto dei comandi finanziari. Il vecchio riferimento errato
  `start_step` è corretto a `start_order_step` nella migrazione 55.
- Privacy: export di una prenotazione senza note staff, ruolo/sede/password, rettifica,
  anonimizzazione, hold, batch disabilitati senza policy, lease e backoff delle identità.
  Soft deletion GoTrue e cron remoto richiedono integrazione vera.
- Browser: pagina privacy con download JSON e rettifica, configurazione versionata,
  technical health non simulata come verde, mappa da tastiera e controlli mobile.
  Screenshot privacy mobile ispezionato; audit accessibilità completo ancora da eseguire.
- Release: gate negativo con requisiti incompleti, integrazioni mancanti, digest modificato
  o review con difetti. Nessun dossier reale compilato, nessuno ZIP commerciale generato.

## Ambiente di esecuzione di questa verifica

Node 24.19.0, Deno 2.9.6, Chromium headless shell locale. Il download del browser atteso
non era disponibile nell’ambiente: Playwright 1.63.0 resta fissato nel progetto e può usare
un eseguibile compatibile tramite `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Questa esecuzione
non copre Safari, iOS, Firefox né la matrice completa dei dispositivi commerciali.

Il workflow CI non è stato eseguito su GitHub. Nessun test è segnato passato per mancanza
di credenziali esterne. I sette gate reali di `check-release.mjs` restano aperti.

Controlli live aggiuntivi: `check:runtime`, `check:edge-http`, `check:gateway`. Richiedono
un riferimento progetto esplicito; il probe gateway è temporaneo e solo development.
Vedere `docs/REMOTE_CONFIGURATION.md` per preparazione, ripristino e limiti delle evidenze.

## Gate STEP 11

`npm run check:step11` verifica staticamente contratto branding, selezione sede/prenotazione, navigazione mobile accessibile, SEO/noindex, contrasto, separazione output public/staff e boundary della telemetry pubblica. I helper di routing/contrasto hanno test unitari in `tests/unit/public-site.test.ts`. Il gate statico non sostituisce i test real-browser: accessibilità WCAG AA, Web Vitals, upload autenticato e routing HTTPS devono essere provati sul deployment reale prima di marcare lo step `COMPLETE`.

## Gate UX operativo — WAITER / RUNNER

`scripts/check-waiter-service-ux.mjs` è un gate sorgente/runtime puro della Local RC e viene eseguito da `npm run check:waiter-ux` e da `local:source-gates`. Verifica priorità dei tavoli, distinzione RUNNER-only rispetto alle assegnazioni miste, raggruppamento degli step cucina, presenza delle sorgenti authoritative parallele e dei comandi contestuali `transition_waiter_call` / `deliver_step`, oltre ai marker responsive/touch della vista Servizio.

Il gate **non** sostituisce il collaudo browser: tempi reali del flusso tavolo→ordine, persistenza del contesto durante Realtime, touch/scroll su smartphone, accessibilità e resa visuale devono essere misurati nella checklist `docs/LOCAL_MANUAL_TEST_CHECKLIST.md`. Nessuna RLS, grant o state machine economica è stata semplificata per ottenere il percorso rapido.

## STEP 8 — live deterministic offline sync (2026-10-05)

- Supabase development, fixture transazionale completamente rollbackata.
- 21/21 controlli PASS: authorization/workspace, replay idempotente, causal predecessor, `VERSION_CONFLICT`, mutazioni solo sugli eventi accettati, Conflict Center `DISCARD → REJECTED`, status reconciliation, revoca device/session/snapshot, conflitto post-revoca, notifiche e audit.
- `store_offline_authorization` resta fuori dal ruolo `authenticated`; il probe ha rispettato il trusted signer/server boundary.
- Evidenza: `docs/evidence/step8-live-offline-sync-2026-10-05.json`.
- Resta il browser release gate PWA install/update + online→offline→online + IndexedDB.

## Gate UX operativo — CASHIER

`scripts/check-cashier-ux.mjs` verifica la command center desktop-first della Cassa: ricerca conto immediata, workspace selezionato con totale/pagato/residuo/pending, prodotti e pagamenti recenti, F2/F4, pagamento senza perdita del contesto principale, divisione/prodotti, stampa, pending payment warning e refresh in-place. Le postazioni, quadrature e verifiche pendenti restano disponibili ma sono spostate sotto l'area di incasso primaria.

Il dialog pagamento mantiene il comportamento storico per gli altri flussi e accetta soltanto in Cassa un callback opzionale di completamento, così conferma manuale e ritorno dal provider aggiornano la workspace selezionata senza forzare la navigazione a `/conti/{id}`.

Il gate non sostituisce l'E2E finanziario. Restano obbligatori i test browser con due casse concorrenti, `CASH`/`CARD_POS`, pagamenti parziali e misti, double-click/retry, timeout dopo commit, stampa e verifica che F2/F4 non aggirino autorizzazioni o state machine server-side. Le RPC usate dalla workspace non sono eseguibili da `anon`; `get_account_workspace` delega al guard `private.can_read_account()`.

## Gate UX operativo — KITCHEN_ADMIN

`scripts/check-kitchen-admin-ux.mjs` verifica il coordinamento cucina sopra la KDS esistente: riepilogo server-side autorizzato, carico per stazione, ritardi >10/>20 minuti, ricevuti/in preparazione/pronti, resi recenti e preservazione del workflow operativo `REMAKE/CANCEL_REQUEST`. La vista di coordinamento resta disponibile anche quando la KDS non contiene comande attive.

La RPC `get_kitchen_admin_overview` legge `returned_items` solo server-side e autorizza esclusivamente `ADMIN`/`KITCHEN_ADMIN`; non apre accesso diretto alla tabella. Restano obbligatori il browser E2E su display/tablet, il test Realtime con più stazioni attive e la misura delle frizioni reali durante un servizio.

## Gate UX operativo — ADMIN

`scripts/check-admin-ux.mjs` verifica la cabina di regia Admin: `/operazioni` come landing, separazione esplicita `OPERATIVITÀ`/`CONFIGURAZIONE`, riepilogo authoritative unico per sala, accoglienza, cucina, cassa e segnali operativi, priorità immediatamente azionabili e accesso alla KDS già autorizzata. La RPC `get_admin_operational_overview` è scoped per sede e ruolo `ADMIN`, non espone fatturato nella home operativa e non concede EXECUTE ad `anon` sul development.

Restano obbligatori il browser E2E con account Admin reale, la verifica Realtime durante un servizio concorrente, accessibilità/focus della sidebar raggruppata e la misura delle frizioni per gli interventi più frequenti. La dashboard non sostituisce statistiche, audit tecnico o configurazione.

## 2026-10-05 — Step 11 asset authorization/RLS live gate

- Edge `asset-upload` deployed ACTIVE v5 with `verify_jwt=true`.
- Deployed handler verifies `auth.getUser()`, validates MIME magic bytes, 5 MiB maximum, SHA-256, rate limit, then reserves an authoritative path through the user-scoped RPC before privileged Storage upload.
- Transactional live probe: **11/11 PASS**.
  - exact retry returns the same reserved asset;
  - foreign venue is rejected with `VENUE_FORBIDDEN`;
  - invalid document MIME is rejected with `INVALID_ASSET`;
  - quota is enforced with `STORAGE_LIMIT`;
  - direct authenticated Storage INSERT is rejected by RLS;
  - own private document is visible to venue ADMIN, foreign document is hidden;
  - WAITER cannot reserve assets and sees no private documents.
- Probe fully rolled back. Real HTTPS upload of bytes from an authenticated browser session remains open because this container cannot reach the project domain.
- Evidence: `docs/evidence/step11-live-asset-authorization-2026-10-05.json`.

## 2026-10-05 — Step 12 live continuity state

- Development currently has one scheduled backup still `QUEUED` since 2026-10-04T12:28:30Z, no completed/verified artifact and no restore jobs.
- Automatic continuity incidents are correctly OPEN: `CONTINUITY_BACKUP_QUEUE_STUCK` (DEGRADED), `CONTINUITY_VERIFIED_BACKUP_MISSING` (WARNING), `CONTINUITY_RESTORE_TEST_MISSING` (WARNING).
- This is a **fail-closed operational PASS for alerting**, not a continuity release PASS. A real Plateform continuity runtime on independent infrastructure, verified encrypted backup, restore test and measured RPO/RTO remain mandatory.
- Evidence: `docs/evidence/step12-live-continuity-state-2026-10-05.json`.

## Gate UX operativo — SUPER_ADMIN

`scripts/check-super-admin-ux.mjs` verifica che il Super Admin entri su `Operational Health`, non su una dashboard Admin del ristorante, e che la vista tecnica sintetizzi versione applicazione/schema, core Supabase, error rate/p95, dispositivi, queue offline/conflitti e continuità backup/restore. Le scorciatoie restano tecniche (`servizi`, `continuità`, `code`, `dispositivi`, `audit`) e la hero non contiene KPI economici del ristorante.

`get_technical_workspace` continua a delegare alla base privata autorizzata `SUPER_ADMIN`. Un probe assente, `UNVERIFIED` o più vecchio di cinque minuti non viene presentato come sano. Il gate non certifica l'infrastruttura esterna: health probe reali, backup/restore test, dispositivi, alerting, error rate e code devono essere alimentati da evidenze runtime.

## Gate STEP 10 — Multi-sede live e UX

`scripts/check-step10-multivenue-ux.mjs` verifica il contratto frontend/statico: `MULTI_VENUE` controlla la complessità UI, una sola sede autorizzata viene selezionata automaticamente, il venue switcher compare soltanto con più sedi autorizzate, l'Admin `CHAIN` può scegliere l'aggregato statistiche, l'Admin `VENUE` non può elevare il proprio scope e il catalogo usa `venue_dish_settings` per gli override locali. La Command Palette può cambiare sede soltanto se `hit.venue_id` appartiene già a `context.venues`.

`docs/evidence/step10-live-cross-venue-2026-10-05.json` registra i probe transazionali eseguiti sul Supabase development reale: `ADMIN:VENUE` vede la propria sede ma non una sede temporanea né room/table/reservation/realtime signal/asset metadata/Storage object correlati; RPC con `venue_id` manipolato risponde `VENUE_FORBIDDEN`; scrittura diretta è negata; `ADMIN:CHAIN` vede entrambe le sedi; `MULTI_VENUE=false` impedisce una seconda sede attiva. Tutti i dati probe sono stati rollbackati.

Restano da provare su client reali la subscription WebSocket Realtime cross-venue e upload/download via Storage HTTP. Il gate PGlite `check-step10-cross-venue.mjs` resta obbligatorio in CI/toolchain completo e non viene considerato passato se la dipendenza embedded manca.

## STEP 12 — continuità: static regression e host readiness

`check-step12-static.mjs` passa la regressione statica **34/34**. Sono verdi anche encryption round-trip, snapshot consistency/fail-closed, replica indipendente e immutabile, HMAC manifest, migration-history recovery, Storage metadata integrity, retention filesystem safety, restore/cutover, alerting, target RPO/RTO e bootstrap/activation/secret configuration.

Il preflight del runtime di continuità Plateform nell'ambiente corrente restituisce `NOT_READY`: Node 22.16.0 invece del runtime richiesto, CLI `supabase`/`psql`/`docker` assenti e variabili/segreti di backup/restore non configurati. I worker `--check` falliscono `CONFIG_REQUIRED` quando manca configurazione obbligatoria; nessuna esecuzione reale è marcata PASS. Evidenza: `docs/evidence/step12-static-and-host-2026-10-05.json`.

## STEP 9 — funzioni avanzate: gate sorgente + probe live

`scripts/check-step9-advanced-ux.mjs` verifica il contratto sorgente di Advanced Room Editor (pointer drag, resize, zoom, snap, livelli, undo/redo, save/activate), Device Management (workspace, online/last seen, step-up revoke, heartbeat), Command Palette autorizzata e Advanced Analytics/CHAIN scope.

`docs/evidence/step9-live-probes-2026-10-05.json` registra i probe transazionali reali sul Supabase development: Analytics deterministico **26 controlli**, Device Management **9/9**, Command Palette **10/10**, Room Editor server-side **10/10**. Tutti i fixture e i feature flag temporanei sono stati rollbackati. Restano browser gesture E2E dell'Editor e build/browser release con Node >=24.13 e dipendenze complete.

### Correzione Analytics rilevata dal gate Step 9

Il gate avanzato ha rilevato che `get_operational_statistics` restituiva già capacità servizi, permanenza media, piatti annullati, errori operativi e incidenti, ma `statisticsSchema` non li dichiarava e Zod li eliminava dalla risposta frontend. La UI ora espone questi KPI e l'utilizzo capacità per servizio; il gate passa **16/16**.

## STEP 11 — internal hardening micro-gates (2026-10-05)

- Asset boundary live: **15/15 PASS** su fixture transazionale rollbackata (reservation idempotente, MIME/size/checksum, ruolo, service-only finish, private document RLS, audit).
- Magic bytes Edge upload: **8/8 PASS** per PNG/JPEG/WebP/PDF e spoofing MIME.
- Contratto anon pubblico: **13/13 PASS**; accesso diretto anon a staff/payments/audit/asset metadata negato.
- Fixture anon popolata: **11/11 PASS** su branding/content/contact/menu/service/form field, poi rollback completo.
- Edge `asset-upload`: **ACTIVE v5**, `verify_jwt=true`; deploy funzionalmente identico al sorgente locale (sola differenza: commento + newline finale).
- HTTP reale resta `BLOCKED_CONTAINER_DNS`; non è marcato PASS.
- Evidenza: `docs/evidence/step11-internal-hardening-2026-10-05.json`.

## STEP 10 — Realtime/transport split (2026-10-05)

- Server contract Realtime: **PASS** — `public.realtime_signals` pubblicata su `supabase_realtime`, RLS attiva, grant `SELECT` authenticated e policy `private.can_read_signal`.
- L'isolamento own/foreign era già PASS nel probe cross-venue SQL rollbackato.
- REST HTTPS, WebSocket Realtime e Storage HTTPS reali restano separatamente `BLOCKED_CONTAINER_DNS`.
- Evidenza: `docs/evidence/step10-realtime-transport-contract-2026-10-05.json`.

## STEP 7 — PDF A4 browser gate

`python scripts/check-step7-pdf-browser.py` passa su Chromium di sistema usando il renderer reale `src/printing/invoice.ts` e `styles/staff.css`: una pagina A4, testo parseabile, `NON FISCALE`, conto/tavolo, totale, pagamento, rimborso e footer non fiscale presenti. Evidenza: `docs/evidence/step7-pdf-browser-2026-10-05.json`.

Questo non sostituisce il collaudo fisico Epson/EPOS/print-bridge/offline-printer, che resta l'ultimo gate esterno dello Step 7.

## STEP 12 — gate rehearsal reale

`npm run continuity:rehearsal` è il runner operativo: non crea grant o richieste restore-test al posto del Super Admin; se il job TEST non è presente termina con `RESTORE_TEST_REQUEST_REQUIRED` e può essere rilanciato dopo la richiesta autorizzata.

`npm run check:step12-rehearsal` è separato dalla regressione statica: fallisce intenzionalmente finché non esiste evidenza reale di backup cifrato/HMAC con replica, restore-test sul target disposable allineato alla migration history corrente, RPO/RTO documentati. Le misure production e il cutover rehearsal restano gate di go-live/Step 13. Il rehearsal storico a 106 migration non può soddisfare questo gate. Baseline corrente: 130 migration, latest `20261006051256`, aggregate SHA-256 `7cb63618015f92a81eac5871e82904a845546f64cf0114d25958a8c09a668e9c`.

## STEP 12 — hardening control plane 6 ottobre 2026

Migration sync finale di questo ciclo: **130/130** con `20261006051256_step12_backup_requester_index.sql`; regressione Step 12 **34/34 PASS**. Gli Advisor non riportano più foreign key Step 12 senza indice; i soli `unused_index` sui tre indici nuovi sono informativi. `private.continuity_worker_heartbeats` resta deliberatamente fail-closed senza policy client e viene aggiornata esclusivamente dal percorso trusted.

Continuity alert/retention completion: `CONTINUITY_RETENTION_OVERDUE` lifecycle **5/5 PASS**. Il target disposable esistente `plateform-restore-test` è ancora presente ma `INACTIVE`; il tentativo di riattivazione è stato rifiutato da Supabase per il limite di due progetti free attivi. Nessun altro progetto è stato sospeso o modificato.

Altri gate live Step 12 del 6 ottobre: calcolo RPO/RTO **9/9**; alert soglie RPO/RTO/restore-test **13/13**; cutover pending alert **5/5**; matrice heartbeat RETENTION/RESTORE_TEST/RESTORE **10/10**; recovery alert backup/restore failure **8/8**; pg_cron inactive/active alert **6/6**. Il post-check conferma un solo `plateform-daily-backup` attivo con `*/5 * * * *` e nessun fixture residuo. Questi gate certificano il control plane e non sostituiscono la misurazione RPO/RTO su rehearsal reale.

Ulteriore hardening live del 6 ottobre: restore reference/actor FK indexes allineati agli Advisor; pre-restore snapshot failure **6/6**; restore worker state machine **12/12**; restore-test worker **9/9**; retention lease/purge **9/9**; retention durante restore attivo **4/4**; failure/retry retention **9/9**. Tutti i probe dati sono transazionali e rollbackati. Il test live del cutover finale resta `BLOCKED_TOOLING`; il gate statico cutover resta verde e non viene promosso a rehearsal reale.

Ulteriori gate transazionali live sul development: alert worker recovery **7/7**, scheduler RPO idempotente **5/5**, lease/reclaim backup **8/8**, restore su backup non eleggibile fail-closed **6/6**, finish backup failure/audit **8/8**, API permission manifest client **5/5**. La migration `20261006044128_step12_audit_error_code_visibility.sql` conserva ora `error_code` e `purpose` negli audit tecnici senza ampliare il payload a campi non whitelisted. La riconciliazione post-restore del runbook passa **11/11**.

### Step 12 control-plane hardening — 2026-10-06

- Restore-test su backup non verificato: **5/5 PASS**, fail-closed senza job/audit/idempotency residui.
- Retention/restore race guard: **5/5 PASS**; restore attivo blocca il claim retention, restore terminale lo rende reclamabile.
- Priorità coda backup: **7/7 PASS** (`PRE_RESTORE → RESTORE_TEST → MANUAL → SCHEDULED`) e un solo RUNNING.
- Single-active restore: **4/4 PASS** con `RESTORE_ALREADY_ACTIVE`.
- Lease restore-test: **7/7 PASS**, secondo worker bloccato e reclaim su lease scaduto con attempt incrementato.
- Finish restore failure guards/audit: **7/7 PASS**.
- Restore-test success state machine: **8/8 PASS** (`VERIFYING → SUCCEEDED`).
- Operational Health percorso positivo: RPO **7/7 PASS**, RTO **7/7 PASS**.
- Alert dinamici: RTO **5/5 PASS**, RPO **5/5 PASS**, con `AUTO_OPEN/AUTO_RESOLVED`.
- Performance hardening restore references: migration `20261006045641`, Advisor ripulito per `backup_id/pre_restore_backup_id`.
- Stato corrente: **130/130 migration**, Step 12 static **34/34**.

### Step 12 control-plane extended live gates — 2026-10-06

- Restore-test backup non eligible: **5/5 PASS**.
- Retention/restore race guard: **5/5 PASS**.
- Backup queue priority: **7/7 PASS** (`PRE_RESTORE → RESTORE_TEST → MANUAL → SCHEDULED`).
- Single active restore: **4/4 PASS**.
- Restore-test lease/reclaim: **7/7 PASS**.
- Restore completion failure guards + audit: **7/7 PASS**.
- Restore-test success state machine: **8/8 PASS**.
- Operational Health positive RPO: **7/7 PASS**; positive RTO: **7/7 PASS**.
- RTO dynamic alert recovery: **5/5 PASS**; RPO dynamic alert recovery: **5/5 PASS**.
- Continuity table RLS/grants: **8/8 PASS**.
- Restore FK performance advisor: **0** finding residui dopo le migration `20261006045641` e `20261006050249`.
- Stato: **130/130 migration**, Step 12 static **34/34**.

- Restore verification `mode=RESTORE` → `CUTOVER_REQUIRED`: **8/8 PASS**; nessun cutover/successo automatico.
