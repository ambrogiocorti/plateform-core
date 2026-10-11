# Audit Plateform

## Stato

Registro PostgreSQL, protezioni, contesto e ricerca sono implementati e coperti da test locali.
Le fondamenta sono state provate anche sul PostgreSQL Supabase reale mediante fixture
transazionali annullate. Copertura completa degli eventi, archiviazione e roundtrip dei
singoli moduli restano da completare.

## Identità e contesto

`audit_log` contiene timestamp, tipo attore, utente/ruolo, sede, azione, risorsa, esito,
old/new redatti, request ID e correlation ID. Include collegamenti a conto, ordine, tavolo,
pagamento, cassa, servizio, device e sessione quando ricavabili dalla risorsa.
Il browser invia un UUID di richiesta; gli endpoint Edge lo validano e lo propagano al database.
Le richieste prive di un UUID valido ricevono un nuovo identificativo server.
Un correlation ID distinto viene conservato fino ad audit e telemetry; gli identificativi
servono alla diagnostica e non conferiscono autorizzazioni.

`private.audit` applica l'allowlist prima di scrivere. Password, PIN, hash dei codici, token,
chiavi e dati completi delle carte non appartengono ai campi ammessi. I motivi delle correzioni
finanziarie sono registrati: non inserirvi segreti o informazioni personali non necessarie.
La struttura conserva l'utente effettivo e il Super Admin impersonante; il workflow di
impersonazione è presente e richiede ancora il collaudo reale di read-only/write e revoca.

## Immutabilità e accesso

Le mutazioni applicative usano RPC controllate. I trigger registrano gli eventi nella stessa
transazione della modifica: una transazione annullata non lascia un falso evento di successo.
Il registro ha protezioni contro UPDATE, DELETE e TRUNCATE e non concede scritture ai ruoli
browser. La dashboard e `search_audit` richiedono Super Admin autenticato con MFA.
Admin e Cashier non possono consultare il registro tecnico completo.

Questi controlli governano gli accessi dell'applicazione. L'accesso amministrativo diretto
all'infrastruttura PostgreSQL richiede anche controlli operativi e copie esterne verificabili;
queste copie non sono ancora configurate nell'ambiente disponibile.

## Consultazione

La pagina `/audit` offre azione, intervallo temporale, utente, sede, ruolo, tipo/ID risorsa,
esito, request ID, correlation ID e presenza di impersonazione. Mostra i dettagli old/new
come testo, senza controlli di modifica. La paginazione usa `(timestamp, id)` decrescente,
50 eventi per pagina, massimo 200 imposto dal server. I timestamp uguali non producono
duplicati o omissioni. I filtri applicati restano stabili durante il caricamento delle pagine.

## Contabilità

`cash_journal` conserva movimenti immutabili di incasso, rimborso e storno, con importo
e mancia separati. `cash_reconciliations` conserva lo snapshot alla chiusura. Le rettifiche
successive vengono registrate nel servizio corrente. I dati originari dei pagamenti,
le richieste di differenza e gli snapshot già conclusi non vengono riscritti.

## Verifiche e lavoro aperto

`tests/database/audit-search.test.ts` verifica filtri, cursori, ruoli e MFA.
`tests/database/reconciliation.test.ts` verifica immutabilità e contesto delle correzioni.
I test usano PostgreSQL PGlite con Auth fixture; non attestano lo stack Supabase completo.

Webhook/provider, sync offline, conflitti, stampa e retention hanno eventi server. Restano
da verificare la copertura completa dei fallimenti Auth e degli eventi del master, oltre
a backup/restore, rotazione delle partizioni e archivio storico senza perdita,
protezione delle copie esterne e prove di carico con milioni di eventi. La tabella è
partizionata per timestamp con partizione di default; nessun job di rotazione è ancora attivo.
Telemetry è separata dall'audit e non può sostituirlo.


## Audit professionale — aggiornamento live 11 ottobre 2026

**Implementato sul database `plateform-development` (non ancora certificato per la vendita).**

- `private.audit_event_catalog` include 141 codici storicamente osservati in produzione di sviluppo, classificati per area, criticità e classe di conservazione. La seed migration canonica popola gli stessi 141 codici anche su nuove installazioni con audit inizialmente vuoto.
- I 7 eventi `AUTH_LOGIN_FAILED`, `MFA_VERIFICATION_FAILED`, `SENSITIVE_DATA_ACCESS`, `SENSITIVE_DATA_EXPORTED`, `AUDIT_EXPORTED`, `ACCESS_DENIED`, `PRIVILEGE_CHANGE_DENIED` sono **PLANNED**: il catalogo non li trasforma in eventi realmente emessi. Serve implementazione/integrazione Auth, privacy ed error-handling con fonte server attendibile.
- `public.search_audit_professional` mantiene autorizzazione `SUPER_ADMIN`, pagina tramite coppia ordinata `(timestamp,id)`, filtra sul server anche `category` e `severity` e restituisce etichetta umana e classe dell'evento. La precedente `public.search_audit` resta disponibile, senza rompere i consumer già esistenti.
- `public.get_audit_event_catalog` espone al solo Super Admin l'elenco dei tipi realmente osservati e di quelli pianificati. Alla dashboard `/audit` si aggiungono filtri Categoria/Criticità, etichetta per evento e informazioni di registrazione e completezza del catalogo.
- Sugli UPDATE di `public.registered_devices` non producono più audit le sole modifiche a `last_seen_at`, `last_sync_at`, `app_version`: sono telemetria/presenza del dispositivo. Restano nell'audit modifiche a utente, sede, etichetta, piattaforma, assegnazione e revoca, più ogni INSERT/DELETE. La verifica diretta con transazione rollback è PASS: heartbeat senza nuovo evento, cambio assegnazione con nuovo evento.
- Colonne opzionali aggiunte per evoluzioni documentate: `ip_address`, `user_agent`, `reason_code`, `authorization_context`; il campo `emitter_source` è `DATABASE_AUDIT` per i record generati nel DB. **Non** raccogliamo automaticamente IP/User-Agent non affidabili da header client né dati di sessione segreti. Per IP/UA serviranno una trust boundary verificata, minimizzazione e retention documentata.
- Le categorie sono basate su un catalogo versionato, non su testo libero dell'utente; gli eventi futuri senza voce esplicita sono restituiti come `UNCATALOGUED`, visibili e da riesaminare, mai ignorati silenziosamente.
- La allowlist di redazione include inoltre i soli identificativi e attributi tecnici `user_id`, `platform`, `assigned_role_or_station`: le differenze sulle assegnazioni dei dispositivi sono consultabili senza duplicare `display_name` nell'audit. Test SQL diretto: heartbeat ignorato, cambio assegnazione registrato, differenza visibile e nessun campo sensibile, tutto in rollback.
- Nessun evento storico è stato cancellato o modificato. Il registro resta append-only. I nomi/codici possono apparire in lingua inglese se non ancora tradotti: le azioni prioritarie hanno già label in italiano.

### Limitazioni e gate residui

1. Il test transazionale sul database Supabase e la verifica SQL delle autorizzazioni sono distinti da un vero test browser/GoTrue/MFA del Super Admin; quest'ultimo non è ancora certificato.
2. La traccia durevole dei login Auth **falliti** non si ottiene affidabilmente da una transazione di login fallita. È necessario un canale server affidabile che non accetti falsificazioni dal browser e con rate limiting. Il catalogo la segnala come PLANNED.
3. Non registrare semplici visualizzazioni, click o heartbeat come audit. Esportazioni e consultazioni di dati personali sono da tracciare con un canale autorizzato separato, non inserendo payload personali o segreti.
4. Una policy concreta di retention per categoria richiede una valutazione normativa e operativa: il campo `retention_class` è classificazione, non autorizza cancellazioni automatiche. Archiviazione durabile, checksum, verifica anti-manomissione esterna e restore storico rimangono da certificare.
5. Database remoto e repository hanno una cronologia migrazioni non ancora completamente riconciliata: **il fatto che due nuove migrazioni siano in git non rende il progetto go-live-ready**. Tutte le condizioni di `ROADMAP_STATUS` e dei gate commerciali restano applicabili.

Test: `tests/database/audit-professional.test.ts` più verifica live transazionale (rollback) del comportamento dei trigger. I test PGlite, anche quando verdi, non equivalgono a una prova completa dell'infrastruttura Supabase.

## Estensione verificata — 11 ottobre 2026, audit privacy / export / security / partizioni

Implementato e applicato esclusivamente a Supabase `plateform-development`:

- La RPC `search_privacy_reservations` è ora VOLATILE e produce `SENSITIVE_DATA_ACCESS` dopo l'autorizzazione Admin e la ricerca, senza inserire né telefono né risultati personali nei campi audit. Errori nella registrazione interrompono anche la lettura; gli eventi non sono persi silenziosamente.
- `export_reservation_personal_data` già usava step-up e scriveva `PERSONAL_DATA_EXPORTED`: NON è stata duplicata la logica. Catalogati anche rettifica, anonimizzazione e privacy hold come eventi implementati.
- `export_audit_professional` usa Super Admin, password step-up `AUDIT_EXPORT` monouso, motivazione obbligatoria, massimo 500 righe e finestra fino a 31 giorni; esclude IP, user-agent e campi metadata. La dashboard `/audit` consente il download JSON e segnala le esportazioni parziali. Ogni esportazione completata scrive `AUDIT_EXPORTED`.
- `record_step_up_denial` può essere chiamata **solo** da `service_role`. La Edge `step-up` v12 la invoca quando la verifica effettiva di password fallisce. Non copia password, email, IP o token; conserva l'attore da `auth.getUser()` e la sessione già autorizzata. Il codice distribuito coincide con GitHub; nessuna prova con account reale è stata eseguita.
- Il catalogo distingue `OBSERVED` (evento effettivamente apparso nel DB), `IMPLEMENTED` (flusso scritto e testato ma evento non ancora prodotto live) e `PLANNED` (funzionalità non ancora verificata). Trigger limitati promuovono eventi sensibili a `OBSERVED` soltanto al loro effettivo inserimento.
- Quattro partizioni audit future sono predisposte per novembre e dicembre 2026, gennaio e febbraio 2027, con RLS e trigger di immutabilità ereditati. Cron `plateform-audit-future-partitions` ogni giorno 20 del mese, ore 00:05 UTC, prepara i prossimi quattro mesi. Non è attiva **alcuna cancellazione** né spostamento dei vecchi eventi in default.
- Test SQL live (transazione rollback) e pipeline PGlite focalizzata: **8/8 PASS**, incluse ricerca privacy senza PII, privilegi, esportazione monouso, step-up denial, partizioni e immutabilità storica. CI globale ancora in FAIL: 101 file nella verifica Prettier; la storia migrazioni remota/local non è riconciliata.

### Requisiti ancora non certificati

- `AUTH_LOGIN_FAILED` prima della sessione e `MFA_VERIFICATION_FAILED`: non implementare da semplice chiamata browser che sarebbe falsificabile; serve un'integrazione con Auth/GoTrue o gateway attendibile con anti-abuso. `ACCESS_DENIED` e `PRIVILEGE_CHANGE_DENIED` generali devono essere registrati fuori dalla transazione negata, senza rendere una negazione una modifica riuscita.
- Prova Auth reale su utente staff e MFA, integrazione browser/deploy della UI, restore end-to-end dell'ultima versione.
- Archivio storico durevole fuori database con cifratura/verifica hash e controllo delle chiavi, test anti-manomissione e retention approvata dal titolare. **Nessuna eliminazione audit** autorizzata finché non è provata la recuperabilità e la policy legale.
- Catalogo con label italiane per tutti i codici; eventuale revisione semantica delle categorie; controllo di qualità dei log.
- Gate completo `npm run check` e `npm run release:check`, confronto delle migrazioni remote/local e merge controllato delle PR #21 e #22.

**Stato rilascio: NO-GO.** Le CI focalizzate non equivalgono al rilascio commerciale e non è stato creato alcun pacchetto.

## Aggiornamento Audit/Log — 11 ottobre 2026

Il catalogo e la dashboard Audit sono integrati con la dashboard **Log tecnici e anomalie** in `/salute`. Le nuove RPC server-side `search_technical_logs` e `run_health_log_retention` sono separate dalla consultazione immutabile `search_audit_professional`; un errore tecnico non viene spacciato per mutazione economica e un log di salute non costituisce prova di un accesso Auth.

Eventi `AUTH_LOGIN_FAILED` e `MFA_VERIFICATION_FAILED` non sono ancora emessi in modo attendibile dall'applicazione: Supabase offre audit Auth nativi, ma la copia opzionale `auth.audit_log_entries` risulta vuota. Il canale live `STEP_UP_FAILED` rimane verificato a livello di fonte Edge; il nuovo login staff richiede un piano specifico per tracciare fallimenti **prima** della sessione senza accettare segnalazioni falsificabili dal browser. Non salvare mai le credenziali tentate.

Lo storico Audit è preservato, senza cancellazioni automatiche. Una retention dell'audit richiede termini approvati, archivio esterno verificato anti-manomissione e restore-test indipendente. Non usare la cronologia dei job PostgreSQL o i log di telemetria al posto di tale archivio. Finché questi gate mancano, l'audit è funzionalmente esteso ma non completamente certificato per la vendita.
