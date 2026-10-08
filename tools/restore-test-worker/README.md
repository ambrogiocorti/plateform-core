# Plateform restore-test worker

Worker **distruttivo solo verso un progetto target isolato**. Non può utilizzare lo stesso project ref della sorgente e richiede `PLATEFORM_RESTORE_TEST_ALLOW_DESTRUCTIVE=true`.

Il preflight verifica il target e `psql` prima di chiamare `claim_restore_test_job`. Il worker verifica checksum del manifest e degli artefatti cifrati, decifra in una directory temporanea, esegue la sequenza ufficiale `roles.sql → schema.sql → session_replication_role=replica → data.sql`, quindi ripristina i byte Storage in `upsert` sui metadati già presenti nel database, passa il job a `VERIFYING` e completa soltanto se risultano veri i gate `database`, `auth`, `storage`, `manifest`, `rls`, `accounts`, `payments`, `audit`, `sessions`, `devices`.

Variabili aggiuntive:

- `PLATEFORM_RESTORE_TEST_SUPABASE_URL`
- `PLATEFORM_RESTORE_TEST_SERVICE_ROLE_KEY`
- `PLATEFORM_RESTORE_TEST_DB_URL`
- `PLATEFORM_RESTORE_TEST_ALLOW_DESTRUCTIVE=true`
- `PSQL_BIN` opzionale, default `psql`
- `PLATEFORM_RESTORE_TEST_LEASE_SECONDS` opzionale, default 1800

Il target deve essere sacrificabile. Non puntare mai development/staging/prod correnti come target di un restore test.
