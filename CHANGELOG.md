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
