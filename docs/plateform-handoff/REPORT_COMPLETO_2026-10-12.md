# PLATEFORM — REPORT COMPLETO DI STATO, PROBLEMATICHE E FUNZIONALITÀ MANCANTI

**Data:** 12 ottobre 2026. **Ambiente esaminato:** `plateform-development` (Supabase `abdxvlykasqmknexxhjo`), repository `ambrogiocorti/plateform-core`, deploy Vercel `plateform-development`. **Tipo di verifica:** audit documentale + letture in tempo reale delle configurazioni, schema, gate, advisory e inventario sorgente. **Nessun test operativo e nessuna scrittura applicativa effettuati per questo report.**

**Fonti primarie:** `MASTER_PROMPT_PLATEFORM_COMMERCIALE_AGGIORNATO.md` (§§0–157); `Roadmap.txt` (Step 0–13); `PLATEFORM_AUDIT_GO_LIVE_E_VENDITA_SUPABASE_2026-10-10.md`; `docs/ROADMAP_STATUS.json` (ultimo aggiornamento 8/10); `docs/IMPLEMENTATION_STATUS.md`; `docs/STEP11_PROGRESS_2026-10-08.md`; `docs/STEP11_CONTINUATION_VERIFICATION_2026-10-08.md`; `docs/REVIEWS.md`; `DEPLOYMENT.md`; `BACKUP_RESTORE.md`; sorgenti e DB live al 12/10.

**Verdetto:** **NO-GO per commercializzazione / produzione.** Plateform non è un semplice mockup: ha un core applicativo, API, procedure SQL e Edge Functions ampi. Tuttavia la completezza funzionale, la riconciliabilità dello schema, la protezione audit, la continuità reale, l'accessibilità e i percorsi end-to-end non sono attualmente certificati. I 15 gate PENDING costituiscono un blocco esplicito.

## Legenda rigorosa

- **[B] Bug/criticità confermata:** evidenza diretta nel DB, nei log, nel codice o nei gate al 12/10.
- **[I] Implementazione incompleta:** una parte necessaria per l'uso completo o la release è documentatamente mancante/non collegata a un percorso funzionante.
- **[V] Presente, ma verifica incompleta:** esistono componenti specifici, senza sufficiente prova reale E2E, hardware, provider o browser; **non** dire che la funzionalità è assente.
- **[L] Non disponibile nell'edizione CORE:** il flag attuale è `licensed=false`, indipendentemente dalla presenza di codice.
- **[R] Requisito di prodotto / rilascio ancora aperto:** responsabilità tecnica, operativa, commerciale o normativa.
- **P0:** impedisce go-live sicuro. **P1:** impedisce completare/accettare una release significativa. **P2:** importante per maturità UX/edizioni avanzate.

## 1. Fotografia attuale verificata (12 ottobre)

| Dato | Risultato | Interpretazione |
|---|---:|---|
| Database PostgreSQL | 17.11 | Ambiente Development. |
| Dimensione database | 60.298.931 byte, ~58 MB visualizzati | La saturazione a ~1,5 GB riportata il 10/10 non è più la situazione corrente. |
| Migrazioni SQL sul remoto | **479** | È un inventario remoto, non una prova di coerenza col Git. |
| File SQL presenti nel manifest Git | **134** | Inventario del sorgente più recente ispezionato. Divario numerico 345, da riconciliare per identità/hash, non solo per conteggio. |
| Auth / staff | 2 utenti / 2 profili | 1 `SUPER_ADMIN`, 1 `ADMIN`, attivi; entrambi hanno MFA verificata. |
| Sedi | 1 | Ambiente mono-sede. |
| Sale / layout / zone / tavoli / servizi | **1 / 1 / 0 / 0 / 0** | Nuova configurazione di prova parziale; nessun servizio avviabile su tavolo. |
| Conti / ordini / prenotazioni / pagamenti | **0 / 0 / 0 / 0** | Non è un test end-to-end di servizio completato. |
| Backup in `public.backup_metadata` | **0** | Non esiste attualmente una prova registrata di backup recuperabile sul dataset corrente. |
| File in Storage | **3.035** | ~192 MB da metadati, concentrati in bucket di continuità e archivio audit. Da riconciliare con i backup cancellati dal catalogo. |
| Job cron attivi | **16** | Non equivalgono a worker esterni sani o backup riusciti. |
| Audit applicativi | **0** | È attivo il trigger `plateform_dev_pause_audit` su tabella e partizioni. |
| Gate rilascio | **7 PASS / 15 PENDING** | Blocco commerciale. |
| `private.master_acceptance_requirements` | **116 PASS** | Risultati di catalogo storico; **non annullano** i gate PENDING. |
| `private.release_test_results` | **197 PASS** | Non certificano da soli una release browser/backup/production dello stesso commit. |
| `private.ci_runs` | **0** | Assenza di evidenza in questo registro; non dimostra assenza assoluta di GitHub Actions. |
| Applicazione Vercel | Esiste, deployment recentissimo READY | Corregge il vecchio audit che non vedeva Vercel. Non prova separazione completa staging/production o go-live. |
| Release applicativa censita | `0.1.0`, `STAGING`, commit `not-recorded` | Tracciabilità applicazione↔commit↔schema incompleta. |

**Nota:** questi conteggi sono letture puntuali, possono cambiare con l'uso del gestionale. La presenza di due utenti con MFA non certifica tutti i percorsi di sessione/recovery su browser e dispositivi differenti.

## 2. Problemi P0 confermati: risolvere prima di proseguire verso clienti

### P0-01 — Audit applicativi intenzionalmente sospesi [B]

Il trigger `plateform_dev_pause_audit` è **attivo** sulla tabella partizionata `public.audit_log` e su cinque partizioni. La funzione associata scarta le nuove righe. Questo spiega in parte le 0 righe di audit: le modifiche al DB non generano la traccia applicativa ordinaria. Lo stop era stato introdotto per alleggerire lo sviluppo dopo i problemi di volume, ma **impedisce test realistici di tracciabilità, accountability, non ripudio e retention**. Va disabilitato/rimosso con procedura controllata *prima* di ripetere test di sicurezza e comunque prima di ogni staging/prod; verificare che un'azione di prova produca audit append-only non alterabile e che le partizioni future siano correttamente protette. **Non disattivare i trigger di immutabilità.**

### P0-02 — Backup e restore non certificati per il database corrente [B/I]

`backup_metadata` è vuota; sono presenti oggetti nei bucket `plateform-continuity-primary` (2.998; ~188 MB da metadati), `plateform-audit-archive-primary` (23; ~3,5 MB) e rehearsal (14). Gli oggetti non costituiscono da soli un set di backup verificato. Nel registro Step 12 i worker, cifratura, manifest, code, retention, health e restore test sono sviluppati in buona parte, ma mancano prove di **backup DB + Auth + contenuti Storage + migrazioni** e **restore effettivo su target separato con integrità** alla versione corrente. Occorre verificare eventuali riferimenti orfani in Storage e policy di conservazione, senza cancellazioni indiscriminate. Nessun RPO/RTO misurato e accettato. **Blocco assoluto prima di acquisire dati di clienti.**

### P0-03 — Divergenza migrazioni e deploy non riproducibile [B]

Remoto: **479** migrazioni registrate. Repository/manifest: **134** file. Il documento dell'8/10 descriveva già divergenze di contenuto oltre alle migrazioni mancanti. Non è possibile dedurre che un database cliente ricreato da Git corrisponderebbe semanticamente a Development. Richiesti: export integrale affidabile delle SQL remote, match `versione:nome:SHA-256`, archiviazione delle baseline, riconciliazione non distruttiva, ricostruzione da zero di un progetto nuovo, grants/RLS/trigger/Edge/cron, upgrade e rollback. **Non “sanare” la divergenza inserendo falsi record nello storico.**

### P0-04 — Release, staging e production non certificati [B/R]

Vercel `plateform-development` esiste e serve la dashboard; il deploy recente Git è `READY`. Tuttavia i gate di staging e production sono ancora PENDING. Manca una catena certificata `commit → test → build → deploy staging isolato → E2E → approvazione → production`. La release `0.1.0` è marcata STAGING con `git_commit=not-recorded`. I documenti risalgono in parte a prima dell'attivazione di Vercel e vanno aggiornati. Nessun cliente deve essere spostato nel Development per sostituire staging o prod.

### P0-05 — Autenticazione e sicurezza: gate aperti e advisory da classificare [B/V]

Gate `AUTH_LEAKED_PASSWORD_PROTECTION` PENDING e warning Supabase attuale. Security Advisor segnala **10 funzioni SECURITY DEFINER eseguibili da `anon`**, **227 da `authenticated`**, **1 estensione in `public`** e **62 tabelle RLS senza policy** (molte `private`: deny-all può essere intenzionale). Non si tratta automaticamente di vulnerabilità ma serve un audit per funzioni, privilegi `EXECUTE`, controlli `auth.uid`, accesso Auth/Staff, privilegi cross-role/cross-venue, storage, impersonazione e RLS. Il percorso di autenticazione è stato recentemente corretto per bootstrap e MFA TOTP incompleta: va regressato con utenti realistici.

### P0-06 — Nuovi percorsi UX non certificati [B/V]

Nel percorso reale di collaudo sono stati osservati errori come `IMMUTABLE_RECORD`, `mfa_factor_name_conflict`, `INVALID_STAFF_COMMAND`, `USE_ROOM_EDITOR`, accompagnati da messaggi generici «Operazione non completata. Verifica la connessione...». Sono state apportate patch mirate al login, creazione staff e modulo layout e Vercel ha riportato deploy READY per la patch layout. Non è però stata effettuata una regressione completa dopo le modifiche. Occorrono messaggi contestuali per errore, pending state, idempotenza e percorso di recovery, non rimandi impropri alla connessione.

### P0-07 — Base dati e prove funzionali non comparabili alla versione candidata [B/V]

Attualmente esistono soltanto 2 utenti amministrativi e nessun cameriere, cuoco, cassiere, servizio, tavolo attivo, conto, ordine o pagamento: gli esiti PASS storici hanno fixture, rollback e versioni software differenti. Occorre un ambiente staging preparato per ciascun ruolo e un intero servizio cross-device. La mancanza di dati operativi non è una feature mancante, ma **impedisce affermare che il sistema corrente abbia superato il collaudo operativo**.

### P0-08 — Tutti i test di produzione, sicurezza e caos non superati [R]

`STEP 13 = TODO`. Mancano prove di esaurimento porzioni in concorrenza, doppi pagamenti tra casse, timeout dopo commit, revoca device offline, webhook duplicati/fuori ordine, Realtime down, DB down, printer down, Storage/Auth errors, ripartenza worker, migrazioni/rollback; esecuzione con Node >=24.13 e `npm ci`, suite completa, Playwright su HTTPS, test di carico e WCAG. Il registro delle revisioni è **0/3**.

## 3. Stato delle funzionalità, modulo per modulo

Il registro del repository del giorno 8/10 segna Step 0–6 come DONE/COMPLETE, Step 7–12 come IN_PROGRESS, Step 13 come TODO. Le indicazioni seguenti combinano tale fonte con le verifiche live al 12/10. **"Presente" significa esistenza documentata di moduli, non certificazione commerciale.**

| Area / moduli | Presenza tecnica riscontrata | Lavoro ancora aperto | Classe/priorità |
|---|---|---|---|
| **0. Fondamenta**: TypeScript/Vite, Supabase/RLS, tracing, idempotenza | Frontend pubblico/staff, database, RPC/Edge, JWT, log strutturati e rate limit | Riallineamento migrazioni; test di sicurezza trasversale; CI stabile su Node 24; ambienti reali | [V/B] P0 |
| **1. Auth e ruoli**: login, MFA, PIN, logout, revoca, step-up, Super Admin | Implementati; due account MFA verificata oggi | Regression bootstrap, primo accesso, MFA incompleta, sessioni, recupero password, cambio ruolo/venue, staff lifecycle, error UX | [V/B] P0 |
| **2. Catalogo menu**: categorie, piatti, ingredienti, allergeni, varianti, prezzi, disponibilità/scorte | DB e pagine catalogo/configurazione; test dichiarati | E2E admin→cliente→cucina; concorrenza ultima porzione, allergeni e snapshots economici reali; import/seed da zero | [V] P1 |
| **2. Sala e tavoli**: sale, layout, zone, tavoli, pianta, status, QR | Pagine `configuration`, `room-editor`, `floor`, API SQL | Bug modulo Layout corretto in codice ma regressione non effettuata; salvataggio/attivazione, revisione, servizio attivo, eliminazione e conflitti; tavoli oggi 0 | [B/V] P1 |
| **2. Conti/ordinazioni**: account code, più conti, ordini, modifiche e stati | DB/API/UI esistono; test dichiarati | Flusso completo con sessioni reali; permessi, stati, splitting, ultimi coperti, refresh/realtime/timeout | [V] P1 |
| **2. Cucina/Pass**: stazioni, KDS, pass, consegna, piatti resi | Moduli dedicati presenti | Staff veri, monitor cucina, notifiche su tablet, ordinazioni reali, ritorni e stock, tempi, timeout e doppie azioni | [V] P1 |
| **3. Cassa base**: apertura/chiusura cassa e servizio, cash/card manuale, split e quadrature | Logica e UI esistono, Step 3 DONE | Doppio incasso/registri concorrenti, zero-differenza, compensazioni/rimborsi, server vs UI, ricevuta reale non fiscale | [V] P1 |
| **4. Cliente e QR**: menu pubblico, accesso conto, chiamata cameriere, ordering modes | Codice e API presenti; Step 4 DONE | Prove da telefoni differenti via HTTPS, scadenza/rotazione codici, QR stampato, approvazione ordini, privacy | [V] P1 |
| **5. Prenotazioni/Host**: capienza, pacing, forms, slot, arrivi, no-show, walk-in | DB/RPC/Host presenti; Step 5 DONE | Servizi attualmente 0; prova prenotazioni reali con locale configurato, multi-sede, DST, cancellazioni e stati | [V] P1 |
| **6. Finanza avanzata**: Stripe/Satispay, webhook/callback, stornare/rimborsare | Edge e SQL presenti; registro storico COMPLETE | `STRIPE_HTTPS_E2E` e `SATISPAY_SANDBOX_E2E` ancora PENDING; prove sulla release candidata e riconciliazione provider | [V/L] P0 per offrire provider |
| **7. Notifiche**: centro ruoli, acknowledge, priorità e suoni | Backend e UI presenti | Interruzioni/retry/out-of-order, browser/device reali, uditività e preferenze; osservabilità e audit reali | [V] P1 |
| **7. Stampa**: jobs, bridge, PDF A4, Epson/ePOS | Coda, codice bridge, PDF provato in passato | Stampa fisica cucina/cassa, offline printer, carta/timeout, UNKNOWN e retry non duplicanti, bridge TLS firmato | [V/I] P1 (se inclusa) |
| **8. Offline/PWA**: installazione, snapshot, queue cifrata, sync, conflitti | Codice e gate statici/esercitazioni presenti | E2E browser/tablet/iOS online→offline→online, IndexedDB, service worker, revoca, risoluzione conflitti e causalità | [V/L] P1 se venduto |
| **9. Editor avanzato** | Componenti per snap, zoom, drag, resize, undo/redo, layer e activation presenti | Test browser reali e permessi; modifiche in servizio e versioning; ADVANCED_ROOM_EDITOR=false | [V/L] P2 |
| **9. Analytics** | Funzioni/stats; test deterministici dichiarati | Dataset reale per fatturato, refunds, timezone, margini, cross-venue, carico/p95; ADVANCED_ANALYTICS=false | [V/L] P2 |
| **9. Command Palette / Device Management** | UI/RPC presenti | Autorizzazioni cross-role, ricerca senza leak, heartbeat, revoca reale, device condiviso/compromesso | [V] P1/P2 |
| **10. Multi-sede** | `venues`, scopes, RLS, selettore e override catalogo; test DB | MATRIX REST/RPC/Realtime/Storage/browser con 2 sedi, licenza, revoca e dashboard aggregate; `MULTI_VENUE=false` | [V/L] P1 per catene |
| **11. Sito pubblico**: home, branding, menu, booking, SEO, upload immagini | Codice e test statici parziali presenti | Dominio cliente HTTPS, separazione staff/pubblico, upload Auth+Storage E2E, SEO/canonical, WCAG, Web Vitals, contenuti e prenotazioni reali | [V/I] P1 |
| **12. Backup e restore** | Molti worker e RPC, cifratura, retention, incidenti, alert e console | Host dedicato, copia indipendente, dump+Storage+Auth, restore fresco e integro, RPO/RTO, dismissione e runbook | [I/B] P0 |
| **13. Hardening/release** | Script di gate e documenti, GitHub/Vercel/Supabase | CI completa, staging/prod, threat/security, test caos e performance, revisioni 3/3, dossier firmato, rollback/test pilota | [I/R] P0 |

## 4. Funzionalità delle Release 3 e 4: non confuse con assenza di codice

**Verifica importante:** nel DB remoto sono presenti, tra le altre, `ingredient_cost_history`, `dish_food_cost_snapshots`, `menu_promotions`, `menus`, `menu_services`, `message_jobs`, `reservation_reminder_rules`, `reservation_deposits`, `waitlist_entries`, `takeaway_orders`, `takeaway_requests`, `takeaway_pickup_slots`; ci sono RPC come `get_dish_food_cost`, `get_menu_engineering`, `save_menu_promotion`, `run_reservation_reminder_scheduler`, `begin_reservation_deposit`, `offer_waitlist_slot`, `create_takeaway_order`. Quindi **non è corretto dichiarare che queste funzioni non siano state implementate per nulla**. Tuttavia non abbiamo prova che la loro UI commerciale, gli adapter e i flussi E2E esistano e funzionino end-to-end. Il repository ha UI generaliste (`configuration`, `catalog`, `public-menu`), ma nell'inventario `src/pages` non compaiono pagine dedicate chiaramente a recipe/food cost/menu engineering/takeaway/messaging. Questo da solo non dimostra assenza di UX, ma rende necessario un censimento puntuale dei percorsi utente.

**Licenze remote:** **15 feature flags tutte disabilitate (`licensed=false`)**:

`ADVANCED_ANALYTICS`, `ADVANCED_ROOM_EDITOR`, `BOOKING_DEPOSITS`, `CLIENT_ORDERING`, `FOOD_COST`, `MENU_PROMOTIONS`, `MULTI_MENU_QR`, `MULTI_VENUE`, `OFFLINE`, `RESERVATION_MESSAGING`, `SATISPAY_API`, `STRIPE`, `TAKEAWAY`, `WAITLIST`, `WHATSAPP_TELEGRAM_SMS_MESSAGING`.

Queste funzioni non devono essere proposte come disponibili nell'installazione CORE attuale. I gate server-side di blocco sono un requisito positivo, ma servono prove che ciascuna feature venga sbloccata correttamente quando venduta, che resti isolata per sede e che il resto del core continui a funzionare.

| Funzione finale del Master Prompt | Evidenza di backend | Quello che manca per considerarla **completamente implementata e vendibile** |
|---|---|---|
| **§151 Ricettario quantitativo** | Funzioni conversione unità, tabelle economiche ingredienti, snapshot | Editor ricette ingredienti↔quantità↔unità↔resa/scarto, validazioni e workflow Admin, storicizzazione testata |
| **§151 Storico costi ingredienti / food cost** | `ingredient_cost_history`, `get_dish_food_cost`, `dish_food_cost_snapshots` | Import di prezzi, unità, tolleranze, costi effettivi, calcolo server confrontato con riferimento, UI e test end-to-end; flag FOOD_COST false |
| **§152 Margini/menu engineering** | `get_menu_engineering`, classificazione privata | UI con filtri, volumi, margine teorico distinto da utile netto, gestione storni/refund; test dataset e scope |
| **§153 Menu multipli e QR dedicati** | `menus`, `menu_categories`, `menu_dishes`, `menu_services`, `menu_venues`, public-menu | Gestione editoriali per calendario/sede, pubblicazione, QR distinto, test cache/canonical/revoca; MULTI_MENU_QR=false |
| **§153 Promozioni/highlights/popup** | `menu_promotions`, `save_menu_promotion`, validatore server | Editor/preview/limiti impression, periodo/fuso, UX mobile, non alterare prezzo autoritativo; MENU_PROMOTIONS=false |
| **§154 Reminder prenotazioni** | Message jobs, scheduler, rule e template | Config reale provider, deliverability, quiet hours/consensi, idempotenza, osservabilità e configurazione per sede |
| **§154 WhatsApp/Telegram/SMS** | Abstraction layer e RPC messaggi | Connettori e credenziali reali, callback SENT/DELIVERED/FAILED, retries con prova reale, consenso; flags false |
| **§155 Caparra prenotazioni/no-show** | `reservation_deposits`, callback, expiry, guard, policy | Pagamento sandbox/staging reale, refund parziale, no-show, caparra separata dai conti, provider eventi fuori ordine; BOOKING_DEPOSITS=false |
| **§156 Takeaway** | `takeaway_orders`, `takeaway_requests`, slot, RPC creation/status | Interfaccia cliente/Admin/KDS concreta, pagamento/ritiro, capacity e disponibilità atomica, READY_FOR_PICKUP→COLLECTED reale; TAKEAWAY=false |
| **§43C Lista attesa** | Tabelle/RPC list/offer/expiry | Host operativo e contatto cliente, conversione offerta→prenotazione, timer e double-accept, privacy; WAITLIST=false |
| **Release 3 offline avanzato** | PWA/queue/conflict/snapshot | Test dispositivi reali e licenza OFFLINE=true coerente con supporto e backup local |
| **Release 3 multi-sede** | Scopes/venue/override | E2E integrali con 2 sedi (oggi 1), RLS reale e controllo licenza MULTI_VENUE=true |
| **Release 3 pagamenti online** | Provider adapter/Edge | Staging HTTPS end-to-end e terminal states, reversals, sandbox checkout; STRIPE/SATISPAY_API=false |

**Distinzione fondamentale:** finché una feature è disabilitata in CORE, il suo *non funzionamento* può essere voluto dalla licenza. Diventa un difetto se la UI la promette come attiva, se un endpoint consente bypass, oppure se la Release contrattuale la include ma manca il flusso funzionante.

## 5. Difetti UX/prodotto e rischio operativo osservati

1. **[B] Errore generico usato per validazioni applicative.** `USE_ROOM_EDITOR` viene presentato come problema di connessione, come accadeva con `INVALID_STAFF_COMMAND`; la patch ha aggiunto mapping per il layout, non costituisce prova di gestione universale degli errori. Cercare le RPC senza codice mappato, preservare request/correlation ID, indicare recovery e non svuotare campi se il comando fallisce.
2. **[B] Flow di creazione layout incoerente tra UI e backend.** Il pulsante **Attivo** compariva nel form Layout nonostante il server richiedesse l'Editor; patch GitHub introdotta il 12/10 (commit `82951efb`, descrizione dell'errore `aa777de0`), build Vercel READY osservata. Servono test browser reali da una sala nuova, con rollback del layout se fallisce la pubblicazione.
3. **[B/V] Bootstrap Super Admin e sessione staff non atomici dal punto di vista UX.** L'account in Auth senza `staff_profiles` non può accedere; flusso di provisioning iniziale/recovery deve essere esplicito, autorizzato e idempotente. Verificare primo avvio su DB nuovo.
4. **[B/V] TOTP interrompibile.** Supabase ha restituito `mfa_factor_name_conflict` sul fattore non verificato `Plateform`; fix recupero enrolment in UI da regressare (no rimozione dei fattori verificati).
5. **[B/V] Identificativi staff diversi dal dominio predefinito.** Generazione richiesta `nome.cognome@nomedellasede.it` e override manuale implementati. Il dominio `.it` generato potrebbe **non essere una casella controllata**, per cui recupero via email e deliverability vanno definiti; la password/recovery deve seguire un processo Admin sicuro. Prove provider Auth e unicità cross-venue necessarie.
6. **[V] Installazione nuova non guidata/accettata.** Dopo reset il core ha zero servizi e zero tavoli; onboarding deve segnalare dipendenze nell'ordine: sede → sala → layout → zone/tavoli → servizi → menu/stazioni/casse/staff, con progressione chiara e controllo di completamento.
7. **[V] Errori di workflow e azioni doppie.** Assicurare disabled/pending, feedback per stato e retries idempotenti per tutti i moduli, non soltanto lo staff e i layout.
8. **[V] Responsive/accessibility da certificare.** A11y statica presente, ma screen reader, tastiera, focus, touch reali, contrasto e performance per ruoli devono essere misurati su dispositivi reali.
9. **[V] UX ambiente CORE vs moduli avanzati.** Nascondere/disabilitare le funzioni non licenziate con spiegazione chiara e nessun inganno su ciò che è acquistabile.
10. **[V] Piantina e tavoli.** Editor supporta molte operazioni, ma non è provato il ciclo completo create → save → publish → sala operativa → modifiche con conti aperti → archivio.
11. **[V] Errore handling provider/print/offline.** Stato `UNKNOWN`, retry, operator confirmation e strumenti di recovery sono essenziali per evitare doppi incassi, duplicazioni e perdita di comande.
12. **[R] Qualità contenuti e documenti fiscali.** «PDF fattura stile A4» non equivale a fatturazione elettronica/registratore telematico certificato. La vendita italiana richiede dichiarazioni accurate e integrazioni fiscali appropriate al perimetro.

## 6. Sicurezza, dati e affidabilità: elenco sistematico delle verifiche mancanti

**Identity/accesso**: password policy/leaked-password, TOTP enrollment/recovery, revoche immediate JWT/session, PIN lock/backoff, brute-force, reset con step-up, impersonazione sola lettura, super-admin senza accessi dati economici non necessari, accesso venue-bound/CHAIN, login da dispositivi condivisi, autenticazione Auth su HTTPS.

**Database/RLS**: exhaustive RPC EXECUTE grants, `SECURITY DEFINER` abuse path, cross-venue e manipolazione UUID, idempotency replay, auth.jwt spoof, session_id check, RLS Storage/bucket, Realtime channel read, rate limiting IP e prevenzione enumeration, limiti tecnici e feature flags server-side.

**Consistenza economica**: importi cents, price snapshots, permessi sconto e storno, no doble-charge/refund, split per item/quote, modifiche prodotto dopo pagamento, tip separate, checksum ledger, riconciliazione cloud provider, due terminali cassa/ultima porzione.

**Privacy**: retention configurata per il cliente e coerente con base giuridica; privacy prenotazioni non equivale a privacy completa staff/transazioni/backup/log; diritto export/rettifica/anonimizzazione con vincoli fiscali, cookie, messaging opt-in, DPA e gestione data breach. `PRIVACY_RETENTION_CONFIGURED` è PENDING.

**Performance**: advisor Supabase segnala **83 FK senza indice di copertura** e **110 indici non usati**. Non sono 193 bug; chiedono misure reali sotto carico (EXPLAIN, p95/p99, statistiche) e correzioni puntuali, non indici aggiunti/rimossi automaticamente.

**Osservabilità**: health, logs e telemetry esistono; manca certificazione di monitoraggi esterni, alert escalation, soglie DB/Storage/Reatime/provider/worker, on-call, correlazioni incident con release e retention di log sensibili. Audit sospesi è un blocker indipendente.

**Continuità**: backup di tutti i contenuti Auth/Postgres/Storage e configurazioni, copia indipendente/immutabile, checksum/manifests, job recovery, retention/purge fisico e verifica restore, infrastruttura Node24/psql/SupabaseCLI/container, RPO/RTO misurati e runbook.

## 7. Release gate attualmente pendenti: elenco completo (15/22)

| # | Gate nel database | Attività richiesta |
|---:|---|---|
| 1 | `DATABASE_OUTAGE_STAGING` | Simulare indisponibilità DB con degrado sicuro in staging. |
| 2 | `SOURCE_CONTROL_CI_PIPELINE` | CI reale e riproducibile, migrazioni e suite passanti. |
| 3 | `APPLICATION_STAGING_ENVIRONMENT` | Supabase staging indipendente e HTTPS con account test. |
| 4 | `PRODUCTION_ENVIRONMENT_READY` | Setup produzione, secrets, backup, DNS, osservabilità. |
| 5 | `PWA_BROWSER_OFFLINE_E2E` | Installazione, IndexedDB, offline/reconnect su browser/device reali. |
| 6 | `STRIPE_HTTPS_E2E` | Checkout, return, webhook, ledger e refund su release candidata. |
| 7 | `SATISPAY_SANDBOX_E2E` | API, callback, riconciliazione e refund su staging. |
| 8 | `PRINT_BRIDGE_HARDWARE_E2E` | Hardware reale, esito incerto, retry/restart, audit. |
| 9 | `PRIVACY_RETENTION_CONFIGURED` | Periodi approvati, cleanup ed export verified. |
| 10 | `STEP11_PUBLIC_DOMAIN_DEPLOYMENT` | Dominio cliente, isolamento dal gestionale e headers. |
| 11 | `STEP11_PUBLIC_FRONTEND_BROWSER_E2E` | Navigazione completa UI su HTTPS, mobile/desktop. |
| 12 | `STEP11_PUBLIC_RESERVATION_E2E` | Prenotazione pubblica su servizi e sedi reali. |
| 13 | `STEP11_PUBLIC_SEO_A11Y_PERFORMANCE` | SEO, WCAG, Web Vitals e test prestazionali. |
| 14 | `STEP11_PUBLIC_SOURCE_MERGE` | Evidenza tracciabile del merge sorgente su build rilasciata. |
| 15 | `AUTH_LEAKED_PASSWORD_PROTECTION` | Protezione password compromesse abilitata e verificata. |

Non modificare lo stato dei gate per convenienza. I passaggi già verificati a livello SQL sono un punto di partenza, non un certificato generale.

## 8. Funzioni/servizi operativi non ancora disponibili in modo concluso

### Blocchi netti di prodotto/operatività (implementazione da completare o integrare)

1. **Host di backup/restore operativo**, con replica indipendente verificata e schedulazione reale su macchina configurata [I].
2. **Restore completo e misurazione RPO/RTO** del dataset corrente [I].
3. **Provisioning cliente per progetto** che ricrei interamente schema, Auth, Storage, Edge, policies, secrets e seed senza operazioni SQL ad hoc [I].
4. **Workflow riproducibile di migrazioni e upgrade** con rollback/roll-forward verificati [I].
5. **Staging indipendente e release pipeline approvativa fino a production** [I].
6. **Release dossier + tre audit integrali consecutivi** sul medesimo digest [I].
7. **Dismissione protetta e restore/cutover verificato** con backup, export, conferme forti e blocchi di retention [I/V].
8. **Configurazione legale/retention/cookie/dati reali per cliente** e prova scheduling del worker [I/R].
9. **Integrazioni con stampanti reali e bridge verificato** se incluse nella release [V/I].
10. **Adapter messaggistica realmente configurati** e test di delivery/status, consenso e backoff se inclusi [V/I/L].
11. **Flussi UI + test per ogni modulo finale Release 4**, oltre alle numerose RPC già esistenti [V/I/L].
12. **E2E device-level per offline, pagamenti, sala, prenotazioni e multi-sede** [V/I].
13. **Sito pubblico e brand del primo cliente testati in HTTPS**, staff/public/cache/redirect e SEO/WCAG/performance [V/I].
14. **Osservabilità produttiva e incident response**, con SLO/SLA e escalation [V/I/R].
15. **Regole commerciali/sicurezza per licenze e quota per installazione**, con test delle feature bloccate/abilitate e preparazione contratti [V/I/R].

### Funzionalità non comprese nel Master Prompt finale (non chiamarle omissioni)

Magazzino consuntivo ERP completo, payroll/HR avanzato, CRM/loyalty generalista, consegna domicilio con riders, loyalty e marketing automation generalista sono esplicitamente rinviati dal §150: non sono bug o feature mancanti rispetto allo scope richiesto.

## 9. Roadmap corretta di completamento

| Ordine | Lavoro | Gate di uscita documentabile |
|---|---|---|
| **P0 — Sicurezza e tracciabilità** | Ripristinare audit in ambiente di verifica, controllare IAM/MFA/SECURITY DEFINER e leaked-password; evitare workaround | Mutazioni auditabili, red team RLS/role/venue su sessioni reali. |
| **P0 — Schema e recovery** | Reconciliare 479 remote vs 134 Git; creare backup verificato, restore di test; controllare Storage residuo | Nuovo progetto installato dal Git e identico semanticamente; restore checksum OK. |
| **P0 — CI/staging** | Node>=24.13, npm ci, check, test Edge, Playwright, Vite build e deploy staging separato | CI verde con commit identificato, HTTPS e no secret leak. |
| **P1 — Onboarding operativo** | Primo setup da zero, ruoli operativi, sala/servizi, menu, KDS, cliente, cassa; correggere regressioni recenti | Intero ciclo d'ordine e pagamento su 2+ dispositivi senza interventi DB manuali. |
| **P1 — Continuity, privacy e sito** | Backup/restore periodici, messaggi/modalità CORE, frontend pubblico, privacy/retention | Incident rehearsal, booking reale e accessibilità misurata. |
| **P1/P2 — Moduli avanzati** | Stampa fisica, offline, multi-sede, provider, release 4 per singolo flag | E2E per modulo, licenza attivata su staging, rollback e documentazione. |
| **P0 — Certificazione finale** | Chaos, sicurezza, carico, review 3/3, dossier e pilot cliente | Tutti i gate richiesti PASS, accettazione formale e decisione GO. |

**Priorità da NON scegliere per ora:** ampliare funzioni ERP, rifare UI da zero o aggiungere altre feature non previste. La criticità principale non è il numero di tabelle, ma far funzionare e dimostrare in modo sicuro l'insieme già sviluppato.

## 10. Conclusioni e limiti di affidabilità

**Già presenti:** architettura full-stack, core catalogo/sala/ordini/cucina/cassa/cliente/prenotazioni, pagamenti provider in codice, UI editor, molti moduli avanzati e tooling di release/backup.

**Confermati ora:** audit sospeso; database 58 MB; migrazioni 479 vs 134; 0 backup registrati; 15 gate PENDING; 15 feature flags false; 0 servizi e 0 tavoli; 1 sala/1 layout; 2 admin MFA; 16 cron, 3.035 file Storage; non tutte le dipendenze/operazioni commerciali sono presenti o certificate.

**Non dimostrabile senza un collaudo ulteriore:** che ogni funzione dei §§0–157 sia corretta o errata in esecuzione, che tutti i provider siano operativi, che una pagina già codificata sia navigabile e completa, che la stampa fisica e il restore abbiano esito positivo, che un account cliente nuovo possa essere installato/portato in produzione dal repository.

**Le verifiche compiute per questo report sono read-only. Non sono stati creati o cancellati utenti, tavoli, ordini, dati o file. Non sono state toccate licenze, audit e deploy.**

## 11. Riferimenti operativi

- Master Prompt caricato, §§0–157.
- Roadmap caricata, Step 0–13, gate e Definition of Done.
- Audit caricato del 10/10/2026, usato come baseline storica, non come fonte di statistiche attuali.
- GitHub: [`docs/ROADMAP_STATUS.json`](https://github.com/ambrogiocorti/plateform-core/blob/main/docs/ROADMAP_STATUS.json); [`docs/IMPLEMENTATION_STATUS.md`](https://github.com/ambrogiocorti/plateform-core/blob/main/docs/IMPLEMENTATION_STATUS.md); [`DEPLOYMENT.md`](https://github.com/ambrogiocorti/plateform-core/blob/main/DEPLOYMENT.md); [`BACKUP_RESTORE.md`](https://github.com/ambrogiocorti/plateform-core/blob/main/BACKUP_RESTORE.md).
- Supabase Security Advisor: [Progetto Development](https://supabase.com/dashboard/project/abdxvlykasqmknexxhjo/advisors/security); [linter `SECURITY DEFINER` anon](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable); [linter `SECURITY DEFINER` authenticated](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable); [Password compromesse](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- Vercel `plateform-development`, deployment Git `aa777de0` READY all'ultimo controllo, ma non considerato certificazione production.

---

**Decisione finale:** **NO-GO.** Nel perimetro CORE dare precedenza a identità/audit, migrazioni, backup/restore, test completo del servizio e release staging. I moduli avanzati non devono essere dichiarati "assenti" laddove esistono nel backend, né "completi" soltanto per la presenza di tabelle o 197 test storici PASS.
