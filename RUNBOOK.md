# Runbook operativo

| Problema                     | Verifica                                                               | Azione sicura                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Login/PIN bloccato           | Ruolo attivo, dispositivo, sessione, MFA e scadenza full auth          | Accesso completo; gestione staff autorizzata. Non usare il PIN per aggirare password/MFA                                       |
| Dati fermi                   | Indicatore connessione, ultima sincronizzazione, salute Realtime/DB    | Aggiornare fuori dai form, ricontrollare snapshot; il polling continua quando il canale è degradato                            |
| Ultima porzione rifiutata    | Stock server e versione del conto                                      | Aggiornare menu/conto e correggere la richiesta; non forzare disponibilità negativa                                            |
| Pagamento pending            | Operazione provider, callback e riserva sul conto                      | Recuperare lo stato server/provider; non confermare dal browser né duplicare l’addebito                                        |
| Quadratura con differenza    | Giornale del servizio, importi e mance separati                        | Richiedere approvazione Admin; registrare motivo. Non modificare movimenti conclusi                                            |
| Stampa SENT/esito incerto    | Carta, rete, stampante, documento fisico, registro bridge              | Ristampa solo dopo conferma del rischio di duplicato; nuovo job collegato all’originale                                        |
| Coda offline bloccata        | Utente originario, autorizzazione/device, versioni e conflitti         | Riconnettere lo stesso utente; consultare il centro Admin. Non eliminare IndexedDB con richieste pending                       |
| Accesso revocato             | Assegnazioni, auth_valid_after, dispositivo e sessioni                 | Nessuna sincronizzazione deve bypassare i controlli; ripristinare accesso solo tramite flusso autorizzato                      |
| Storage pieno                | Quota riservata, oggetti completati e upload sospesi                   | Verificare riserve/esiti prima di ripetere upload; aumento quota tecnico autorizzato                                           |
| Installazione sospesa        | Stato installazione e motivo auditato                                  | Super Admin verifica l’incidente e riattiva con password e motivo                                                              |
| Backup oltre target RPO      | Operational Health, cron, job QUEUED/RUNNING, worker e ultimo successo | Ripristinare il worker; non marcare manualmente il job come riuscito. Ottenere un nuovo backup verificato                      |
| Restore oltre target RTO     | Snapshot pre-restore, lease, target isolato, manifest e log worker     | Non ripetere azioni distruttive alla cieca; preservare artefatti e seguire la timeline incidente                               |
| Cutover replacement pendente | Stato `CUTOVER_REQUIRED`, target ref, gate piattaforma e smoke test    | Non dichiarare il restore riuscito. Confermare cutover con step-up solo dopo riallineamento completo, oppure abortire/rollback |

Ogni diagnosi usa request/correlation ID e registra l’impatto senza password, codici cliente o dati di pagamento sensibili. Probe verde indica raggiungibilità del componente misurato; non conclude il collaudo del flusso.

Per perdita dati non avviare reset o tentativi di restore sull’unica copia. Preservare lo stato, aprire un incidente, identificare backup `SUCCEEDED` con `integrity_verified=true` e seguire BACKUP_RESTORE.md. Il flusso applicativo di restore è implementato ma **non è ancora certificato production**: prima della vendita deve essere completato almeno un restore test reale su progetto disposable separato.

Gli obiettivi RPO/RTO sono configurabili dal Super Admin. I default development sono 60 minuti / 60 minuti e sono soltanto target operativi, non SLA. Operational Health mostra età dell’ultimo backup verificato, durata backup, durata restore test e stato rispetto ai target. Il scheduler verifica ogni 5 minuti se è dovuto un nuovo backup; il worker esterno deve essere effettivamente in esecuzione perché l’enqueue da solo non protegge i dati.

Escalation/responsabili, finestre del servizio e contatti dell’installazione devono essere registrati dal cliente nel piano operativo. Non sono precompilati con nomi o canali inventati. Vedere INCIDENT_RESPONSE.md.

## Restore replacement e cutover

Per restore reale usare esclusivamente un progetto replacement distinto dalla sorgente.

Sequenza operativa:

1. verificare che il backup selezionato sia `SUCCEEDED`, integro e con restore test valido;
2. eseguire step-up e conferma forte dalla dashboard;
3. attendere il completamento obbligatorio del backup `PRE_RESTORE` prioritario; se fallisce, fermare il restore e gestire `PRE_RESTORE_BACKUP_FAILED`;
4. preparare un progetto replacement vuoto e confermarne esplicitamente il project ref nel worker;
5. eseguire `npm run restore:check`;
6. eseguire `npm run restore:once`;
7. non effettuare cutover se uno dei gate database/Auth/Storage/RLS/finanza/audit/sessioni/dispositivi è falso;
8. riallineare Edge Functions, secrets, Auth settings, Realtime e configurazioni di piattaforma;
9. eseguire smoke test pubblico/staff e health probe sul replacement;
10. effettuare il cutover dell'infrastruttura/hosting soltanto dopo approvazione operativa;
11. mantenere la sorgente/pre-restore disponibile fino alla fine della finestra di verifica;
12. in caso di errore, interrompere il cutover o tornare alla sorgente e aprire/aggiornare l'incidente automatico.

Il tempo RTO osservato deve includere restore **e** attività necessarie al cutover, non soltanto il tempo di import del database.

### Gate cutover replacement

Dopo i gate dati il job reale resta `CUTOVER_REQUIRED`. Prima della conferma:

1. riallineare/deployare Edge Functions e relative dipendenze;
2. configurare secrets, Auth provider/redirect, Realtime/publications ed estensioni necessarie;
3. verificare bucket Storage, publishable key/frontend e domini/hosting;
4. eseguire health check e smoke test staff/pubblico;
5. registrare la nota operativa e confermare dalla dashboard con step-up `RESTORE`.

Se uno dei gate non è soddisfatto usare **Abbandona cutover**; il job termina `FAILED/CUTOVER_ABORTED`. Un cutover che resta pendente oltre il target RTO apre l'incidente automatico `CONTINUITY_CUTOVER_PENDING`.

Il backup worker continuativo viene eseguito tramite il contratto `deploy/continuity/`. Verificare `npm run continuity:host-check` prima di abilitare il timer; un host non pronto non deve reclamare job.

## Riconciliazione operativa post-restore

Dopo un restore verificato e **prima del cutover**, non assumere che lo stato esterno sia tornato indietro insieme al database. Provider di pagamento, stampanti e dispositivi possono aver già eseguito operazioni dopo il timestamp del backup. La riconciliazione è quindi obbligatoria e deve essere fail-safe.

1. **Pagamenti e rimborsi provider** — bloccare nuove azioni finanziarie sul replacement finché le operazioni `PENDING`/recenti non sono riconciliate con Stripe/Satispay tramite identificatori provider e idempotency key. Un addebito o rimborso già concluso dal provider non deve essere ripetuto solo perché il record locale manca o è tornato a uno stato precedente. Correggere lo stato tramite i flussi server-authoritative e conservare evidenza/audit della riconciliazione.
2. **Sessioni, codici e autorizzazioni** — mantenere invalidate le sessioni staff/customer, i codici temporanei, step-up, challenge e token revocati dal restore worker. Gli utenti devono autenticarsi nuovamente; non copiare dal sorgente snapshot di sicurezza temporanei per “far funzionare” più velocemente il replacement.
3. **Print job con esito incerto** — per job `QUEUED`, `SENT` o `PRINTING` vicini alla finestra del backup, verificare stampante/bridge/documento fisico prima di ristampare. Non trasformare automaticamente un job incerto in una nuova stampa. Ogni ristampa deve essere esplicita e collegata al job/documento originario per evitare duplicati fiscali o operativi.
4. **Device e queue offline** — i dispositivi devono riaprire una nuova sessione e scaricare uno snapshot authoritative prima di inviare la queue. Non cancellare IndexedDB alla cieca e non rieseguire automaticamente eventi già terminali: riconciliare per `client_event_id`/event ID con `get_offline_sync_statuses`, preservando `SYNCED`, `REJECTED` e `CONFLICT` e riapplicando solo eventi ancora validi.
5. **Gate di cutover** — registrare nel ticket/job di restore l’esito delle quattro riconciliazioni precedenti. Se provider, stampa o queue offline restano ambigui, il replacement resta in `CUTOVER_REQUIRED`; usare abort/rollback invece di dichiarare il restore `SUCCEEDED`.

La regola generale è: **un restore del database non autorizza mai la ripetizione automatica di un effetto esterno**. Quando lo stato è ambiguo, preservare prove e identificatori, sospendere l’azione duplicabile e riconciliare prima del cutover.

## Gate di integrità continuity prima di un restore

Prima di usare un backup verificare almeno:

- `status=SUCCEEDED` e `integrity_verified=true`;
- artefatti non purgati e retention non scaduta;
- manifest `format_version=2` con HMAC valido;
- prova di replica (`replica_file_count`, `replica_size_bytes`, `replica_hash`);
- migration history con `count`, `latest_version`, `aggregate_sha256`;
- fingerprint Storage coerente;
- chiave `encryption_key_id` disponibile nel keyring/escrow;
- project ref coerente con URL API e connection string del target.

Il restore test/restore non deve essere marcato riuscito senza i 14 gate previsti dal protocollo corrente. Una risposta di rete persa dopo il commit di `finish_backup_job` va riconciliata leggendo lo stato server; in stato ambiguo gli artefatti si preservano e non si cancellano.

## Sicurezza durante il restore

Prima di verificare il target, il restore deve quiescere i cron `plateform-*`. Dopo il caricamento del database devono essere invalidate le sessioni e gli artefatti temporanei di sicurezza (staff/customer sessions, refresh token, step-up, rate-limit, impersonazioni e challenge); i dati `private` duraturi devono invece conservare il fingerprint registrato nel manifest.
