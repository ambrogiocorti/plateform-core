# Plateform · GitHub Pages — test e installazione commerciale

## Decisione di hosting (27 ottobre 2026)
- **A, test:** `https://ambrogiocorti.github.io/plateform-core/` con prefisso
  `/plateform-core/`, variabile `PAGES_MODE=test`, Supabase **STAGING**
  isolato. Nessuna indicizzazione, sitemap commerciale o CNAME.
- **B, vendita:** dominio HTTPS root del singolo ristorante, ad esempio
  `https://ristorante.example.org/`, con `PAGES_MODE=commercial`.
  Ogni ristorante/catena deve avere il proprio progetto Supabase e ciclo di
  pubblicazione, nel rispetto del Master Prompt.

Il codice rimane su GitHub; **GitHub Pages esegue soltanto il frontend statico**.
Auth, database, RLS, Realtime, Edge Functions, webhooks e backup devono restare
sull'infrastruttura server sicura (Supabase/provider). Non utilizzare dati di
produzione nella modalità test.

## Modifica effettiva
- Vite usa la pathname di `VITE_PUBLIC_BASE_URL` e `VITE_STAFF_BASE_URL` per
  asset, manifest e service worker; il router pubblico converte tra pathname
  reali e rotte applicative, senza intercettare /staff o pagine sconosciute.
- I link generati dal frontend pubblico sono prefissati, anche quando aperti
  in una nuova scheda. Il fallback 404 conserva il percorso richiesto e
  ritorna alla base pubblica/staff corretta; i token del link lista d'attesa
  restano nel fragment, non nella query.
- Il bundle in modalità test non genera sitemap/canonical e mantiene
  `robots.txt` con `Disallow: /`; neppure i meta tag e la telemetria
  dinamici potranno trasformarlo in un sito pubblico indicizzabile.
- La build commerciale continua a fallire senza metadata pubblici verificati
  tramite RPC; test in browser reali ancora obbligatorio.

## GitHub Actions

Il workflow `.github/workflows/plateform-github-pages.yml` viene eseguito
al push **del solo branch candidato** per generare un artifact, oppure
manualmente via `workflow_dispatch` **quando il workflow sarà presente sul
branch predefinito**. Nessun push avvia il deploy.

Ambienti GitHub da preparare in `Settings > Environments`:
- `staging` (solo Supabase di prova): variable `SUPABASE_URL` e secret
  `SUPABASE_PUBLISHABLE_KEY` (key pubblicabile, MAI `service_role`).
- `production` (solo dopo approvazione del go-live): stessi nomi,
  riferiti a un progetto Supabase di produzione isolato; reviewer obbligatorio.
- `github-pages`: reviewers e protezione dell'ambiente; imposta
  `Settings > Pages > Build and deployment > GitHub Actions`.

Per ottenere il candidato A: selezionare `pages_mode=test` e lasciare
`publish_after_approval=false`. Il job deve produrre `dist/site` e
un artifact scaricabile; non pubblica il sito. Un'eventuale pubblicazione
di test richiede `workflow_dispatch`, consenso esplicito e
`publish_after_approval=true`; la sola presenza di un commit o PR non basta.

Per l'installazione B: `pages_mode=commercial` e
`site_origin=https://dominio-del-ristorante.it`, senza path e senza slash
finale. Serve `main`, env `production`, verifiche release e approvazione
esplicita: nessun rilascio commerciale dal feature branch.

## Attenzioni di sicurezza e limiti noti
- GitHub Pages ignora le regole di `vercel.json` e i file `_headers`; non è
  possibile assumere CSP/HSTS, `no-store`, isolamento delle sessioni o
  gli stessi status HTTP di uno static server configurabile.
- Le deep link della SPA recuperate tramite `404.html` rispondono prima con
  HTTP **404**, non con rewrite HTTP 200. Verificare QR, OAuth/redirect Auth,
  recovery, token sensibili, cookies, refresh, installazione PWA, cache e SEO.
- Non pubblicare la piattaforma commerciale se header e cache richiesti dal
  Threat Model non sono ottenibili; usare un host/reverse proxy che possa
  applicarli (GitHub può comunque conservare il codice e avviare il deploy).
- Prima del GO: reconcile SQL remoto/Git; audit e RLS; backup/restore fresco;
  Playwright e prove manuali mobile/staff/operazioni su staging HTTPS;
  pagamenti e stampanti fisiche se previste in licenza; test d'accessibilità.
- Il workflow GitHub Pages non distribuisce migrazioni o Edge Functions e non
  sostituisce le rispettive approvazioni di rilascio.

**Stato:** sviluppo sul branch PR #50, **NO-GO / nessun deploy automatico**.
