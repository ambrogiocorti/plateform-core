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
- Nessun evento storico è stato cancellato o modificato. Il registro resta append-only. I nomi/codici possono apparire in lingua inglese se non ancora tradotti: le azioni prioritarie hanno già label in italiano.

### Limitazioni e gate residui

1. Il test transazionale sul database Supabase e la verifica SQL delle autorizzazioni sono distinti da un vero test browser/GoTrue/MFA del Super Admin; quest'ultimo non è ancora certificato.
2. La traccia durevole dei login Auth **falliti** non si ottiene affidabilmente da una transazione di login fallita. È necessario un canale server affidabile che non accetti falsificazioni dal browser e con rate limiting. Il catalogo la segnala come PLANNED.
3. Non registrare semplici visualizzazioni, click o heartbeat come audit. Esportazioni e consultazioni di dati personali sono da tracciare con un canale autorizzato separato, non inserendo payload personali o segreti.
4. Una policy concreta di retention per categoria richiede una valutazione normativa e operativa: il campo `retention_class` è classificazione, non autorizza cancellazioni automatiche. Archiviazione durabile, checksum, verifica anti-manomissione esterna e restore storico rimangono da certificare.
5. Database remoto e repository hanno una cronologia migrazioni non ancora completamente riconciliata: **il fatto che due nuove migrazioni siano in git non rende il progetto go-live-ready**. Tutte le condizioni di `ROADMAP_STATUS` e dei gate commerciali restano applicabili.

Test: `tests/database/audit-professional.test.ts` più verifica live transazionale (rollback) del comportamento dei trigger. I test PGlite, anche quando verdi, non equivalgono a una prova completa dell'infrastruttura Supabase.
