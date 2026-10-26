# Plateform — verifica del candidato PR #49 (26 ottobre 2026)

**Ramo:** `plateform/gpt6-prerender-preview-resilience-20261026` sopra `plateform/steps-7-12-completion-y2bvpd` (PR #48).  
**Target:** build Vercel Preview e gate sorgente Step 11; non un ambiente production.  
**Esecutore:** Vercel Sandbox temporanea in `fra1`, Node.js 24.22.1, repository pubblico clonato dal commit `ad6d0ed` e correzioni riprodotte nella workspace prima del commit GitHub.

## Problemi trovati e correzioni

1. **Deployment Vercel non riproducibile** — build precedente `dpl_BJ2VHmzAixR71jRG8ZwcKxtfn9EX` fallisce durante il prerender del sito per `ENOTFOUND abdxvlykasqmknexxhjo.supabase.co`. Il backend Development va verificato separatamente e non può essere sostituito con credenziali arbitrarie.
2. **Prerender parziale** — `build-site.mjs` ora genera le pagine in una cartella temporanea e la promuove soltanto quando il processo termina correttamente. In Preview, esclusivamente per un errore di connessione reale, mantiene una shell client-side non indicizzabile senza sitemap; errori HTTP, payload invalidi e build production restano bloccanti.
3. **Formattazione e import Node** — corretta la formattazione Prettier di `check-step11-prerender.mjs`; `check-step11-public-runtime.mjs` carica una copia temporanea dell'implementazione TypeScript reale con import compatibili con Node 24 e sostituzione della costante di build Vite; `check-step11-build-assembly.mjs` include nella fixture il nuovo helper importato da `build-site.mjs`.
4. **Dipendenza vulnerabile** — il gate `report-dependency-audit.mjs` rifiutava `zod@4.6.5` per una vulnerabilità alta. Aggiornati il pin `zod@4.6.7` e il lockfile, preservando le altre versioni. Il successivo audit npm ha riportato zero vulnerabilità di gravità alta o critica.

## Verifiche effettivamente eseguite

| Prova | Esito | Perimetro |
|---|---|---|
| `npm ci --no-audit --no-fund` | PASS | Dipendenze installate nel sandbox |
| `npm run check:step11-prerender` | PASS — 39 asserzioni | Includes condizione di fallback e promozione atomica |
| `npm run check:step11-runtime` | PASS | Routing pubblico e 13 asserzioni telemetria |
| `npm run check:step11-build-assembly` | PASS — 16 asserzioni | Assemblaggio in temp con transport RPC isolato |
| `npm run local:source-gates` | PASS | Inclusi check migrazioni, UX, steps 7–12, TypeScript, lint, Prettier |
| `npm run check:edge` | PASS | Check sorgenti Edge Functions |
| `npm run test:edge` | PASS — 74/74 | Deno test provider/worker |
| `npm test` | PASS — 339/339 | 41 file Vitest unit/database PGlite |
| `npm run build` | PASS | Build Vite public/staff |
| `node scripts/report-dependency-audit.mjs` | PASS — high=0, critical=0 | npm audit, dopo aggiornamento Zod |
| `npm run build:pages` con backend inesistente e `VERCEL_ENV=preview` | PASS | Pipeline completa; robots Disallow /, nessuna sitemap, shell client non prerenderizzata |
| `node scripts/build-site.mjs` con lo stesso backend inesistente e `VERCEL_ENV=production` | FAIL atteso — `ENOTFOUND` | Fail-closed in produzione confermato |

La build Preview è stata verificata con valori di configurazione **di test**, senza segreti e senza chiamare alcun progetto cliente. Il PASS indica soltanto che la shell di anteprima è pubblicabile in sicurezza, non che il frontend possa servire ordini senza backend.

## Lacune ancora aperte

- Il connettore Supabase della sessione restituisce `link_id must identify an eligible linked account`; non è stato possibile leggere o modificare Development o Staging.
- L'account Free Vercel rifiuta un nuovo deployment API con quota giornaliera superata (HTTP 402). I test elencati sono stati eseguiti nella sandbox, **non** su un nuovo hostname pubblico Vercel.
- Non ancora eseguiti in questa verifica: Playwright browser completo, E2E hosted Supabase con ruoli reali, Stripe/Satispay, recovery del backup su target indipendente, hardware/stampanti e revisioni integrali finali.
- Le PR #48 e #49 rimangono separate e draft; nessun merge in `main` o rilascio production.

**Decisione: IN PROGRESS / NO-GO.** Non cambiare il gate commerciale sulla base delle sole suite locali.
