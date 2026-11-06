# Pagine pubbliche e controllo tecnico

Richiesta del proprietario: popolare menu, ristorante, contatti e gallery;
riordinare Salute e le schermate allegate; rimuovere i badge della nuova UI;
correggere il collegamento del tavolo.

## Modifiche

- `public-about.ts`: storia con paragrafi, fotografia e sezioni editoriali;
  gallery con didascalie e apertura accessibile delle immagini; contatti con
  indicazioni stradali e informazioni reali della sede.
- `publicAppUrl`: mantiene il percorso del progetto nei QR tavolo e nei link
  della lista d'attesa, con o senza slash finale. Il vecchio link alla radice
  del dominio GitHub non appartiene a questo progetto: occorre rigenerare i QR.
- `technical.ts` e `technical.css`: cinque sezioni con navigazione dedicata,
  indicatori principali compatti e dettaglio secondario espandibile. Tutti i
  controlli, permessi, verifiche e dati tecnici esistenti restano disponibili.
  I valori dei campi e la sezione selezionata sono conservati durante il cambio
  di sezione e gli aggiornamenti.
- Menu profilo con azioni in elenco; icona del pannello laterale in SVG;
  messaggi d'errore con testo, riferimento e chiusura separati. Duplicati dello
  stesso request ID esclusi. Errori rete, autorizzazione e sessione distinguibili;
  gli errori Edge della preparazione offline e dei controlli servizi sono decodificati.
- Badge `NUOVA UI · TEST` e `UI 2.0 · TEST` rimossi. Il percorso di hosting e il
  comportamento noindex della build Pages restano invariati.

## Contenuti di esempio autorizzati

`tools/public-example-content/seed.sql` prepara quattro categorie, otto piatti,
ingredienti e allergeni per il catalogo inizialmente vuoto, oltre ai contenuti
editoriali. La transazione si ferma se il catalogo o la versione del profilo
sono cambiati. Non crea utenti, ordini o pagamenti e non modifica le impostazioni
operative o la sicurezza. Il menu precisa che piatti e prezzi sono di esempio.
La gallery precisa che le immagini non raffigurano la sede SACER.

Il profilo prima dell'intervento è conservato in `profile-before.json`; il
rollback disattiva soltanto gli otto piatti dell'esempio. Ripristinare il testo
precedente richiede prima il confronto con le eventuali modifiche del gestore.
Questo snapshot di configurazione non è un backup completo DB/Auth/Storage.

Le quattro immagini sono distribuite localmente da `assets/public/demo/`,
senza nuovi host consentiti dalla CSP. Fonte: Unsplash, immagini
`1517248135467-4c7edcad34c4`, `1414235077428-338989a2e8c0`,
`1504674900247-0877df9cc836`, `1473093295043-cdd812d0e601`.
Licenza: <https://unsplash.com/license>.

## Verifica

TypeScript, lint e test unitari dei link passati localmente. Scenari browser
estesi per le pagine pubbliche, il visualizzatore fotografico, le sezioni Salute,
la conservazione dei campi, il profilo e il messaggio di errore su telefono.
La CI verifica la candidata prima della pubblicazione. L'esito del deploy,
il caricamento HTTPS e l'applicazione/verifica dei contenuti vanno riportati
nella PR sul commit distribuito. Il riferimento `ef6d860c` degli screenshot
non è presente nei log server consultati: non è stata inventata una diagnosi
del singolo errore originario.
