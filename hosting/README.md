# Header e routing di Plateform

Ogni build configurata genera `security-headers.json` e `_headers` per entrambe le aree.
Una build locale senza configurazione genera `DEPLOYMENT_UNCONFIGURED.txt` e non è distribuibile.
Staging e production richiedono HTTPS, una chiave publishable oppure una JWT anon,
URL privi di credenziali/query/frammenti e separazione del percorso staff.

Struttura primaria: pubblico su `/`, staff su `/staff/` della stessa origine.
È supportata anche la separazione su due origini configurate, con due artefatti distinti.
Il server deve inoltrare le route pubbliche a `dist/public/index.html` e quelle staff
a `dist/staff/index.html`, preservando percorso e query. Asset e service worker non vanno
inoltrati al fallback HTML; un asset inesistente deve produrre 404.

`_headers` è utilizzabile solo da un host che supporta questo formato. Per altri server
importare i valori di `security-headers.json` nella configurazione effettiva e collaudarli
con richieste HTTP reali. La semplice presenza del file non applica gli header.
GitHub Pages non applica questo formato: richiede un livello di hosting/proxy che lo faccia
prima di poter superare il gate di sicurezza commerciale.

`VITE_IMAGE_ORIGINS` e `VITE_CONNECT_ORIGINS` sono liste di origini HTTPS esatte separate
da virgole. Servono rispettivamente per fotografie esterne e bridge/provider autorizzati.
Non sono ammessi wildcard, credenziali o URL con percorso. Il browser usa Supabase come
backend; i segreti dei pagamenti restano nelle Edge Functions.

La CSP consente gli stili inline usati da branding e editor sala; gli script inline e
`eval` sono vietati. Gli upload SVG non fidati non fanno parte dei formati consentiti.
Mantenere pubbliche solo le immagini autorizzate e servire i documenti riservati attraverso
Storage protetto. Lo staff riceve inoltre `X-Robots-Tag: noindex, nofollow`.

Verificare prima del go-live: CSP effettiva, HTTPS/HSTS, fallback corretto, cache separate,
Auth redirect esatti, origini CORS e contratti del gateway per l'indirizzo client.


## Step 11 — SEO con rendering pubblico statico

Per distribuire anche il sito prerenderizzato, usare `npm run build:pages` con
`PUBLIC_SITE_ORIGIN`, `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`
esportati come variabili dell'ambiente di build. `PUBLIC_SITE_ORIGIN` deve essere
l'origine HTTPS effettiva (senza slash finale, path, query o frammento), identica
alla `public_base_url` validata sul progetto Supabase.

La build interroga solo RPC pubbliche (`get_public_site`, `get_public_sitemap_entries`,
`get_public_page_metadata`, `get_public_menu`, `get_public_menu_by_slug`). Se
non riesce a validare il dominio, la chiave pubblica o una route, si interrompe;
non sono ammesse chiavi segrete, service-role o contenuti simulati. In ambiente
non indicizzabile produce solo una home `noindex` e un `robots.txt` restrittivo,
senza sitemap. Non confondere questi file con gli header HTTP effettivamente
applicati dall'hosting: i controlli HTTP restano obbligatori.

Il fallback SPA, il service worker e la route `/staff/` devono essere verificati
sull'host scelto. Il prerender HTML non effettua prenotazioni e non contiene dati
personali o credenziali. In fase di deploy ricostruire i file da RPC anonime;
non riutilizzare HTML prodotto per un altro ristorante o una diversa versione.

## Vercel staging — configurazione controllata

`vercel.json` e `scripts/vercel-configuration.mjs` preparano un deployment statico
con frontend `/`, staff `/staff/` e rewrites limitati alle sole route valide.
I file JS/CSS mancanti NON ricadono su un fallback HTML. La CSP limita
connessioni/API al progetto Supabase indicato nella configurazione dello staging.
Gli header dello staging includono `X-Robots-Tag: noindex, nofollow`.

**Prima del collegamento al repository e del deployment:**

1. Crea un progetto **Vercel privato di staging** collegato a un repository
   Git privato contenente il progetto integrato. Imposta Node.js 24.x.
2. Prima del push, se il backend cambia, rigenera e verifica `vercel.json`:
   `VITE_SUPABASE_URL=https://<project-ref>.supabase.co node scripts/generate-vercel-config.mjs`
   e `npm run check:step11-deploy-config`. Usa soltanto chiavi **publishable**
   nelle variabili `VITE_*`: mai `service_role`, Stripe secret o credenziali DB.
3. Configura `VITE_ENVIRONMENT=staging`, `VITE_PUBLIC_BASE_URL`,
   `VITE_STAFF_BASE_URL=<origin>/staff`, `PUBLIC_SITE_ORIGIN=<origin>`,
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` e `VITE_RELEASE_VERSION`.
   Vercel deve usare `npm ci` e `npm run build:pages` come da `vercel.json`.
4. Configura l'origine staging anche nell'allowlist `ALLOWED_ORIGINS` delle
   Edge Functions. Verifica auth redirects, servizi prenotabili, privacy e
   attivazione del sito sul backend di sviluppo, non produzione.
5. Dopo un deployment completo, esegui la pipeline manuale
   `.github/workflows/staging-readiness.yml`, con le variabili GitHub
   `STAGING_SUPABASE_URL` e il secret `STAGING_SUPABASE_PUBLISHABLE_KEY`.
   Il collaudo HTTP read-only verifica home, menu, staff, CSP, SSL/HSTS, noindex,
   robots.txt, mancanza di sitemap indicizzabile e 404 degli asset inesistenti.
6. **Non** rendere pubblica la versione commerciale per la vendita finché
   `npm run release:check`, integrazioni reali e 3 revisioni complete
   consecutive non sono passati. Il test HTTP NON verifica pagamenti o restore.

Il progetto staging può restare `noindex` su un dominio Vercel temporaneo. Per
la futura produzione l'indicizzazione e i domini dei singoli clienti devono
essere rigenerati usando il proprio backend isolato, non riutilizzando questa
configurazione di sviluppo.
