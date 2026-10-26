# Plateform — STEP 2/3: Eccezioni operative e coordinamento fra ruoli
**Aggiornato:** 12 ottobre 2026  
**Stato:** implementato su branch di sviluppo PR #38, non collaudato in CI su questo commit né distribuito.

## Problema individuato
Il Centro operativo mostrava conteggi sintetici di chiamate, cucina critica e incassi, ma un Admin non disponeva di un unico elenco delle **chiamate attive per tavolo** e delle **consegne prese in carico senza conferma** per verificare cosa stesse succedendo durante il servizio.

Non è sicuro aggiungere un pulsante che confermi arbitrariamente la consegna al posto del cameriere, perché l'RPC `deliver_step` controlla la titolarità del claim e la separazione dei ruoli.

## Funzionalità introdotte
- Nuova pagina Admin `/eccezioni`, raggiungibile da sidebar, Centro operativo e dalla priorità «Chiamate nuove».
- Consultazione in sola lettura delle `waiter_calls` attive (`NEW`, `ACCEPTED`) della sede selezionata, ordinate dalle più vecchie. Evidenzia tipo, tavolo, stato, assegnazione e tempo di attesa; CTA «Apri tavolo» e «Gestisci assegnazioni staff».
- Consultazione dei `step_deliveries` con `served_at IS NULL`, con contesto del `get_kitchen_board` letto dalla medesima sede; mostra lo step e la durata della presa in carico, senza concedere all'Admin la conferma `SERVED` per conto di un collega.
- Indicazioni visive per valutazione manuale: chiamate `NEW` oltre 5 minuti, `ACCEPTED` oltre 10 minuti dall'accettazione, consegne prese in carico oltre 10 minuti. **Non sono SLA né stati registrati nel DB**; nessun incidente è automaticamente dichiarato chiuso.
- Sezione contabile che recupera dal contratto `get_admin_operational_overview` il numero di pagamenti `PENDING`, quadrature in attesa e servizi contabili aperti, con collegamento alla pagina Cassa e quadrature.
- Caricamento limitato a 50 chiamate e 50 consegne per consultazione, con avviso esplicito qualora il risultato sia troncato; nuove selezioni/refresh scartano risposte obsolete.
- Unit test della funzione di classificazione pura per chiamate, claim, attese, completi e skew orario.

## Sicurezza e condizioni verificate
Il catalogo Supabase Development è stato consultato senza mutazioni:
- `waiter_calls.calls_read`: per `authenticated` limita alla sede e, per ruolo WAITER, al solo `assigned_waiter_id` corrente; ADMIN può leggere le chiamate della sede.
- `step_deliveries.deliveries_read`: verifica la sede e limita a claim propri per WAITER, con read access per ADMIN/PASS.
- Le colonne usate esistono con tipi previsti: `created_at`, `accepted_at`, `claimed_at`, `served_at`, `table_id`, `step_id`, `venue_id`, `waiter_id`.
- `get_floor_workspace`, `get_kitchen_board` e `get_admin_operational_overview` sono RPC esistenti; non sono stati aggiunti permessi, trigger o migrazioni.
- La pagina non invia comandi di riassegnazione, pagamento, chiamata completata, consegna SERVED o quadratura chiusa.

## Punti ancora aperti
1. Verifica con sessioni JWT reali di almeno un Admin, due camerieri, un Runner, un Pass e due sedi, inclusi cambi turno e RLS cross-venue.
2. Simulare una chiamata assegnata a personale non disponibile, un claim doppio e una consegna non registrata dopo 10 minuti, verificando audit e processi di escalation del locale.
3. Realizzare eventuale **riassegnazione assistita** solo dopo un contratto server autorizzato, auditabile, idempotente e coperto da regressioni. Non farla in client tramite UPDATE diretto.
4. Confermare il flusso Cassa con terminali POS reali e quadratura dopo verifiche di pagamento senza duplicazioni.
5. Typecheck, lint, unit test, suite PostgreSQL, Edge, Playwright e responsive/a11y del commit aggiornato. Nessun PASS inferito per la semplice presenza del codice.

**Non è un rilascio completo di STEP 2/3:** l'installazione pulita, Auth/Storage reali, backup/restore e P0 restano aperti.
