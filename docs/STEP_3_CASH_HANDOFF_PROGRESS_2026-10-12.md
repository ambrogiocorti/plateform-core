# Plateform — Step 3, completamento funzionale del passaggio conto → cassa

**Data:** 12 ottobre 2026  
**Stato:** codice implementato sul branch funzionale di PR #38; ancora NON verificato sulla CI del commit candidato, né integrato o distribuito.

## Evidenza delle funzionalità backend già esistenti

Lettura senza modifiche dal catalogo PostgreSQL Development:

- `public.create_payment(...)` salva un tentativo `PENDING` idempotente e riserva l'importo, incluso l'eventuale split.
- `public.confirm_manual_payment(uuid, boolean)` ammette `CASH`, `CARD_POS`, `SATISPAY_POS` e verifica ruolo `ADMIN/CASHIER`, registro assegnato, sessione contabile `OPEN`, conto e stato `PENDING` in transazione. Se già terminale, restituisce lo stato esistente. NON conferma provider online.
- `public.close_account(uuid)` accetta soltanto un conto con `remaining_cents = 0` e `pending_cents = 0` sotto autorizzazione `ADMIN/CASHIER`. Può chiudere finanziariamente un conto con piatti ancora da servire; il servizio fisico rimane distinto.
- `public.search_accounts(...)` accetta `p_search = ''`, filtro `ACTIVE`, limita a 20 per richiesta, controlla accesso alla sede e all'account sul server.

## Nuove funzionalità

1. **Elenco conti attivi in Cassa senza obbligo di ricerca.** Alla prima apertura, la postazione carica fino a 20 conti accessibili della sede dalla RPC `search_accounts`; ricerca per tavolo/nome/ID rimane disponibile. Risposte di ricerca e caricamento conto obsolete non sostituiscono mai il conto selezionato successivamente.
2. **Recupero dei pagamenti manuali rimasti PENDING** dopo chiusura finestra, perdita risposta o reload. I movimenti esistenti sono recuperabili dal dettaglio conto, dagli ultimi pagamenti della Cassa e dall'area `Incassi da verificare`. L'operatore verifica il contante o esito POS e invia **solo** `confirm_manual_payment` con l'ID originale; NON richiama `create_payment`, quindi non genera un incasso duplicato.
3. **Pagamento di esito ignoto rimane PENDING.** La finestra può essere chiusa senza forzare un esito. Le due azioni contraddittorie (riuscito/non riuscito) sono serializzate: dopo il primo invio entrambe si disabilitano; su errore del server tornano disponibili.
4. **Confine CORE / provider.** La vecchia conferma manuale duplicata nella sezione secondaria è rimossa. STRIPE / SATISPAY_API e metodi non abilitati non possono più essere confermati dal workflow manuale. I pagamenti di provider restano sotto il rispettivo flusso di verifica.
5. **Chiusura diretta del conto in Cassa.** Riutilizza `accountClosureActions` con bilancio server; il pulsante è disabilitato in presenza di residuo o pagamenti in attesa. Conferma esplicita prima di chiamare `close_account`, con avviso speciale se il conto contiene piatti non ancora serviti; dopo il successo aggiorna la stessa postazione. La chiusura dell'account NON equivale alla quadratura del servizio.
6. **Risultati coerenti con la contabilità.** L'UI mostra il conteggio dei piatti ancora in servizio in modo separato dai saldi e dai pagamenti. La sola presenza di un pagamento in coda non viene spacciata per incasso confermato.

## Regression test introdotti

- Nuovi test unitari per gli stati finanziari e i soli metodi manuali CORE recuperabili.
- Test E2E sulla lista iniziale dei conti attivi di una sede autorizzata (HTTP mock; server authorization verificata separatamente).
- Test PostgreSQL per il recupero della stessa transazione manuale `PENDING`: verifica cronologia, conferma idempotente della stessa operazione e assenza di un secondo record pagamento.
- Tutti i test sono nel branch ma **non ancora eseguiti sul suo commit aggiornato**. Non dichiarare PASS, GO-LIVE, restore o sicurezza real JWT senza prove.

## Gate e dipendenze ancora aperti

- TypeScript, Prettier, lint, test unitari/database ed E2E browser sull'esatto commit aggiornato; correggere i fallimenti emersi.
- Verifiche in staging con due cassieri contemporanei, due conti, due postazioni, quota parziale e pagamento già PENDING; refresh durante conferma, cassa chiusa e POS esterno con esito realmente verificato.
- Chiusura conto, ricevuta non fiscale, quadratura e salvataggio; collaudo con stampante reale se prevista.
- Cronologia SQL riproducibile, backup/restore, Security/RLS e Gate P0 prima di qualunque rilascio commerciale.

**Divieto:** non pubblicare come nuova versione CORE, non caricare dati demo nel Development, non modificare pagamenti reali e non produrre pacchetti finché la roadmap completa e i gate non sono verificati.

## Macro-passo successivo — Triage delle anomalie fra più operatori

Il nuovo pannello `/eccezioni` è collegato al Centro operativo Admin. Consente di individuare chiamate clienti in ritardo, consegne già prese in carico ma non completate e verifiche contabili pendenti **senza inventare permessi per altri operatori**. Mostra i dati della sola sede autorizzata tramite PostgREST RLS e contratti RPC già esistenti, e rimanda alla Sala, allo Staff, alla Cucina o alla Cassa per l'intervento. Le soglie visive 5/10 minuti non sono SLA contrattuali né modificano automaticamente gli stati.

Riferimento: `docs/STEP_2_3_SERVICE_EXCEPTION_PROGRESS_2026-10-12.md`.

**Gate ancora aperti:** multiutente/multisede in staging, passaggio turno con claim già aperto, reale incasso POS, quadratura, stampante, test e completamento del rollout. Il prodotto non è ancora certificato.
