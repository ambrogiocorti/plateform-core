# Operazioni del ristorante

Questa guida descrive i flussi presenti; l’uso durante un servizio reale richiede completamento e collaudo dei gate elencati in TESTING.md.

## Preparazione e servizio

Admin configura sale/layout attivi, tavoli/QR, servizi, turni, pacing/modulo prenotazioni, catalogo e disponibilità, staff e assegnazioni, registri e stampanti. Le assegnazioni al tavolo hanno precedenza sulle zone; RUNNER è una modalità del cameriere. Prima del servizio controllare dispositivi, autorizzazioni, stock e stato dei provider/stampanti. Preparare offline solo sui dispositivi previsti.

Host lavora sulla pianta e lista prenotazioni: arrivi, assegnazioni, walk-in e gruppi. Il conteggio ospiti non espone nomi dei conti o saldi. Cameriere apre conti, comunica il codice corrente, raccoglie ordini, richieste cliente e chiamate pertinenti. Il QR identifica il tavolo; il codice corrente identifica il conto autorizzato. Non condividere codici tra gruppi.

Cucina prepara sulla stazione primaria, osservatori leggono; step successivi seguono il flusso configurato. Pass e camerieri gestiscono consegne e resi. Un conto già pagato può restare operativamente in servizio finché i piatti non sono consegnati: il tavolo non è libero solo perché il saldo è zero.

Cashier opera su cassa assegnata e servizio aperto. Pagamenti per importo, prodotti o quote uguali usano riserve server e centesimi esatti. Le mance sono separate. Confermare manualmente solo metodi manuali; Stripe/Satispay API richiedono verifica server. In caso di pending/esito incerto verificare la relativa operazione prima di crearne un’altra.

La chiusura del servizio conserva quadratura e differenza. Le differenze richiedono approvazione Admin con password. Rimborsi/storni successivi hanno motivo e permessi e vengono iscritti nel servizio corrente, mantenendo lo storico.

## Notifiche, stampa e fine servizio

Ogni utente vede notifiche pertinenti. Audio va abilitato con un gesto sul dispositivo; volume e preferenze sono per utente/device/sede. Le regole di categoria sono configurate da Admin. Un badge con errore non equivale a zero notifiche.

Stampe sono documenti non fiscali. Per browser, verificare il documento fisico e registrare l’esito. Per Epson/bridge, esito ambiguo richiede verifica prima di ristampa esplicita. Non fare retry automatici di un job SENT. Il bridge conserva ID/hash/esito anche dopo un riavvio; vedere tools/print-bridge/README.md.

Alla fine del servizio completare consegne, richieste/conti pendenti, conflitti e stampe incerte, chiudere e quadrare il servizio. Sincronizzare le code offline con l’utente che le ha create prima di riutilizzare il dispositivo. Bloccare o terminare la sessione. Non cancellare uno storico per correggere un errore.

## Amministrazione tecnica

Super Admin gestisce licenze, limiti, sicurezza, salute, incidenti e audit. Per leggere/intervenire come un operatore deve avviare assistenza autorizzata: sola lettura di default; intervento richiede password e conferma e conserva doppia identità. Sospensione impedisce il servizio operativo e lascia disponibile l’accesso tecnico. Dismissione protetta e ripristino installazione non sono ancora flussi completi.

Richieste privacy passano dalla pagina Admin dedicata. I tempi di conservazione globale richiedono Admin CHAIN e conferma password. Gli obblighi contabili/audit e il piano backup vengono gestiti separatamente.
