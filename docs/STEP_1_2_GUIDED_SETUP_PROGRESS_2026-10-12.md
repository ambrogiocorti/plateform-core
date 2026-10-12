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


## Macro-passo funzionale 2 — Preflight operativo per sede

La pagina `/preparazione` controlla anche, **attraverso SELECT RLS** e senza scrivere dati, quattro prerequisiti del flusso CORE:

1. Almeno un piatto attivo con categoria attiva, calendario di disponibilità valido nel fuso della sede, scorta odierna non esaurita, override di sede non disabilitato e stazione principale (o override locale) attiva.
2. Almeno un profilo `WAITER` attivo, assegnato alla sede con assegnazione attiva.
3. Un `KITCHEN_ADMIN` assegnato oppure un `KITCHEN_STAFF` assegnato anche a una stazione attiva.
4. Un `PASS` attivo e assegnato alla stessa sede.

Le regole menu seguono l'effettivo `public.get_public_menu(uuid)` verificato in sola lettura: `venue_dish_settings` è **facoltativo**; `coalesce(enabled, true)`, schedule `ALWAYS/DATE/WEEKDAYS/RANGE`, disponibilità giornaliera e catalogo con categorie attive. Nessun risultato può essere dichiarato positivo per mera esistenza di righe non utilizzabili. L'Admin VENUE può leggere il catalogo mediante policy `catalog_read` ma non modificare il catalogo globale.

**Riscontro Development, solo read-only:** sulla sede Plateform Milano risultano zero piatti attivi e zero assegnazioni attive per WAITER, KITCHEN e PASS. Queste mancanze vengono visualizzate come configurazioni aperte, non nascoste.

## Macro-passo funzionale 3 — Menu della sede (override operativi)

Nuova rotta Admin `/menu-sede` per ogni sede autorizzata, raggiungibile dalla navigazione, dal Centro operativo e dall'avvio guidato.

- Pagina di catalogo con paginazione server-side da 25 piatti, filtrata su prodotti attivi e letta con RLS.
- Mostra categoria, prezzo di catalogo, stato locale, scorte e stazione di preparazione; riconosce override disabilitati, scorte giornaliere scadute o a zero, stazioni non attive e categorie non attive.
- Riutilizza l'editor esistente `venueDishDialog`: salva `enabled`, prezzo locale, disponibilità giornaliera e stazione con la RPC server `save_venue_dish`.
- La RPC è già protetta da `private.authorize(p_venue, ADMIN)`, controllo di versione, idempotenza, transazione, stazioni valide e storico prezzi (funzione originale controllata nel catalogo PostgreSQL).
- Se non esiste una stazione attiva, impedisce di aprire un editor che il backend rifiuterebbe e collega alla configurazione stazioni.
- Non consente creazione o modifica di `dishes`, `categories` o altri dati condivisi agli Admin limitati alla sede.

Le nuove funzioni pure hanno test unitari per scope, stock, calendario, overrides, stazione principale e assegnazioni del personale. Questi test **sono implementati ma non ancora eseguiti sul nuovo commit**; TypeScript, lint, test browser e reali sessioni JWT devono essere verificati prima di considerare il macro-passo completo o fare merge della PR.

## Prossimi sotto-passi CORE

- Verifica reale della configurazione staff e assegnazioni contro due sedi e quattro ruoli, con JWT e RLS.
- Test di un ordine reale dall'account alla stazione, PASS e consegna, senza simulare il backend.
- Gestione delle anomalie di servizio e handoff cassa/chiusura.
- Completamento dello storico migrazioni in quarantena, backup/restore e staging prima del go-live commerciale.

La roadmap mantiene STEP 2 **IN PROGRESS** finché il gate cameriere → ordine → cucina → Pass → servizio non è verificato in modo reale.
