# Changelog

## 0.1.0 — in sviluppo, non rilasciata

- Blueprint, matrici preliminari e tracciabilità della specifica commerciale.
- Toolchain TypeScript vanilla/Vite e due ingressi pubblico/staff.
- Schema e RPC iniziali per sicurezza, configurazione, servizio e cassa.
- Login/TOTP, gestione staff server, menu, conti, ordini, cucina/Pass, cliente QR e Host.
- Test PostgreSQL incorporato e contratti browser.
- Sessioni PIN/device, accoglienza con gruppi tavoli e invalidazioni realtime limitate dallo scope.
- Giornale contabile, quadratura immutabile, approvazione differenze Admin e ricerca audit paginata.

Molte funzionalità e verifiche richieste restano aperte. Questa versione identifica
il lavoro in corso e non costituisce una release commerciale delle Release 1–3 del master.

### CI browser riallineata — 9 ottobre 2026 (non rilasciato)

- Corrette sei fixture/azioni E2E obsolete senza cambiare i flussi applicativi; preservate verifiche finanziarie, step-up e scope. Aggiunto il caso di conferma cambio tavolo prima del comando versionato.
- Run GitHub 54 sul commit `3f35d78a0bb6a2e80772393bcc01327980504dbf` completata con successo: check completo/Edge/build, 242 test unit/database con quattro esclusi CORE, browser gate della build e 20 contratti Playwright.
- Supabase isolato, HTTP/JWT reale, restore corrente e attestazioni commerciali rimangono aperti; migrazione fail-closed non applicata su Development.

### Recupero baseline e gate evidenze — 9 ottobre 2026 (non rilasciato)

- Recuperate tutte le 457 migrazioni applicate da Development: 324 file mancanti e 24 SQL divergenti riconciliati con lo storico canonico, preservando gli originali. Nessuna modifica del database remoto.
- Installatore esplicito per database vuoti: sette tabelle private nel bootstrap, storico immutabile e due RPC operative nel postlude. Confronto ripetibile di catalogo, colonne, indici, vincoli e policy; escluse due diagnostiche specifiche di Development.
- Preparata una migrazione che ritira i PASS legacy senza attestazione e ne conserva autore/data/evidenza; blocca nuovi PASS tramite RPC e trigger. Applicazione Development respinta dal controllo automatico, CI autenticata ancora da realizzare.
- Allineati master e matrice a 158 sezioni (§§0–157), con binding SHA-256; nuovi requisiti pending e sole esclusioni CORE 79/80/90.
- Gate sorgente, TypeScript, lint, formato, 242 test e due build passano; quattro test esclusi CORE. Edge/browser e Supabase isolato restano aperti. Step 0 riaperto, nessuna release commerciale.

### Edizione CORE ridotta — 8 ottobre 2026 (non rilasciata)

- Formalizzato il perimetro richiesto per la vendita senza Stripe, Satispay (incluso POS Satispay) ed Epson/ePOS/bridge. Restano contanti, POS carta esterno con conferma operatore e stampa browser/PDF.
- Moduli staff aggiornati per impedire la selezione dei metodi di pagamento e dei driver non inclusi, anche quando presenti nello stato della sede o cassa già memorizzato.
- Resa la gestione dello storico dei provider esclusi in sola consultazione nella CORE; la dashboard Cassa non può più verificare manualmente Satispay POS e la stampa rifiuta anche i vecchi job destinati a EPOS/BRIDGE.
- I documenti browser/PDF sono esplicitamente non fiscali anche nel contenuto stampato; verifica sul contenuto reale di `printLines()`.
- Prenotazioni pubbliche: gli slot che richiedono caparra online sono esclusi; se una risposta stale richiede una caparra, il cliente viene informato senza creare un checkout o simulare conferma.
- Gate commerciale distinto per profilo FULL/CORE: soltanto le sezioni 79, 80 e 90 del master possono essere marcate fuori scope in CORE; gli altri 148 requisiti, 14 step e i test E2E/sicurezza/restore/review restano obbligatori.
- Verifiche pure `check:core-edition` e `check:core-release-profile` aggiunte alla pipeline; non equivalgono a collaudi di produzione.
- Il primo tentativo di applicare una policy CORE su Development era stato bloccato. Una successiva migrazione, descritta più sotto, è stata applicata e verificata su Development; questi stati storici non certificano Production.
- Resta il disallineamento 132/455 migrazioni locali/remote, non è stata installata la toolchain Node 24 né verificato uno staging HTTPS.

### CORE — hardening prudenziale aggiuntivo, 8 ottobre 2026 (non rilasciato)

- Filtro slot booking fail-closed anche su metadati `deposit` incoerenti con `status_if_booked` e su stati ignoti; UI informa senza offrire orari che potrebbero richiedere checkout online.
- Il pannello tecnico del Super Admin mostra Stripe/Satispay come `FUORI PERIMETRO CORE` anche se il flag remoto è rimasto concesso; questo non equivale a blocco RPC.
- La proposta SQL **non applicata** è stata rafforzata: controllo di preflight su operazioni/rimborsi/caparre/job aperti, disabilitazione della licenza `BOOKING_DEPOSITS`, trigger su licenze e configurazione dei registratori, nuove operazioni provider, metodi pagamento/rimborso e nuove stampe su driver esclusi. Corretto l'uso di uno stato rimborso inesistente nell'enum.
- Nuovo `check:core-server-policy` (26 contratti sorgente) richiesto dal gate commerciale CORE, oltre ai test API negativi reali obbligatori (compreso il divieto di nuove caparre online).
- Verifiche effettive: CORE 50/50; policy SQL 26/26 (SOLO STATICA); gate CORE 18/18; migrazioni locali 132/132; Step 8 16/16 e Step 12 statico 34/34. 16 gruppi UX/Step 11 disponibili superati, Step 10 cross-venue test PostgreSQL bloccato da `node_modules` incompleta.
- Preflight Node 22 / binding Vite-Rolldown assente e variabili staging non configurate; `release:check` nega il rilascio per assenza dossier reali. Rimane irrisolto lo storico SQL 132 locale / 455 Development. Nessuna migrazione, dato remoto o Production modificato durante questo incremento.

### CORE — Enforcement SQL Development, 8 ottobre 2026 (non rilasciato)

- Su Supabase Development il preflight CORE è passato: provider operations aperte 0, caparre pendenti 0, stampanti esterne attive 0, job di stampa esterni pendenti 0. I dati effettivi comprendono **2 pagamenti Stripe e 1 Satispay API REFUNDED**, **1 pagamento Satispay POS CANCELLED** e **3 rimborsi provider COMPLETED**. Queste righe storiche sono state preservate.
- Applicata `20261008181605_core_edition_payment_and_print_denial` (8 trigger), con licenze Stripe/Satispay/BOOKING_DEPOSITS a false e blocco delle nuove operazioni lato DB. SQL locale identico ai 5.552 byte e SHA-256 registrati dal database.
- Verificate 10 azioni negate e 3 update CORE consentiti, senza lasciare dati fixture (ROLLBACK); `release_security_gate` e `release_database_regression_gate` sono PASS.
- Restano obbligatorie prove RPC reali con JWT e ruolo, build Node 24, staging HTTPS, restore attuale, 3 review e recupero delle 323 migrazioni storiche. L'enforcement è **solo su Development** e non equivale a certificazione Production.

### UX operativa WAITER / RUNNER — 5 ottobre 2026

- Aggiunta la home staff `/servizio`, ora primo ingresso del ruolo WAITER, con priorità visibili per chiamate cliente, piatti pronti e tavoli assegnati.
- Caricamento operativo in parallelo da `get_floor_workspace`, `get_kitchen_board`, `waiter_calls` e `table_assignments`, senza introdurre una seconda source of truth.
- Aggiunte azioni contestuali per conto, ordine, chiamata cliente e consegna; con un solo conto attivo `Nuovo ordine` apre direttamente l'editor corretto.
- Estratto il flusso di creazione conto in un helper riutilizzabile; dopo la creazione è possibile passare direttamente ad `Aggiungi piatti`.
- Modalità RUNNER-only ridotta alle consegne READY; le assegnazioni miste mantengono la dashboard completa da WAITER.
- Rimossa la Command Palette dalla top bar dei ruoli operativi che non la richiedono, mantenendola per Admin/Super Admin/Host/Cashier.
- Aggiunto `check:waiter-ux` con gate su priorità, modalità runner, grouping step e contratto sorgente; nessuna modifica a RLS, permessi finanziari o API authoritative.
- Restano aperti collaudo reale smartphone, misurazione delle interazioni/tempi, regressione Realtime e rifinitura della navigazione mobile complessiva.

### Incremento — 3 ottobre 2026

- Migrazioni 31–55: quote uguali, catalogo/planning, editor grafico, correzioni ordini e conti,
  provider server, stampa/offline, job staff, governance, statistiche, booking e Storage.
- Pianta operativa accessibile per Host e sala, ricerca globale e UI delle assegnazioni.
- Regole servizio/cassa/stazioni, alias tavoli, dispositivi stampa e notifiche configurabili.
- Analytics aggregate, health probe reali, metrics Edge minimizzate e heartbeat device.
- Trust anchor offline, cache per utente/ruolo, tre operazioni non finanziarie in coda;
  corretto il dispatcher di avvio step e l’invio delle code su dispositivi condivisi.
- Bridge HTTPS con firma breve server, digest documento, SQLite persistente e test TLS.
- Privacy prenotazioni: export, rettifica, anonimizzazione, hold e retention approvata;
  worker server con pseudonimizzazione delle identità cliente e retry con backoff.
- Workflow CI/retention, documentazione obbligatoria e gate dell’archivio commerciale.
- Nessuna migrazione, integrazione provider o pubblicazione remota eseguita in questa fase.

Non è una release commerciale. Tre revisioni integrali pulite: 0/3.

### Fondamenta verificate sul nuovo progetto — 3 ottobre 2026

- Ripresa del checkpoint nel rispetto della Roadmap a step; Step 0: configurazione remota e collaudo gateway completati.
- Nuovo Supabase development isolato, 58 migrazioni applicate e cronologia/versioni riconciliate con SHA-256.
- Corretti grant API diretti che rendevano invocabili RPC staff/server da anon; riproduzione dei default Supabase nei test.
- RLS privata, revoca scritture API dirette e test dei default per tabelle/funzioni future.
- Request/correlation ID indipendenti client/Edge/audit/telemetry; configurazione ambienti e header generati.
- Corretta la quantità del carrello durante editing e riconciliazione della vista.
- 196 test unit/database, 19 browser con fixture, 11 Deno; strict/lint/formato/build verificati.
- Test PostgreSQL/PostgREST reali delle fondamenta; signup pubblico disabilitato, password minima 12, JWT 900s, TOTP e redirect esatti verificati.
- Gate commerciale esteso agli step 0–13; nessuna release ZIP creata o consegnata.

### Correzioni del collaudo Edge reale — 3 ottobre 2026

- Il client server inoltrava Authorization/apikey del chiamante: ora inoltra soltanto contesto diagnostico, con regressione Deno.
- L’header XFF non era attendibile sul gateway hosted: configurazione esplicita CF-Connecting-IP, IP validato e normalizzato.
- 13 controlli HTTP e 10 controlli gateway/rate limiting passati; telemetry correlata distinta da audit.
- Probe di collaudo temporanea, vincolata a development/capability/scadenza; entrypoint ordinario ripristinato dopo la prova.

### STEP 11 — sito pubblico e branding, 5 ottobre 2026

- Corretto il contesto multi-sede: selezione sede persistente tra menu/prenotazione e pagina dedicata `/sedi/{slug}`.
- La prenotazione sceglie soltanto sedi abilitate, evitando il fallback errato sulla prima sede non prenotabile.
- Aggiunti menu mobile accessibile, Restaurant JSON-LD e `noindex,nofollow` sui percorsi QR cliente.
- Rafforzato il branding configurabile con guardie di contrasto e rifiuto di URL social/privacy con schemi non sicuri.
- Deployata `public-telemetry` v1 per page view e Web Vitals minimizzati; scrittura anon diretta a telemetry e audit verificata negata.
- Gate statico STEP 11 e runtime puro passati. Il repository è stato successivamente riallineato al development a 112/112 migrations. STEP 11 resta `IN_PROGRESS`: mancano browser E2E asset upload, build Node >=24.13, audit WCAG/performance e separazione HTTPS reale public/staff.

### Consolidamento STEP 7–12 — 5 ottobre 2026

- Riallineata la codebase al Supabase development: **112/112 migrations** e manifest SHA-256 coerente; recuperate dalla migration history live le sei migrations STEP 9–11 mancanti nel checkpoint locale.
- STEP 7: Notification Center e print queue/retry verificati live con lifecycle, idempotenza e audit; restano identità PASS/KITCHEN_ADMIN e hardware Epson/bridge.
- STEP 8: snapshot offline, workspace, replay idempotente, conflitti, causal ordering, Conflict Center e revoca device verificati live; static gate 13/13.
- STEP 9: Device Management, Command Palette, Room Editor e matematica Analytics verificati live contro SQL indipendente; static gate 16/16.
- STEP 10: creazione/lifecycle sede, step-up, idempotenza, scope VENUE/CHAIN, catalogo condiviso con override locale e venue switcher verificati; static gate 15/15.
- STEP 12: gate statico completo **26/26 PASS**, inclusi backup/restore, cifratura, HMAC, replica, retention, private state, cutover e continuity host contract.
- Corrette cinque incompatibilità TypeScript rilevate dal typecheck reale, portati ESLint e Prettier a PASS e rafforzato `checkPrerequisites()` del backup worker contro root non canoniche/symlink.
- Resi i checker STEP 11/12 indipendenti dalla sola formattazione Prettier senza ridurre i marker semantici richiesti.
- Vitest/Vite/browser release restano non eseguiti: la sandbox ha Node 22.16 e la `node_modules` recuperata contiene binding nativi Windows Rolldown; Plateform richiede Node >=24.13. Nessun gate release è stato falsamente marcato PASS.

### STEP 8 — causal queue reconciliation, 5 ottobre 2026

- Aggiunto predecessore causale locale per gli eventi offline dello stesso utente/sede.
- Estesi gli stati locali della queue a `SYNCING`, `REJECTED`, `RESOLVED` e introdotta una policy condivisa degli stati terminali.
- Prima del replay il client riconcilia gli eventi già conosciuti dal server tramite `get_offline_sync_statuses`.
- I successori restano bloccati solo finché il predecessore non è terminale; una risoluzione Admin che produce `REJECTED` sblocca correttamente la catena.
- Il reconnect rinnova authorization snapshot e workspace; in caso di refresh fallito vengono eliminate le cache offline sensibili ma la queue viene preservata.
- Le risorse con eventi non terminali e le queue appartenenti ad altri utenti restano bloccate.
- Nuovo gate statico STEP 8: **16/16 PASS**; test puro della queue policy PASS. Il browser E2E release resta aperto.

### 2026-10-08 — Step 11 venue fail-closed and development SQL regressions

- Public venue selection now fails closed for unknown explicit venue slugs instead of displaying another venue’s menus and prices. Invalid venue metadata is noindex without canonical/JSON-LD from the default venue.
- Static host 404 restoration is restricted to same-origin public application routes; /staff without a slash is treated as staff.
- Added unit and Node runtime/static regressions; Development SQL rollback tests passed for notifications, conflicts, venue scope, overrides, room editor and reservation workflows.
- Commercial release remains blocked by incomplete migration source, Node 24 dependencies, staging/browser E2E, provider/hardware gates and three independent reviews.

### 2026-10-08 — Step11 security permission manifest (Development)

- Registered the four existing public read RPCs under `anon` and `authenticated` in the authorization manifest (8 entries) without granting any new privilege.
- Applied `20261008163112_step11_public_rpc_permission_manifest.sql` to Development; reproduced the exact applied SQL checksum in source and updated the local manifest to 131 versioned files.
- Verified `release_security_gate` green (0 undocumented grants, 0 disabled RLS tables). Remaining 323 applied remote migrations and production readiness gates are still open.

### 2026-10-08 — Repeatable Notification Center DB test and honest restore gate

- Repaired the private SQL Notification Center test fixture's expired full-auth window, with transactional rollback, without changing real authentication controls.
- Stabilized eight Step12 validator regressions against an isolated historical manifest; retained explicit failure for obsolete restore evidence against the current source.
- Database regression, security and test-catalog gates remain green on Development at 455 applied migrations; 323 historical SQL files remain missing locally.

- Reran available dependency-free role UX and Step9/11/12 checks; separate blocked PGlite/fake-indexeddb gates from passing tests in the latest verification log.

### 2026-10-08 — Step11 Realtime and public performance lifecycle hardening

- Public analytics now bind performance observations to a captured route and venue context, instead of attributing CLS from a previous menu to the next SPA route.
- QR/customer session paths never emit public analytics. Historical document TTFB/FCP timings are not re-emitted for SPA navigation; pagehide handlers and observers are disconnected on route cleanup.
- Leaving an active venue, or failing to load the public site, closes stale public Realtime subscriptions and performance observers. Error fallback removes canonical/structured restaurant metadata and sets `noindex,nofollow`.
- A stale asynchronous page-render failure can no longer replace a newer successful navigation; invalid venue context also skips the SEO RPC and removes inherited Open Graph URLs.
- Added a zero-npm TypeScript observer regression harness; included in `npm run check:step11-runtime` and verified alongside static, prerender, booking and build-assembly gates.
- **Not certified**: real hosted Chromium user journeys, Node >=24.13 full npm CI, 323 missing historical applied SQL files, stage deployment, provider/hardware certification and current-schema restore.

### 2026-10-08 — CORE Development server enforcement and booking regression

- Applied `20261008181605_core_edition_payment_and_print_denial` on the Development project only: eight SQL triggers block excluded payment methods, provider commands, booking-deposit licences and Epson print drivers; historical refunded/cancelled/completed transactions remain untouched.
- Verified 10 server-side negative SQL cases and 3 allowed CORE updates in rollback-only transactions; release security and database regression gates remain green.
- Added `supabase/tests/core_booking.live.sql` with CORE-safe live booking, idempotency, large-group and deposit-fail-closed tests, exercised successfully against Development with rollback.
- The two older FULL-edition booking/deposit probes now fail by design under CORE licence denial and must not be represented as current test PASS. Full CI, JWT/HTTP E2E, staging, 323 migration files, current-schema restore and three independent reviews remain required.

### 2026-10-08 — CORE public venue selectors and telemetry privacy regression

- Removed contradictory multi-venue resolution when a venue detail path and `?sede=` identify different venues; repeated `sede` query parameters are now rejected, not silently resolved to the first venue.
- Booking from an explicitly selected venue that does not accept reservations now fails closed rather than silently redirecting to another location. Venue detail rendering uses the same authoritative selection as booking and SEO.
- Public metric deduplication retains only an allowlisted venue slug, not arbitrary query parameters containing possible email, phone, token or tracking values. The initial document timing key uses the same sanitized normalization so UTM parameters do not suppress the first-page timing metrics.
- Verified dependency-free public routing/booking/telemetry tests, STEP11 static checks and a 31-case Chromium desktop/mobile static HTML audit. CORE source, SQL policy, release profile, migration-manifest and STEP12 static checks remained green in the available environment.
- **Release not approved:** these checks do not replace the Node >=24.13 full build, authenticated HTTP/JS browser E2E, 323 missing historical migrations, current restore and production readiness. Production was not accessed.

### 2026-10-08 — CORE Edge Functions deny provider/bridge execution on Development

- Added fail-closed checks in the authenticated `payments` and `print-authorization` Edge handlers, sharing the same immutable CORE capability flags as the client.
- Development `payments` v10 and `print-authorization` v3 deployed ACTIVE; source inspected after deployment to verify guard order before sensitive RPCs.
- Added `check:core-edge-guards` as a mandatory local/CI release source gate and required authenticated HTTP/JWT denial evidence in the CORE commercial release gate. The source tests pass but the remote authenticated HTTP test has **not been performed**.
- Retained historical provider/print records and browser/PDF CORE support; Production unchanged. This is not a release approval.
