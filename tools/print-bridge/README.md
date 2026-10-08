# Bridge locale Plateform

Servizio HTTPS Node 24 per stampanti Epson ePOS-Print compatibili. Non genera documenti fiscali. Il software è verificato localmente con TLS e stampante simulata; compatibilità firmware, stampa fisica, carta esaurita, spooling e reti reali restano collaudi obbligatori.

## Installazione

Eseguire `npm ci` e conservare configurazione, certificati e database in una directory privata fuori dalla distribuzione. Copiare `config.example.json` e sostituire riferimenti/origini, chiavi pubbliche e ID dei dispositivi configurati nel ristorante. L’esempio intenzionalmente non parte senza chiavi pubbliche reali.

Configurare `PRINT_SIGNING_PRIVATE_JWK` nelle Edge: coppia ECDSA P-256 dedicata alla stampa, chiave privata mai nell’app/bridge. `public_keys` contiene soltanto chiavi pubbliche, una–tre per rotazione. `issuer` è l’origine del progetto Supabase. `origin` deve corrispondere all’URL BRIDGE configurato nello staff; `allowed_origins` contiene origini staff HTTPS esatte.

Il bridge usa un certificato TLS attendibile dai browser operativi. Epson usa HTTPS con verifica del certificato: `ca_file` consente una CA privata esplicita. Non disabilitare la verifica TLS. Collegare ogni device ID a un endpoint ePOS locale conosciuto; il browser non può scegliere l’indirizzo fisico della stampante.

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
