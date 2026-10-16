# Integrazione operativa Plateform — 16 ottobre 2026

## Codice implementato sul candidato

Baseline: `42119c91042d4e5df933eb6167844fef37bd016a`, branch
`plateform/two-phase-completion-20261013`. Integrati i moduli operativi della
PR #38, precedentemente assenti dal candidato #41, senza sostituire il recupero
delle migrazioni o modificare il database remoto.

- Avvio guidato Admin con verifiche degli elementi attivi della sede, catalogo
  condiviso e assegnazioni effettive di sala, cucina, Pass e cassa.
- Menu della sede con paginazione, categorie, disponibilità e stazioni locali;
  gli aggiornamenti ricaricano anche categorie e stazioni disattivate o aggiunte.
- Console delle anomalie: chiamate, richieste conto, consegne e quadrature,
  mantenendo i permessi dell'operatore che possiede ciascuna consegna.
- Cassa con lista iniziale dei conti attivi, chiusura contabile e recupero degli
  incassi manuali già creati, senza creare un secondo pagamento.
- Consegne del cameriere: presa in carico distinta dalla conferma SERVED.
- Menu engineering con RPC esistenti e feature flag della sede. Il dettaglio
  costi usa la fine del periodo del report nel fuso della sede, compreso il
  cambio dell'ora; non usa prezzi correnti per spiegare un margine storico.
- Protezione degli aggiornamenti asincroni della configurazione: una risposta
  precedente non può sovrascrivere quella più recente o il cambio di sede.

## Verifiche di questa sessione

- `node scripts/check-operational-readiness.mjs`: **23/23 PASS** su moduli reali,
  eseguibile anche senza dipendenze npm.
- `node scripts/check-core-edition.mjs`: **55/55 PASS**; verificati entrambi gli
  accessi al recupero degli incassi e il filtro centralizzato dei metodi.
- Controlli sorgenti Admin, cameriere, cucina, Pass, Host, Super Admin,
  multi-sede e cassa eseguiti; il controllo cassa ora segue il componente
  condiviso e conserva i controlli sul metodo e sullo stato PENDING.
- Manifest migrazioni: **482 file verificati**, storico Development a **480**;
  promozione delle due migrazioni retrodatate ancora bloccata dal preflight.
- Aggiunti test unitari e browser dei flussi integrati; la loro esecuzione
  completa dipende dall'ambiente di build e non è attestata da questi controlli.
- Installazione npm locale impedita dai limiti di rete/permessi. Tentato avvio
  di PostgreSQL 18 su due directory di test nuove: inizializzazione non
  completata e processi interrotti. **Nessun PASS PostgreSQL nativo attribuito.**

## Stato e lavoro ancora necessario

I moduli integrati sono codice reale collegato alle API esistenti; la presenza
delle pagine e i controlli locali non certificano un servizio del ristorante.
I gate della roadmap non vengono promossi automaticamente.

Alla lettura del 16 ottobre Development è ACTIVE_HEALTHY, con 480 migrazioni,
75.871.923 byte di database, 3.038 oggetti Storage e **0 backup registrati**.
Restano aperti installazione Supabase pulita, upgrade controllato, backup e
restore indipendente DB/Auth/Storage, test HTTPS multi-ruolo/dispositivo,
concorrenza PostgreSQL, offline e revoche, provider e stampa fisica, e i gate
commerciali. L'ambiente Restore Test è inattivo e non è stato riattivato.

**Macro-step A IN PROGRESS; rilascio commerciale NO-GO.** Nessun merge su main,
nessuna migrazione remota, nessun pagamento e nessuna cancellazione di dati.
