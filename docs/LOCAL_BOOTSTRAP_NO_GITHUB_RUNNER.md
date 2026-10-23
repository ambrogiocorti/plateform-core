# Plateform — clean bootstrap senza GitHub runner

Questo percorso è pensato per la verifica tecnica **su una macchina con Docker Desktop e Node.js 24.13+**. È indipendente da GitHub Actions, non utilizza token Supabase e non richiede un nuovo progetto cloud.

## Avvio

Da una copia aggiornata del branch `plateform/two-phase-completion-20261013`:

```powershell
node scripts/bootstrap-local.mjs --self-test
node scripts/bootstrap-local.mjs --run
```

Il secondo comando scarica temporaneamente via `npx` la CLI Supabase fissata alla versione `2.120.0` (serve Internet e Docker Desktop attivo). Crea una directory temporanea con un `project_id` casuale e porte non standard, copia le 482 migrazioni, avvia un container PostgreSQL **soltanto locale**, poi controlla catalogo e history (`482|7|true|true`). La pulizia utilizza esclusivamente l'identificativo generato in quella stessa esecuzione.

Non copia né legge `.env.local` e forza `SUPABASE_ACCESS_TOKEN` vuoto nel sottoprocesso. Non esegue `db push`, `db reset`, `--linked` o `--db-url`. **Non eseguire manualmente comandi di reset sul tuo Development o Restore Test.**

## Limiti

- Il percorso `--self-test` verifica le protezioni dello script e l'inventario locale; non avvia Docker.
- Il percorso `--run` è la prova PostgreSQL reale ma richiede esecuzione e uscita PASS sulla macchina host. Non è stato eseguito durante la creazione di questo file.
- Il test non certifica staging HTTPS reale, backup/restore di dati e Storage, stampanti, pagamenti e autorizzazioni remote.
- Se fallisce, conservare la riga dell'errore e l'identificativo temporaneo. Non trattare un problema d'infrastruttura Docker come fallimento automatico dello schema.

Per il rilascio commerciale servono ancora un progetto staging indipendente, un backup completo testato e i gate applicabili.
