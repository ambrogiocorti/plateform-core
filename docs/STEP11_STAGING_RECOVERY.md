# Step 11 — ambiente staging e riconciliazione database

Questo documento non autorizza la vendita: è una procedura di collaudo.
**Nessuna connessione al progetto di produzione deve essere usata per i test.**

## Dati verificati (8 ottobre 2026)

- Checkpoint integrato locale: 130 migrazioni (`npm run check:migrations` PASS).
- ATTENZIONE: il confronto SHA-256 su versioni storiche ha rilevato
  divergenze **anche tra le 130 già presenti**. In particolare la versione
  `20261005062508_step10_venue_lifecycle_management` cambia l'ordine tra
  validazione dei dati e consumo del token di autorizzazione rafforzata;
  `20261006051256_step12_backup_requester_index` differisce per un a capo
  iniziale nel SQL registrato. Non considerarle equivalenti senza un diff
  completo e una revisione. `--write` deve rifiutare il recupero se esiste
  anche un solo checksum discordante.
- Supabase development `abdxvlykasqmknexxhjo`: 453 migrazioni applicate, 323
  successive al checkpoint; lo storico sul server contiene SQL per tutte.
- Localmente l'ambiente ha Node 22 e non raggiunge il registry npm; il build Vite
  Node 24 e i test E2E non sono certificati qui.
- Vercel config generata in modalità `staging` con gli header `noindex` e la
  sola origine Supabase development autorizzata.

## Recupero SQL autorevole (nessuna migrazione applicata)

Prerequisiti: `psql` e una connection string PostgreSQL **solo del progetto
Supabase development**, impostata esclusivamente nell'ambiente dell'operatore o
in un secret protetto. **Non salvarla in file o variabili `VITE_*`.**

```bash
export SUPABASE_DB_URL='postgresql://...'
node scripts/reconcile-migrations.mjs --dry-run
# Esamina il numero di file mancanti e conferma il progetto di destinazione.
node scripts/reconcile-migrations.mjs --write
npm run check:migrations
unset SUPABASE_DB_URL
```

Lo script legge `supabase_migrations.schema_migrations`, confronta SHA-256 di
**tutte** le migrazioni già presenti e interrompe l'operazione se rileva SQL
modificato, nomi/versioni divergenti o duplicati. Recupera solo i file SQL
mancanti e aggiorna il manifest. **Non esegue SQL sul database**. Non si devono
modificare le versioni già applicate né usare il progetto di produzione.

Il test isolato `node scripts/check-migration-recovery.mjs` deve passare.
Questo test non sostituisce il recupero reale delle 323 versioni mancanti.

## Staging Vercel

Usa un **repository Git privato dedicato**, non `gestioneRistorante` che è
pubblico. Vedi `hosting/README.md` per le variabili Vercel e le regole CORS.

`vercel.json` è generato per la singola installazione di sviluppo e contiene
solo origini pubbliche; non deve essere riutilizzato per un altro ristorante.
L'hosting deve distribuire `dist/site/`, con `/staff/` isolato e HTTPS valido.
Esegui in CI GitHub con Node 24, `npm ci`, build Vite, query read-only della
cronologia Supabase e controllo HTTP vero `npm run check:staging-http`.

## Criteri di rilascio

Bloccare il rilascio se manca anche uno solo tra: riconciliazione completa,
compilazione Node 24, test E2E browser+Supabase (CORS, prenotazioni, caparre,
idempotenza), audit WCAG/SEO/performance, controllo degli header HTTP reali,
test pagamento sandbox e ripristino backup, verifiche autorizzazioni RLS,
controlli di sicurezza ancora aperti, dossier e tre revisioni integrali
pulite. Non sostituire evidenze remote con fixture locali.
