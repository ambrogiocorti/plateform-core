# Step 11 — Verifica del sorgente integrato (8 ottobre 2026)

**Stato: IN PROGRESS — non autorizza ZIP o rilascio commerciale.**

## Sorgente recuperato

- Origine: Library personale `Plateform_internal_checkpoint_step12_rehearsal_gate_2026-10-06.tar.gz` (checkpoint autorizzato, 593 membri).
- Contiene `apps/public`, `apps/staff`, `src`, Edge Functions, migrazioni, `package-lock.json`, script CI ed e2e.
- Base Git locale creata dopo il ripristino: non è il repository GitHub pubblicato.
- Inventario: **130 migrazioni SQL nel checkpoint**, **450 migrazioni applicate** a `plateform-development` alla verifica iniziale. Occorre riconciliare il delta e dimostrare riproducibilità in ambiente di staging prima di chiudere source-merge gate.

## Modifiche apportate nel checkpoint

- `src/pages/public-booking.ts`: disponibilità ottenuta dall'RPC server, invalidazione degli slot dopo cambio di servizio/data/persone; validazione delle risposte in base ai parametri; informativa privacy, stati `RESERVED`/`REQUESTED`/`PENDING_DEPOSIT`, passaggio protetto ai provider della caparra e nessun successo simulato dopo timeout.
- `src/pages/public-menu.ts`: indice menu pubblicati e pagina `/menu/{slug}` dai relativi payload RPC, mantenendo il menu legacy.
- `src/services/public-navigation.ts`: gestione menu accessibile, Escape, click esterno, focus e resize.
- `apps/public/main.ts`: impiego degli RPC e dei servizi recuperati; CTA prenotazioni nella home contestualizzata; indicizzazione client inizialmente noindex e poi allineata al backend.
- `scripts/prerender-public.mjs`: HTML editoriale prerenderizzato, sitemap e robots da RPC anonime con controllo di origine, rotte e chiavi; invocazione tramite `npm run build:pages` dopo build Vite.

## Verifiche realmente eseguite

- `node --experimental-strip-types scripts/check-step11-booking-client.mjs`: **19/19 asserzioni PASS**.
- `python scripts/check-step11-mobile-dom.py`: **7/7 asserzioni Chromium PASS**.
- `node scripts/check-step11-prerender.mjs`: **15/15 asserzioni PASS** su RPC simulate.
- `node scripts/check-step11-static.mjs`: PASS.
- `node --experimental-strip-types scripts/check-step11-public-runtime.mjs`: PASS.
- Sorgenti TypeScript aggiornati: parsing sintattico senza errori tramite TypeScript installato globalmente; **non equivale al typecheck integrale**.
- `npm ci --offline`: fallisce `ENOTCACHED` (manca pacchetto zod). `npm ping`: `EAI_AGAIN` su `registry.npmjs.org`; Node locale 22, mentre il progetto richiede Node >=24.13.

## Gate ancora aperti

- `STEP11_PUBLIC_SOURCE_MERGE`: checkpoint ripristinato ma migrazioni/posteriori non riconciliate e non pubblicato su repository autoritativo.
- `STEP11_PUBLIC_FRONTEND_BROWSER_E2E`: bundle Vite con dipendenze installate e browser HTTP reale non testati.
- `STEP11_PUBLIC_RESERVATION_E2E`: test transazionale reale Edge Function → database, CORS, retry e provider sandbox non eseguiti.
- `STEP11_PUBLIC_DOMAIN_DEPLOYMENT`: nessun dominio staging reale verificato; backend usa dominio `.example`.
- `STEP11_PUBLIC_SEO_A11Y_PERFORMANCE`: HTTP prerender, crawler/robots/404, WCAG AA e Core Web Vitals su sito distribuito non verificati.

## Condizione di chiusura

Non cambiare i gate PENDING in PASS per soli test mock, funzioni compilate o query backend. Eseguire l'integrazione in staging HTTPS con le vere credenziali **pubbliche**, test di prenotazione e caparra non distruttivi, audit a11y/performance, test di separazione staff e riallineamento delle migrazioni.
