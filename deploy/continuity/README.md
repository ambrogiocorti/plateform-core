# Plateform continuity worker host

Questo pacchetto prepara un **host operativo dedicato** per il worker di backup. Non certifica da solo il backup.

## Requisiti obbligatori

- Node.js `>=24.13.0`;
- Supabase CLI compatibile con il progetto;
- PostgreSQL client `psql` (Postgres 17+ consigliato per il target corrente);
- runtime Docker compatibile richiesto dal flusso `supabase db dump`; su Linux il doctor richiede rootless per default;
- due root backup persistenti: primaria + replica cifrata. In produzione devono essere su filesystem/device distinti o la replica deve essere un mount remoto separato;
- accesso server-side a Supabase e database; nessun segreto nel frontend;
- chiave API server-side: `sb_secret_...` consigliata oppure legacy `service_role` durante il periodo di compatibilità; il doctor rifiuta publishable/anon e placeholder;
- nessun ingresso HTTP pubblico sul worker.

Installazione consigliata:

```bash
deploy/continuity/install-user-service.sh "$HOME/plateform" "/mnt/plateform-backup-replica"
```

Lo script **non abilita il timer**: crea/preserva `~/.config/plateform/continuity.env`, forza permessi `0600` e installa le unit user. La root primaria viene impostata sull’home reale dell’utente; la root replica va passata come secondo argomento e deve essere un filesystem/device o mount indipendente. Il relativo `ReadWritePaths` systemd viene generato come drop-in. Dopo aver inserito i secret eseguire:

```bash
npm run continuity:host-check
npm run backup:check
```

Il backup viene marcato `SUCCEEDED` solo dopo la replica atomica e la verifica SHA-256 byte-per-byte della seconda copia. Per default `backup:check` rifiuta root primaria e replica sullo stesso device; `PLATEFORM_ALLOW_SAME_DEVICE_REPLICA=true` è ammesso soltanto per sviluppo/test.

Il timer backup esegue `backup:once` ogni minuto. È sicuro perché il database applica lease e `skip locked`: senza job il worker risponde `IDLE`, mentre `enqueue_due_backup()` decide ogni 5 minuti se il target RPO richiede un nuovo backup. Un secondo timer esegue `retention:once` ogni 30 minuti: può reclamare solo backup `SUCCEEDED` scaduti e non coinvolti in restore attivi; elimina **sia primaria sia replica** prima di chiudere il purge, senza cancellare lo storico metadata/audit.

## Installazione systemd user

Copiare le unit backup e retention in `~/.config/systemd/user/`, creare `~/.config/plateform/continuity.env` con permessi `0600`, eseguire `backup:check` e `retention:check`, quindi abilitare entrambi i timer. Il percorso `%h/plateform` e il backup root possono essere adattati all'host.

Su Linux usare un runtime Docker **rootless dedicato**. Il doctor fallisce con `DOCKER_NOT_ROOTLESS` se rileva Docker rootful; l'override `PLATEFORM_ALLOW_ROOTFUL_DOCKER=true` esiste solo per ambienti controllati ed è esplicitamente segnalato come warning. Il socket Docker root dell'host equivale sostanzialmente a privilegi elevati e non deve essere condiviso con il processo web.

## Restore test e restore reale

Non sono schedulati automaticamente su questo host perché richiedono un progetto target distinto e confermato. Si eseguono dal runbook con variabili target dedicate:

```bash
npm run restore-test:check
npm run restore-test:once

npm run restore:check
npm run restore:once
```

Il restore reale si ferma in `CUTOVER_REQUIRED`; il Super Admin conclude o abbandona il cutover dalla dashboard dopo i gate di piattaforma e gli smoke test.

## Bootstrap riproducibile del toolchain

Per un host Linux dedicato, prima dell'installer systemd è disponibile:

```bash
deploy/continuity/bootstrap-user-toolchain.sh "$HOME/plateform"
```

Il bootstrap installa **solo nel profilo dell'utente** la versione Node fissata in `toolchain.lock.env`, verificando il tarball ufficiale con `SHASUMS256.txt`, quindi installa una versione esatta della Supabase CLI tramite npm. Non usa `sudo` e non modifica automaticamente i repository di sistema.

`psql`, Docker Engine/rootless extras e `uidmap` restano prerequisiti di sistema: se mancano, il bootstrap termina `fail-closed` con il prerequisito preciso da installare. Quando `dockerd-rootless-setuptool.sh` è disponibile e i range `/etc/subuid` + `/etc/subgid` sono configurati, il bootstrap configura/avvia il daemon Docker rootless e scrive `~/.config/plateform/toolchain.env` con PATH, socket Docker e path binari espliciti.

`install-user-service.sh` monta tale file come `EnvironmentFile` opzionale delle unit systemd; in questo modo i timer non dipendono dal PATH interattivo della shell.

## Attivazione fail-closed dei timer

Dopo bootstrap, installazione unit e configurazione dei secret, non abilitare i timer manualmente. Usare:

```bash
deploy/continuity/activate-user-service.sh "$HOME/plateform"
```

Lo script richiede `continuity.env` e `toolchain.env` con permessi `0600`, rifiuta i placeholder, esegue il doctor host, `backup-worker --check` e `backup-retention-worker --check`; solo dopo abilita i due timer e verifica che risultino realmente enabled/active. Per fermare il worker:

```bash
deploy/continuity/deactivate-user-service.sh
```

## Configurazione sicura dei secret

Dopo l'installer, configurare le credenziali senza inserirle negli argomenti della shell:

```bash
deploy/continuity/configure-continuity-env.sh "$HOME/plateform"
```

Il configuratore usa prompt senza echo per server key, connection string PostgreSQL e chiave di cifratura; valida la configurazione con lo stesso parser del backup worker e sostituisce `continuity.env` solo dopo il successo, con permessi `0600`. La chiave di cifratura deve comunque essere conservata anche in un escrow esterno/off-host: il file locale non è una strategia di recovery della chiave.
