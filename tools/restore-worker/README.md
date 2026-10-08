# Plateform restore worker

Worker esterno per il restore reale dell'intera installazione. Non esegue restore in-place sul progetto sorgente: il target deve essere un progetto Supabase replacement distinto e vuoto, così il control plane sorgente resta disponibile per audit, lease e gestione errori.

## Sicurezza

Prima del claim il worker verifica prerequisiti locali e richiede:

- `PLATEFORM_RESTORE_ALLOW_DESTRUCTIVE=true`;
- `PLATEFORM_RESTORE_TARGET_CONFIRM_PROJECT_REF` identico al project ref target;
- target diverso dal progetto sorgente;
- `psql` disponibile;
- backup root leggibile;
- `@supabase/supabase-js` disponibile.

Dopo il claim accetta esclusivamente `mode=RESTORE` e richiede un `pre_restore_backup_id` già `SUCCEEDED`, integro e comprensivo di Auth/Storage. In stato `RESTORING` il target deve essere privo di una precedente installazione Plateform e di oggetti Storage. In stato `VERIFYING` non ripete il restore: verifica soltanto il target già scritto.

## Flusso

```text
REQUESTED
→ conferma forte + step-up
→ PRE_RESTORE backup
→ SNAPSHOTTING
→ pre-restore SUCCEEDED
→ RESTORING su replacement project
→ VERIFYING
→ SUCCEEDED / FAILED
→ cutover infrastrutturale separato
```

Il successo del restore dati non esegue automaticamente DNS/deploy/cambio credenziali: l'output include `requiresCutover=true`. Il cutover deve seguire il runbook e resta un gate operativo distinto.

## Comandi

```bash
npm run restore:check
npm run restore:once
npm run check:restore-worker
```

## Variabili richieste

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PLATEFORM_BACKUP_ROOT`
- `PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64`
- `PLATEFORM_RESTORE_TARGET_SUPABASE_URL`
- `PLATEFORM_RESTORE_TARGET_SERVICE_ROLE_KEY`
- `PLATEFORM_RESTORE_TARGET_DB_URL`
- `PLATEFORM_RESTORE_TARGET_CONFIRM_PROJECT_REF`
- `PLATEFORM_RESTORE_ALLOW_DESTRUCTIVE=true`
- opzionale `PSQL_BIN`
- opzionale `PLATEFORM_RESTORE_LEASE_SECONDS`

I secret non devono essere salvati nel repository.
