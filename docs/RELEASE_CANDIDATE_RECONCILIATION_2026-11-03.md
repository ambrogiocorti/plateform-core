# Plateform — candidata completa: riconciliazione del 3 novembre 2026

**Obiettivo:** completamento del perimetro del Master Prompt aggiornato, sezioni 0–157.
**Stato:** sviluppo e verifica in corso; **NO-GO commerciale**. Questo registro sostituisce i conteggi e il perimetro dei checkpoint precedenti, senza trasformare le prove storiche in collaudi della candidata.

## Checkpoint di integrazione verificato il 3 novembre, sera

La PR [#57](https://github.com/ambrogiocorti/plateform-core/pull/57) comprende le
correzioni della candidata FULL, il controllo delle licenze, la stampa Epson
di cortesia e i nuovi flussi di gestione operativa. Sul commit
`2f97fa2aefacc3daa6c08cb5509aae57b811111e` il
[collaudo integrato](https://github.com/ambrogiocorti/plateform-core/actions/runs/41726143666)
ha superato **39 test su 39** in quattro gruppi, con GoTrue, PostgREST,
PostgreSQL, Storage ed Edge Functions in uno stack isolato.
Superata anche la prova isolata di ripristino. Passano 389 test applicativi,
32 test Edge e 39 test browser ordinari; la verifica statica della dashboard
Kitchen Admin passa tutti e 10 i controlli, compreso il reso dei piatti serviti.

Tra gli scenari integrati verificati: servizio completo fino a chiusura del
conto, notifiche e resi dopo la consegna con autorizzazione Admin,
prenotazioni, carico delle immagini, accessibilità, prestazioni, offline
reale con code e conflitti, multi-sede, backup e archivio audit isolato.
L'editor dei conflitti impedisce di reinviare piatti esauriti.

Per la stampa di cortesia non fiscale il bridge ora comprende Epson ePOS
Ethernet, coda USB Windows e coda USB macOS/Linux tramite CUPS, con
documenti autorizzati e deduplicati. I test CUPS controllano i byte inviati
alla coda simulata: **non attestano** una stampa, un taglio o una
compatibilità fisica con una stampante reale. La TM-T20III (012) va
verificata sulla sua interfaccia effettiva.

La storia presente in staging e produzione resta di **496 migrazioni**;
nel sorgente ne risultano **499**. Le tre migrazioni successive ancora
da promuovere in staging, in ordine, sono `20261027183000` (waitlist),
`20261103161146` (Epson/licenze) e `20261103213000` (annullamento di
un ordine vuoto nel Conflict Center). Nessuna di esse è stata applicata
ai database collegati. Il CORS dell'anteprima è stato corretto solo in
staging con prove HTTP reali.

**NO-GO commerciale:** prima della vendita pubblica restano obbligatori
la promozione tracciata e il collaudo completo su staging, un vero
backup di PostgreSQL/Auth/Storage con ripristino indipendente, provider
in sandbox e rimborsi reali, prove su hardware Epson e dispositivo
fiscale/partner certificato se si richiede un documento commerciale,
privacy/sicurezza e accettazione dei requisiti. Il superamento dei test
automatici isolati non certifica da solo questi passaggi.

## Sorgente unico e contratto delle licenze

La candidata riunisce il lavoro UX/stampa della PR 55 e il replay isolato della PR 56. Recupera inoltre le 14 SQL che il ramo applicativo non conteneva più, mantenendone ogni byte e SHA-256. Le nuove migrazioni forward-only comprendono `20261103161146_licensed_epson_printing.sql` e `20261103213000_conflict_center_empty_order_discard.sql`.

Il confronto **in sola lettura** con `plateform-staging` (`qfgoatdabgnzozxuzxku`) rileva 496 migrazioni applicate. Tutte le versioni, i nomi e i digest coincidono con il sorgente recuperato. Nella candidata ci sono 499 migrazioni: restano pendenti `20261027183000` (waitlist idempotente), `20261103161146` (licenza Epson) e `20261103213000` (Conflict Center), tutte successive alla storia applicata. Non risultano migrazioni retrodatate o SQL applicate divergenti. Nessun `db push` o aggiornamento dello schema/dati è stato eseguito. Il successivo intervento CORS descritto sotto riguarda soltanto configurazione e codice delle Edge Functions di staging.

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

### Pipeline completate

Sul commit `7b6069b37c65d2cae8eb024f8ffdffb7f75ac701`:

- [Run hardening 41676651064](https://github.com/ambrogiocorti/plateform-core/actions/runs/41676651064): tre job riusciti; **376 test applicativi**, **31 test Edge**, **39 test browser**, controlli di continuità e build CORE/FULL.
- [Run PostgreSQL 41676651067](https://github.com/ambrogiocorti/plateform-core/actions/runs/41676651067): installazione da zero su PostgreSQL Supabase nativo, isolato in Docker e senza credenziali cloud; catalogo verificato `498|7|true|true` (migrazioni, tabelle rehearsal, Auth e Storage presenti).

Il test del classificatore usa ora storie sintetiche fisse: aggiungere una migrazione successiva non altera artificialmente la definizione di «retrodatata». La lettura di staging rimane un controllo distinto. Sul runner CI i browser eseguono tutti i test in sequenza, evitando la competizione delle compilazioni Vite iniziali. Il contatore negativo delle caparre comprende solo le due API di prenotazione e pagamento; la telemetria è una fixture separata.

Un ultimo rafforzamento della migrazione Epson, **ancora non applicata ad alcun progetto**, blocca anche la riga del dispositivo durante accodamento/autorizzazione: la disattivazione non può superare il controllo mentre nasce un nuovo job. I 13 test Epson e i controlli completi sono passati sul commit indicato, compresi il replay su PostgreSQL nativo e i browser.

La verifica estesa `local:source-gates` copre anche tutti i ruoli UX e gli Step 7–12. Il controllo della dashboard cucina è aggiornato alla workspace attuale; non cambia il comportamento applicativo. `format:check` preserva i file originali dell’handoff e prima ne verifica gli 11 digest SHA-256 del pacchetto, invece di riscriverli con Prettier.

### Correzione dell’anteprima Vercel

Il deploy automatico dello stesso commit ha evidenziato due controlli di bootstrap rimasti a 483 migrazioni: ora verificano il manifest e confrontano il catalogo PostgreSQL con il suo conteggio effettivo, senza alterare hash o SQL storici. Questi controlli sono inclusi anche nella pipeline della candidata.

L’anteprima del solo ramo `fix/release-edition-contracts-20261103` usa staging attivo, chiave pubblicabile corrente, URL dedicati al ramo e profilo FULL esplicito. Il progetto Vercel ereditava invece il riferimento allo sviluppo sospeso. La CSP versionata permette ora esclusivamente staging; la build Vercel rifiuta un backend diverso dalla CSP. Node è vincolato alla serie 24 usata in CI: il precedente intervallo senza limite consentiva a Vercel di scegliere la serie 26. Nessuna variabile di produzione è stata modificata. La suite di recupero pagamenti verifica esplicitamente CORE e FULL, senza dipendere dalle variabili ambientali del deploy: Satispay POS manuale è distinto dai provider online, che non possono essere confermati manualmente. La CI esegue tutti i test unitari anche con FULL esplicito. I nuovi controlli locali sono passati; il deploy e la pipeline devono essere verificati sul commit successivo prima di attribuirgli un esito.

Lettura staging del 3 novembre: 2.526 righe audit; Stripe, Satispay e caparre licenziati; analisi avanzate non licenziate. Il solo backup censito è **QUEUED**, senza Auth, Storage o integrità verificati; i restore riusciti sono **zero**. Gli 11 gate remoti esaminati sono ancora PENDING. Questi stati non sono stati modificati.

Prima della vendita completa restano necessari:

1. Esecuzione della pipeline sull'esatto commit candidato e integrazione controllata delle sole migrazioni successive su staging.
2. Backup completo corrente di PostgreSQL, Auth e Storage, copia indipendente e ripristino effettivo su destinazione separata, con integrità e RPO/RTO misurati.
3. Verifiche reali Auth/RLS/multiutente, provider sandbox e rimborsi, worker, privacy/retention, offline/dispositivi, carico e isolamento sedi.
4. Collaudo fisico Epson sulle postazioni e sulla variante/interfaccia effettivamente disponibili; integrazione fiscale distinta se si vogliono emettere documenti commerciali fiscali.
5. Accettazione puntuale delle 158 sezioni, documenti operativi/commerciali, tre revisioni complete sullo stesso digest e chiusura dei gate di rilascio.

Il recupero di una funzione distribuita non prova che il suo provider, cron o infrastruttura siano configurati correttamente. Nessuna evidenza di produzione, hardware, backup/restore o firma fiscale viene emessa da questo checkpoint.

## Blocco CORS chiuso nello staging

Dopo l’accesso alla dashboard autorizzato dal proprietario, è stata aggiunta l’origine esatta della PR 57 mediante `ADDITIONAL_ALLOWED_ORIGINS`. Il valore precedente di `ALLOWED_ORIGINS` è write-only: non è stato sovrascritto e digest/data di aggiornamento sono rimasti identici. Il middleware unisce le due liste, mantenendo il confronto esatto delle origini.

Sulle 12 funzioni browser già distribuite è stato applicato soltanto questo cambiamento nel loro `_shared/http.ts`; gli altri sorgenti e i flag JWT coincidono byte per byte con gli snapshot precedenti. Questo rollout ristretto non distribuisce retroattivamente tutte le altre modifiche della candidata e non applica le tre migrazioni ancora pendenti.

Verifiche HTTP reali: **12/12** preflight dell’anteprima autorizzati, **12/12** endpoint protetti con diniego 401 senza sessione, **24/24** rifiuti di origini estranee/contraffatte e **3/3** confronti invariati con un endpoint che usa ancora il middleware originale. L’origine della PR 49 rimane autorizzata; localhost 5173/5174 risulta già respinto anche dal middleware originale: non è una regressione dell’aggiunta. Tutti i **32 test Edge** sono passati localmente con Deno e le dipendenze da lockfile.

Dettagli, versioni, digest e prove: `docs/evidence/cors-2026-11-03/verification.json`. Conservate le due varianti originali del middleware per rollback. La nuova CI deve ancora essere letta sull’esatto commit che include queste prove. Il NO-GO commerciale rimane in vigore per i collaudi e i gate reali ancora aperti.
