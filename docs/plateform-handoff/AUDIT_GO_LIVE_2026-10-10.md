# PLATEFORM — AUDIT DI PUBBLICABILITÀ E VENDIBILITÀ

**Data di riferimento:** 10 ottobre 2026  
**Decisione architetturale:** mantenere Supabase; migrazione a Nhost sospesa.  
**Ambito audit:** Master Prompt commerciale aggiornato (sezioni 0–157), Roadmap (Step 0–13), Recap sviluppo, repository privato `ambrogiocorti/plateform-core` e database di sviluppo Supabase `plateform-development` (`abdxvlykasqmknexxhjo`).  
**Verdetto:** **NO-GO** per un rilascio production/vendita della piattaforma completa. Possibile pianificare una Release 1/2 contrattualmente limitata solo dopo tutti i gate di sicurezza, continuità, test end-to-end e operatività pertinenti alla release.

## Legenda della valutazione
- **RISCONTRATO LIVE**: ottenuto con SQL read-only da Supabase al 10/10/2026.
- **RISCONTRATO SORGENTE**: riportato e/o esaminato nei documenti del repository GitHub; non equivale a deploy production.
- **REQUISITO**: deriva dal Master Prompt o dalla Roadmap, non prova che sia implementato.
- **DA DIMOSTRARE**: evidenza insufficiente; non significa automaticamente che il codice sia assente.
- **BLOCCANTE**: impedisce l'avvio commerciale sicuro finché non è chiuso o escluso formalmente dal perimetro della specifica release, quando consentito.

## 1. Sintesi esecutiva

Il backend Plateform è già esteso e possiede un core operativo che il registro di sviluppo considera completato: autenticazione, ruoli, menu, sala, conti, ordinazioni, cucina, Pass, cassa, cliente/QR e prenotazioni. Lo Step 6 relativo ai pagamenti avanzati è marcato COMPLETE nel registro. Tuttavia la release non è stata certificata: Step 7–12 in corso e Step 13 TODO; release gate 15 PENDING su 22; tre revisioni integrali consecutive 0/3. Nessun host/staging/production commerciale reale risulta certificato; CI applicativa end-to-end e backup/restore sulla versione corrente non hanno la prova richiesta.

**Emergenza osservata:** il database di sviluppo è cresciuto da 844.183.219 byte (~805 MiB visualizzati, rilevazione del 9 ottobre) a 1.542.092.467 byte (~1.471 MiB visualizzati, rilevazione del 10 ottobre). Il limite database del piano Supabase Free è 500 MB e la documentazione ufficiale avverte del read-only oltre la soglia: non è stato verificato se il progetto sia già in read-only; le restrizioni devono essere verificate nella dashboard.

La causa prevalente osservata è il volume di prova della continuità:
- `private.continuity_rehearsal_snapshot_rows` ~1.237 MiB / 1.296.654.336 byte;
- `private.continuity_rehearsal_transfer_chunks` ~174 MiB / 182.362.112 byte;
- **1.685.926 righe** di snapshot, **8.508 chunk**;
- **153 manifest/snapshot** dal 6 ottobre, **80** creati nelle ultime 24 ore al controllo;
- **64** backup registrati SUCCEEDED e **90** FAILED; gli ultimi tentativi al 10 ottobre sono FAILED, ultimo SUCCEEDED il 9 ottobre;
- **2 restore test** registrati SUCCEEDED, ma relativi al 6 ottobre: non attestano ripristino delle 457 migrazioni oggi presenti.

Questa massa è quasi interamente materiale di rehearsal e non deve essere cancellata senza documentare riferimenti, retention, backup indipendente, eventuali vincoli di recovery e rollback. L'obiettivo è interrompere la crescita alla fonte e recuperare spazio in modo verificabile, non semplicemente eseguire `DELETE` a caso.

## 2. Inventario di sviluppo e discrepanze

| Indicatore | Stato |
|---|---|
| Progetto | `plateform-development`, eu-west-1 |
| PostgreSQL | 17.11 alla verifica precedente |
| Database 10 ottobre | 1.542.092.467 byte / ~1.471 MiB visualizzati |
| Tabelle `public` | 114 |
| Tabelle `private` | 48 |
| Utenti `auth.users` | 12 |
| Oggetti Storage | 3.528 |
| Somma dimensioni Storage dichiarate | 373.736.309 byte (~374 MB decimali), separata dalla quota DB |
| Edge Functions | 33 attive alla verifica del 9 ottobre; aggiornare conteggio prima del go-live |
| Migrazioni SQL applicate al DB remoto | 457, ultima `20261009001127` |
| Migrazioni locali | 133 nel documento repository dell'8 ottobre; non riconciliate con il remoto |
| Job `pg_cron` attivi | 12 |
| Release gate | 7 PASS, 15 PENDING |
| `private.ci_runs` | 0 righe: non prova da sola che nessuna GitHub Action sia mai partita |
| Revisioni integrali pulite | 0/3 secondo `docs/REVIEWS.md` |

Bucket Storage: `plateform-continuity-primary` 3.514 oggetti (~373.313.953 byte dichiarati); bucket di rehearsal 14 oggetti (~422.356 byte). Gli altri bucket applicativi (`branding`, `gallery`, `dishes`, `documents`) erano vuoti alla verifica del 9 ottobre, richiedendo nuovi controlli prima dei test asset reali. Il numero di oggetti non prova integrità o recuperabilità dei loro contenuti.

**Incoerenza da risolvere:** il registro STEP 6 segna Stripe e Satispay sandbox come PASS, mentre i gate `STRIPE_HTTPS_E2E` e `SATISPAY_SANDBOX_E2E` nel database risultano ancora PENDING. Servono stessa versione software, prova provider verificabile, registrazione coerente del gate e riesecuzione in staging HTTPS. Non dichiarare fallite le integrazioni soltanto perché il gate non è aggiornato, ma neppure dichiararle certificate.

## 3. P0 — Stabilità e capacità Supabase (bloccante)

**Da fare**
1. Identificare il job/applicazione che produce snapshot di rehearsal a ritmo elevato; incrociare manifest, backup metadata, scheduler e log.
2. Mettere in sicurezza gli artefatti e bloccare il ciclo di test non necessario tramite modifica programmata e autorizzata, con piano di rollback. Non fermare alla cieca i veri backup production.
3. Identificare quali rehearsal sono diagnostiche, obsolete o non più referenziate; distinguere snapshot test da backup realmente ripristinabili.
4. Verificare almeno una copia indipendente e sua integrità prima di qualunque pulizia; definire retention e audit; provare la pulizia su staging.
5. Eseguire soltanto successivamente una bonifica selettiva, transazionale dove possibile, e la procedura adeguata di recupero dello spazio PostgreSQL. Una `DELETE` non riduce automaticamente la dimensione fisica del file/database.
6. Documentare allarmi su DB %, Storage, tasso crescita, errore backup, stato queue, RPO; applicare soglie e stop preventivi ai rehearsal.
7. Valutare Supabase Pro per ambienti production (piano e costi attuali da verificare per organizzazione/progetto). Free non è adeguato come configurazione predefinita per garantire continuità, backup e non-sospensione di installazioni vendute.

**Gate di chiusura:** trend dimensioni stabile, soglia sotto la quota con margine operativo, backup/restore attuali integri, automatismi di retention testati, allarmi funzionanti. Nessuna perdita di dati di servizio.

## 4. P0 — Cronologia migrazioni e distribuzione riproducibile (bloccante)

Il repository documenta all'8/10 133 migrazioni locali contro 456 remote; il database ne ha ora 457. Prima di creare nuove installazioni bisogna:
- esportare e identificare le SQL canoniche mancanti con inventario versione/nome/SHA-256;
- riconciliare le difformità tra file locali e SQL già eseguiti, archiviando la baseline precedente;
- impedire script che marcano migrazioni come applicate senza eseguirle;
- ricostruire da zero un Supabase di staging isolato con lo schema completo usando esclusivamente sorgenti versionati;
- verificare seed, Auth, Storage, 33 Edge Function e 12 cron, policy, trigger, grants e rollback compatibile;
- fornire pipeline upgrade cliente per cliente e controllo idempotenza;
- legare ogni rilascio a commit/tag, hash migrazioni, build e runbook.

**Gate:** una nuova installazione generata dal repository coincide semanticamente con il database di riferimento e supera test di schema/RLS/operazioni.

## 5. Stato Step 0–6: il core già presente, ma da rivalidare

- **0 — Fondamenta:** marcato DONE; ripetere schema, RLS, JWT, rate limiting, logging, secure headers e CI nei nuovi ambienti.
- **1 — Accesso:** DONE; provare TOTP/MFA, recovery, PIN, refresh/logout/revoca e ruoli su Auth reale production-like.
- **2 — Menu/sala/conti/ordini/cucina/Pass:** DONE; simulazione completa di servizio reale, multi-device e casi concorrenziali.
- **3 — Cassa base:** DONE; quadratura, importi in centesimi, più casse/operatori, doppio pagamento, refund, split, chiusura e non fiscalità dei documenti.
- **4 — Cliente/QR:** DONE; codici, sessioni multiple, ordering mode DISABLED/WAITER_APPROVAL/DIRECT, chiamata cameriere, permessi e cross-device.
- **5 — Prenotazioni/Host:** DONE; capacità, pacing, timezone/DST, no-show, cancellazione, grandi gruppi, booking pubblico HTTPS; alcuni controlli HTTP esterni erano bloccati dall'ambiente di prova.
- **6 — Finanza avanzata:** COMPLETE nel registro; allineare prove reali Stripe Checkout/refund/webhook e Satispay API callback/refund con i gate di rilascio database PENDING; testare HTTPS, duplicati, retry, timeout/commit, ledger e no doppio addebito.

**Condizione:** DONE nel registro non equivale automaticamente a release cliente; occorre regression end-to-end nella versione candidata.

## 6. STEP 7 — Notification Center, stampa, piatti tornati indietro

Già presenti: backend notifiche, stati e audit; print queue/claim/retry; ritorno piatti e riemissione; generazione PDF A4 provata in browser secondo il registro.

**Manca da dimostrare/completare:** uso reale delle notifiche per ruolo, suoni/priorità, scadenza/acknowledge/resolve, stampa cucina/cassa durante servizio, esiti indeterminati dopo invio, retry non duplicante, bridge ePOS/Epson su hardware/firmware/rete effettivi, carta esaurita e stampante offline, ripartenza del worker, accessi al bridge e audit. Il registro segnala hardware come blocco del gate; se una prima edizione non include bridge Epson, va escluso esplicitamente dalla licenza/contratto e mantenuto disabilitato server-side, senza dichiarare lo Step 7 integralmente completo.

## 7. STEP 8 — PWA, offline, reconnect e Conflict Center

Già presenti: logica autorizzazione offline, queue, riconciliazione e Conflict Center, secondo documenti di sviluppo.

**Manca:** prova installazione/aggiornamento PWA con manifest e service worker distinti pubblico/staff; comportamento reale IndexedDB e storage su dispositivi; snapshot autorizzazione/TTL; gestione scadenza, revoca utente/dispositivo e account condiviso; online→offline→online; causal ordering/idempotenza; scenari conflitto tra device, ultima porzione, timeout e retry; annullamento di operazioni non consentite offline, messaggi UX in caso di impossibilità, sincronizzazione e risoluzione auditata. I gate browser release sono ancora bloccati.

## 8. STEP 9 — Editor sala, analytics, Command Palette, dispositivi

Implementazioni dichiarate: editor avanzato, analytics, Ctrl/Cmd+K e management device.

**Manca:** regressione UI reale per drag/drop, rotazione/resize, layer, snap, zoom, undo/redo, multiselezione e permessi; confrontare KPI/fatturato/storni/rimborsi/food cost con un dataset numericamente controllato, filtraggio per intervallo/fuso/sede; ricerca senza fuga di dati cross-role e cross-venue; heartbeat/offline/revoca dispositivi; limiti e performance. Gate release browser non superato.

## 9. STEP 10 — Multi-sede

Modello richiesto: una sola catena/cliente per progetto Supabase, mono-sede di default, `MULTI_VENUE` controllato da licenza, scope CHAIN/VENUE e isolamento tra sedi.

**Manca:** matrice di autorizzazione reale con utenti rappresentativi attraverso UI, REST/PostgREST, RPC, websocket/Realtime, bucket Storage e URL/ID manipolati; autenticazione e disattivazione venue; menu catalogo condiviso con override prezzo/disponibilità locali; selettore sede, comportamento automatico mono-sede, Admin CHAIN vs VENUE, dashboard aggregate. Il registro segna in particolare gli E2E cross-venue come TODO/BLOCKED.

## 10. STEP 11 — Sito pubblico e branding

Il codice include lavoro su home, menu pubblici, metadata SEO, sitemap, route per sede, prenotazioni, isolamento `/staff` e branding; sono registrati test statici e di backend.

**Manca:** host pubblico HTTPS realmente configurato per un cliente, `/staff` isolato (routing, asset, cache, cookies, CSP), dominio/DNS, CORS, redirect Auth, configurazione provider; upload autenticato effettivo di logo/immagini/galleria su Storage, ACL e limiti; contenuti reali personalizzabili, gallery, contatti, menu, booking; responsive e tastiera/lettore schermo, WCAG AA e prestazioni real browser/Web Vitals; SEO sitemap/canonical/robots/structured data per sedi e menu; test booking pubblico con orario/DST, caparra fail-closed se fuori licenza. I 5 gate pubblici PENDING impediscono il completamento.

## 11. STEP 12 — Backup, restore, continuità e dismissione

Nel repository sono implementati worker avanzati, cifratura e manifest verificabili, code e scheduler, pre-restore snapshot, restore test su target separato, 14 controlli post-restore, Operational Health, retention e incident reconciler. NON considerare questo equivalente alla continuità operativa certificata.

**Manca:** host dedicato realmente configurato Node >=24.13 + Supabase CLI + psql + Docker e secret sicuri; storage persistente e replica indipendente, encryption key custody; test backup integrale dell'ATTUALE schema/utenti/oggetti Storage; restore completo su Supabase disposable isolato con hash byte-per-byte, migration SHA/utente/permessi/ledger/audit; simulazione cutover e rollback, provider esterni e callback post-restore; misurazione RPO/RTO; retention/purge sicuro, incident escalation; runbook verificato; dismissione con export, conferma forte e rispetto conservazione dati. Il limite di 2 progetti Free attivi è un ostacolo segnalato per restore rehearsal: prevedere infrastruttura dedicata/progetti a pagamento per le prove.

**Gate assoluto:** backup fresco verificato + restore-test sulla stessa versione di schema e dati, non risultato storico precedente.

## 12. STEP 13 — Hardening e certificazione go-live

Da eseguire solo dopo dipendenze precedenti:
- Security testing: ruoli, RLS, RPC `SECURITY DEFINER`, grants anon/auth, JWT/refresh/revoca/MFA, brute force PIN/codici, Storage, cross-venue, session fixation, feature flag, prezzo/stock/importi, pagamenti/rimborsi, impersonazione, offline auth.
- Security advisor Supabase: analizzare `anon_security_definer_function_executable`, `authenticated_security_definer_function_executable`, `extension_in_public`, `auth_leaked_password_protection` e RLS senza policy (deny-all intenzionale vs errore). I warning NON sono automaticamente vulnerabilità. Nella verifica del 9 ottobre risultavano 83 FK non indicizzate e 127 indici non usati: misurare workload, non aggiungere/eliminare indici automaticamente.
- Prove failure/chaos: DB indisponibile, Realtime interrotto, errore rete, timeout dopo commit, duplicate/out-of-order webhook, due casse stesso conto, due ordini sull'ultima porzione, stampante offline, Edge retry, device revocato offline.
- Release build su Node >=24.13 con `npm ci`; format, lint, TypeScript strict, unit/db/integration/security, Edge tests, Playwright browser, PWA, performance/load, accessibilità; evidenze su vera infrastruttura.
- CI/CD commit→checks→migrazioni/RLS→build→deploy staging→E2E→release gate→approvazione→production, con canary/rollback e pin versioni.
- Osservabilità e risposta agli incidenti: health esterni, error budget/SLO misurati, alert deduplica/escalation, on-call, log retention/privacy, dashboard tecnica non esposta agli utenti operativi.
- Tre revisioni complete consecutive senza difetti aperti **sullo stesso digest** (oggi 0/3), dossier `.local/release/evidence.json`, `npm run release:check`, `npm run release:zip` solo su esito realmente positivo.

## 13. Release gate obbligatori attualmente PENDING (15/22)

| Dominio | Chiave obbligatoria |
|---|---|
| Chaos | `DATABASE_OUTAGE_STAGING` |
| CI/CD | `SOURCE_CONTROL_CI_PIPELINE` |
| Ambiente | `APPLICATION_STAGING_ENVIRONMENT` |
| Ambiente | `PRODUCTION_ENVIRONMENT_READY` |
| Offline | `PWA_BROWSER_OFFLINE_E2E` |
| Pagamenti | `STRIPE_HTTPS_E2E` |
| Pagamenti | `SATISPAY_SANDBOX_E2E` |
| Stampa | `PRINT_BRIDGE_HARDWARE_E2E` |
| Privacy | `PRIVACY_RETENTION_CONFIGURED` |
| Sito | `STEP11_PUBLIC_DOMAIN_DEPLOYMENT` |
| Sito | `STEP11_PUBLIC_FRONTEND_BROWSER_E2E` |
| Sito | `STEP11_PUBLIC_RESERVATION_E2E` |
| Sito | `STEP11_PUBLIC_SEO_A11Y_PERFORMANCE` |
| Sito | `STEP11_PUBLIC_SOURCE_MERGE` |
| Sicurezza | `AUTH_LEAKED_PASSWORD_PROTECTION` |

Sette gate nel DB sono PASS. Non modificare lo stato dei PENDING senza prova valida, coerenza di versione/ambiente e owner responsabile.

## 14. Funzioni commerciali Release 4 / sezioni 151–157

Nel Master Prompt sono esplicitamente in scope finale, ma **non risultano individualmente certificate per un'offerta completa** dal solo inventario esaminato. Per ognuna serve una matrice `REQ → codice → DB/RLS → UI → API → test → piano licenza → accettazione`:
- ricettario quantitativo (unità, rese, scarti, prezzi storici ingredienti);
- food cost teorico, snapshot e margini per piatto/menu engineering;
- più menu per servizio/sede, QR specifici, calendari, promozioni/highlights senza cambiare prezzi non autorizzati;
- reminder e conferme prenotazione tramite provider di messaggistica, tracking delivery, retry/backoff e consensi;
- caparre prenotazione/no-show, scadenza, trattenimenti, rimborsi e indipendenza dal conto al tavolo;
- lista d'attesa/capacity/pacing e conversione misurata;
- takeaway con prezzi, stock, cucina e pagamento condivisi e fonte ordine corretta.

Il repository contiene parti di questi flussi e guard server-side in edizione CORE, ma la presenza di tabelle o funzioni non è prova di una release vendibile. Se la Release 1 commercializzata li esclude, documentare chiaramente l'edizione e mantenere i relativi endpoint disabilitati fail-closed.

## 15. Ambiente Production e architettura cliente

**Requisito Master Prompt:** un cliente ristorante/catena = un progetto Supabase dedicato, DB/Auth/Storage/secrets/backup dedicati, dominio e ciclo di deployment propri; più sedi solo all'interno della stessa catena.

Da fare per ogni cliente:
1. Provisioning DEV/STAGING/PROD separati, con identificatori, segreti, policy e provider non condivisi.
2. Progetto Supabase di piano adeguato, budget e alert quota DB/Storage/egress/Realtime/Edge/Auth; nessuna promessa di SLA o RPO non misurata.
3. Deploy frontend staff/pubblico, HTTPS, DNS, mail SMTP autenticazione, redirect, HTTPS webhook, CSP, CORS, reverse proxy/static SPA fallback, cookie/sessioni.
4. Versioni schema/Edge/frontend coerenti, migrazioni riproducibili, deploy blue-green o rollback pianificato.
5. Seed unico ristorante, bootstrap tecnico Super Admin distinto dal primo Admin cliente, uno o più venue secondo licenza, staff e ruoli; import menu/ingredienti/allergeni/foto, sala e QR, casse/stampanti, provider.
6. Health, backup test, monitoraggio, sicurezza, perf/UX e accettazione formale con responsabile locale.
7. Upgrade senza fork di codice per ogni cliente, feature flag/licenze server-side e offboarding/export protetto.

**Costi:** Supabase Free 500 MB/database, Pro da US$25/mese organizzazione e progetti extra/costi add-on secondo uso; prezzo venduto al cliente deve coprire tutta la singola installazione, frontend/hosting, backup extra, storage/egress, messaging/SMS, transazioni provider, supporto e margine. Il prezzo Pro iniziale non equivale a un costo totale fisso garantito per cliente.

## 16. Privacy, sicurezza organizzativa, fiscalità e contrattualistica

### Privacy/GDPR (da predisporre e verificare con consulente)
- Mappatura dati staff/clienti, basi giuridiche, retention per categorie, dati di minori se pertinenti, cookies e strumenti di analytics, consensi per messaggi promozionali.
- Ruolo titolare/responsabile in ogni installazione, accordo ex art. 28 GDPR ove applicabile, sub-responsabili/cloud e regioni, istruzioni, procedure diritti interessati, export/rettifica/cancellazione con blocchi di conservazione legale.
- Protezione dati (art. 32), registro trattamenti se richiesto, procedure incident e data breach, modello di informativa sito/booking, retention su backup/audit/log, revoche dipendenti.
- Protezione account Super Admin, minimizzazione accesso dati economici/personali, audit accessi tecnici e impersonazione read-only dove prevista.

### Documenti fiscali/pagamenti
- Chiarire espressamente che stampa ricevuta/«fattura stile A4» Plateform non è automaticamente un documento fiscale valido: integrare registratore telematico e/o sistema fiscalmente conforme se si pubblicizza emissione di documenti fiscali.
- Distinguere incasso POS manuale dalla vera integrazione provider, riconciliare commissioni/rimborsi/storni. Non memorizzare PAN o dati carta non necessari.
- Far verificare commercialista/consulente fiscale italiano per corrispettivi, e-fattura, conservazione e modalità di assistenza fiscale.

### Materiale contrattuale
- Termini licenza SaaS/hosting vs software installato; responsabilità, licenze funzionalità, scope per sede, limiti e trattamento dati.
- Contratto servizio, DPA, SLA e finestre di manutenzione, supporto/on-call, backup/RPO/RTO misurati, esclusioni e responsabilità in caso di disservizio.
- Prezzi setup/canone/multi-sede/opzioni, costi hardware/provider di terzi, procedure pagamento e fatturazione commerciale.
- Onboarding/training/accettazione, versioning/changelog, uscita cliente/export e cancellazione controllata.
- Verifica marchio/nome/dominio Plateform e titolarità di codice/assets/dependenze. Consulenza professionale prima dei primi contratti.

## 17. Esperienza utente, qualità e accessibilità prima di venderlo

- Test end-to-end sull'hardware e sui ruoli effettivi: cucina touchscreen/tablet, staff Android/iOS/desktop, Wi-Fi ristorante, stampanti, fallback rete, HTTPS QR.
- UX per ciascun ruolo, effettiva separazione Admin vs Super Admin, menu e comandi rapidi per servizio, notifiche visibili, error recovery, azioni con conferma e audit.
- Onboarding 1 sede senza dati demo, configurazione menu/allergeni/varianti/prezzi/storico, QR, sale, staff, disponibilità, prenotazioni.
- Test accessibilità WCAG pertinente, contrasto, tastiera, screen reader, touch target, lingua italiana, responsive, sessioni condivise/disconnesse.
- Load test realistici con staff+clienti+Realtime+Storage, N+1, indici FK con workload, p95/p99 richieste e stress transazioni.
- Runbook per servizio attivo, fallback operativo senza stampa/provider, supporto reattivo serale/weekend secondo contratto.

## 18. Strategia commerciale consigliata

Il Master Prompt prevede quattro edizioni funzionali incrementali: **Release 1 Core Operations**, **Release 2 Customer Experience**, **Release 3 Advanced**, **Release 4 Revenue, Booking & Menu Optimization**. La vendita di una release ridotta è legittima solo se la scheda prodotto e il contratto dichiarano esplicitamente ciò che è incluso, ciò che è disabilitato e la gestione del rischio residuo; non si può chiamare «completa» una funzionalità in `IN_PROGRESS`.

**Percorso più prudente:** prima chiudere infrastruttura, migrazioni, restore, sicurezza, CI/staging/production e prove del ciclo `login → tavolo → ordine → cucina → Pass → cassa → pagamento → chiusura`; quindi pilot controllato con ristorante reale, formazione, bug triage e acceptance; poi primo cliente pagante su release perimetrata e supportabile. Le integrazioni hardware/online/offline/multi-sede e feature Release 4 diventano vendibili singolarmente solo dopo i rispettivi gate e contratti.

## 19. Piano d'azione in ordine di esecuzione e definition of done

**FASE A — Arrestare il rischio operativo [P0]**
- crescita rehearsal/backup falliti: root cause, retention, copia indipendente e recupero spazio verificato;
- monitoraggio quote e decisione piano infrastrutturale Supabase per DEV/STAGING/PROD.

**FASE B — Rendere riproducibile una release [P0]**
- riconciliazione SQL remoto↔Git; installazione da zero con migration integrali;
- runner pulito Node >=24.13, `npm ci`, typecheck/lint/tests/build;
- staging con HTTPS e chiavi indipendenti, CI completa.

**FASE C — Concludere prodotto e continuità [P0/P1]**
- Step 11 sito pubblico e staff verificate, booking, branding Storage, SEO/accessibilità;
- Step 12 backup corrente DB/Auth/Storage, restore reale su target nuovo, RPO/RTO osservati;
- chiusura dei gate Step 7–10 che ricadono nell'edizione venduta e test reali E2E.

**FASE D — Certificare e vendere [P0/P1]**
- sicurezza e advisor, test chaos/concorrenza/payment, SLO e monitoraggio;
- Step 13, 15 gate PENDING, 3 revisioni complete pulite sul medesimo digest, release bundle;
- GDPR/fiscale/contratti, prezzi e supporto, provisioning per cliente;
- pilota e acceptance documentata, solo dopo release production e vendita.

### Evidenza richiesta per ogni elemento
Ogni voce deve avere **owner, commit/hash, ambiente, test manuale/automatico, output/log o screenshot, stato, bug residui, data di certificazione e decisione go/no-go**. I gate nel database non vanno marcati PASS con dati sintetici o testimonianze senza verifiche.

## 20. Rischi principali e decisione

| Rischio | Gravità | Azione |
|---|---|---|
| DB 1.471 MiB su Free 500 MB, crescita rapida | CRITICA | Contenere immediatamente rehearsal e quota, preservare dati |
| Backup recenti FAILED e restore non sulla versione attuale | CRITICA | Continuità certificata prima dei clienti |
| Migrazioni GitHub/Supabase divergenti | CRITICA | Riconciliare SQL e creare installazione da zero |
| Nessun staging/production HTTPS certificato | CRITICA | Infrastruttura isolata e CI E2E |
| 15 gate PENDING, Step 13 TODO, revisioni 0/3 | CRITICA | Chiudere evidenze reali e release gate |
| Sicurezza/RLS/scope/SECURITY DEFINER non auditati finali | ALTA | Security audit e test di abuso |
| Stampa fisica, offline real browser, cross-venue trasporto non collaudati | ALTA | Collaudi per edition/contratto |
| Privacy/contratti/servizio e fiscalità non certificati | ALTA | Completamento amministrativo e professionale |
| Feature release 4 senza singola certificazione | MEDIA/ALTA | Non offrirle prima del relativo gate |

**Decisione:** mantenere Supabase e non vendere la piattaforma completa ora. Prima eliminare il rischio operativo sul DB, poi ricostruibilità, prodotto reale, disaster recovery, hardening e preparazione commerciale. La migrazione Nhost non è il lavoro necessario per risolvere i blocchi attuali.

## 21. Fonti e limiti

### Specifiche caricate
- `MASTER_PROMPT_PLATEFORM_COMMERCIALE_AGGIORNATO.md` §§0–157: modello per installazione, ruoli, funzionalità, sicurezza, release strategy, Definition of Done.
- `Roadmap.txt` Step 0–13: ordine di implementazione e gate; nessuna feature deve essere dichiarata COMPLETE solo dalla UI.
- `Recap sviluppo piattaforma.txt`: analisi precedente, soprattutto Step 6–13; alcuni punti aggiornati da evidenza GitHub più recente.

### Repository privato consultato
- `https://github.com/ambrogiocorti/plateform-core/blob/main/docs/ROADMAP_STATUS.json` (ultimo checkpoint 2026-10-08)
- `https://github.com/ambrogiocorti/plateform-core/blob/main/docs/IMPLEMENTATION_STATUS.md`
- `https://github.com/ambrogiocorti/plateform-core/blob/main/BACKUP_RESTORE.md`
- `https://github.com/ambrogiocorti/plateform-core/blob/main/DEPLOYMENT.md`
- `https://github.com/ambrogiocorti/plateform-core/blob/main/docs/REVIEWS.md`
- `https://github.com/ambrogiocorti/plateform-core/blob/main/docs/STEP11_PROGRESS_2026-10-08.md`
- `https://github.com/ambrogiocorti/plateform-core/blob/main/.github/workflows/ci.yml`

### Fonti pubbliche per capacità/compliance (orientative, verificare a contratto)
- Supabase Free e database read-only: https://supabase.com/docs/guides/platform/database-size
- Supabase prezzi/quote: https://supabase.com/pricing
- Checklist production: https://supabase.com/docs/guides/deployment/going-into-prod
- GDPR testo ufficiale: https://eur-lex.europa.eu/eli/reg/2016/679/

### Limiti dell'audit
- Sono state fatte interrogazioni **di sola lettura** al DB Development, non è stata modificata la configurazione né ripulita una tabella.
- I documenti del repository possono essere antecedenti allo stato SQL remoto corrente; non sono stati eseguiti Playwright, test stampanti fisici, pagamento di prova, restore o produzione.
- Non si è ispezionato integralmente ciascun file del repository né ricostruita ogni singola funzione del Master Prompt: le aree non comprovate sono `DA DIMOSTRARE`, non automaticamente `NON IMPLEMENTATE`.
- Non è consulenza legale o fiscale.
