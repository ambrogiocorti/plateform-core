# Deployment e release

Versione corrente 0.1.0 di sviluppo. Il progetto Supabase development
`abdxvlykasqmknexxhjo` è attivo; le verifiche database di sicurezza e
regressione passano. **Lo storico SQL non è allineato** (456 migrazioni remote,
133 locali, sette divergenze non spiegabili soltanto con spazi ai margini):
vedere `docs/evidence/remote-migration-audit-2026-10-08.json`.
Auth e secrets development configurati e verificati nella dashboard autorizzata;
CORS, errori, diagnostica, telemetry e gateway/rate limiting collaudati via HTTP reale.
Vedere `docs/REMOTE_CONFIGURATION.md`.
Nessun host o ambiente production è stato distribuito. Release commerciale bloccata.
All'8 ottobre 2026 non risulta un progetto Vercel collegato. Node 24,
`npm ci`, l'ambiente staging HTTPS, i test JWT/browser reali e un restore della
versione corrente non sono ancora certificati. Il target restore-test esistente
non è vuoto; non deve essere azzerato senza esplicita autorizzazione e verifica.

## Ambienti

Un cliente/brand per progetto Supabase; development, staging e production separati con chiavi, bucket, account provider e domini distinti. Usare un progetto di sviluppo nuovo per i test iniziali. Conservare progetti/dati esistenti fino alla verifica di importazione e integrità.

Nel browser: URL Supabase e publishable/anon key, domini pubblico/staff, ambiente, versione e chiavi pubbliche offline. Nei segreti Edge: credenziali Supabase server, RATE_LIMIT_SECRET, ALLOWED_ORIGINS esatte, TRUSTED_CLIENT_IP_HEADER verificato; chiavi Stripe/Satispay e webhook quando abilitate; chiavi private offline/print; parametri telemetry e segreto del worker retention. Nessuna chiave server può avere prefisso VITE_.

## Sequenza per staging

1. Identificare progetto, regione, piano, domini e proprietari. Verificare che non contenga dati production.
2. Applicare le migrazioni SQL in ordine. Con CLI già autenticata, `supabase link --project-ref PROJECT_REF` e `supabase db push` agiscono sul progetto collegato: ricontrollare il riferimento prima di eseguirli. Il reset locale è ammesso soltanto su database sacrificabili.
3. Configurare segreti e distribuire le dodici Edge Functions con CLI/deployment dell’ambiente. `verify_jwt=false` è intenzionale per consentire i confini pubblici/webhook; gli handler privati verificano identità e RPC, non accettano richieste anonime per operazioni staff.
4. Eseguire bootstrap tecnico server, TOTP, setup installazione, Admin e configurazioni. Non creare account dimostrativi in production.
5. Eseguire build pubblico/staff con configurazione staging. Servire pubblico su `/` e staff su `/staff/` in HTTPS; sono supportate anche origini distinte configurate. I domini devono corrispondere a profilo, CORS e webhook configurati.
6. Applicare e verificare secure headers/CSP, redirect e fallback SPA. I template sono in `hosting`; adattare connect-src alle origini Supabase/Realtime/provider/stampa effettivamente usate. Non usare wildcard per risolvere problemi CORS.
7. Configurare callback/webhook provider e bridge locale. Attivare retention solo dopo la configurazione Admin e la verifica del worker. Configurare backup/ripristino prima del primo servizio reale.
8. Eseguire integrazione Supabase, multi-connessione, provider sandbox, stampa fisica, PWA/offline, accessibilità, carico e restore test. Registrare evidenze e difetti.

## Gate e pacchetto

`npm run local:source-gates` verifica i gate sorgente STEP 7–12 senza richiedere GitHub. `npm run local:verify` aggiunge Edge, Vitest e build Vite; `npm run local:browser` esegue Playwright; `npm run local:full` li concatena. `npm run check` resta il gate tecnico generale. GitHub/CI non sono richiesti per la fase di collaudo locale pre-GitHub.

`npm run release:check` richiede tutti gli step 0–13 DONE con evidenze e controlli passati, 151 sezioni VERIFIED, sei controlli locali passati, sette categorie di integrazione con evidenze e tre revisioni integrali pulite sullo stesso digest dei sorgenti. `npm run release:zip` chiama il gate anche nell’archiviatore, esclude segreti/cache/stato locale e crea un manifest SHA-256. Senza dossier `.local/release/evidence.json` valido non viene creato uno ZIP commerciale. Le evidenze devono essere reali; compilarle a mano non sostituisce i collaudi.

## Upgrade e rollback

Prima di upgrade: backup completo verificato, migrazioni provate su copia staging, compatibilità tra vecchio/nuovo client e schema, rilascio progressivo, controlli post-deploy. Una regressione frontend può consentire il ritorno alla build precedente solo se il relativo schema resta compatibile. Migrazioni distruttive o trasformazioni contabili richiedono una procedura specifica e restore collaudato; non esiste un rollback universale mediante `db reset`.

Fonti: [migrazioni Supabase](https://supabase.com/docs/guides/deployment/database-migrations), [deploy Edge](https://supabase.com/docs/guides/functions/deploy). Il piano completo di distribuzione commerciale/rollback resta da collaudare.

## Continuity worker host

Backup e restore non vengono eseguiti dal frontend né dalle Edge Functions. Prima del primo servizio reale predisporre un host continuity dedicato secondo `deploy/continuity/README.md`: Node >=24.13, Supabase CLI, PostgreSQL client, runtime container rootless/dedicato, secret server-side e volume backup persistente con copia separata/immutabile. Il timer può processare la coda backup; restore test e restore reale restano comandi one-shot su target distinti. Il deployment non è production-ready finché `continuity:host-check`, backup reale e restore test reale non passano.
