# Backup production a costo zero (piano Supabase Free)

Decisione del proprietario del 9/11/2026: nessuna spesa per Supabase. `plateform-production` resta sul piano Free, che **non** ha backup gestiti né PITR. Il backup è quindi affidato al worker applicativo `tools/backup-worker`, eseguito ogni notte dal workflow `.github/workflows/production-backup.yml`.

Stato: **IMPLEMENTATO, NON VERIFICATO**. Nessun backup è considerato valido finché non esiste un job `SUCCEEDED` con `integrity_verified=true` **e** un restore test riuscito su un progetto isolato.

## Cosa fa il workflow

1. Ogni notte alle 02:30 UTC (oppure a mano da _Actions → Plateform production backup → Run workflow_).
2. `backup-worker --check`: verifica configurazione, Supabase CLI 2.119.0, `psql` 17, Docker; non reclama job.
3. `backup-worker --once` fino a `IDLE` (massimo 5 job): reclama i job in coda in `backup_metadata`, crea `roles.sql`, `schema.sql`, `data.sql` (Auth incluso) e copia gli oggetti Storage, cifra tutto con AES-256-GCM, verifica la decifratura e la replica byte per byte, chiude il job con `finish_backup_job`.
4. Carica la cartella cifrata come artefatto `plateform-production-backup-<run id>`, conservato **14 giorni**.

Il workflow è spento finché non si imposta la variabile `PLATEFORM_PRODUCTION_BACKUP_ENABLED=true`. Non applica migrazioni, non esegue restore e non scrive su production oltre al ciclo di vita del job di backup e all'audit.

## Attivazione (da fare una volta, dal proprietario)

In GitHub: _Settings → Environments → New environment_ `plateform-production-backup`. Facoltativo ma consigliato: _Deployment branches_ = solo `main`.

Secret dell'environment:

| Secret                                   | Valore                                                                                    | Dove trovarlo                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `PLATEFORM_BACKUP_SUPABASE_URL`          | `https://xzateqavvaparjoybbhr.supabase.co`                                                | Dashboard → Project Settings → API                       |
| `PLATEFORM_BACKUP_SUPABASE_SECRET_KEY`   | chiave `sb_secret_…` (o legacy `service_role`)                                            | Dashboard → Project Settings → API Keys                  |
| `PLATEFORM_BACKUP_SUPABASE_DB_URL`       | connection string **Session pooler** (porta 5432, utente `postgres.xzateqavvaparjoybbhr`) | Dashboard → Connect → Session pooler                     |
| `PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64` | 32 byte casuali in Base64                                                                 | generare sul proprio computer: `openssl rand -base64 32` |

Variabili del repository (_Settings → Secrets and variables → Actions → Variables_):

| Variabile                             | Valore                                                |
| ------------------------------------- | ----------------------------------------------------- |
| `PLATEFORM_BACKUP_ENCRYPTION_KEY_ID`  | es. `prod-2026-11` (nome della chiave, non la chiave) |
| `PLATEFORM_PRODUCTION_BACKUP_ENABLED` | `true`                                                |

Il Session pooler è obbligatorio: la connessione diretta dei progetti Free è solo IPv6 e i runner GitHub non la raggiungono.

**Chiave di cifratura:** salvarla anche in un password manager e in una copia offline. Senza chiave i backup sono irrecuperabili; GitHub non permette di rileggere un secret dopo averlo salvato.

## Copia locale settimanale

Gli artefatti scadono dopo 14 giorni e vivono sullo stesso account GitHub del codice. Una volta alla settimana scaricare l'ultimo artefatto (pagina del run → _Artifacts_) e conservarlo su un disco del proprietario o sull'hub di sede. I file sono cifrati: il disco non deve contenere la chiave.

## Test di restore non distruttivo

Production non viene mai usata come target. Il restore avviene su un **secondo progetto Free temporaneo** (`plateform-restore-test`, eu-west-1), creato solo per la prova ed eliminato subito dopo; non è uno staging.

1. Scaricare l'artefatto ed estrarlo in una cartella qualsiasi, da indicare in `PLATEFORM_BACKUP_ROOT` (i riferimenti `plateform-backup://<id>/manifest.json` sono relativi alla radice). Servono anche le stesse `PLATEFORM_BACKUP_ENCRYPTION_KEY_*` e le credenziali server-side della sorgente, che il worker usa per reclamare e chiudere il job.
2. Impostare le variabili `PLATEFORM_RESTORE_TEST_*` (vedi `tools/restore-test-worker/README.md`), con `PLATEFORM_RESTORE_TEST_CONFIRM_PROJECT_REF` uguale al ref del progetto temporaneo.
3. `npm run restore-test:check`, poi richiedere il restore test dal pannello Super Admin e `npm run restore-test:once`.
4. Il job passa solo se risultano veri i gate `database`, `auth`, `storage`, `manifest`, `rls`, `accounts`, `payments`, `audit`, `sessions`, `devices`.
5. Annotare commit, data, durata ed esiti nel registro continuità; eliminare il progetto temporaneo.

## Limiti accettati

- **RPO fino a 24 ore.** In production `rpo_target_minutes=60`: gli allarmi di continuità segnaleranno RPO superato tra un run e l'altro. Portare il target a 1440 minuti dal pannello Super Admin (`configure_continuity_targets`) per allinearlo alla realtà.
- **Override solo per il runner effimero:** `PLATEFORM_ALLOW_SAME_DEVICE_REPLICA=true` e `PLATEFORM_ALLOW_ROOTFUL_DOCKER=true`. La vera copia esterna è l'artefatto GitHub, non la replica sul disco del runner.
- **Retention:** `backup_retention_days=30` nel database, ma gli artefatti durano 14 giorni e il retention worker non gira su GitHub. I metadati di backup più vecchi di 14 giorni puntano a file non più disponibili su GitHub, salvo copia locale.
- **Nessuna SLA:** il piano Free può essere messo in pausa per inattività e non dà garanzie. Rivalutare Pro/PITR al primo cliente pagante.
- **Secret production su GitHub:** limitati all'environment dedicato; i workflow da fork non li ricevono.
