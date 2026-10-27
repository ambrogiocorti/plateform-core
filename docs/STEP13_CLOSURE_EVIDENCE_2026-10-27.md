# Plateform — audit di chiusura tecnica del 27 ottobre 2026

## Decisione

**Core applicativo e suite E2E integrata: PASS. Rilascio commerciale: NO-GO.**

Questo rapporto descrive ciò che è stato verificato realmente, i limiti della prova e
i requisiti residui del Master Prompt/Step 12–13. Non sostituisce il dossier delle
tre revisioni integrali e non autorizza merge su `main` né modifiche a Production.

## Regressione completa senza simulazioni del database o dello Storage

Eseguita la suite `playwright.live.config.ts` con PostgreSQL 18, GoTrue
reale, PostgREST, Edge Functions Deno, Chromium headless e immagine Docker
`supabase/storage-api:v1.28.0` con backend file. Ambiente **usa e getta**,
senza credenziali o dati dei progetti hosted.

- **39/39 PASS, 0 FAIL, 0 SKIP**, su **16 file `.spec.ts`** eseguiti in
  **quattro processi Playwright consecutivi** per contenere la memoria:
  `14 + 5 + 9 + 11 = 39`.
- **496 migrazioni** applicate alla base PostgreSQL usa e getta.
- Auth JWT/server-side, autorizzazioni di ruolo, idempotenza, prenotazioni
  singole e di gruppo, caparre in modalità mock provider, sala, cucina, pass,
  cassa, offline, PWA e retry, stampa, accessibilità e sito pubblico.
- **Storage reale**: upload logo/galleria e immagine piatto, accessi
  non autorizzati, archivio audit e prova di manomissione verificati.
- Worker HTTP protetti (negazione senza token) e worker di messaggistica
  esercitati con **adapter `dry_run`**: non viene inviato alcun messaggio
  a servizi terzi.
- Nessun pagamento Stripe/Satispay effettivo né collaudo di stampanti,
  telefoni o reti reali: queste evidenze **non** possono essere dedotte
  dai test isolati.
- Il primo tentativo monolitico del giorno precedente era interrotto per
  OOM (`oom_kill=1`): la suddivisione ora evita l'accumulo di memoria
  tra file senza escludere alcuno scenario.

Per ripetere integralmente su host Linux con Docker e PostgreSQL:

```bash
npm ci
npx playwright install --with-deps chromium
E2E_STORAGE=required E2E_POSTGRES_BIN=/usr/lib/postgresql/18/bin npm run test:e2e:live
```

Il comando avvia lo stack isolato, fallisce subito se Docker/Storage non è
disponibile, richiede listener Edge effettivi ed esegue tutti i file in batch.
Non puntare mai questo stack a Staging o Production.

## Hosted Staging e sicurezza

- Supabase Staging e Production espongono le stesse **496 versioni/nome**
  di migrazione storica e 21 Edge Functions; ciò non certifica la perfetta
  parità di segreti, dati o Storage.
- Preflight CORS dalla Vercel Preview a Staging: **10/10 HTTP 204** e
  `Access-Control-Allow-Origin` esatto.
- Negazione HTTP non autenticata su funzioni protette: **12/12 HTTP 401**.
- La Preview più recente verificata su Vercel è READY, ma protetta da SSO:
  lo smoke HTTP anonimo risponde 302 verso l'autenticazione Vercel.
  Non dichiarare quindi superati i test hosted autenticati o del routing
  finché non vengono eseguiti con accesso autorizzato.
- La workflow `.github/workflows/staging-readiness.yml` richiede ora
  `E2E_STORAGE=required`, test HTTP CORS/negazione e suite reale a batch.
  La sua esecuzione completa GitHub Actions resta da certificare.

## Backup e disaster recovery: blocco sostanziale

Audit read-only su Supabase hosted, **27 ottobre 2026**:

| Ambiente   | Backup QUEUED | Backup con integrità verificata | Restore completati |
| ---------- | ------------: | ------------------------------: | -----------------: |
| Staging    |             1 |                               0 |                  0 |
| Production |             2 |                               0 |                  0 |

Non risultano heartbeat recenti del worker backup esterno. Production
non ha ancora bucket di archivio/replica continuità allineati a Staging.
I backup sono quindi **richiesti ma non prodotti**, non «attivi».

La repository contiene il worker operativo
`tools/backup-worker/start.mjs`, il doctor e gli script systemd
(`deploy/continuity/README.md`), ma non è stato collegato un host
**sempre attivo con dischi persistenti indipendenti** e i necessari
segreti server-side. Una Vercel Sandbox temporanea **non è** un host
di backup affidabile, non preserva adeguatamente la replica off-site
e non può fornire evidenza di RPO/RTO garantiti.

Per concludere lo Step 12 servono:

1. host Linux continuo separato, replica indipendente e segreti inseriti
   tramite canale riservato: DB URL, server key, chiave AES-256;
2. `npm run continuity:host-check`, `npm run backup:check`,
   timer e job `backup:once` realmente attivi;
3. backup con Auth, DB, Storage, manifest HMAC, hash verificati e
   replica off-site, registrato `SUCCEEDED`;
4. restore **reale** del backup recente su target Supabase nuovo,
   isolato e temporaneo, seguito da test di RPO/RTO e di accessi;
5. stessa copertura per Production prima del traffico clienti.

## Decisione finale / divieti

**NO-GO per uso commerciale e dati di clienti reali** fino a backup+restore
dimostrati, test HTTPS hosted con ruoli autenticati, provider Stripe/Satispay
in sandbox, periferiche/dispositivi reali e tre revisioni integrali.
`npm run release:check` deve restare bloccante.

Nessun merge in `main` e nessuna migrazione o modifica di backup ai
progetti Supabase Production sono stati effettuati.
