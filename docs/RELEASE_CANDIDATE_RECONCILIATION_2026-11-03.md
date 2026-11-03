# Plateform — candidata completa: riconciliazione del 3 novembre 2026

**Obiettivo:** completamento del perimetro del Master Prompt aggiornato, sezioni 0–157.
**Stato:** sviluppo e verifica in corso; **NO-GO commerciale**. Questo registro sostituisce i conteggi e il perimetro dei checkpoint precedenti, senza trasformare le prove storiche in collaudi della candidata.

## Sorgente unico e contratto delle licenze

La candidata riunisce il lavoro UX/stampa della PR 55 e il replay isolato della PR 56. Recupera inoltre le 14 SQL che il ramo applicativo non conteneva più, mantenendone ogni byte e SHA-256. Le sole nuove modifiche di schema sono nella migrazione forward-only `20261103161146_licensed_epson_printing.sql`.

Il confronto **in sola lettura** con `plateform-staging` (`qfgoatdabgnzozxuzxku`) rileva 496 migrazioni applicate. Tutte le versioni, i nomi e i digest coincidono con il sorgente recuperato. Nella candidata ci sono 498 migrazioni: restano pendenti soltanto `20261027183000` (waitlist idempotente) e `20261103161146` (licenza Epson), entrambe successive alla storia applicata. Non risultano migrazioni retrodatate o SQL applicate divergenti. Nessun `db push` o aggiornamento di staging/produzione è stato eseguito.

Le migrazioni del 18–21 ottobre avevano intenzionalmente introdotto statistiche di base e pagamenti per licenza. I test sono ora distinti: il precedente contratto CORE viene ancora eseguito sul suo schema storico, mentre sullo schema attuale sono obbligatori sia i rifiuti senza licenza/ruolo/step-up sia i flussi autorizzati. I quattro test della macchina a stati dei provider sono nuovamente eseguiti.

## Implementazione collegata

- Statistiche: schema frontend discriminato fra dati di base e avanzati; niente metriche avanzate inventate come zero e niente errore di parsing per una risposta di base. Restano i controlli sui ruoli e sulle sedi.
- Profili: `VITE_PLATEFORM_EDITION=CORE|FULL` per le due build e `PLATEFORM_EDITION=CORE|FULL` sul server. CORE resta il default; il server legge la propria configurazione e le RPC applicano le licenze reali. Ogni build emette `edition.json`, verificato automaticamente; il gate rifiuta evidenze di un'edizione diversa dalla build.
- Epson: nuova licenza `EPSON_PRINTING`, inizialmente disattivata; configurazione e job esterni autorizzati solo dopo l'abilitazione tecnica con step-up. Restano firma del bridge, lease, ruoli, revoca protetta, controllo dei job in uso e divieto di retry automatico dopo esito incerto. I documenti restano **non fiscali**.
- Caparre: recuperati checkout, letture provider e callback già distribuiti su staging; preservate normalizzazione del telefono e validazioni applicative della candidata. Collegata la verifica al ritorno dal provider, con capacità ospite in sessionStorage per massimo 24 ore, assente da URL e log, e possibilità di verifica nella scheda originale se lo storage non è disponibile. Il frontend offre solo i provider restituiti dal server. Una prenotazione annullata o no-show non diventa confermata perché la sua garanzia è stata pagata.
- Worker: recuperati i sorgenti già distribuiti di messaggistica prenotazioni, rimborsi caparre, retention, archivio/verifica audit e probe di indisponibilità database. Le dipendenze condivise più recenti non sono state sostituite da copie obsolete. Il probe richiede ora un ambiente non produttivo esplicito. Provenienza e versioni: `docs/evidence/source-recovery-2026-11-03.json`.
- Master: il file canonico ora corrisponde al documento aggiornato fornito dall'utente; matrice di 158 sezioni con SHA-256 della specifica e hash per sezione. Il controllo non può accettare la precedente matrice di 151 sezioni. Nessuna sezione è stata marcata verificata per la sola presenza del codice.

## Verifiche della candidata

Verifiche locali già eseguite: Node 24.22.1, installazione da lockfile, TypeScript, lint, **211 test database senza skip**, **165 test unitari**, build pubblica e staff sia CORE sia FULL con controllo dei metadati dell'edizione. PGlite usa PostgreSQL in WASM con fixture esplicite per i servizi gestiti Supabase: non certifica GoTrue, PostgREST, Realtime, Storage o concorrenza fra connessioni separate.

La pipeline `Plateform release candidate hardening` è obbligatoria sul ramo `fix/release-edition-contracts-20261103`: applicazione, controlli e test Deno di tutti gli endpoint recuperati, ricostruzione del database, controlli di continuità e browser Chromium. Aggiunti test per il ritorno delle caparre e per token, importi, idempotenza, callback, esiti tardivi e ambienti dei worker. I browser usano fixture HTTP e non attestano un pagamento sandbox. Nel contenitore locale il download delle dipendenze npm di Deno è stato bloccato da errori di connessione: l'esito dei controlli Edge e browser va letto dal run CI, non dichiarato sulla base dei soli sorgenti.

## Situazione remota e blocchi ancora reali

Lettura staging del 3 novembre: 2.526 righe audit; Stripe, Satispay e caparre licenziati; analisi avanzate non licenziate. Il solo backup censito è **QUEUED**, senza Auth, Storage o integrità verificati; i restore riusciti sono **zero**. Gli 11 gate remoti esaminati sono ancora PENDING. Questi stati non sono stati modificati.

Prima della vendita completa restano necessari:

1. Esecuzione della pipeline sull'esatto commit candidato e integrazione controllata delle sole migrazioni successive su staging.
2. Backup completo corrente di PostgreSQL, Auth e Storage, copia indipendente e ripristino effettivo su destinazione separata, con integrità e RPO/RTO misurati.
3. Verifiche reali Auth/RLS/multiutente, provider sandbox e rimborsi, worker, privacy/retention, offline/dispositivi, carico e isolamento sedi.
4. Collaudo fisico Epson sulle postazioni e sulla variante/interfaccia effettivamente disponibili; integrazione fiscale distinta se si vogliono emettere documenti commerciali fiscali.
5. Accettazione puntuale delle 158 sezioni, documenti operativi/commerciali, tre revisioni complete sullo stesso digest e chiusura dei gate di rilascio.

Il recupero di una funzione distribuita non prova che il suo provider, cron o infrastruttura siano configurati correttamente. Nessuna evidenza di produzione, hardware, backup/restore o firma fiscale viene emessa da questo checkpoint.
