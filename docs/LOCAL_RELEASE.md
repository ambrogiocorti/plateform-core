# Plateform — verifica e utilizzo locale

Questa è la procedura da usare **prima di GitHub**. La release locale usa il progetto Supabase development già configurato e mantiene separati i gate automatici dai collaudi che richiedono browser/hardware reali.

## 1. Prerequisiti

- Node.js **>= 24.13.0** (la versione attesa è anche in `.node-version` e `.nvmrc`).
- npm e accesso al registry per eseguire una installazione pulita dal `package-lock.json`.
- Chromium per Playwright (`npx playwright install chromium`) oppure `PLAYWRIGHT_CHROMIUM_EXECUTABLE` verso un Chromium compatibile.
- Un file `.env.local` derivato da `.env.example`, con URL/chiave **publishable** del Supabase development. Non inserire mai service-role, provider secret, private key o webhook secret in variabili `VITE_*`.

Installazione pulita:

```bash
npm ci
npm run local:preflight
```

Il preflight fallisce se Node è troppo vecchio, manca il binding nativo Vite/Rolldown della macchina, manca la configurazione browser o un segreto server è stato esposto con prefisso `VITE_`.

## Avvio rapido su Windows 11

Nella radice della Local RC sono presenti due launcher:

1. `SETUP_LOCALE_WINDOWS.cmd` — controlla Node >= 24.13.0, esegue `npm ci` e crea `.env.local` se manca.
2. Dopo aver valorizzato `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local`, eseguire `AVVIA_PLATEFORM_WINDOWS.cmd`. Il launcher esegue il preflight, apre due terminali separati e apre automaticamente pubblico (`http://localhost:5173`) e staff (`http://localhost:5174`).

Il setup PowerShell supporta anche configurazione non interattiva:

```powershell
.\scripts\setup-local-windows.ps1 -SupabaseUrl "https://<project>.supabase.co" -PublishableKey "<publishable-key>"
```

I launcher non memorizzano service-role, provider secret o chiavi private. `.env.local` resta escluso dagli archivi RC.

## 2. Gate sorgente

```bash
npm run local:source-gates
```

Comprende migrations, resi STEP 7, PWA/offline STEP 8, Room Editor STEP 9, isolamento multi-sede STEP 10, sito pubblico STEP 11, continuity STEP 12, TypeScript, ESLint e Prettier.

## 3. Gate automatico completo

```bash
npm run local:verify
```

Aggiunge Edge checks/tests, suite Vitest/PGlite e build Vite reale public + staff.

## 4. Browser

Prima installare Chromium, poi:

```bash
npx playwright install chromium
npm run local:browser
```

Per eseguire tutto in sequenza:

```bash
npm run local:full
```

I server browser di test usano `http://localhost:5173` per il pubblico e `http://localhost:5174` per lo staff.

## 5. Avvio manuale per i test dell'utente

Con `.env.local` configurato:

```bash
npm run dev:public
```

in un terminale e:

```bash
npm run dev:staff
```

in un secondo terminale.

Aprire quindi `http://localhost:5173` e `http://localhost:5174`.

## 6. Gate che richiedono ancora prova reale

- Satispay sandbox quando arrivano le credenziali provider.
- Epson/print bridge con hardware reale e recovery stampante offline.
- PWA install/update e `online → offline → online` nel browser della release locale.
- Room Editor pointer/visual regression nel browser reale.
- Multi-sede via REST, WebSocket Realtime e download Storage privato.
- Asset upload autenticato, WCAG AA e Web Vitals sul sito pubblico.
- Backup + restore su continuity host indipendente e misura RPO/RTO.

Questi controlli non possono essere marcati `PASSED` soltanto perché l'ambiente di test non è disponibile.
