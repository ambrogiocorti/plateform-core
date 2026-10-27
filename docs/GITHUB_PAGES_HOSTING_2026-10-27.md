# Plateform su GitHub Pages — configurazione candidata

Il frontend pubblico e quello staff di Plateform possono essere serviti come
file statici da GitHub Pages. **GitHub Pages non esegue PostgreSQL, Supabase
Edge Functions, servizi di stampa, worker di backup, Stripe webhook o cron**:
questi rimangono servizi backend separati, con HTTPS e relativi controlli.

## Architettura e limite di origine

Il bundle esistente `npm run build:pages` genera `dist/site/`, contenente il
portale pubblico, `/staff/`, le pagine prerenderizzate, una fallback `404.html`
per le deep-link SPA e `.nojekyll`. Usa percorsi assoluti come `/staff`:
**la URL di progetto `https://ambrogiocorti.github.io/plateform-core/` non è
attualmente supportata**. Per questa repository serve un dominio personalizzato
con origine root, ad esempio `https://ristorante.example.org` (solo esempio;
non impostarlo come dominio reale). Il dominio deve essere configurato in
Settings > Pages e nei DNS con HTTPS verificato; il file `CNAME` incluso nel
bundle non sostituisce tale configurazione (nei workflow personalizzati
GitHub Pages lo ignora).

GitHub Pages **non interpreta** `vercel.json` né le istruzioni di header
`_headers` incluse nel bundle. Header come Content-Security-Policy,
Cache-Control, HSTS, `frame-ancestors` e `no-store` richiesti dal progetto
vanno verificati su HTTP reale: se non possono essere garantiti da GitHub
Pages, prima del go-live servirà uno strato HTTPS/CDN che li imposti. In
particolare non trattare il fallback `404.html` come rewrite HTTP 200;
verificare il comportamento di deep-link, PWA e SEO su dispositivi reali.

## Workflow di revisione, senza messa online

`.github/workflows/plateform-github-pages.yml` si avvia **solo manualmente**:

1. In GitHub, configurare un ambiente `staging` con
   `STAGING_SUPABASE_URL` (variabile) e
   `STAGING_SUPABASE_PUBLISHABLE_KEY` (secret; è una chiave pubblicabile,
   **mai una secret/service_role**).
2. Da Actions, selezionare il branch candidato, il workflow
   **Plateform GitHub Pages candidate**, `site_origin` HTTPS root del
   dominio desiderato e lasciare **`publish_after_approval: false`**.
3. Il job controlla origine e credenziali, installa con `npm ci`, verifica
   formattazione, audit delle dipendenze, integrità migrazioni, test unitari e
   database, quindi costruisce `dist/site`.
4. Il bundle risultante resta un artifact scaricabile in Actions; **non si
   verifica alcuna pubblicazione automatica e non si aggiorna produzione**.

## Per una futura pubblicazione dopo collaudo

- Eseguire su staging HTTPS reale i test browser/multidispositivo, accessi
  autorizzati, CORS, Auth redirect, token di prenotazione, PWA, rate limit,
  disponibilità runtime Edge, pagamenti in sandbox e test backup/restore.
- Risolvere e applicare su un database di **staging** le migrazioni con
  preflight e backup, poi approvare esplicitamente il passaggio a produzione.
- Configurare repository **Settings > Pages > Build and deployment > GitHub
  Actions**, DNS e custom domain. Proteggere l'ambiente `github-pages` con
  reviewer e limitazione a `main`.
- **Solo dopo autorizzazione esplicita**, eseguire il workflow da `main` con
  `publish_after_approval: true`. Il job `deploy` è impossibile sui feature
  branch e non parte al normale push/PR.

Il workflow attuale non sostituisce l'approvazione del collaudo né i processi
backend. Per la pubblicazione automatica di tutte le risorse commerciali
servono inoltre configurazioni DNS e host dedicati per ogni installazione.
