# Registro revisioni integrali

Revisioni complete consecutive senza modifiche: **0 / 3**.

## Specifica vigente — 9 ottobre 2026

Il master corrente comprende §§0–157, con matrice e digest di ogni sezione.
I checkpoint sotto conservano il perimetro della specifica vigente alla loro data;
non costituiscono revisioni integrali pulite della versione corrente.
Il recupero baseline e i 242 test locali non incrementano il conteggio: **0/3**.

## Baseline — 2026-09-14

- Letta integralmente la specifica (§0–150).
- Cartella iniziale: specifica e immagine; applicazione assente, nessun repository Git.
- Node 24.13.0, npm 11.6.2, Python 3.13.6 disponibili.
- Docker, psql, Deno non disponibili sul PATH.
- Nessuna configurazione Supabase o provider fornita nella cartella.
- Architettura preventiva e 18 elaborati del §134 definiti in ARCHITECTURE.md.
- Tutte le funzionalità applicative ancora da implementare/verificare.

Le revisioni pulite potranno iniziare soltanto dopo la copertura completa. Una suite verde
non equivale a revisione integrale. Le verifiche esterne mancanti restano gate espliciti.

## Checkpoint sviluppo — 2026-09-15

- 16 migrazioni SQL, build separata pubblico/staff, funzioni server e UI iniziali.
- 53 test unit/database e 4 test browser passati; lint e TypeScript passati.
- Individuati e corretti: privilegio EXECUTE globale PostgreSQL, ambiguità SQL booking,
  disponibilità giornaliera obsoleta, contratto di risposta assegnazione cameriere,
  revoca sessione cliente e correlazione richiesta nei comandi auditati.
- Screenshot login e home mobile ispezionati.
- Registro aperto: `IMPLEMENTATION_STATUS.md`; non è una revisione integrale pulita.
- Conteggio invariato: **0/3**.

## Incremento accoglienza, sessioni e realtime — 2026-09-15

- Migrazioni 17–20: registrazione device, PIN, workspace Host, gruppi e segnali realtime.
- 70 test unit/database, 8 browser e 5 Deno HTTP passati; Deno check delle Edge passato.
- Corretti: bypass con PIN SQL nullo, duplicazione device dopo login, gruppi non coordinati,
  capienza spostamento prima dell'apertura conto, policy anon dei segnali, intestazione mobile,
  cart perso su refresh, errore strict del reset password, JSON malformato e body streaming illimitato.
- Fixture browser e PGlite non provano lo stack Supabase e la contesa tra connessioni separate.
- Rimangono requisiti aperti in IMPLEMENTATION_STATUS.md. Conteggio invariato: **0/3**.

## Incremento contabilità e audit — 2026-09-15

- Migrazioni 21–24: giornale append-only, contesto audit, quadratura e ricerca paginata.
- 81 test unit/database, 10 contratti browser e 5 test Deno passati; strict/lint/build passati.
- Corretti: alterazione retroattiva dei periodi dopo rimborso/storno, mutabilità importi originari,
  chiusura con operazioni pending, differenze senza prova password e centesimi vicino al limite Number.
- Snapshot contabili e richieste di differenza protetti, archivio postazioni bloccato durante servizi aperti.
- Verifiche Supabase/provider/concorrenza reale assenti; implementazione integrale ancora incompleta.
- Questo incremento non è una revisione completa. Conteggio invariato: **0/3**.

## Incremento conti e rettifiche — 2026-09-15

- Migrazioni 25–27: ricerca e snapshot conti, storico pagamenti, rilascio operativo del tavolo,
  retry idempotenti per riapertura e chiusura forzata.
- UI rimborso/storno/forzatura/riapertura con motivazione e verifica password nei casi Admin.
- 87 test unit/database, 12 test browser, 5 test Deno; strict/lint/build passati.
- Corretti: interrogazioni N+1 degli ordini, chiusura UI consentita con residuo, vecchio conto
  riaperto che interferiva con nuovi ospiti, stato incompleto dei tavoli uniti dopo chiusura.
- Restano divisioni, sconti, provider, offline e gli altri requisiti nel registro aperto.
- Non è una revisione integrale. Conteggio invariato: **0/3**.

## Incremento servizio prepagato — 2026-09-15

- Migrazione 30: chiusura finanziaria e rilascio operativo distinti finché ci sono piatti da servire.
- KDS mantiene la comanda; il tavolo non può essere riutilizzato, può essere spostato e viene
  rilasciato dopo l'ultima consegna. Una riapertura di storico servito resta solo contabile.
- 95 test unit/database, 15 test browser, 5 test Deno; strict/lint/build passati.
- Corretto il test precedente che prevedeva il rilascio prematuro del tavolo.
- La migrazione segnala dati storici già rilasciati con piatti incompleti e richiede riconciliazione.
- Non è una revisione integrale. Conteggio invariato: **0/3**.

## Incremento allocazioni e sconti — 2026-09-15

- Migrazioni 28–29: unità contabili, allocazioni immutabili, coperture parziali, sconti/omaggi.
- Policy indipendenti, anteprima server, richieste di approvazione e verifica password Admin.
- 94 test unit/database, 14 test browser e 5 test Deno; strict/lint/build passati.
- Corretti: rifiuto dei prodotti scontati, mancata attribuzione dei pagamenti per importo,
  rischio di riallocazione di prodotti già coperti e assenza di migrazione verificata.
- Divisione equa, trasferimenti/unioni e gli altri requisiti restano aperti.
- Non è una revisione integrale. Conteggio invariato: **0/3**.

## Incremento completamento — 3 ottobre 2026

- Migrazioni 31–55 e moduli descritti in IMPLEMENTATION_STATUS.md.
- 173 test unit/database, 19 browser e 9 Deno; strict, lint, dodici Edge check e build passati.
- Corrette autorizzazioni/quote, contesto Host, trust anchor offline, code condivise/corrotte,
  dispatcher step, validazione XML e telemetry legacy. Bridge TLS e privacy con nuovi test.
- Documentazione obbligatoria presente; lacune di backup/restore, dismissione, privacy/offline,
  osservabilità, audit puntuale e verifiche esterne registrate senza dichiararle completate.
- Nessuna esecuzione remota Supabase/provider/hardware e nessuna pubblicazione.
- Questo è un incremento di sviluppo con verifiche locali, non una revisione integrale pulita.
- Conteggio invariato: **0/3**. Gate ZIP commerciale atteso bloccato.
