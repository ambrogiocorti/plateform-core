# Plateform — checklist collaudo locale pre-GitHub

Questa checklist è il gate manuale della Local Release Candidate. Ogni riga va marcata **PASS**, **FAIL** o **BLOCKED_EXTERNAL**. Un FAIL produce una correzione e una nuova RC; non viene convertito in PASS senza riesecuzione.

## Preparazione

- [ ] Installare Node >= 24.13.0.
- [ ] Estrarre lo ZIP in un percorso nuovo, non sopra una vecchia installazione.
- [ ] Copiare `.env.example` in `.env.local` e configurare soltanto valori browser/publishable del progetto Supabase development.
- [ ] Eseguire `npm ci`.
- [ ] Eseguire `npm run local:preflight` → `ok: true`.
- [ ] Eseguire `npm run local:verify` → exit code 0.
- [ ] Installare Chromium Playwright con `npx playwright install chromium` oppure configurare `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.
- [ ] Eseguire `npm run local:browser` → exit code 0.

## UX operativa — WAITER / RUNNER

Questo gate verifica il redesign operativo introdotto senza sostituire i test di sicurezza/RLS esistenti. Usare almeno viewport **360 px, 390 px e 430 px** e una identità WAITER realmente assegnata a zona/tavolo.

- [ ] Login WAITER: la radice staff deve aprire direttamente **Servizio** senza passare da dashboard amministrative.
- [ ] Nei primi 2 secondi devono essere riconoscibili chiamate cliente, piatti pronti e tavoli assegnati, senza scroll obbligatorio per capire la priorità corrente.
- [ ] Tavolo con **un solo conto aperto**: `Nuovo ordine` deve aprire direttamente l'editor ordine senza chiedere di riselezionare tavolo/conto.
- [ ] Tavolo senza conto: `Nuovo conto` deve aprire il flusso contestuale; dopo la creazione `Aggiungi piatti` deve portare direttamente all'ordine sul conto appena creato.
- [ ] Tavolo con più conti: Plateform deve chiedere/selezionare il conto corretto e non indovinare automaticamente il destinatario.
- [ ] Chiamata cliente assegnata: `Prendi in carico` e `Completa chiamata` devono funzionare senza cambio pagina e aggiornarsi via stato authoritative.
- [ ] Step READY: `Prendi in carico` e `Consegnato` devono funzionare dal contesto Servizio senza aprire menu secondari.
- [ ] Modalità **RUNNER-only**: mostrare principalmente consegne READY, tavolo, step, tempo operativo e azioni di presa/consegna; non mostrare creazione conto/ordine o sezioni amministrative.
- [ ] Utente WAITER con assegnazione mista RUNNER + TABLE/ZONE: mantenere la dashboard completa da cameriere, non forzare la UI runner-only.
- [ ] Verificare touch target delle azioni principali, uso con una mano, focus da tastiera e assenza di overflow orizzontale del workspace.
- [ ] Durante un aggiornamento Realtime, selezione/scroll e contesto tavolo non devono saltare inutilmente.
- [ ] Simulare errore operativo (es. risorsa non più disponibile): deve apparire un messaggio umano e l'utente deve poter correggere senza perdere il contesto.

### Misura del flusso WAITER

Registrare con screen recording o cronometro, senza alterare artificialmente i tempi di rete:

1. partire da un tavolo già visibile/selezionato nella vista Servizio;
2. aprire `Nuovo ordine`;
3. aggiungere un piatto;
4. inviare l'ordine;
5. annotare **numero di interazioni principali**, tempo totale ed eventuali attese di rete.

Il riferimento progettuale è mantenere il percorso dopo il contesto tavolo vicino a **3–4 interazioni principali** quando non servono varianti o scelte aggiuntive. Il risultato reale va registrato anche se superiore: il test serve a trovare frizioni, non a forzare un PASS.

Evidenze minime: screenshot 360/390/430 px, registrazione di un ordine completo, una chiamata cliente, una consegna READY e una sessione RUNNER-only.

## PWA / offline — STEP 8

- [ ] Aprire staff online, autenticarsi e aprire una sede autorizzata.
- [ ] Verificare che il service worker staff abbia scope `/staff/` e quello pubblico non intercetti `/staff/`.
- [ ] Installare la PWA staff dal browser.
- [ ] Preparare l'autorizzazione offline e verificare che l'app mostri scadenza/contesto coerenti.
- [ ] Passare offline e ricaricare: shell, workspace già acquisito e queue devono restare disponibili.
- [ ] Accodare almeno due operazioni offline consentite e verificare che l'ordine causale venga preservato.
- [ ] Tornare online: verificare `PENDING → SYNCED` oppure apertura del Conflict Center senza perdita silenziosa.
- [ ] Creare un conflitto controllato, risolverlo `DISCARD`, verificare che i successori possano ripartire.
- [ ] Revocare il device da un'altra sessione, tornare online sul device revocato e verificare fail-closed.
- [ ] Pubblicare una modifica frontend locale, ricaricare e verificare il prompt/update controllato della PWA.

Evidenze minime: screenshot PWA installata, schermata queue prima/dopo reconnect, Conflict Center, DevTools service-worker scope/version.

## Room Editor — STEP 9

- [ ] Aprire un layout fuori servizio.
- [ ] Trascinare elementi/tavoli fino ai quattro bordi e verificare che non escano dalla sala.
- [ ] Selezionare più elementi e ridimensionarne uno: gli altri non devono muoversi.
- [ ] Verificare snap ON/OFF.
- [ ] Verificare undo/redo dopo move, resize, delete e duplicate.
- [ ] Salvare e ricaricare: posizione/versione devono restare coerenti.
- [ ] Provocare un version conflict da due schede e verificare messaggio/refresh sicuro.
- [ ] Mettere un tavolo del layout in servizio e verificare che il salvataggio layout venga bloccato con `LAYOUT_IN_SERVICE`.

Evidenze minime: screenshot layout prima/dopo, conflitto versione, blocco durante servizio.

## Multi-sede — STEP 10

Usare almeno due sedi e due identità/assegnazioni rappresentative.

- [ ] Admin assegnato solo alla sede A: la sede B non deve comparire nei dati operativi.
- [ ] Provare URL/ID della sede B manipolato manualmente: nessun dato deve essere restituito.
- [ ] Verificare da DevTools Network che richieste REST verso risorse B siano negate/vuote secondo il contratto.
- [ ] Generare un evento operativo in B e verificare che il client assegnato solo ad A non lo riceva via Realtime.
- [ ] Verificare che un documento privato Storage di B non sia scaricabile da un utente assegnato solo ad A.
- [ ] Assegnare lo stesso Admin anche a B e verificare che l'accesso compaia senza nuovo account.
- [ ] Revocare l'assegnazione B e verificare che REST/Realtime/Storage tornino immediatamente negati al reconnect/refresh.
- [ ] Verificare catalogo condiviso e override prezzo/disponibilità differenti tra A e B.
- [ ] Verificare che lo switch sede mantenga la pagina corrente e ripari una sede stale/non più autorizzata.

Evidenze minime: Network REST deny/allow, evento Realtime non ricevuto/ricevuto dopo assignment, Storage deny/allow, screenshot switch sede.

## Sito pubblico / branding — STEP 11

- [ ] Home, menu, ristorante, gallery, sedi, prenota e contatti su desktop e mobile.
- [ ] In multi-sede, verificare canonical e `og:url` distinti per `/menu?sede=<slug>` e pagine contestuali equivalenti.
- [ ] Verificare `/sedi/<slug>` con nome, contatti e dati della sede corretta.
- [ ] Verificare che una sede senza prenotazioni non venga scelta come destinazione della prenotazione.
- [ ] Upload reale di logo/favicon/hero/gallery da sessione Admin autorizzata.
- [ ] Verificare MIME/errore quota con un file non valido o troppo grande senza lasciare asset fantasma.
- [ ] Verificare che un ruolo non autorizzato non possa caricare asset.
- [ ] Verificare `noindex,nofollow` per `/tavolo/...` e area `/staff/`.
- [ ] Eseguire audit accessibilità browser: tastiera, focus visibile, menu mobile, contrasto, reduced motion, label/alt.
- [ ] Rilevare TTFB/FCP/LCP/CLS/INP e verificare che non compaiano dati personali nella telemetry pubblica.
- [ ] Verificare che cache/service worker pubblico non intercetti `/staff/` e viceversa.

Evidenze minime: screenshot mobile/desktop, DevTools Elements per canonical/robots/JSON-LD, upload riuscito/negato, Lighthouse/Web Vitals.

## Stampa — STEP 7

Solo quando è disponibile hardware rappresentativo.

- [ ] Stampa ricevuta su Epson/bridge reale.
- [ ] Stampante offline durante invio: job deve diventare `FAILED/UNKNOWN` secondo contratto senza doppia stampa automatica.
- [ ] Retry manuale con conferma rischio duplicato.
- [ ] Ripristino stampante e stampa nuovo job.
- [ ] Verificare audit di richiesta/fallimento/retry/successo.

## Provider — STEP 6

Solo dopo credenziali Satispay sandbox.

- [ ] Configurare sandbox con `npm run setup:satispay:sandbox` e self-test autenticazione.
- [ ] Eseguire MATCH_CODE reale sandbox.
- [ ] Ricevere callback e verificare stato authoritative ACCEPTED/CANCELED.
- [ ] Verificare retry/idempotenza e callback duplicata/fuori ordine.
- [ ] Eseguire refund sandbox e verificare ledger/rimborso authoritative.

## Backup / restore — STEP 12

Richiede continuity host distinto dal client ristorante.

- [ ] `continuity:host-check` verde su host con Node >=24.13, Supabase CLI, psql e runtime container richiesti.
- [ ] Primary e replica su filesystem/dispositivi persistenti indipendenti.
- [ ] Eseguire un backup reale completo e verificare artifact cifrato + HMAC + replica.
- [ ] Creare target Supabase sacrificabile/fresco e lanciare restore-test reale.
- [ ] Verificare database, auth, migration history, private state e Storage metadata/bytes.
- [ ] Misurare RPO osservato.
- [ ] Misurare RTO osservato.
- [ ] Eseguire rehearsal di cutover/replacement e rollback operativo.

## Criterio di uscita

Gli STEP 6–12 possono essere marcati `COMPLETE` soltanto quando tutti i loro punti obbligatori sono PASS oppure un requisito esplicitamente opzionale/non applicabile è documentato dalla Roadmap. Dopo questa checklist si esegue lo STEP 13 finale e le tre revisioni complete richieste dal release gate.
