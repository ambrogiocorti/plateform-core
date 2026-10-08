# Aggiornamenti realtime

## Contratto

PostgreSQL è autoritativo. I trigger inseriscono nella stessa transazione segnali di
invalidazione in `public.realtime_signals`. Un rollback annulla anche i segnali.
Il payload contiene soltanto ID, sede, argomento e timestamp; prezzi, nomi e dati di
contatto restano fuori dal canale. Gli ID sono comunque protetti dalle policy di accesso.

La migrazione 20 ammette nella pubblicazione `supabase_realtime` esclusivamente questa
tabella e configura `publish=insert`. Blocca la migrazione se trova altre tabelle non
revisionate nella pubblicazione. DELETE/UPDATE dei dati aziendali producono nuovi INSERT
di invalidazione; le cancellazioni dei segnali scaduti non sono pubblicate.

## Autorizzazione

| Segnale      | Destinatari autorizzati dal database                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| PUBLIC       | Lettori del sito/menu della sede attiva                                             |
| FLOOR        | Ruoli operativi sala della sede                                                     |
| BOOKING      | Host e Admin della sede                                                             |
| ACCOUNT      | Admin/Cashier, cameriere responsabile o sessione cliente del proprio conto          |
| KITCHEN      | Ruoli cucina/Pass, stazioni assegnate/osservatrici, consegne autorizzate            |
| FINANCE      | Admin e Cashier della sede                                                          |
| CALL         | Cameriere destinatario e Admin                                                      |
| NOTIFICATION | Destinatario utente o ruolo della notifica                                          |
| ACCESS       | Solo proprietario del JWT; chiede di ricontrollare l'accesso, non comunica permessi |
| CONFIG       | Admin della sede                                                                    |

Ogni canale filtra la sede selezionata e, se autenticato, l'utente destinatario. RLS
verifica nuovamente il contesto corrente. La policy anon accetta esclusivamente PUBLIC.
I segnali ACCESS permettono di rimuovere una vista revocata; polling e scadenza server
rimangono necessari anche quando il canale è disconnesso.

## Recupero client

`SnapshotReconciler` deduplica gli ID, accorpa eventi ravvicinati e rilegge lo snapshot.
Se un evento arriva durante la lettura, effettua una nuova lettura prima di considerare
concluso il recupero. Nessun payload tardivo sovrascrive una versione corrente.

Una subscription confermata, il ritorno online e il ritorno della scheda in primo piano
richiedono un nuovo snapshot. Un controllo ogni 30 secondi recupera eventi persi e verifica
le sessioni; non sostituisce il canale realtime. Il trasporto può risultare connesso solo
dopo SUBSCRIBED e una lettura riuscita. Errori/offline sono mostrati esplicitamente.

I form aperti rinviano il ridisegno per conservare gli inserimenti; gli RPC mantengono
version checks e autorizzazione al momento del comando. Una revoca confermata chiude le
viste protette. Il carrello cliente è separato dallo snapshot ed è congelato dopo l'invio;
un esito incerto mantiene payload e chiave per il retry idempotente.

## Operazioni e verifiche mancanti

La funzione server `purge_realtime_signals()` rimuove segnali più vecchi di un giorno.
Lo scheduling richiede ancora il worker operativo/configurazione del progetto.
Test locali verificano trigger, RLS, publication, deduplica e riconciliazione del carrello.
Websocket, revoca effettiva attraverso il gateway, carico e latenza <1 s richiedono test
su Supabase reale: non sono dichiarati verificati. Impersonazione e snapshot offline
devono essere integrati quando quei moduli saranno completati.

Riferimento infrastrutturale: [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes).
