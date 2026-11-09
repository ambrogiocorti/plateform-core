# ADR-0001 — Continuità LAN tramite hub di sede

- Stato: **ACCETTATA come direzione; prova minima eseguita in locale, collaudi LAN-01…07 NON eseguiti**
- Data: 8 novembre 2026
- Requisito: prompt di completamento commerciale dell'8/11/2026, §6 e collaudi LAN-01…LAN-07; Master Prompt §§ offline/continuità (superato per la parte "solo coda browser").
- Codice della prova: `tools/venue-hub/`, test `tests/hub/lan-cycle.test.ts`.

## Problema

Con Internet interrotto e LAN funzionante, sala, cucina/Pass e cassa devono continuare a comunicare e a registrare operazioni economiche in modo durevole, senza duplicazioni al ritorno della connessione. L'implementazione esistente (`src/offline/*`) accoda nel singolo browser tre comandi "sicuri" con snapshot firmati: non permette a un secondo dispositivo di vedere l'ordine e quindi non soddisfa il requisito. GitHub Pages serve file statici e Supabase non fornisce un server LAN.

## Vincoli verificati nel repository

1. Tutte le regole di business (prezzi dal catalogo, disponibilità, versioni, idempotenza, permessi per ruolo/sede, RLS, audit) sono implementate in **PL/pgSQL nelle 500 migrazioni** e nelle RPC `SECURITY DEFINER`.
2. Le 500 migrazioni sono già rieseguite integralmente su **PGlite** (PostgreSQL 17 in WASM) dalla suite `tests/database` (214 test verdi l'8/11/2026). Le parti Supabase non portabili sono poche e isolate: `auth.uid()/auth.jwt()`, `pg_cron`, Vault, metadati Storage (`tools/venue-hub/platform-schema.ts`).
3. Il bridge di stampa Node 24 esiste già (`tools/print-bridge`, registro SQLite WAL, stati SENT/UNKNOWN, nessun retry fisico automatico).
4. Esistono snapshot autorizzativi offline firmati ECDSA P-256 (`supabase/functions/offline-authorization`, `prepare_offline_authorization`).
5. Il log di audit è protetto da un controllo che vieta trigger non approvati sulle partizioni (`private.assert_audit_append_only`): la prova lo ha confermato in pratica (`AUDIT_APPEND_ONLY_VIOLATION`).

## Alternative valutate

| #   | Alternativa                                                                            | Pro                                                                                                                                                                | Contro                                                                                                                                        | Esito                                          |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A   | Solo coda nel browser (attuale)                                                        | Già presente                                                                                                                                                       | Nessuna comunicazione fra postazioni; cucina e cassa non vedono gli ordini                                                                    | Scartata (non soddisfa §6)                     |
| B   | Supabase self-hosted completo (Docker) in sede                                         | Stessa API cloud                                                                                                                                                   | Docker su Windows/macOS dei ristoratori, 10+ container, risorse, aggiornamenti e sicurezza pesanti; due Supabase con due Auth da riconciliare | Scartata per installazione e manutenzione      |
| C   | PostgreSQL nativo in sede + servizio Node                                              | Postgres completo, multi-connessione                                                                                                                               | Installer/servizio Postgres per OS, upgrade di major version, superficie amministrativa locale                                                | Riserva se PGlite non regge il carico misurato |
| D   | Nuovo datastore locale (SQLite/IndexedDB) con regole riscritte in TypeScript           | Leggero                                                                                                                                                            | **Duplica** prezzi, disponibilità, conti e cassa in un secondo motore: rischio di risultati economici diversi (vietato dal §6)                | Scartata                                       |
| E   | **Hub Node 24 con PostgreSQL embedded (PGlite) che esegue le stesse migrazioni e RPC** | Una sola implementazione delle regole; stesso SQL verificato in CI; transazioni reali; processo unico installabile su Windows/macOS/Linux; integra il print bridge | PGlite è a connessione singola (scritture serializzate); emulazione Auth/cron/Vault da mantenere; prestazioni da misurare                     | **Scelta**                                     |

## Decisione

### Tecnologia e packaging

- **Servizio:** processo Node.js 24 LTS (`tools/venue-hub`), stesso runtime del print bridge, che a regime viene integrato nello stesso processo (una sola installazione per sede).
- **Dati:** PGlite su filesystem locale (`dataDir`), stesse migrazioni del cloud applicate con registrazione in `supabase_migrations.schema_migrations`, ogni migrazione nella stessa transazione della sua registrazione (ripresa sicura dopo installazione interrotta). Le migrazioni restano immutabili: nessun fork dello schema per l'hub.
- **Packaging (da realizzare):** pacchetto per OS con Node 24 incluso e supervisore nativo (servizio Windows, `launchd` su macOS, `systemd` su Linux), directory dati privata, backup locale cifrato periodico. Matrice delle versioni collaudate da compilare solo dopo prove reali.

### Autorità delle scritture

- **Modalità stabile:** l'hub è l'**unica autorità di scrittura per le operazioni di servizio della sede** (conti, ordini, disponibilità giornaliera, stati cucina/Pass, consegne, sessioni di cassa, incassi contanti/POS attestati) **anche quando il cloud è raggiungibile**. Non c'è commutazione automatica cloud↔hub durante il servizio: si evita per costruzione la doppia autorità.
- **Generazione / fencing:** ogni hub ha `hub_id` e una `generation` intera. Il cloud registra per sede la generazione corrente; la replica rifiuta batch di generazioni inferiori (`HUB_GENERATION_FENCED`). L'hub rifiuta di avviarsi con una generazione inferiore a quella dei propri dati (`HUB_GENERATION_REGRESSION`) o con dati di un altro hub (`HUB_DATA_BELONGS_TO_ANOTHER_HUB`). La sostituzione dell'hub è un'operazione amministrativa esplicita (promozione con generazione +1); un hub deposto che si riconnette viene respinto e i suoi dati non sincronizzati vanno in quarantena per riconciliazione manuale.
- **Guasto dell'hub:** stato esplicito "hub non raggiungibile" sui client; nessun secondo server scrivente parte da solo. Ripresa: riavvio, oppure ripristino dell'ultimo backup locale + replica cloud su macchina sostitutiva con nuova generazione.
- **Il browser non è mai autorevole:** prezzi, residui e disponibilità sono calcolati dalle RPC eseguite dall'hub.

### Modello dei dati e sincronizzazione

- **Outbox:** trigger `AFTER ROW` (`hub.capture`) su tutte le tabelle `public` con chiave primaria scrivono in `hub.changelog` (seq monotono, generazione, txid, tabella, PK, riga) **nella stessa transazione** della modifica di business. Nessuna modifica confermata può mancare dall'outbox o comparire in ordine diverso.
- **Replica verso il cloud:** batch in ordine di seq applicati in una transazione con upsert per PK; stato `(hub_id, generation, applied_seq)` sul cloud; i seq già applicati vengono ignorati (ritrasmissioni e ack persi non duplicano ordini, consumi, incassi). L'ack sull'hub è monotono. I trigger di business non vengono rieseguiti sul cloud: si replicano i risultati già calcolati dall'hub, non i comandi (gli ID generati dal server restano stabili).
- **Audit:** il log è append-only e non ammette trigger aggiuntivi; la replica avverrà con un cursore append-only sulle righe di audit (aperto: **AUD-SYNC**), senza modificare le guardie.
- **Cloud → hub (inbox):** cataloghi, configurazioni, staff/revoche e richieste dei canali remoti (prenotazioni online, QR fuori LAN, caparre) vengono scaricati dall'hub e applicati in ordine con la stessa tecnica; le richieste remote diventano **richieste da confermare** dall'autorità di sede, mai conferme definitive emesse dal cloud mentre l'hub detiene l'autorità (aperto: **INBOX**, **LAN-07**).
- **Vincolo hosted da verificare:** sul cloud la replica deve sospendere i trigger di business durante l'applicazione. In PGlite si usa `session_replication_role = replica` (superuser). Su Supabase ospitato il ruolo applicativo non è superuser: servirà una nuova migrazione con guardia `current_setting('plateform.replica_apply')` nelle funzioni trigger oppure l'uso documentato di un ruolo con tale privilegio. Fino a quella verifica la replica verso il cloud è **NON VERIFICATA su Supabase**.

### Protocollo e rete

- HTTP JSON (`POST /v1/rpc/:name`, `GET /v1/table/:name`, `GET /v1/health`) e flusso eventi `GET /v1/events` (Server-Sent Events via `fetch` con header di autorizzazione). Gli eventi trasportano **solo invalidazioni** (`rpc`, `seq`): i client rileggono attraverso RPC/RLS, quindi lo stream non espone dati non autorizzati.
- Superficie esposta: allowlist esplicita di RPC con arità esatta (`LAN_RPCS`) e di tabelle leggibili sotto RLS (`LAN_TABLES`). Amministrazione, credenziali/MFA, restore, creazione privilegi, provider di pagamento online: **non disponibili via LAN**.
- Protezioni: allowlist esatta dell'header `Host` (DNS rebinding), allowlist esatta di `Origin` con CORS, `Content-Type: application/json` obbligatorio (preflight per richieste cross-site), limite del corpo, token dispositivo opaco verificato per digest SHA-256 con scadenza assoluta.
- In produzione: **HTTPS** con nome stabile in LAN (es. `hub.<ristorante>.plateform.local` risolto da DNS locale/DHCP reservation) e certificato attendibile dai dispositivi associati; l'app staff viene servita **dall'hub stesso** in LAN, così il contesto sicuro e il service worker funzionano senza Internet e senza dipendere dalle regole Local Network Access di Chrome per richieste da origini pubbliche. Rete ospiti separata e isolamento Wi-Fi: diagnosi in fase di associazione.
- **Identità locale:** associazione dispositivo con codice di pairing emesso dal cloud quando disponibile; sessioni staff locali derivate dagli snapshot firmati esistenti (verifica della firma con chiave pubblica, durata limitata, PIN/blocco postazione). Revoca locale immediata; finestra di revoca remota limitata alla durata dello snapshot quando il cloud è irraggiungibile, documentata al cliente.

### Operazioni economiche e servizi esterni

- Contanti e POS esterno con attestazione manuale: registrati dall'hub, durevoli, auditati.
- Stripe, Satispay, rimborsi online e qualunque provider: **bloccati** durante l'isolamento con messaggio esplicito; nessun addebito differito automatico.
- Stampa conti/comande: coda persistente nell'hub/bridge con gli stati esistenti (SENT/UNKNOWN, nessuna ristampa automatica).

## Prova minima eseguita (8/11/2026)

`tests/hub/lan-cycle.test.ts` avvia l'hub reale su disco con le 500 migrazioni e lo pilota via HTTP con **client indipendenti con token distinti** (cameriere, cucina, Pass, cassa). I risultati e i limiti sono riportati nella sezione "Evidenze" del registro `docs/commercial-completion/AUDIT_2026-11-08.md`.

Limiti dichiarati: stessa macchina, loopback HTTP senza TLS, nessuna partizione di rete reale, nessun dispositivo fisico, nessuna prova su Supabase ospitato. **Non chiude LAN-01…LAN-07.**

## Conseguenze e lavoro aperto

1. ~~Adattatore dati nel frontend~~ **Fatto il 9/11/2026, da completare:** contratto condiviso `shared/lan-contract.ts` (RPC con argomenti nominali, tabelle, metodi di pagamento ammessi), instradamento in `src/api/client.ts` tramite `src/api/venue-hub.ts`, eventi dell'hub nella vista live (`src/realtime/live.ts`), pagina staff "Hub di sede" e indicatore separato Internet / hub / cloud / sincronizzazione. Prova browser in `tests/e2e/venue-hub.spec.ts`. **Accesso in sede (9/11/2026):** su un dispositivo associato la persona sceglie il proprio nome e inserisce il PIN; l'hub esegue `public.unlock_staff_session` come quella persona (contatore tentativi, blocco progressivo, finestra di autenticazione completa già esistenti nel database) e rilascia un token di sessione casuale, conservato solo come SHA-256 in `hub.local_sessions`, legato al dispositivo, con scadenza = min(finestra di sblocco, 12 h) e revoca su "Esci"/"Blocca". Con l'header `x-plateform-staff-session` le richieste agiscono come la persona; senza, come il dispositivo (schermi monouso). Profilo, sedi e funzionalità arrivano da `GET /v1/context` sotto RLS della persona. L'hub **non crea mai** un'autenticazione completa: usa l'ultima `private.staff_sessions` replicata dal cloud, quindi chi non ha fatto login con password nella finestra consentita riceve `FULL_AUTH_REQUIRED`. Prove: `tests/hub/staff-session.test.ts`, secondo scenario di `tests/e2e/venue-hub.spec.ts` (cloud bloccato). Limiti: l'elenco dei nomi è visibile a ogni dispositivo associato; le sessioni cloud e le revoche arrivano all'hub solo con INBOX (punto 3), oggi non ancora costruito; lo sblocco da parte di un responsabile attende la decisione del committente. Mancano inoltre: copertura delle viste sala/conti/cassa con dati dall'hub, servizio dell'app staff dall'hub stesso.
2. Ingest cloud (Edge Function service-only + RPC) con le stesse semantiche di `tools/venue-hub/replication.ts`; migrazione per la guardia di replica; registro generazione per sede.
3. AUD-SYNC, INBOX, pairing e sessioni locali da snapshot firmati, revoche.
4. Integrazione del print bridge nel processo hub; coda stampe locale.
5. Packaging/servizio per OS, backup locale, spazio disco, upgrade compatibile client/hub.
6. Misure di capacità (PGlite serializza le scritture): target dichiarati solo dopo misura.
7. Collaudi LAN-01…LAN-07 su dispositivi e browser realmente separati.
