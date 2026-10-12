# Plateform — registro di avanzamento

Aggiornamento: 5 ottobre 2026. **Versione commerciale non ancora pronta.** Fonte primaria: checkpoint corrente + Supabase development `abdxvlykasqmknexxhjo` + Definition of Done della Roadmap.

| Step                               | Stato       | Nota corrente                                                                                                                                                                                                              |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Fondamenta                     | COMPLETE    | gate già chiuso                                                                                                                                                                                                            |
| 1 — Accesso/configurazione         | COMPLETE    | gate già chiuso                                                                                                                                                                                                            |
| 2 — Core operativo                 | COMPLETE    | gate già chiuso                                                                                                                                                                                                            |
| 3 — Cassa/pagamenti base           | COMPLETE    | gate già chiuso                                                                                                                                                                                                            |
| 4 — Cliente/QR                     | COMPLETE    | gate già chiuso                                                                                                                                                                                                            |
| 5 — Prenotazioni/Host              | COMPLETE    | gate già chiuso                                                                                                                                                                                                            |
| 6 — Finanza/provider               | COMPLETE    | Stripe e Satispay sandbox E2E chiusi; payment/refund, callback/webhook, idempotenza, retry/reconciliation e regressione rimborsi verificati                                                                                |
| 7 — Notification Center/stampa     | IN PROGRESS | Notification Center, print queue/retry e resi autenticati PASS/KITCHEN_ADMIN verificati live; PDF A4 non fiscale verificato in Chromium reale; resta hardware Epson/bridge reale                                           |
| 8 — PWA/offline/sync               | IN PROGRESS | sync/Conflict Center/snapshot verificati live 21/21; vault core AES-GCM, causalità, reconnect e PWA runtime verificati; resta solo browser reale del build online→offline→online/install/update                            |
| 9 — Editor/analytics/search/device | IN PROGRESS | backend, matematica KPI, scope ricerca, revoca device e Room Editor verificati live; static gate 16/16; resta regression browser/build reale                                                                               |
| 10 — Multi-sede                    | IN PROGRESS | creazione/lifecycle, idempotenza, scope VENUE/CHAIN, override menu e isolamento RPC verificati live; restano REST/Realtime/Storage e browser E2E cross-venue                                                               |
| 11 — Sito pubblico/branding        | IN PROGRESS | hardening pubblico avanzato, telemetry live, contrasto/server renderer e smoke browser mobile PASS; asset boundary server-side live 15/15; restano Edge HTTP upload reale, audit WCAG/performance e deployment HTTPS reale |
| 12 — Backup/restore/continuità     | IN PROGRESS | repository/live riallineati a 130 migrations e gate statico completo 33/33 PASS; manca backup+restore reale sul runtime di continuità Plateform in infrastruttura indipendente con RPO/RTO misurati                        |
| 13 — Hardening/go-live             | TODO        | da eseguire solo per ultimo                                                                                                                                                                                                |

## Consolidamento 5 ottobre 2026

Il repository corrente è stato riallineato al Supabase development: **130/130 migrations** presenti e verificate contro `supabase/migration-manifest.json`. Sono stati recuperati dalla migration history live i sei file mancanti relativi a contrasto branding STEP 11, correzioni Analytics STEP 9 e lifecycle/idempotenza multi-sede STEP 10.

Gate sorgente eseguiti sulla workspace corrente:

- `scripts/check-migrations.mjs`: **PASS — 130 migrations**;
- `scripts/check-step11-static.mjs`: **PASS**;
- `scripts/check-step12-static.mjs`: **PASS — 33/33**;
- TypeScript `tsc --noEmit`: **PASS sul sorgente Plateform**; la sandbox usa un declaration shim temporaneo per `saxes`, assente nella `node_modules` recuperata, e quindi non sostituisce il gate release con installazione pulita;
- ESLint: **PASS**;
- Prettier: **PASS**.

Vitest/Vite non vengono marcati falliti né superati: la `node_modules` recuperata proviene da Windows e contiene binding nativi Rolldown Windows, mentre il container è Linux; inoltre il progetto richiede Node >=24.13 e il container corrente usa Node 22.16. Il gate release build/browser resta quindi **BLOCKED_ENVIRONMENT** finché non viene eseguito su toolchain Linux pulita conforme al lockfile.

## STEP 6 — chiuso il 5 ottobre 2026

Stripe e Satispay API sono stati verificati end-to-end in sandbox: creazione pagamento, ritorno/callback o webhook, stato provider authoritative, ledger Plateform e rimborso. Il test Satispay ha prodotto callback duplicate gestite idempotentemente; i replay terminali, gli eventi stale `WAITING`, il mismatch dello stesso event id e il percorso timeout/esito remoto incerto → retry → riconciliazione sono stati verificati senza duplicare eventi o operazioni.

Durante il collaudo è emerso e corretto un difetto reale: un pagamento completamente rimborsato restava contabilizzato sulle billing units e impediva un nuovo incasso. La migration `20261005140800_step6_refund_reopens_balance.sql` rende l'allocazione effettiva al netto dei rimborsi completati e aggiorna lo stato conto dopo refund manuali/provider. Verifica finale: nessuna incoerenza tra provider/payment/refund, nessun over-refund, nessuna billing unit sovra-allocata, nessun lease terminale residuo e nessun `last_error` su operazioni provider completate.

Il gate STEP 6 è quindi **COMPLETE**. Evidenza consolidata: `docs/evidence/step6-final-2026-10-05.json`.

## STEP 7 — evidenze correnti

Notification Center verificato live in transazioni rollback: isolamento per ruolo, scadenza automatica, lifecycle `NEW → ACKNOWLEDGED → RESOLVED` e audit. Print queue verificata live: `QUEUE/CLAIM → FAILED → RETRY → SUCCESS`, lease/attempts, `reprint_of` e audit coerenti.

Il flusso resi è ora verificato live con identità reali `PASS` e `KITCHEN_ADMIN`: `RIFARE` riporta correttamente il piatto a `RECEIVED`; `ANNULLARE` crea una richiesta `RETURN_CANCELLATION` `PENDING`, mantiene il piatto `READY` fino alla decisione Admin, supporta rifiuto e approvazione, chiude la notifica `RETURN_APPROVAL`, produce audit PASS + ADMIN e, in approvazione, porta item/ordine a `CANCELLED`. È stato inoltre corretto il controllo economico per usare l’allocazione effettiva al netto dei refund completati, evitando doppio rimborso su pagamenti già `REFUNDED`. Evidenza: `docs/evidence/step7-returns-authenticated-2026-10-05.json`.

È inoltre disponibile un dispositivo virtuale `PDF / Browser A4`: i documenti di conto possono essere resi in layout A4 stile fattura e salvati dal dialogo di stampa del browser come PDF. Il documento è esplicitamente marcato **NON FISCALE** e il relativo snapshot contabilizza pagamenti e rimborsi senza duplicare gli importi. Evidenza: `docs/evidence/step7-pdf-output-2026-10-05.json`.

È stata inoltre aggiunta un’uscita `PDF / Browser A4` gestita da Plateform: usa lo stesso snapshot authoritative del conto, renderizza un documento A4 in formato fattura/copia di cortesia, espone chiaramente `NON FISCALE` e gestisce pagamenti netti e rimborsi completati senza duplicarli. Il backend e lo snapshot refund-aware sono verificati live; resta da eseguire il salvataggio PDF reale nel browser con il frontend aggiornato.

Il PDF A4 è stato anche verificato in Chromium reale: 1 pagina A4 parseabile con marker `NON FISCALE`, totale, pagamento e rimborso. Evidenza: `docs/evidence/step7-pdf-browser-2026-10-05.json`. Resta aperta la prova fisica Epson/print bridge con stampante offline e recovery su hardware rappresentativo.

## STEP 8 — evidenze correnti

Vault core micro-gate (5 ottobre 2026): **PASS** sul codice reale `src/offline/vault.ts` con storage in-memory solo nel test harness. Verificati AES-GCM roundtrip, ciphertext senza plaintext, `clearOffline()` che preserva la sola queue, queue manomessa → `OFFLINE_QUEUE_UNREADABLE` e `additionalData` che impedisce il riuso del ciphertext sotto un nome diverso. Il test di integrazione con IndexedDB/browser reale resta separato e bloccato dalla policy Chromium del container.

PWA runtime: `STEP8_STATIC_GATE=PASSED 16/16`, `STEP8_CAUSALITY_GATE=PASSED`, `STEP8_RECONNECT_GATE=PASSED`, `STEP8_PWA_RUNTIME_GATE=PASSED`. Il runtime verifica versionamento cache per contenuto, rimozione cache obsolete, fallback offline, cache-first asset, separazione scope public/staff e `ACTIVATE_UPDATE`.

Probe deterministico live aggiuntivo (5 ottobre 2026): **21/21 PASS** su fixture transazionale rollbackata. Verificati replay esatto senza duplicazione, predecessor causale terminale, `CAUSAL_PREDECESSOR_REQUIRED`, `VERSION_CONFLICT`, assenza di mutazioni sugli eventi rifiutati, risoluzione Admin `DISCARD → REJECTED`, reconciliation degli stati, revoca device/session/snapshot e rifiuto del comando successivo con `OFFLINE_AUTHORIZATION_CHANGED`. Evidenza: `docs/evidence/step8-live-offline-sync-2026-10-05.json`.

Verificati live: authorization snapshot, workspace offline, sync riuscita, replay idempotente, status reconciliation, `VERSION_CONFLICT`, causal ordering, Conflict Center con `DISCARD`, revoca device al reconnect, notifiche e audit. Static gate: **16/16 PASS**. Il client ora assegna un predecessore causale all’ultimo evento non terminale della stessa coppia utente/sede, riconcilia gli stati server prima del replay, considera `SYNCED`/`REJECTED`/`RESOLVED` terminali e rinnova authorization snapshot + workspace dopo il reconnect. Un fallimento del refresh invalida cache/autorizzazione sensibile senza cancellare la queue. Il live SQL conferma che `sync_offline_event` accetta gli stessi stati terminali e che `resolve_sync_conflict` porta l’evento sorgente a `REJECTED`.

Resta aperto il gate browser reale PWA `online → offline → online`, install/update e persistenza IndexedDB nel build di release. Il probe live completo è stato eseguito su fixture transazionale artificiale e completamente rollbackata: **21/21 PASS**. Il vault core è stato inoltre riverificato sul codice reale con harness in-memory: cifratura AES-GCM, assenza plaintext, queue preservata al logout, tamper fail-closed e binding `additionalData` al nome record. Chromium del container blocca ogni navigazione HTTP/HTTPS/file con `ERR_BLOCKED_BY_ADMINISTRATOR`, quindi il browser E2E resta `BLOCKED_ENVIRONMENT`, non fallito.

## STEP 9 — evidenze correnti

Verificati live:

- Device Management: heartbeat online/current, revoca di device + sessione + snapshot offline, step-up e audit;
- Command Palette: Admin vede risorse autorizzate, Waiter non riceve `STAFF`/`DISH` privilegiati;
- Room Editor: save/versioning/revision, activate, version conflict e blocco `LAYOUT_IN_SERVICE`, con audit;
- Analytics: preparazione 360 s, delivery 120 s, stay 5.400 s, receipts/refunds/net/tips, prodotti, prenotazioni/no-show/cancellazioni, capacità, chiamate, errori, incidenti e average check; i risultati RPC sono stati confrontati con query SQL indipendenti;
- frontend Device Management e multi-sede già collegati; static gate STEP 9 **16/16 PASS**.

I probe live deterministici aggiuntivi registrano Analytics 26/26, Device Management 9/9, Command Palette 10/10 e Room Editor server-side 10/10 (`docs/evidence/step9-live-advanced-gates-2026-10-05.json`). Resta aperto il browser regression/build reale; per questo STEP 9 rimane **IN PROGRESS**.

## STEP 10 — evidenze correnti

Verificati live in transazioni rollback:

- `MULTI_VENUE=false` baseline con singola sede;
- creazione seconda sede tramite RPC Super Admin, step-up, audit e replay idempotente;
- Admin scope `VENUE` isolato da sede non assegnata e manipulated-ID bloccato;
- utente assegnato a più sedi e differenza `VENUE` vs `CHAIN` sugli aggregati;
- catalogo condiviso + override prezzo/abilitazione per sede;
- lifecycle `create → update → deactivate → reactivate`, versioning `1→4`, step-up e audit;
- venue switcher mantiene la pagina corrente e ripara selezioni sede stale/non autorizzate;
- static gate STEP 10 **15/15 PASS**.

Il probe live cross-venue aggiuntivo conferma `ADMIN:VENUE` senza leak su venue/room/table/reservation/realtime/asset/storage metadata, RPC manipolata `VENUE_FORBIDDEN`, scrittura cross-venue inefficace, `ADMIN:CHAIN` su due sedi e `MULTI_VENUE_DISABLED` quando la feature è off (`docs/evidence/step10-live-cross-venue-2026-10-05.json`). Restano aperti i gate E2E cross-venue via REST/Realtime/Storage e browser reale. I tentativi di fixture diretta `storage.objects` sono stati correttamente fermati dai guardrail del connettore e non vengono aggirati.

## STEP 11 — stato corrente

Implementati e verificati: selezione sede deterministica, persistenza contesto sede, fallback prenotazione solo verso sedi abilitate, vera pagina `/sedi/{slug}`, navigazione mobile ARIA, contrasto branding client+server, URL pubblici sicuri, Restaurant JSON-LD, canonical/OpenGraph, `noindex,nofollow` sui QR cliente e telemetry pubblica minimizzata per page view/Web Vitals.

La Edge Function `public-telemetry` è live sul development. `anon` non può scrivere direttamente in `telemetry_events` né accedere ad `audit_log`. Le migrations di contrasto branding sono live e ora presenti anche nel repository locale. Static gate STEP 11: **PASS**.

Browser accessibility smoke reale su Chromium 390×844: landmark, H1 unico, focus, menu ARIA, link nominati e contrasto 9,35:1 PASS (`docs/evidence/step11-browser-a11y-2026-10-05.json`). Asset boundary server-side verificato live **15/15**, magic-byte validation **8/8**, contratto anon pubblico **13/13** e fixture pubblica popolata **11/11**. `asset-upload` deployato è ACTIVE v5 con `verify_jwt=true` ed è funzionalmente allineato al sorgente locale. Restano: upload E2E via HTTPS da sessione staff reale, release build/toolchain Node >=24.13, audit WCAG AA completo/Web Vitals in browser reale e deployment HTTPS che dimostri routing/cache separati fra pubblico e staff.

## STEP 12 — stato corrente

Il controllo plane backup/restore, worker protocol, cifratura, HMAC, replica, retention, schema/migration/private-state binding, Operational Health, incident automation e restore cutover sono implementati. Il gate `scripts/check-step12-static.mjs` è ora **33/33 PASS** dopo aver reso i checker resistenti alla sola formattazione senza indebolire i marker semantici.

Lo step resta **IN PROGRESS** perché la Definition of Done richiede ancora un artifact reale prodotto su runtime di continuità Plateform su infrastruttura indipendente e un restore-test completo di quell'artifact con RPO/RTO osservati, oltre al rehearsal di cutover su infrastruttura reale.

## Blocchi esterni reali

- **STEP 7 / stampa:** il PDF A4 browser è già PASS; resta soltanto hardware Epson/bridge realistico con test stampante offline/recovery.
- **STEP 8–11 / browser release:** toolchain Linux pulita con Node >=24.13 e dipendenze native coerenti col lockfile; il container corrente ha Node 22.16 e la `node_modules` recuperata è Windows.
- **STEP 11:** ambiente HTTPS reale per routing/cache/origin e metriche browser.
- **STEP 12:** runtime di continuità Plateform su infrastruttura indipendente, storage/replica persistenti e credenziali server-side per backup/restore reale.
- **Infrastruttura Supabase:** `auth_leaked_password_protection` non è disponibile nell'attuale piano development Free; va risolto con piano/assetto production adeguato prima del go-live.

Plateform **non viene dichiarata production-ready** finché i gate aperti degli STEP 6–12 e infine lo STEP 13 non sono chiusi secondo la Definition of Done.

## Local Release Candidate pre-GitHub

È disponibile una RC sorgente locale con packaging dedicato e manifest SHA-256. `npm run local:preflight` valida Node/configurazione/binding nativo; `npm run local:source-gates` esegue i gate sorgente; `npm run local:verify` aggiunge Edge/Vitest/build e `npm run local:browser` aggiunge Playwright. La checklist manuale è `docs/LOCAL_MANUAL_TEST_CHECKLIST.md`. Lo ZIP locale esclude `node_modules`, `.git`, `.env.local`, segreti/certificati, cache, backup e stato print-bridge.

## UX staff prioritaria — Slice 1 WAITER / RUNNER — 5 ottobre 2026

Prima del redesign sono stati riconciliati i due checkpoint correnti: la Local RC a 112 migrations conteneva gate/browser/offline/device che non erano presenti nel checkpoint successivo, mentre il checkpoint STEP 7/8 più recente conteneva le 6 migrations e le correzioni provider/heartbeat/settings/reso/PDF successive. Il merge a tre vie sul checkpoint comune mantiene entrambe le linee e porta la workspace a **130/130 migrations** senza scartare Device Management, vault offline, causal reconciliation, gate locali o le nuove funzioni finanziarie/stampa.

**Modificato**

- introdotta `/servizio` come home operativa WAITER, smartphone-first;
- caricamento parallelo delle fonti authoritative già esistenti: floor workspace, kitchen board, waiter calls e table assignments;
- priorità operativa: chiamate assegnate, step READY, tavoli assegnati e relativo stato;
- azioni contestuali sul tavolo: nuovo conto, nuovo ordine, apertura conto e dettaglio tavolo;
- fast path `tavolo con un solo conto attivo → Nuovo ordine → editor ordine`, senza riselezione di tavolo/conto;
- flusso di creazione conto estratto e riutilizzabile, con passaggio diretto ad `Aggiungi piatti` dopo la creazione;
- modalità RUNNER-only con consegne READY, presa in carico e consegna; assegnazioni miste non vengono degradate a runner-only;
- top bar alleggerita per i ruoli operativi: Command Palette non esposta a WAITER/KITCHEN/PASS;
- CSS operativo dedicato con target touch grandi, gerarchia di urgenza e layout mobile.

**Testato / passato**

- Supabase development `abdxvlykasqmknexxhjo`: progetto `ACTIVE_HEALTHY` verificato prima delle modifiche;
- nessuna migration/RLS/grant modificata dal redesign; vengono riutilizzate RPC/policy authoritative già presenti;
- `node scripts/check-migrations.mjs`: **PASS — 118 migrations**;
- `node scripts/check-step8-static.mjs`: **PASS — 16/16** dopo il merge delle due implementazioni offline;
- `check-step8-causality`: **PASS**;
- `check-step8-reconnect`: **PASS**;
- `node --experimental-strip-types scripts/check-waiter-service-ux.mjs`: **PASS**;
- parsing TypeScript dei file modificati con Node type-stripping: **PASS**;
- `git diff --check`: **PASS**.

**Ancora aperto**

- toolchain release pulita Node >=24.13 con `npm ci`, `typecheck`, ESLint, Prettier, Vitest, Vite build e Playwright: il container corrente usa Node 22.16 e non costituisce ambiente valido per dichiarare questi gate PASS;
- test browser reale WAITER a 360/390/430 px, misurazione interazioni/tempo tavolo→ordine, Realtime senza perdita di contesto, accessibilità/touch;
- navigazione mobile staff complessiva ancora da rifinire come vera bottom navigation/action bar role-specific;
- prossimo redesign operativo: KITCHEN_STAFF e poi PASS, mantenendo gli stessi criteri di logica/permessi/realtime/regression.

Gli stati degli Step restano quelli del registro sopra: il redesign UX non sostituisce la Definition of Done e non promuove automaticamente Step ancora `IN PROGRESS`.

## 2026-10-05 — UX STAFF SLICE 2: KITCHEN_STAFF + PASS

### Modificato

- `src/pages/kitchen.ts`: KDS trasformata in workspace operativo a ticket con tavolo/step/tempo immediatamente leggibili, conteggio piatti pronti per il Pass, modifiche/varianti evidenziate e azioni primarie grandi.
- `styles/staff.css`: gerarchia KDS dedicata, timer tabulare, urgenza temporale, touch target operativi e layout responsive per tablet/display.
- `get_kitchen_board`: aggiunto `allergens` usando `order_items.allergen_snapshot`, quindi gli allergeni mostrati in cucina restano coerenti con lo snapshot storico dell'ordine invece di dipendere dal catalogo corrente.
- `20261005163939_kitchen_board_allergen_snapshot.sql`: migration applicata al Supabase development e registrata nel manifest.
- `scripts/check-kitchen-pass-ux.mjs`: gate statico dedicato alla UX KITCHEN/PASS e alla preservazione dei controlli server-side.

### Testato / passato

- Supabase development `plateform-development`: migration `20261005163939 kitchen_board_allergen_snapshot` applicata con successo.
- `node scripts/check-migrations.mjs`: **PASS — 119 migrations**.
- `node scripts/check-kitchen-pass-ux.mjs`: **PASS 9/9**.
- Security advisor rieseguito dopo la migration: nessun nuovo rilievo specifico introdotto da `get_kitchen_board`; restano advisor globali preesistenti da trattare nel gate di hardening, compresi warning sulle SECURITY DEFINER esposte intenzionalmente e INFO su tabelle private/RLS.

### Aperto

- Browser/E2E reale KITCHEN_STAFF e PASS su tablet/display con account di test e realtime attivo.
- Misura operativa: arrivo ticket → `IN_PREPARATION` → `READY`; READY completi → `PRONTO PER IL SERVIZIO`.
- Il container corrente usa Node 22 mentre il progetto richiede Node >=24.13.0 e non contiene `node_modules` completo: typecheck/lint/build completi non vengono dichiarati PASS in questo slice.
- Prossimo slice UX operativo: **HOST**, poi **CASHIER**, seguendo l'ordine del requisito prioritario.

### Evidence aggiuntive 2026-10-05 — Step 11 asset / Step 12 continuity live

- **Step 11 asset-upload**: Edge deployato `ACTIVE` v5 con `verify_jwt=true`; probe transazionale autorizzazione/RLS **11/11 PASS** (idempotenza, venue isolation, ruolo, MIME, quota, Storage write RLS, documenti privati). Resta aperto l'E2E HTTPS reale di upload byte da browser autenticato.
- **Step 12 continuity**: il development espone correttamente uno stato degradato reale: backup schedulato `QUEUED`, nessun backup verificato, nessun restore job; gli incidenti automatici `CONTINUITY_BACKUP_QUEUE_STUCK`, `CONTINUITY_VERIFIED_BACKUP_MISSING` e `CONTINUITY_RESTORE_TEST_MISSING` sono OPEN. Step 12 resta `IN_PROGRESS` finché non esistono artifact + restore rehearsal + RPO/RTO misurati.

- **Step 10 Realtime/Storage live contract**: `realtime_signals` è pubblicata in `supabase_realtime` con RLS attiva e policy `private.can_read_signal`; il bucket `documents` è privato e l’accesso passa da `asset_uploads` RLS. Il probe live conferma own/foreign/WAITER isolation. Resta aperto il vero E2E client WebSocket/Storage HTTP.

### 2026-10-06 — STEP 12 control-plane hardening

- runbook riconciliazione post-restore: **11/11 PASS**;
- worker alert recovery: **7/7 PASS** transazionale;
- scheduler RPO idempotente: **5/5 PASS**;
- lease/reclaim backup: **8/8 PASS**;
- restore backup non eleggibile: **6/6 PASS**;
- finish backup failure guards + audit: **8/8 PASS**;
- API permission manifest `anon/authenticated`: **5/5 PASS**;
- migration `20261006044128_step12_audit_error_code_visibility`: applicata;
- repository/development: **130/130 migration**.

Lo STEP 12 resta `IN_PROGRESS`: non viene dichiarato completo senza un backup reale verificato e un restore test reale da artifact cifrato.

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
- Stato corrente: **130/130 migration**, Step 12 static **33/33**.

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
- Stato: **130/130 migration**, Step 12 static **33/33**.

- Restore verification `mode=RESTORE` → `CUTOVER_REQUIRED`: **8/8 PASS**; nessun cutover/successo automatico.
