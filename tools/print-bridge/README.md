# Bridge locale Plateform

Servizio HTTPS Node 24 per stampanti Epson ePOS-Print via Ethernet, utilizzabile da Windows, macOS o Linux, e per stampanti Epson con USB realmente disponibile collegate alla coda Windows. Non genera documenti fiscali. Il software è verificato localmente con TLS e stampante simulata; compatibilità firmware, stampa fisica, carta esaurita, spooling e reti reali restano collaudi obbligatori.

## Installazione

Eseguire `npm ci` e conservare configurazione, certificati e database in una directory privata fuori dalla distribuzione. Copiare `config.example.json` e sostituire riferimenti/origini, chiavi pubbliche e ID dei dispositivi configurati nel ristorante. L’esempio intenzionalmente non parte senza chiavi pubbliche reali.

Configurare `PRINT_SIGNING_PRIVATE_JWK` nelle Edge: coppia ECDSA P-256 dedicata alla stampa, chiave privata mai nell’app/bridge. `public_keys` contiene soltanto chiavi pubbliche, una–tre per rotazione. `issuer` è l’origine del progetto Supabase. `origin` deve corrispondere all’URL BRIDGE configurato nello staff; `allowed_origins` contiene origini staff HTTPS esatte.

Il bridge usa un certificato TLS attendibile dai browser operativi. Epson usa HTTPS con verifica del certificato: `ca_file` consente una CA privata esplicita. Non disabilitare la verifica TLS. Collegare ogni device ID a un endpoint ePOS locale conosciuto, oppure a una coda Windows USB (vedi sotto). Il browser non può scegliere arbitrariamente l’indirizzo fisico della stampante.

```sh
PLATEFORM_BRIDGE_CONFIG=/absolute/private/config.json npm run print:bridge
```

Il bind predefinito è loopback. Per altri dispositivi usare interfaccia LAN e firewall appropriati, DNS/certificati e browser che consentano l’accesso alla rete locale. Non esporre il servizio a Internet. Avviare come utente senza privilegi, con supervisore del processo e directory scrivibile persistente. Arresto SIGTERM attende le richieste in corso.

## Protocollo e riconciliazione

L’app reclama il job server, poi ottiene il documento originale e un’autorizzazione firmata di massimo due minuti. La firma vincola job, device, lease, digest del documento, issuer e origini. Il bridge verifica tutto, limiti/CORS/Host e configurazione della stampante prima di inviare.

SQLite usa WAL e synchronous FULL. ID/device/hash sono registrati SENT prima dell’I/O; un replay SUCCESS riproduce soltanto l’esito. SENT/UNKNOWN non provoca un nuovo invio. Dopo un crash i SENT diventano UNKNOWN. Il registro non contiene il documento o nomi degli ospiti; va conservato e protetto, senza cancellarlo per risolvere un errore.

Invio serializzato per stampante, timeout totale 45 secondi, XML della risposta validato con namespace Epson, niente DTD o risposte malformate. Successo richiede la risposta positiva ePOS. Il modello/firmware deve essere configurato e collaudato affinché tale risposta rappresenti l’esito della stampa, inclusa la modalità spooling; non considerare una sola accettazione nello spool come documento fisico verificato.

Timeout, carta/rete, crash o risposta negativa producono esito incerto. Verificare il documento fisico e utilizzare la ristampa esplicita nell’app: un nuovo job collega l’originale e dichiara il rischio di duplicato. Nessun retry automatico della richiesta fisica.

Fonti: [Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [manuale Epson ePOS-Print XML](https://files.support.epson.com/pdf/pos/bulk/epos-print_xml_um_en_rev_af.pdf).

## Epson TM-T20III (012): stampa Ethernet multipiattaforma

**Scelta consigliata per una sala con PC Windows 10/11, macOS, Linux, tablet e smartphone.** La sigla Epson (012) identifica il modello Ethernet; non richiede che una delle postazioni sia collegata via USB. Stampante e postazioni devono poter raggiungere la rete locale. Epson documenta ePOS-Print XML per il modello Ethernet.

- **Diretto, senza servizio locale:** configurare in Plateform una sola stampante attiva con `driver=EPOS` e `endpoint=https://epson.restaurant.example/cgi-bin/epos/service.cgi?devid=local_printer&timeout=45000`. Quando l'edizione/licenza abilita Epson, il pulsante `Stampa scontrino` invia in un clic. La stampante deve supportare HTTPS con certificato attendibile da tutti i browser; verificare anche CORS e permessi di rete locale. Nessun driver per singola postazione.
- **Con bridge centralizzato, consigliato con molte postazioni:** configurare in Plateform una stampante `driver=BRIDGE` e `endpoint=https://print.restaurant.example:7443/v1/print`; sul PC/server scelto (Windows, macOS o Linux) eseguire il bridge Node 24 usando `config.ethernet.example.json`. Il bridge conserva autorizzazioni firmate e idempotenza, serializza i job e inoltra l'XML Epson via HTTPS con verifica TLS. **Basta un bridge per tutte le postazioni**, non uno per computer. Il computer/mini-server del bridge deve restare acceso durante il servizio e non deve essere esposto a Internet.
- In presenza di più stampanti, la scelta di default può essere indicata in `print_devices.configuration.default_for_receipts=true` **per una sola** stampante EPOS o BRIDGE della sede. Se la selezione è ambigua, Plateform mantiene il selettore di stampa.
- La rete deve prevedere un indirizzo stabile (DHCP reservation o IP statico), DNS risolvibile dalle postazioni e certificati HTTPS validi. Verificare il comportamento del browser da tutte le piattaforme realmente utilizzate, anche dopo riconnessioni.

**Collaudi prima dell'attivazione:** stampa e taglio reali, risposta positiva del dispositivo, occupazione/carta esaurita, perdita di rete, accessi da Windows/macOS/Linux e mobile, ristampa consapevole dopo esito incerto. Una stampante su rete locale non è automaticamente accessibile da Internet; per postazioni esterne servono un percorso protetto e un progetto di sicurezza dedicato.

**Scontrino non fiscale:** i documenti generati da Plateform con questi driver restano conti/ricevute di cortesia. Per documenti commerciali fiscali servono strumenti certificati.

Fonti del produttore: [scheda TM-T20III (012) Ethernet](https://www.epson.eu/en_EU/products/printers/pos-printers/pos-printers/pc-pos-printers/epson-tm-t20iii-%28012%29%3A-ethernet%2C-ps%2C-blk%2C-eu/p/28150); [manuale tecnico TM-T20III](https://download4.epson.biz/sec_pubs/bs/pdf/TM-T20III_trg_en_revF.pdf); [manuale ePOS-Print XML](https://support.epson.net/publist/bsmanual.php?lang=C2&model=TM-T20III).

## Epson TM-T20III con porta USB disponibile: Windows e taglierina

1. Solo per una variante che **dispone realmente dell'interfaccia USB utilizzabile**: collegarla al PC Windows, installare il driver Epson supportato e verificare **una stampa di prova**. La TM-T20III **(012) è commercializzata da Epson come modello Ethernet**: per questa scegliere la modalità rete descritta di seguito. Non rimuovere eventuali protezioni della porta USB senza verificare il manuale e la specifica variante.
2. Verificare il nome esatto della coda locale con `Get-Printer | Select-Object Name,PortName` in PowerShell. Per esempio `EPSON TM-T20III Receipt`. Non usare nomi UNC o condivisioni remote.
3. Partire da `config.windows-usb.example.json`: sostituire l'ID device con quello registrato in Plateform (`driver=BRIDGE`), `windows_printer_name` con il nome della coda, origini, chiavi e certificati TLS attendibili. Se configurata una sola stampante BRIDGE attiva, il pulsante `Stampa scontrino` invia direttamente una `RECEIPT`, senza finestra del browser; con più stampanti rimane la scelta manuale.
4. Avviare il bridge sullo **stesso PC Windows** e sotto un account che abbia accesso alla stampante. È un servizio locale Node, non una funzione cloud; deve essere attivo durante il turno. Usare `npm ci` e poi `$env:PLATEFORM_BRIDGE_CONFIG='C:\\Plateform\\config.json'; npm run print:bridge` in PowerShell. Gestire avvio automatico e log con un supervisore affidabile.
5. Nella configurazione staff, l'endpoint BRIDGE sarà `https://localhost:7443/v1/print` (il certificato deve essere valido e considerato attendibile dal browser). L'origine HTTPS e la porta devono corrispondere a `origin` del bridge. Registrare nel database lo stesso device UUID.
6. Con funzionalità Epson abilitata nella **release e licenza applicabile**, provare un documento di cortesia senza valore fiscale: confermare contenuto, taglio, stato della carta e scenario di errore. Non usare la stampante in servizio prima del collaudo su Windows + driver Epson + hardware effettivo.

Il bridge verifica l'autorizzazione ECDSA e il digest del documento prima di inoltrarlo. La versione USB accetta soltanto il preciso XML generato da Plateform, lo converte in testo ASCII stampabile (42 caratteri/riga) ed esegue `ESC @` e `GS V 1` per il taglio parziale. Ignora qualsiasi comando di controllo contenuto nei nomi degli articoli. Il processo PowerShell usa Winspool con datatype `RAW`, senza `window.print()` o dialoghi di stampa.

**Limiti:** l'accettazione della coda Windows non certifica l'uscita fisica dello scontrino. In caso di incertezza controllare carta e documento prima di qualunque ristampa; il bridge non riprova automaticamente. L'operazione non emette **documenti commerciali fiscali**: per quelli serve un registratore telematico o un partner fiscale certificato. L'edizione CORE attuale mantiene il blocco Epson: attivazione e collaudo richiedono una release/abilitazione separata.

Fonti Epson: [TM-T20III Technical Reference Guide](https://download4.epson.biz/sec_pubs/bs/pdf/TM-T20III_trg_en_revF.pdf), [ESC/POS GS V](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_cv.html).
