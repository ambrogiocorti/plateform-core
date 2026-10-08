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
