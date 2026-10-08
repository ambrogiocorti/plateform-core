# Plateform

Gestionale ristorazione con sito pubblico e area staff separate. TypeScript vanilla,
Vite e Supabase. Una sola catena per installazione, mono-sede di default.

**Sviluppo in corso. Non pronto per produzione.** Stato, verifiche e requisiti ancora aperti:
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).
La Roadmap e il registro degli step sono in `docs/ROADMAP.txt` e `docs/ROADMAP_STATUS.json`.
Le verifiche reali delle fondamenta sono documentate in `docs/STEP_0_VERIFICATION.md`.
La specifica completa resta [MASTER_PROMPT_PLATEFORM_COMMERCIALE.md](MASTER_PROMPT_PLATEFORM_COMMERCIALE.md).

## Prerequisiti

- Node.js 24.13 o successivo, npm.
- Progetto Supabase di sviluppo, oppure Supabase CLI con Docker per lo stack locale.
- Progetti e credenziali distinti per staging e production.

## Sviluppo

```sh
npm ci
```

Copia `.env.example` in `.env` e configura URL pubblico/staff, URL Supabase e chiave
publishable/anon. Le chiavi service role e dei provider devono restare sul server.

```sh
npm run dev:public
npm run dev:staff
```

Pubblico: `http://localhost:5173`. Staff: `http://localhost:5174`.
Senza configurazione il sito mostra indisponibilità e il gestionale richiede setup:
non esistono account dimostrativi o dati simulati nell'applicazione.

## Database e setup

Le migrazioni ordinate sono in `supabase/migrations`; applicarle soltanto a un ambiente
di sviluppo durante l'implementazione. Le migrazioni applicate sono immutabili;
le correzioni richiedono nuovi file e l'aggiornamento del manifest delle versioni.

Con Supabase CLI e Docker: `supabase start` e `supabase db reset` per un database locale
**sacrificabile**. Non eseguire reset su database contenenti dati da conservare.

Per il primo account tecnico imposta nell'ambiente del processo:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`,
`BOOTSTRAP_NAME`, quindi esegui `node scripts/bootstrap.mjs`.
Lo script non stampa password o chiavi. Rimuovi i segreti dall'ambiente al termine.
Accedi al dominio staff, configura TOTP e crea profilo ristorante e prima sede.
Il bootstrap database impedisce la creazione di altri tecnici con questa procedura.

Edge Functions presenti: `reservation`, `customer-session`, `step-up`, `staff-admin`,
`payments`, `stripe-webhook`, `satispay-callback`, `offline-authorization`,
`asset-upload`, `health-probe`, `print-authorization`, `maintenance`.
Richiedono i segreti server Supabase, `RATE_LIMIT_SECRET`, `ALLOWED_ORIGINS`
(origini esatte separate da virgola) e `TRUSTED_CLIENT_IP_HEADER`. Sul percorso Supabase
ospitato è configurato `cf-connecting-ip`, verificato con richieste HTTP contraffatte.
Non considerare attendibile `x-forwarded-for` senza un contratto proxy collaudato.

## Verifiche locali

```sh
npm run check
npm run format:check
npm exec playwright -- install chromium
npm run test:e2e
```

`npm test` esegue test di dominio e PostgreSQL incorporato con PGlite.
`npm run test:e2e` avvia i due ingressi Vite e test browser con fixture HTTP esplicite.
Auth/TOTP live, Storage, Realtime, gateway e provider richiedono test d'integrazione
aggiuntivi. Nessuna di queste verifiche viene dichiarata eseguita dai test con fixture.

`npm run requirements` fallisce finché non sono verificate tutte le sezioni del master.
Questo fallimento è intenzionale durante lo sviluppo e impedisce una dichiarazione di completezza.

## Build

`dist/public` e `dist/staff` sono artefatti separati per i due host, senza source map
pubbliche. Le due PWA e un workflow CI sono presenti. Il progetto non è stato pubblicato né il
workflow eseguito su GitHub. Configurazione di hosting, integrazioni reali e procedure
di recovery restano gate aperti; vedere il registro di implementazione.

## Progettazione e revisioni

- [ARCHITECTURE.md](ARCHITECTURE.md): 18 elaborati preliminari.
- [docs/REQUIREMENTS.json](docs/REQUIREMENTS.json): tracciabilità §§0–150.
- [docs/REVIEWS.md](docs/REVIEWS.md): registro revisioni complete; attualmente 0/3.
- [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md): evidenze e attività aperte.

## Moduli aggiunti durante il completamento

Pianta operativa e editor sala, booking/form builder, catalogo e assegnazioni,
rettifiche/trasferimenti conti, quote uguali, provider server, print job e bridge locale,
notifiche persistenti con badge/audio, offline cifrato e firmato, conflitti, impersonazione,
licenze/limiti, salute/incidenti, analytics aggregate, branding/Storage e privacy prenotazioni.
Le funzioni presenti richiedono ancora verifica puntuale contro tutti i requisiti del master.

Backup/restore eseguibili e dismissione protetta restano incompleti. Non sono offerti
come funzionalità già operative. `BACKUP_RESTORE.md` descrive le dipendenze mancanti.

`npm run release:zip` crea l’archivio commerciale soltanto dopo il controllo dei requisiti,
collaudi reali e tre revisioni integrali sullo stesso digest. Attualmente fallisce intenzionalmente.
Il checkpoint di sviluppo non costituisce una release vendibile.

## Documentazione operativa

- `DATABASE.md`, `SECURITY.md`, `AUDIT.md`: invarianti, privilegi e storico.
- `PRIVACY.md`, `OFFLINE.md`, `OBSERVABILITY.md`: dati, dispositivi e misure.
- `DEPLOYMENT.md`, `OPERATIONS.md`, `RUNBOOK.md`: installazione e servizio.
- `BACKUP_RESTORE.md`, `INCIDENT_RESPONSE.md`: recovery e gestione incidenti, con lacune esplicite.
- `TESTING.md`, `CHANGELOG.md`: verifiche, limiti delle evidenze e cambiamenti.
- `tools/print-bridge/README.md`: configurazione HTTPS, firme e gestione degli esiti incerti.
