# Menu, finestre e navigazione — 6 novembre 2026

## Comportamento richiesto

- Le categorie del menu sono filtri con selezione visibile e contatore. Ricerca e categoria si combinano; lo stato vuoto permette di ripristinare tutta la carta.
- Le card sono apribili con mouse e tastiera. Il dettaglio mostra foto se presente, prezzo, descrizione, ingredienti, allergeni, tag e disponibilità reali.
- Le finestre condividono intestazione, spaziature, controlli e tasto X. Non hanno il vecchio pulsante testuale «Chiudi» né barre di scorrimento visibili; il contenuto lungo rimane raggiungibile. Escape, X e clic sullo sfondo chiudono; il focus torna al controllo di apertura.
- La gallery usa un visualizzatore fotografico dimensionato allo schermo. Non applica la sfocatura dello sfondo.
- Gli avvisi usano una gerarchia compatta con icona, messaggio e riferimento. Nei moduli il feedback appare sotto l’intestazione, senza coprire i comandi; mostra l’errore corrente e conserva le conferme quando il modulo si chiude. Non duplica lo stesso request ID.
- La navigazione staff segue la struttura annidata del riferimento FASAS, mantenendo identità Plateform e temi chiaro/scuro. Gruppi: Servizio, Conti e cassa, Attività, Ristorante, Amministrazione. Le autorizzazioni e le licenze filtrano le voci prima di raggrupparle.
- Su telefono rimangono quattro scorciatoie operative e Menu, che apre la stessa struttura organizzata. La sezione attiva viene espansa e le preferenze desktop sono ricordate per ruolo.

## Navigazione pubblica e caricamento

Il video mostrava la sostituzione dell'intera pagina con «Caricamento…» fra due sezioni editoriali. La pagina visibile ora rimane montata finché la nuova destinazione è pronta, con sostituzione atomica e protezione dalle risposte superate. La configurazione pubblica è condivisa in memoria per 30 secondi; nessuna sessione, ordine, prenotazione o disponibilità viene memorizzata in questa cache. Le notifiche realtime, l'aggiornamento esplicito e il ritorno online invalidano la configurazione. Catalogo e indice dei menu sono richiesti in parallelo.

## Verifica

- TypeScript, lint, build CORE pubblica/staff, test unitari e controlli dei contratti pubblici eseguiti localmente.
- Nuovi percorsi browser: filtri/ricerca e popup prodotto a 390/1280 px; focus e chiusura; navigazione con catalogo lento senza svuotare la pagina; gruppi staff e menu mobile; errore sopra una finestra aperta.
- Percorso integrato aggiornato per verificare la struttura raggruppata e le autorizzazioni reali sullo stack isolato. Il resoconto dei job e l'artefatto distribuito sono nella PR.

Nessuna migrazione o modifica a credenziali, MFA, RLS o dati commerciali. Staging non eliminato. Lo script specifico degli account è un allegato privato destinato all'esecuzione manuale dell'utente; non è una migrazione e non è stato eseguito sul database ospitato.

## Verifica di regressione

La prima esecuzione browser ha evidenziato un’interferenza degli avvisi sovrapposti con i pulsanti, un errore di disposizione della barra mobile e i margini dell’intestazione del compositore. Corretti alla fonte: avvisi nel flusso del modulo, ripristino delle conferme alla chiusura, righe esplicite del compositore, controlli su larghezze e visibilità mobile. Eliminata la dissolvenza delle finestre per evitare fotogrammi trasparenti durante l’apertura. La verifica fotografica ora controlla il contenimento della miniatura, anziché imporre al nuovo layout l’immagine larga quanto la card.
