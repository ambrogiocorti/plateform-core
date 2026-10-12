# Plateform — Avvio guidato CORE (Step 1 → Step 2)

**Stato:** implementazione funzionale su branch dedicato; non equivale a collaudo del servizio completo o certificazione di release.

## Obiettivo

Consentire a un Admin di comprendere cosa manca in una nuova installazione reale, senza inserire dati demo e senza confondere la presenza dei record con la piena operatività.

## Funzionalità implementate

- Nuova voce di navigazione **Avvio guidato** in area Admin, accessibile anche dal Centro operativo.
- Pagina per sede, letta tramite lo stesso client PostgREST con JWT/RLS usato dalle altre pagine.
- Otto prerequisiti minimi, nel corretto ordine operativo: sala, layout attivo, tavoli attivi, servizi attivi, stazioni attive, categorie attive, piatti attivi, cassa attiva.
- Ogni verifica usa una lettura server con `limit: 1`, senza replicare tutto il catalogo in memoria.
- Collegamenti diretti alle schermate esistenti di configurazione, che effettuano gli interventi tramite il server-side `save_configuration_command` e le sue autorizzazioni, non tramite LocalStorage.
- Aggiornamento dello stato dal database dopo le modifiche; nessuna falsa conferma offline o in caso di errore API.
- Nei multi-sede, i due controlli di catalogo condiviso non vengono letti né resi modificabili a un Admin limitato alla sede: vengono mostrati come **da gestire da un Admin di catena**, senza una falsa conferma.
- Avviso esplicito che personale, assegnazioni, disponibilità, autorizzazioni, stampa, pagamenti e servizio end-to-end devono ancora essere controllati.
- Test unitari del calcolo di avanzamento e dell'ordine delle dipendenze.

## Verifica di conformità preliminare

Lettura sola del catalogo Development al 12/10/2026: tutte le otto tabelle hanno `id`, `active`; le sei tabelle per sede sono associate a `venue_id`, categorie e piatti sono condivisi. Tutte le otto tabelle hanno RLS e grant SELECT per il ruolo PostgreSQL `authenticated` (le policy per singolo utente/sede continuano a filtrare i dati).

Lettura privilegiata **solo per diagnosi** del dataset della sede Plateform Milano: sala 1; layout attivi 0; tavoli 0; servizi 0; stazioni 1; categorie 0; piatti 0; casse 1. È quindi attesa una progressione minima di 3/8, ma la vista deve sempre usare il **JWT/RLS dell'utente**, non replicare questa lettura privilegiata.

## Non compreso in questo macro-passo

- Non crea automaticamente sale/tavoli/staff o dati fittizi e non attiva licenze.
- Non sostituisce il collaudo di un servizio completo.
- Non attesta che il menu condiviso sia effettivamente pubblicato o instradato alle stazioni per ogni sede.
- Non certifica sezione P0 migrazioni, backup/restore, staging o E2E multi-dispositivo.

**Prossima realizzazione funzionale:** verifica e completamento del circuito reale Admin → cameriere → tavolo/conto → ordine → cucina → Pass → cassa, concentrandosi su eventuali funzionalità mancanti rispetto alle pagine già esistenti, senza dichiarare assenti quelle implementate.
