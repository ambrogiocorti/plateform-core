# PWA e lavoro offline

Pubblico e staff hanno manifest, build e service worker separati. La cache del service worker include asset statici; non memorizza risposte Auth/API. L’aggiornamento della PWA è presentato all’operatore prima di ricaricare durante il servizio.

## Preparazione

1. Generare una coppia ECDSA P-256 per questa installazione. La chiave privata va esclusivamente in `OFFLINE_SIGNING_PRIVATE_JWK` server.
2. Configurare `VITE_OFFLINE_PUBLIC_KEYS_JWK` con l’array di una–tre chiavi pubbliche JWK ammesse, mai la coordinata privata `d`.
3. Abilitare la licenza OFFLINE; accedere online con ruolo operativo, registrazione device e sessione valida.
4. Usare la preparazione offline dal profilo. Vengono salvati contesto, menu e snapshot operativo per l’utente/sede: sala, comande pertinenti, conti del cameriere e operazioni autorizzate.

Lo snapshot firmato comprende utente, ruolo, scope, sedi, assegnazioni, dispositivo e scadenza limitata dalla sessione e dalla configurazione. La verifica locale usa le chiavi configurate nell’app: non si fida di una chiave sostituita dentro il record. Un controllo del tempo massimo osservato limita arretramenti accidentali dell’orologio; non è una protezione hardware contro la manipolazione del sistema operativo.

## Comandi disponibili

| Comando             | Ruolo locale                | Condizioni                                                                                              |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| CREATE_ORDER        | WAITER                      | Conto incluso nello snapshot, versione corrispondente, menu validato; una richiesta pending per risorsa |
| START_STEP          | WAITER, PASS, KITCHEN_ADMIN | Step incluso e autorizzato nello snapshot; dipendenze precedenti già servite                            |
| SET_TABLE_AVAILABLE | ADMIN, HOST, WAITER         | Tavolo da riapparecchiare incluso nello snapshot e senza occupazione nota                               |

Il comando in coda non modifica lo stato autoritativo né attiva la cucina prima del sync. Sala e comande mostrano data dell’ultimo snapshot. Non sono consentiti pagamenti, rimborsi, casse/quadrature, provider, ruoli, turni, impostazioni, feature, audit o configurazioni offline.

## Persistenza e sincronizzazione

IndexedDB conserva dati cifrati con AES-GCM e chiave non esportabile, distinta dal token di firma. Il nome del record è autenticato come additional data. Web Locks coordina scritture e sync tra tab; senza questa API la coda è disabilitata. Questa cifratura non sostituisce protezioni da XSS o sicurezza del dispositivo.

Ogni evento conserva UUID client, chiave idempotente, data locale, utente/device/sede, tipo/ID risorsa, operazione, versione, payload e stato. Alla riconnessione vengono inviati solo eventi dell’utente autenticato. PostgreSQL ricontrolla sessione, dispositivo, assegnazioni, licenza, scadenza, versione e invarianti. Il replay identico non esegue due volte il comando.

Un rifiuto conserva l’evento come CONFLICT e crea un conflitto server con motivo/snapshot. Il centro Admin consente annullamento o verifica motivata, auditata; questi atti non dichiarano eseguita l’operazione rifiutata. Dopo la risoluzione il server porta l’evento sorgente a REJECTED e il client riconcilia gli stati remoti prima di riprendere la coda: SYNCED, REJECTED e RESOLVED sono terminali e possono sbloccare il successore causale. Ogni nuovo evento locale conserva come predecessor l’ultimo evento non terminale dello stesso utente e sede. Correzioni degli ordini avvengono sui dati aggiornati online. Una coda cifrata illeggibile viene conservata e blocca nuove scritture con un errore
esplicito; non viene sostituita silenziosamente da una coda vuota. Non c’è ancora un editor completo del payload dal centro conflitti.

Logout rimuove cache e autorizzazioni ma conserva la coda. Un altro utente non può sovrascrivere richieste non terminali. Alla riconnessione, dopo il sync, Plateform rinnova authorization snapshot e workspace; se il refresh fallisce, invalida i dati offline sensibili preservando la queue per la riconciliazione successiva. Lo storico locale sincronizzato e la pulizia delle vecchie cache richiedono ancora una gestione completa dei limiti/retention. Safari/iOS, scadenza durante servizio, revoca da un altro dispositivo, cadute dopo commit e perdita del dispositivo restano prove obbligatorie su staging.
