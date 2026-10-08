# Plateform backup worker

Worker operativo **esterno al browser e alle Edge Functions** per lo Step 12. Consuma `claim_backup_job`/`finish_backup_job` con `service_role` e non reclama alcun job finché i prerequisiti locali non sono validi.

## Perché è esterno

Il dump coerente del database richiede Supabase CLI con Docker operativo e un runtime con spazio persistente. Gli oggetti Supabase Storage devono essere copiati separatamente: i backup database della piattaforma non contengono i file Storage.

## Variabili obbligatorie

- `SUPABASE_URL`: URL HTTPS del progetto target.
- `SUPABASE_SERVICE_ROLE_KEY`: solo sul worker, mai nel frontend.
- `SUPABASE_DB_URL`: connessione server-side/session pooler adatta al dump.
- `PLATEFORM_BACKUP_ROOT`: mount assoluto persistente/off-site, non una directory temporanea dell'app.
- `PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64`: chiave casuale di 32 byte in Base64.
- `PLATEFORM_BACKUP_ENCRYPTION_KEY_ID`: identificatore/rotazione della chiave, non la chiave stessa.
- `SUPABASE_CLI_BIN`: opzionale, default `supabase`. La CLI usa Docker per `db dump`.
- `PLATEFORM_BACKUP_LEASE_SECONDS`: opzionale, 60–1800; default 1800.

## Modalità

`node tools/backup-worker/start.mjs --check` controlla configurazione, directory e Supabase CLI senza chiamare `claim_backup_job`.

`node tools/backup-worker/start.mjs --once` reclama un solo job e crea tre dump ufficiali (`roles.sql`, `schema.sql`, `data.sql`), esporta tutti gli oggetti Storage, cifra ogni artefatto con AES-256-GCM, verifica la decifratura e registra il manifest.

Il worker usa i tre dump ufficiali Supabase (`roles.sql`, `schema.sql`, `data.sql`). L'Auth è preservato nel `data.sql`; il worker verifica in streaming la presenza del blocco `COPY auth.users` e ne registra il conteggio nel manifest. Se la CLI/versione in uso non include Auth termina con `AUTH_DUMP_MISSING`: **non** imposta `includes_auth=true` e non dichiara il backup recuperabile.

## Sicurezza

Gli artefatti plaintext sono cancellati dopo la cifratura verificata. Il manifest contiene hash, IV/tag, riferimenti e ID chiave, mai il segreto di cifratura. Il percorso configurato deve essere un volume persistente separato dall'istanza Plateform; la copia off-site/immutabile resta una responsabilità dell'infrastruttura di deployment e va verificata nel gate production.
