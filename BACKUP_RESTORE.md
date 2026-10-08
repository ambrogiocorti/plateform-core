# Backup e ripristino

**Modulo in implementazione avanzata, non ancora certificato production.** Il control plane server-side gestisce queue, lease, retry, metadata, pre-restore snapshot e restore test; il sorgente include worker esterni fail-closed per backup e restore test, manifest cifrato/verificato, scheduler adattivo rispetto al target RPO e alert automatici. Manca ancora la prova reale end-to-end di backup + restore su target isolato: nessun backup è dichiarato affidabile sulla base delle sole tabelle o dei test statici.

## Ambito obbligatorio

Una copia recuperabile deve comprendere database applicativo, schema/Auth coerenti, oggetti Storage e manifest con riferimenti/versioni/hash, oltre al piano di chiavi/configurazione esterne. Il backup database Supabase comprende metadati Storage ma non i contenuti degli oggetti. L’export dei sorgenti dell’applicazione non è un backup dei dati del ristorante.

Definire per ciascuna installazione RPO e RTO, infrastruttura necessaria, retention, cifratura, custodia e rotazione delle chiavi, copie separate/immutabili, accessi e responsabili. Il piano di continuità è ora configurabile: default development `RPO target = 60 min`, `RTO target = 60 min`, retention backup `30 giorni`, restore test `30 giorni`. Il cron controlla ogni 5 minuti se un nuovo backup è dovuto rispetto al target RPO; ciò non equivale a un RPO/RTO garantito perché il worker e l’infrastruttura devono essere operativi e i valori devono essere misurati. Il Master Prompt richiede di progettare per RPO nell’ordine dei minuti e RTO nell’ordine di un’ora quando l’infrastruttura lo consente; i valori reali devono essere misurati durante restore test e staging prima di qualsiasi dichiarazione commerciale.

## Stato implementazione e gate aperti

1. **Implementato:** queue/lease/retry, worker backup fail-closed, dump database/Auth/migration history, export Storage, AES-256-GCM, HMAC-SHA256 del manifest, fingerprint metadata Storage, snapshot consistency prima/dopo, replica secondaria obbligatoria con prova hash, scheduler adattivo, retention metadata e purge fisico auditato di primaria+replica.
2. **Implementato:** restore test worker su target distinto e vuoto, project-ref ↔ DB binding, ricostruzione database/Auth/Storage/migration history e **14 gate** post-restore: database, migrations/version/hash, Auth, private-state duraturo, Storage bytes, Storage metadata fingerprint, manifest+HMAC, RLS, accounts, payments, audit, sessioni invalidate e devices.
3. **Implementato:** restore Super Admin con selezione backup eleggibile, step-up, motivo, conferma forte e snapshot `PRE_RESTORE` obbligatorio prima del restore.
4. **Implementato:** Operational Health con ultimo successo/fallimento, restore test, integrità, retention, queue e cron; reconciler automatico ogni 10 minuti apre/deduplica/risolve incidenti di continuità.
5. **Implementato:** retention fisica con lease/retry, protezione dei backup usati da restore attivi, purge filesystem confinato al backup root, alert di retention overdue e Operational Health dedicato.
6. **Da verificare realmente:** almeno un backup completo su storage persistente/off-site e almeno un restore test riuscito su progetto disposable separato. Da quella prova derivano RPO/RTO osservati e gate commerciale.
7. **Implementato nel runbook:** riconciliazione post-restore di provider, sessioni/codici, print job e device offline. Il cutover resta bloccato in caso di stato esterno ambiguo e un restore del database non autorizza mai la ripetizione automatica di effetti già avvenuti fuori dal database.

Restore per sede o per singola componente non è offerto come operazione sicura finché non è documentata e provata la coerenza di dipendenze. La dismissione protetta deve usare un backup completo prima delle transizioni definitive; oggi questa dipendenza blocca il flusso.

Il gate commerciale `backup_restore_database_auth_storage` richiede evidenze reali. Non registrarvi un successo simulato. `npm run continuity:rehearsal` orchestra host preflight → backup reale → restore-test reale e produce l’evidenza di certificazione; se manca la richiesta restore-test Super Admin si ferma senza bypassare step-up. `npm run check:step12-rehearsal` applica inoltre il fail-closed sulla baseline corrente (migration count/version/hash, backup reale integro, restore-test completo e RPO/RTO documentati; misure production/cutover restano gate di go-live). Fonte: [backup Supabase](https://supabase.com/docs/guides/platform/backups).

## Auth nel dump logico canonico

Plateform usa il percorso documentato da Supabase: `supabase db dump` produce `roles.sql`, `schema.sql` e `data.sql`. I dati Auth sono preservati nel `data.sql`; non viene creato un secondo dump Auth che rischierebbe di duplicare `auth.users` durante il restore.

Il worker scansiona `data.sql` in streaming e richiede esplicitamente il blocco `COPY auth.users`. Il manifest registra il numero utenti trovato e `verified_in_data_dump=true`. Se il blocco Auth manca, il job fallisce con `AUTH_DUMP_MISSING` e il backup non può diventare `SUCCEEDED`. Il restore verifica che il numero utenti target coincida con il manifest.

I metadati Storage (`storage.buckets` / `storage.objects`) sono anch'essi parte del database; i byte degli oggetti vengono invece copiati separatamente. Dopo il restore SQL, il worker ripristina i byte Storage sugli stessi path tramite upload `upsert`, quindi verifica SHA-256 di ogni oggetto.

## Restore reale: replacement project

Il restore reale non viene eseguito in-place sul progetto sorgente. Plateform usa un progetto Supabase replacement distinto per mantenere disponibile il control plane sorgente durante snapshot, restore, verifica e rollback.

Il target iniziale deve essere vuoto. Dopo il restore vengono verificati almeno:

- database;
- Auth e numero utenti;
- Storage e SHA-256 degli oggetti;
- manifest;
- RLS;
- conti;
- pagamenti;
- audit;
- sessioni;
- dispositivi.

Un worker che riprende un job già in `VERIFYING` non riesegue il restore: esegue soltanto i controlli post-restore.

### Cutover

Dopo la verifica dei dati, un restore reale entra in `CUTOVER_REQUIRED`: il replacement ha superato i gate database/Auth/Storage ma **non è ancora considerato completato**. `SUCCEEDED` viene assegnato soltanto dopo conferma Super Admin con step-up, project ref target esatto e nota dei gate/smoke test eseguiti. Se il replacement non deve diventare attivo, il Super Admin usa l'abbandono cutover e il job termina `FAILED/CUTOVER_ABORTED`.

Prima del cutover devono essere verificati e, dove necessario, riconfigurati:

- Edge Functions;
- secrets;
- Auth settings/provider;
- URL di redirect;
- Realtime/publications;
- estensioni e impostazioni database non trasferite dal percorso usato;
- Storage bucket settings;
- API/public key usate dal frontend;
- domini/hosting;
- health check staff/pubblico.

Il cutover e il rollback devono essere provati in staging/rehearsal e temporizzati prima di dichiarare RTO garantito.

## Runtime continuity worker

Il backup worker deve essere eseguito su un host operativo dedicato e non sul processo web. Il contratto riproducibile è in `deploy/continuity/` e richiede:

- Node.js `>=24.13.0`;
- Supabase CLI;
- `psql` per restore e verifiche;
- runtime Docker necessario al flusso CLI; su Linux rootless per default;
- volume backup persistente, cifrato e soggetto a copia separata/immutabile;
- secret server-side in file ambiente `0600`;
- nessun endpoint HTTP pubblico sul worker.

`npm run continuity:host-check` verifica il runtime **prima** dell'avvio. Anche `backup:once` controlla Supabase CLI e Docker **prima** di reclamare un job; un daemon Docker non disponibile o rootful non autorizzato non consuma la coda. Il template systemd user esegue un solo `backup:once` al minuto: lease e `skip locked` lato database rendono il polling idempotente, mentre `enqueue_due_backup()` decide se il target RPO richiede effettivamente un nuovo job. Restore test e restore reale restano one-shot controllati perché richiedono un target distinto e confermato.

Nell'attuale container di sviluppo il check restituisce correttamente `NOT_READY` (Node 22, Supabase CLI/psql/Docker e secret operativi mancanti); questo è un gate fail-closed, non un errore considerato superato. Il rehearsal del 4 ottobre 2026 era stato eseguito su **106 migration** con hash aggregato identico `74776e587ba374f2be0f7efc55aff8bf933d4cce18d9040d0c8d8be79e01068b`. Il repository e il development correnti sono ora allineati su **130 migration**; il prossimo target disposable deve quindi essere creato/riallineato dalla migration history corrente prima del nuovo restore test reale.

## Retention fisica e rotazione chiavi

La scadenza non è soltanto metadata. Un worker separato reclama backup `SUCCEEDED` con `retention_until <= now()`, purché non siano usati da restore attivi. Dopo aver verificato che il riferimento file appartenga esattamente a `<PLATEFORM_BACKUP_ROOT>/<backup_uuid>/manifest.json#database`, elimina la directory del backup e conferma il purge al control plane. Symlink e riferimenti fuori root sono rifiutati. Metadata storico, manifest, checksum e audit restano disponibili; soltanto i riferimenti ad artefatti cancellati vengono azzerati. `CONTINUITY_RETENTION_OVERDUE` segnala purge oltre la tolleranza.

La rotazione delle chiavi non deve rendere irrecuperabili i backup storici. Il backup nuovo usa la chiave attiva (`PLATEFORM_BACKUP_ENCRYPTION_KEY_ID` + `PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64`); restore test e restore reale risolvono invece la chiave usando l'`encryption_key_id` del backup, con eventuali chiavi storiche in `PLATEFORM_BACKUP_KEYRING_JSON`. Se la chiave richiesta non è disponibile il restore fallisce chiuso. Il keyring non sostituisce un secret store/escrow esterno: recovery ed accesso alle chiavi devono essere provati sul deployment production.

## Replica secondaria obbligatoria

Un backup Plateform non è considerato completo con la sola copia primaria. Il continuity host richiede `PLATEFORM_BACKUP_REPLICA_ROOT`: la directory cifrata del job viene copiata tramite staging `.partial`, rinominata atomicamente e verificata file-per-file con SHA-256 prima della finalizzazione DB. Se per lo stesso backup ID esiste già una replica identica viene riusata idempotentemente; se differisce, il worker genera `BACKUP_REPLICA_IMMUTABLE_CONFLICT` e preserva la copia esistente invece di sovrascriverla. Il controllo di durabilità registra `replica_file_count`, `replica_size_bytes` e `replica_hash`; la transizione a `SUCCEEDED` è bloccata lato database se la prova manca.

In produzione primaria e replica devono risiedere su filesystem/device distinti oppure la replica deve essere un mount remoto separato. L'override same-device esiste solo per sviluppo/test. La retention elimina entrambe le copie prima di marcare gli artefatti come purgati. I riferimenti `plateform-backup://...` restano portabili: una replica può essere montata come nuovo `PLATEFORM_BACKUP_ROOT` su un host sostitutivo.

## Integrità del manifest, schema snapshot e coerenza temporale

Il manifest corrente usa `format_version=2` ed è autenticato con HMAC-SHA256 (`manifest.hmac`) derivato dalla chiave del backup. La transizione database a `SUCCEEDED` viene rifiutata se `manifest_auth=true` non è presente o se manca la prova di replica. Restore test e restore reale verificano l'HMAC **prima** di fidarsi di path, metadati o componenti del manifest.

La migration history `supabase_migrations` è salvata separatamente (`history_schema.sql` + `history_data.sql`) e il manifest registra `count`, `latest_version` e `aggregate_sha256`. `schema_version` del backup non deriva dallo stato corrente del DB al termine del job: è legato alla `latest_version` dello snapshot effettivamente dumpato. Il restore deve ritrovare lo stesso count/version/hash.

Il worker legge lo stato Auth + migration history prima e dopo il dump e fallisce con `DATABASE_SNAPSHOT_CHANGED_DURING_BACKUP` se cambiano durante la copia. Storage applica lo stesso principio tramite fingerprint dei bucket/oggetti e rifiuta configurazioni non supportate (bucket non `STANDARD` o versioning attivo) invece di dichiarare un backup recuperabile senza prova.

## Pre-restore snapshot

Il restore reale non parte direttamente dal backup scelto. Dopo la conferma forte, Plateform accoda un backup `PRE_RESTORE` usando la retention configurata. `claim_backup_job()` assegna priorità allo snapshot pre-restore rispetto ai backup manuali/schedulati; il restore resta `SNAPSHOTTING` finché lo snapshot non è `SUCCEEDED`, integro e completo. Se lo snapshot fallisce, il restore termina `FAILED/PRE_RESTORE_BACKUP_FAILED`. La conferma del restore riverifica eleggibilità, retention e stato purge usando `clock_timestamp()` per evitare race sulla scadenza.

## Versione applicazione e schema in Operational Health

Operational Health legge `schema_version` direttamente dalla history canonica `supabase_migrations.schema_migrations`; la tabella legacy `database_migrations_metadata` non è usata come fonte autoritativa. In development è registrata una baseline `0.1.0 / STAGING` con `git_commit=not-recorded`: serve a rendere osservabile la versione applicativa senza fingere una release production. Il vero commit/build provenance e la promozione `RELEASED` appartengono al release pipeline/go-live e restano da certificare nello Step 13.

### Stato private e sicurezza post-restore

Il backup include lo schema `private`, ma il restore distingue tra dati duraturi e stato di sicurezza temporaneo. Il manifest registra un fingerprint SHA-256 aggregato delle 11 tabelle private durature. Dopo il restore il worker disabilita i cron `plateform-*`, invalida sessioni/token/step-up/rate-limit/challenge temporanei e verifica che il fingerprint duraturo corrisponda al backup. Un restore non può essere marcato riuscito senza `private_state=true` e `sessions=true`.

Il 4 ottobre 2026 è stato inoltre eseguito un rehearsal assistito su `plateform-restore-test`: **storicamente 106/106 migration**, schema/policy/RLS, dati public+Auth e fingerprint Storage coincidevano allora con il development e lo smoke Super Admin/RPC era passato. La build corrente è a **130/130 migration**: quella prova resta evidenza storica e non certifica la migration history attuale né sostituisce il restore-test worker da artefatto cifrato reale.
