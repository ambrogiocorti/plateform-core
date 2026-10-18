# E2E Realtime, Edge Functions e MFA — 18/10/2026

Branch `plateform/e2e-service-flow-ncceyo`, allineato a `plateform/migrations-reconciliation-4dgntr`
(integrazione #42–#47, 485 migrazioni). Segue [E2E_SERVIZIO_LIVE_2026-10-18.md](E2E_SERVIZIO_LIVE_2026-10-18.md),
che lasciava scoperti aggiornamento live tra dispositivi, Edge Functions, ruoli con MFA e concorrenza.

Stato: **IN PROGRESS**. Tutto quanto sotto è VERIFICATO su uno stack Supabase locale e usa-e-getta;
**non** è verificato su Supabase ospitato, staging o production.

## Stack usato

`npm run test:e2e:supabase` → `tests/e2e-live/stack/supabase-stack.mjs up`, poi la suite live.

| Componente                                                                                          | Reale o sostituto                                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `supabase start` (CLI 2.54.11): PostgreSQL 17.6, GoTrue, PostgREST 13, Kong, Storage, postgres-meta | reale, immagini ufficiali                                                            |
| Realtime `v2.57.3`                                                                                  | reale; in questo container ricompilato per ascoltare su IPv4 (il kernel non ha IPv6) |
| Edge Functions `step-up`, `staff-admin`, `payments`, `health-probe`                                 | codice del repository eseguito con Deno sull'host, non con `edge-runtime`            |
| Gateway `edge-gateway.mjs` (54320): `/functions/v1/*` → Deno, resto → Kong                          | sostituto del routing funzioni di Kong                                               |
| Migrazioni                                                                                          | le 485 del branch, applicate dalla CLI                                               |

Note sull'ambiente: le immagini arrivano da `mirror.gcr.io` (ECR/ghcr bloccati, Docker Hub in 429) e il
container `edge-runtime` non risolve DNS; per questo `E2E_IMAGE_MIRROR` attiva pull, retag e patch IPv4
solo quando serve. Su una macchina normale bastano Docker e `supabase start`.
Ogni test riparte da un database clonato da un template (`plateform_e2e_template`) dopo il seed.

## Cosa è stato provato davvero (9/9 superati)

### `realtime.spec.ts`

- Cameriere, Cucina e Pass su tre browser, nessun ricaricamento dopo il primo render. L'ordine del
  cameriere compare in Cucina, i piatti pronti compaiono al Pass, lo step liberato compare al cameriere,
  ogni passaggio entro 10 s (il polling di sicurezza dell'app è 30 s, quindi solo Realtime lo spiega).
  Indicatore "Aggiornamenti connessi" verificato su tutti i dispositivi.
- Realtime rispetta RLS: con client Supabase autenticati, la Cucina riceve i segnali `KITCHEN` ma non
  `ACCOUNT`/`FINANCE`; la Cassa riceve `ACCOUNT`.

### `admin-step-up.spec.ts`

- Admin con MFA: login password + TOTP reale (iscrizione al primo accesso con il segreto manuale).
- "Riapri conto" con password sbagliata: il conto resta `CLOSED`, nessun `step_up_grants`; con la
  password giusta: "Conto riaperto." e audit attribuito ad `ADMIN`. Esiti della funzione `step-up`
  registrati: `UNAUTHORIZED`, poi `SUCCESS`.
- La Cassa che chiede lo step-up `REOPEN_ACCOUNT` riceve `FORBIDDEN`.
- Pagamenti online: la funzione `payments` risponde `PAYMENT_METHOD_UNLICENSED` e `create_payment` con
  metodo `STRIPE` è rifiutato. È il comportamento atteso dell'edizione CORE.
- Codice TOTP sbagliato: la sessione Admin non si apre.

### `concurrency.spec.ts` (gira anche sullo stack nativo)

- Due incassi simultanei da 14,00 € sullo stesso residuo: uno solo passa, totale incassato 1400.
- Due dispositivi prendono in carico la stessa consegna nello stesso istante: una sola riga in
  `step_deliveries`.

### Suite della fase 1, rieseguita su questo stack

`service-flow.spec.ts` (4 ruoli, flusso completo fino alla chiusura) e `server-authority.spec.ts`
superati anche su PostgreSQL 17 con Kong reale.

## Bug trovati

Nessun difetto di prodotto in questa fase: Realtime, MFA, step-up, blocco dei pagamenti online in CORE,
filtri RLS sui segnali e lock di concorrenza si sono comportati come previsto. Le correzioni hanno
riguardato solo l'infrastruttura di test (reset del database con il worker pg_cron, Kong che conserva
gli indirizzi dei container dopo un riavvio). Nessuna migrazione nuova.

## Comandi eseguiti e risultati (stesso albero di lavoro)

| Comando                                                                      | Esito                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `npx playwright test -c playwright.live.config.ts` (Supabase)                | 9/9 superati                                         |
| `npm run test:e2e:live` (stack nativo PG16)                                  | 4 superati, 5 saltati (Realtime/Edge non serviti lì) |
| `npx playwright test` (e2e con fixture HTTP)                                 | 21/21                                                |
| `npm run test:unit`                                                          | 121/121                                              |
| `npm run test:db`                                                            | 190 superati, 4 saltati                              |
| `npm run check:migrations`                                                   | 485 migrazioni verificate                            |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` | OK                                                   |

## Come rieseguire

```sh
npm run test:e2e:supabase                          # supabase start + Edge Functions + suite live
node tests/e2e-live/stack/supabase-stack.mjs down  # ferma tutto (supabase stop --no-backup)
```

Lo script usa solo il progetto locale della CLI, non collega mai progetti remoti. Le chiavi sono quelle
demo locali stampate da `supabase status`; non vengono scritte nel repository (`tests/e2e-live/.stack/`
è ignorato).

## Prove mancanti e rischi

- Pagamenti online reali (Stripe, Satispay): non provabili, CORE li esclude e non ci sono chiavi sandbox.
  Verificato solo che restino chiusi. Serve un'edizione con licenza e un ambiente sandbox.
- Edge Functions eseguite con Deno sull'host, non con `edge-runtime`: differenze del runtime ospitato
  (limiti, variabili iniettate, routing Kong delle funzioni) non coperte.
- Realtime ricompilato per IPv4 solo in questo container.
- Super Admin, step-up per sconti/storni/chiusura forzata e gestione staff via `staff-admin` non ancora
  coperti dal browser.
- Nulla è provato su staging o production: prima della pubblicazione serve un progetto Supabase di
  staging con le stesse migrazioni e la stessa suite.

## Prossimo task

Eseguire la suite live in CI su Supabase CLI e poi contro uno staging; aggiungere i flussi step-up di
sconti, storni e chiusura forzata e la gestione staff.
