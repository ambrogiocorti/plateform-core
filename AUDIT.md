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
