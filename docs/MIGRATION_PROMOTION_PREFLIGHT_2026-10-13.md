# Plateform — migrazioni: preflight prima di qualsiasi promozione

## Stato verificato (13 ottobre 2026)
- Development: 480 migrazioni remote applicate, confrontate contro il Git storico.
- Branch candidato: 482 migrazioni, di cui due introdotte **prima** del numero di versione più recente già applicato:
  - `20261006100100_continuity_rehearsal_schema_recovery.sql`
  - `20261012075300_audit_pause_legacy_compatibility.sql`
- La stessa directory può essere usata per provare un **replay da zero** su ambiente disposable, ma un aggiornamento 480→482 richiede una procedura distinta. Non usare un `db push` automatico su Development/Production dando per scontato che le versioni retrodatate siano applicate.
- Lo script `scripts/plan-migration-promotion.mjs` confronta versioni, nomi e SHA-256 dello storico applicato con quelli locali. In caso di divergenze o migrazioni retrodatate restituisce stato BLOCKED ed exit code 2. Non possiede credenziali, non accede alla rete e non esegue DDL.

## Esportazione dei metadati remoti, sola lettura
Eseguire sul progetto autorizzato:

```sql
SELECT version, name,
       encode(digest(convert_to(array_to_string(statements, E'\n'), 'UTF8'), 'sha256'), 'hex') AS sha256
FROM supabase_migrations.schema_migrations
ORDER BY version;
```

Salvare le righe come array JSON in un file locale privato e usare:

```sh
node scripts/plan-migration-promotion.mjs --applied-json /path/to/applied-migrations.json
```

La procedura non interpreta un esito `READY_FOR_DISPOSABLE_STAGING_ONLY` come autorizzazione alla produzione. Prima di ogni aggiornamento sono comunque necessari backup/restore indipendenti, staging completo, convalida dell'ordine di applicazione e approvazione del piano di roll-forward/rollback.

## Evidenza automatica
`node scripts/plan-migration-promotion.mjs --self-test` verifica con fixture deterministiche quattro scenari: backfill delle due migrazioni candidate, alterazione dello storico, versione remota sconosciuta e futura migrazione valida, oltre alla duplicazione dello storico. La fixture usa i 480 record **derivati dal manifest**, non è una nuova lettura live di Supabase. Non sostituisce il confronto SQL reale.

**Gate:** il rilascio resta NO-GO finché un piano di upgrade compatibile con il database popolato non viene verificato su staging indipendente.
