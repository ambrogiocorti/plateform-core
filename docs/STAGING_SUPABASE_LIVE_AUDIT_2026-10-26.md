# Plateform — audit di collegamento Supabase e Staging

Data: 26 ottobre 2026. Ambiente di lavoro: branch
`plateform/gpt6-prerender-preview-resilience-20261026` (PR #49, sopra PR #48).

## Accesso e riconciliazione

L'account Supabase **Ambrogio** risulta nuovamente collegato al progetto.

- `plateform-development` (`abdxvlykasqmknexxhjo`): INACTIVE.
- `plateform-staging` (`qfgoatdabgnzozxuzxku`): ACTIVE_HEALTHY.
- `plateform-production` (`xzateqavvaparjoybbhr`): ACTIVE_HEALTHY.

Staging e Production registrano entrambe **496 migrazioni**, con le stesse
coppie di versione e nome; l'ultima è `20261021090000`. Il confronto
della sola cronologia non prova l'uguaglianza integrale di schema, dati,
Storage, Auth, secrets o configurazioni delle Edge Functions.

Su Staging: PostgreSQL 17.11, 122 tabelle `public`, 53 `private`,
347 funzioni `public`, 110 policy RLS `public`, 21 Edge Functions
in stato ACTIVE e sei bucket Storage. Sono presenti un ristorante, una sede
e fixture operative; non si tratta di un ambiente vuoto.

Su Production: 21 Edge Functions ACTIVE, ma soltanto quattro bucket
Storage. Rispetto a Staging mancano i bucket privati
`plateform-continuity-audit-archive` e
`plateform-continuity-audit-archive-replica`. La continuità e il
disaster recovery in Production NON sono certificati; evitare di
creare bucket senza aver verificato configurazione, replica e
procedure di restore.

## Test HTTP anonimi reali su Staging

Eseguiti con la **publishable key** di Staging (non salvata nel repository):

- `GET /auth/v1/settings` → HTTP 200.
- `POST /rest/v1/rpc/get_public_site` → HTTP 200, sito configurato.
- `POST /rest/v1/rpc/get_public_sitemap_entries` → HTTP 200,
  `indexable=false`, zero route da indicizzare.
- `GET /rest/v1/staff_profiles?select=id&limit=1` → HTTP 401: negato
  all'utente anonimo.

Sono smoke test mirati, **non** la matrice completa degli accessi JWT,
RLS, Storage, Auth MFA e dei ruoli operativi.

## Audit degli advisor Supabase

I rilievi Staging non sono stati corretti indiscriminatamente:

- Security: 66 casi INFO `rls_enabled_no_policy`, in prevalenza nello
  schema `private` o su tabelle senza accesso diretto.
- Security: 10 `SECURITY DEFINER` eseguibili da `anon`. Le firme
  corrispondono alle dieci RPC di lettura per sito, menu,
  prenotazioni e sitemap; vanno verificate le implementazioni, le
  autorizzazioni interne e i limiti di risorse, non revocate alla cieca.
- Security: 229 `SECURITY DEFINER` eseguibili da `authenticated`;
  superficie da riesaminare rispetto al manifest API e ai test JWT/RLS.
- Security: un WARN per leaked-password protection di Supabase Auth.
- Performance: 83 FK senza indice di copertura e 154 indici non
  utilizzati. Priorità da determinare tramite volumi e query plan.

Riferimenti: [Security Advisor](https://supabase.com/docs/guides/database/database-linter)
e [Protezione password compromesse](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Preview Vercel isolata

Create **otto variabili Vercel con target Preview e filtro Git branch**
esclusivamente su `plateform/gpt6-prerender-preview-resilience-20261026`.
Comprendono ambiente, URL del frontend, URL Supabase Staging,
publishable key, origine pubblica, versione e trust anchor offline.
L'anteprima imposta `VITE_OFFLINE_PUBLIC_KEYS_JWK=[]`: la modalità offline
è disabilitata per scelta di sicurezza finché la chiave pubblica della
firma Staging non viene verificata. Non è stata modificata nessuna
variabile globale Production.

La CSP `vercel.json` del branch autorizza solo
`https://qfgoatdabgnzozxuzxku.supabase.co` e il relativo WebSocket.
`scripts/build-site.mjs` rifiuta con
`VERCEL_CSP_BACKEND_ORIGIN_MISMATCH` le build Vercel i cui host CSP non
corrispondono al backend configurato. Il test isolato di assemblaggio
non eredita la variabile `VERCEL=1` dal runner.

## Risultato della build con backend reale

Nel sandbox Vercel, Node.js 24.22.1, sul commit `64ee0a2`:

- `npm run local:source-gates`: PASS.
- `npm run build:pages` con le configurazioni Preview e il backend
  Staging reale: PASS.
- HTML prerenderizzato: include **Trattoria E2E**.
- `robots.txt`: `Disallow: /`; `sitemap.xml`: assente.
- Nessun warning `PLATEFORM_PREVIEW_BACKEND_UNREACHABLE` in build.

Le build Git/Vercel degli ultimi commit sono limitate dalla quota Free
(`build-rate-limit`). Il risultato nel sandbox **non** certifica un
nuovo deployment HTTPS su Vercel.

## Stato commerciale

Il comando `npm run release:check` è stato eseguito e ha rifiutato
correttamente il rilascio per mancanza del dossier dei collaudi reali e
delle tre revisioni integrali.

**NO-GO.** Restano indispensabili le verifiche E2E hosted multi-ruolo,
i controlli negativi delle funzioni privilegiate, Stripe e Satispay
Sandbox, le prove di backup e restore indipendente, le attrezzature
reali, la configurazione Production isolata e le tre revisioni
integrali di release. Non modificare Production senza preflight,
piano di rollback e approvazione della pubblicazione commerciale.
