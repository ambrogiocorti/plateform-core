# Step 11 — Preview resilienti a backend temporaneamente irraggiungibile

Data: 26 ottobre 2026. Branch: `plateform/gpt6-prerender-preview-resilience-20261026`.
Base: `plateform/steps-7-12-completion-y2bvpd` (PR #48, commit `2120108702facbc12c31c5ff964072974b37eba9`).

## Evidenza del problema

Il deployment Vercel `dpl_BJ2VHmzAixR71jRG8ZwcKxtfn9EX` ha eseguito i controlli statici
ma `npm run build:pages` è uscito con codice 1 dopo la build Vite:

```text
TypeError: fetch failed
getaddrinfo ENOTFOUND abdxvlykasqmknexxhjo.supabase.co
```

Il backend Development configurato nel progetto Vercel non è risolvibile al momento
della build. Questo **non dimostra** che il backend staging sia indisponibile e non
autorizza a sostituire URL o publishable key con valori non verificati.

## Correzione

- `scripts/build-site.mjs` prerenderizza in una directory temporanea e la promuove
  solo dopo il successo di tutte le RPC. Non può lasciare pagine prerenderizzate
  parziali quando la rete cade dopo la prima chiamata.
- Esclusivamente in Vercel **preview** (`VERCEL=1`, `VERCEL_ENV=preview`), un errore
  di connessione può lasciare la shell client-side con `robots.txt` che blocca
  l'indicizzazione e senza `sitemap.xml`. Un warning chiaro indica che il backend
  non è stato verificato.
- Errori HTTP, configurazioni mancanti, risposte malformate e tutte le build
  **production** o GitHub Pages continuano a fallire senza pubblicare un sito
  incompleto come release di produzione.
- `scripts/check-step11-prerender.mjs` verifica le condizioni di fallback e
  l'eliminazione della sitemap. I test del predicato sono stati riprodotti anche
  con Node.js 22 in ambiente isolato (7 asserzioni riuscite). L'intera pipeline
  Node 24/Vercel va verificata sul commit proposto.

## Gate ancora aperti

Questa modifica **non** riattiva il progetto Supabase Development, non convalida
Satispay/Stripe, non prova l'operatività di un ristorante e non concede un GO-LIVE.
Prima della pubblicazione operativa occorrono:

1. Connettere il deployment HTTPS a un progetto Supabase vivo e dedicato, con
   URL/publishable key corrispondenti e CSP che autorizzi solo tale progetto.
2. Eseguire il prerender reale con RPC anonime, controllando
   `robots.txt`, `sitemap.xml`, menu, prenotazioni e contenuti.
3. Rieseguire la matrice dei gate di rilascio sulla **stessa revisione**.
4. Eseguire backup e restore su installazioni isolate, insieme a prove su dispositivi
   e hardware previsti dalla release.

Stato: **IN PROGRESS / NO-GO**. Nessuna modifica production o Supabase in questo branch.
