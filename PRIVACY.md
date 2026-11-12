# Privacy e conservazione

Questo documento descrive strumenti tecnici e dati trattati. Testi dell’informativa, finalità, basi giuridiche e tempi effettivi devono essere configurati per il cliente; il software non determina automaticamente una base giuridica.

| Classe       | Dati                                                       | Accesso                                                 | Conservazione tecnica                                                                                            |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PUBLIC       | Menu, immagini approvate, indirizzi e contatti commerciali | Sito pubblico                                           | Finché pubblicati, poi secondo piano Storage/backup                                                              |
| INTERNAL     | Sala, configurazioni e assegnazioni                        | Staff autorizzato per ruolo e sede                      | Storico operativo e archiviazione delle entità                                                                   |
| CONFIDENTIAL | Contatti prenotazioni, note e risposte del modulo          | Host per accoglienza; Admin per richieste privacy       | Prenotazioni terminali anonimizzabili; protezione della conservazione per eccezioni motivate                     |
| SENSITIVE    | Password, PIN, token, chiavi; note sulle allergie          | Auth/server; informazioni del servizio secondo permesso | Nessun segreto in audit, telemetry o bundle; le allergie delle prenotazioni vengono rimosse dall’anonimizzazione |

## Richieste su prenotazioni

La pagina Admin `/privacy` ricerca un telefono esatto nella sede autorizzata. Export, rettifica e anonimizzazione richiedono nuova verifica della password, grant associato alla prenotazione, conferma della richiesta e audit. Super Admin e altri ruoli non accedono a questi strumenti attraverso le RPC privacy.

L’export JSON comprende una sola prenotazione e le sue risposte; esclude le note interne dello staff. Rettifica modifica contatti e versione senza cambiare coperti, stato o contabilità. Anonimizzazione rimuove nomi, telefono identificabile, note, allergie e risposte, conservando ID, data, stato e coperti. È vietata su prenotazioni attive/future o con `privacy_hold`. Admin può impostare/rimuovere la protezione con password e motivo.

Una richiesta relativa a più prenotazioni, dati non collegati a una prenotazione o dati di un dipendente richiede una verifica più ampia. Non esiste ancora un export globale automatico di tutti i dati di una persona. Il nome libero di un conto non ha un legame automatico con l’identità del prenotante: va verificato separatamente.

## Policy automatica

Solo Admin con scope CHAIN configura i giorni di conservazione globali, con password e conferma esplicita. La procedura è disabilitata fino a tale configurazione. I valori iniziali della UI sono proposte modificabili, non termini legali già approvati.

`maintenance` applica batch limitati: anonimizza prenotazioni concluse oltre il termine e non protette, revoca/rimuove sessioni cliente scadute, elimina codici scaduti, telemetry, errori e segnali Realtime oltre i termini. Non elimina audit né movimenti contabili. La pulizia di identità Auth usa lease, retry con backoff e Admin API server: soft deletion/pseudonimizzazione delle sole identità marcate `CUSTOMER_SESSION`, mantenendo le FK degli ordini storici. Il risultato va collaudato su GoTrue reale prima della produzione.

Il workflow `maintenance.yml` è inattivo salvo `PLATEFORM_RETENTION_ENABLED=true` e segreti corretti. Il job schedulato non è stato attivato o eseguito su un progetto remoto. Il pannello tecnico può applicare la policy già approvata e vedere solo contatori.

## Log, dispositivi e backup

IP viene trasformato in HMAC per i bucket di rate limit; non viene scritto nei log applicativi. Telemetry conserva soltanto codici, durata, stato HTTP e correlazione. La conservazione dei log gestiti dal fornitore/gateway va configurata separatamente. I motivi liberi non devono contenere segreti o dati personali non necessari.

Cache staff cifrata e vincolata all’utente; logout rimuove cache/autorizzazione conservando operazioni non sincronizzate. La pulizia locale dello storico della coda e il piano di retention dei backup esterni richiedono ancora completamento. L’anonimizzazione del database non elimina automaticamente copie precedenti: retention e accesso ai backup devono rispettare il piano del cliente.

Riferimento infrastrutturale: [Supabase Admin deleteUser](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser). Non è una dichiarazione di conformità dell’intera piattaforma.
