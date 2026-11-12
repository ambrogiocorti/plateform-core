# Ripristino da disastro offline

Da usare quando l'installazione sorgente (e quindi il suo control plane) è persa.
Ricostruisce un progetto Supabase **vuoto e dedicato** da una copia cifrata del
backup (primaria o replica), senza contattare la sorgente.

```sh
node tools/disaster-restore/start.mjs --check               # autentica il manifest
node tools/disaster-restore/start.mjs --restore             # ripristina e verifica
node tools/disaster-restore/start.mjs --activate-schedules  # solo al cutover
```

Variabili: vedi l'intestazione di `start.mjs`. Il comando rifiuta target occupati,
manifest con HMAC errato, artefatti con SHA-256 errato, chiavi mancanti.

Dopo `--restore` l'installazione contiene:

- il backup usato, finalizzato `SUCCEEDED` tramite `finish_backup_job`
  (`verification.reconciled_by = DISASTER_RESTORE`);
- un job `RESTORE` in `CUTOVER_REQUIRED` intestato al Super Admin indicato
  (`public.record_disaster_restore`, migrazione `20261018114500`);
- sessioni, token e step-up invalidati; cron `plateform-*` spenti.

Il passaggio in produzione richiede `confirm_restore_cutover` con step-up dal
pannello Super Admin, dopo le verifiche del runbook (secrets, Edge Functions,
Auth, domini, provider). Le schedulazioni si riattivano con `--activate-schedules`.
