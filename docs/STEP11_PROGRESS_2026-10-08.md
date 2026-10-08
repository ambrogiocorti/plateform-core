# Plateform — Step 11 stabilization checkpoint (2026-10-08)

Status: **IN PROGRESS**. Do not release, market, or deploy to Production.

## Source changes

- Public booking now distinguishes the generic entry point from an explicit `?sede=` selection. Invalid, disabled or unknown explicit venue requests never fall back silently to a different venue.
- If online booking is not permitted at that venue, the customer sees a clear unavailable state; requests remain server-authoritative.
- Published menu canonical URLs preserve venue context, so menus with a shared slug but different venue configuration are not merged.
- Dynamic branding drops stale CSS variables and restores the default favicon when an Admin removes a customization. Removed hero imagery also removes stale `og:image` metadata.
- Existing public/staff route isolation and `/menu/:slug` telemetry are retained; Development Edge Function `public-telemetry` v3 was separately verified active.

## Remote SQL history inventory (read-only evidence)

Observed directly from **plateform-development**, Supabase project `abdxvlykasqmknexxhjo`:

- Remote count: **453**; total applied SQL bytes: **2,192,771**.
- First version: `20261003165439`; latest version: `20261008134229`.
- Authenticated inventory fingerprint calculated from ordered `version:name:SHA256(SQL)` rows:
  `838b9ff1bcc6f5a148fbac22ebde8d7f7d73713b74501d29808a27c6e12e1c50`.
- Local inventory: **130** files through `20261006051256`; remote has exactly **130** entries through that checkpoint. Remaining **323** remote migrations are not present locally.
- The earlier checkpoint recorded 24 divergent local/remote SQL files. This count was **not** independently reverified in this checkpoint without the complete remote SQL export.
- **No remote history rows were modified, deleted, or marked applied.**

## Migration recovery safeguards

`scripts/reconcile-migrations.mjs` supports explicit `--adopt-remote-with-backup` when SQL applied by Supabase differs from local history:

1. Requires a complete database history; refuses missing/renamed local migrations.
2. For file exports, requires a separately verified SHA-256 fingerprint of the complete remote inventory.
3. Verifies **every** canonical SQL file before the adoption swap.
4. Archives the entire previous local migration directory and original manifest, plus a report describing every divergence.
5. Uses same-filesystem directory swaps and rollbacks if the new tree or manifest cannot be installed.
6. Never executes a migration against Supabase or manipulates `supabase_migrations` history.

The verified export of all 453 complete SQL statement bodies is **not** available in this local environment. **Do not run adoption against a partial export and do not claim source/database reconciliation completed.**

## Executed checks

- `scripts/check-migrations.mjs`: **PASS** (local 130 manifest files only; *not* a remote consistency assertion).
- `scripts/check-migration-recovery.mjs`: **PASS, 27/27**, including wrong digest rejection, preserved prior files, archived manifest, adopted canonical SQL, truncated export rejection.
- `scripts/check-step11-static.mjs`: **PASS**.
- `scripts/check-step11-public-runtime.mjs`: **PASS** (including explicit booking venue isolation and multi-venue menu canonical tests).
- `scripts/check-step11-booking-client.mjs`: **PASS, 33/33**.
- `scripts/check-step11-prerender.mjs`: **PASS, 15/15**.
- `scripts/check-step11-build-assembly.mjs --browser-python`: **PASS, 17 assertions**, including Chromium **31 checks** with JavaScript disabled across mobile/desktop.
- `scripts/check-vercel-config.mjs`: **PASS, 33/33**.
- `scripts/check-staging-http.mjs`: **PASS, 7/7 mock cases** (not live HTTP).
- `git diff --check`: **PASS**.
- `npm run check:step11`: **BLOCKED** at `@electric-sql/pglite` (dependencies missing in the local runtime); not passed.
- Typecheck, npm ci, full unit/integration suite and JS-enabled E2E: **NOT PASSED**; local runtime Node 22.16 versus required Node >=24.13, npm registry DNS unavailable.

## Next gate, in priority order

1. Retrieve complete SQL history through a trusted, read-only database connection, verify the inventory fingerprint and adopt with preserved original source. Re-run the migration check against remote history.
2. Run Node 24 `npm ci`, format, TypeScript, unit/integration/security tests and actual Vite builds in a complete runner.
3. Provision independent staging environment (not the restore-test database), deploy the actual public/staff build, test real HTTPS navigation, real booking, Core Web Vitals and browser offline/reconnect behavior.
4. Close all remaining Beta blocking gates, provider and print hardware acceptance gates, and then run final go-live hardening. Do not confuse recorded Supabase tests with actual browser E2E proof.

## Continuazione verificata, 8 ottobre 2026

- I link pubblici con una sede esplicita inesistente o archiviata (`?sede=` o
  `/sedi/{slug}`) **non possono più mostrare il menu, il prezzo, i contatti o
  i JSON-LD di una sede differente**. Mostrano uno stato esplicito di sede
  non disponibile; i metadati della selezione invalida restano `noindex` e
  senza canonical riferito a un'altra sede.
- Il recupero route del fallback 404 accetta soltanto percorsi pubblici
  same-origin conosciuti. URL protocol-relative, staff, API e asset non
  vengono più ripristinati tramite `history.replaceState`; gestito anche il
  caso `sessionStorage` indisponibile. Il fallback del sito statico riconosce
  anche `/staff` senza slash terminale.
- Controlli locali dopo le modifiche: runtime pubblico, static, booking client,
  prerender, build-assembly e deploy-config **PASS**. I nuovi test Vitest sono
  presenti ma non possono essere eseguiti senza dipendenze npm complete.
- Supabase Development: funzioni di test SQL per storytelling, metadata e
  sitemap **PASS** in transazioni read-only; prenotazioni RESERVED, REQUESTED,
  PENDING_DEPOSIT, idempotency e verifica riga caparra **PASS** mediante
  transazione di prova con rollback.
- In test transazionali con rollback, Notification Center, Conflict Center,
  venue context, override del menu, attivazione multi-sede ed editor sala
  avanzato hanno restituito evidenza positiva. Per Notification Center il
  vecchio fixture di autenticazione era scaduto: è stato rinnovato **solo
  dentro la transazione temporanea**, poi annullato da rollback. Non si tratta
  di un permesso bypassabile dal client né di una sessione riattivata in modo
  permanente.
- Continuità Supabase Development: **49** backup `SUCCEEDED` (45 attualmente
  utilizzabili e verificati), **11** `FAILED` storici, **2** restore test
  `SUCCEEDED`, nessun incidente aperto. Questa evidenza certifica le registrazioni
  nel database, **non** un recovery indipendente in produzione o un RTO garantito.
- Il report Supabase rimane `IN PROGRESS`: 7 gate Beta bloccanti. La pipeline
  Node 24, la riconciliazione di 323 SQL mancanti e i collaudi reali
  browser/HTTPS restano aperti.
