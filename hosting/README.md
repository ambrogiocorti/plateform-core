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
