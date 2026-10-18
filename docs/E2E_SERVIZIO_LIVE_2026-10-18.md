# E2E servizio reale multi-ruolo — 18/10/2026

Branch `plateform/e2e-service-flow-ncceyo`, base PR #42 (`plateform/a1-audit-append-only-inbac1`, `759c8fe`).
Roadmap: flusso P0 `login → tavolo → conto → ordine → cucina → Pass → servizio → cassa → pagamento → chiusura`.

Stato: **IN PROGRESS**. Il flusso è VERIFICATO sullo stack locale descritto sotto; **non** è verificato
su Supabase ospitato, staging o production.

## Cosa è stato provato davvero

Stack locale usa-e-getta, senza Docker (le immagini Supabase non sono scaricabili da questo ambiente):

| Componente                                                             | Reale o fixture                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| PostgreSQL 16.15 con le 483 migrazioni del branch, applicate in ordine | reale                                               |
| GoTrue `v2.180.0` (supabase/auth): login password, JWT, sessioni       | reale                                               |
| PostgREST `v12.2.12`: RPC, RLS, ruoli `anon`/`authenticated`           | reale                                               |
| Gateway minimo `/rest/v1` + `/auth/v1` al posto di Kong                | sostituto                                           |
| pg_cron, Vault, Storage                                                | fixture SQL (come `tests/database/harness.ts`)      |
| Realtime, Edge Functions                                               | **non serviti**: i dispositivi ricaricano la pagina |

Supabase usa PostgreSQL 17; qui gira il 16. Nessuna migrazione ha richiesto modifiche.

### `tests/e2e-live/service-flow.spec.ts` — 4 dispositivi, 4 ruoli, UI reale

1. Login reale di Cameriere, Cucina, Pass e Cassa in 4 contesti browser separati (sessione GoTrue,
   `complete_staff_login` e dispositivo registrato propri). Ognuno atterra sulla propria vista.
2. Cassa: apre la postazione e il servizio contabile con fondo iniziale.
3. Cameriere: apre il conto al Tavolo 1 (3 coperti), ordina 2 Carbonara e 1 Tiramisù.
4. Cucina: vede gli allergeni dell'ordine (`ALLERGENI: Uova · Latte`), porta ogni piatto a READY.
5. Pass: vede `2/2 piatti pronti`, libera lo step.
6. Cameriere: prende in carico la consegna e conferma il servizio; il Pass torna libero.
7. Cassa: totale 34,50 €, pagamento POS registrato e confermato, conto chiuso.
8. Verifiche sul database: conto `CLOSED`, pagamento `CARD_POS:3450:COMPLETED`, piatti `SERVED`,
   audit dei pagamenti attribuito a `CASHIER`, tavolo senza conti aperti.

### `tests/e2e-live/server-authority.spec.ts` — HTTP reale senza UI

- Doppio invio di `create_order` con la stessa chiave: un solo ordine.
- Prezzo unitario preso dal server (1400), non dal client.
- `create_payment` rifiutato a Cameriere e Cucina; la Cucina non legge `accounts` né `payments`.
- `create_account` rifiutato al client anonimo.
- La Cassa non incassa con postazione e servizio contabile chiusi.
- Audit attribuito al ruolo reale; `DELETE` su `public.audit_log` rifiutato anche al superuser
  (`IMMUTABLE_RECORD`), a conferma del lavoro A.1 sulla base di questo branch.

## Bug trovati e corretti

| #   | Problema                                                                                                                                   | Effetto in servizio                                                                                                       | Correzione                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/pages/kitchen.ts` validava gli allergeni come stringhe, il server li restituisce come `{code,name}` (`order_items.allergen_snapshot`) | **La vista Cucina e il Pass non si caricavano** ("La risposta ricevuta non è valida") appena un piatto aveva un allergene | Schema allineato al server, si mostrano i nomi. Il controllo statico `check-kitchen-pass-ux` imponeva lo schema sbagliato ed è stato corretto |
| 2   | Atterraggio dopo il login = prima voce del menu                                                                                            | Cucina atterrava su Stampe, Pass e Cassa su Sala                                                                          | Mappa ruolo → vista operativa in `apps/staff/main.ts`                                                                                         |
| 3   | Pannello "Postazioni, servizi e verifiche" ricreato chiuso a ogni aggiornamento                                                            | Dopo "Apri postazione" spariva il pulsante del passo successivo                                                           | Stato aperto conservato; aperto di default finché non c'è un servizio contabile                                                               |
| 4   | Risultati di ricerca in Cassa con `role="listitem"` sul pulsante                                                                           | Il pulsante non era annunciato come azionabile; il test e2e esistente `cash.spec.ts` falliva già sulla base               | Il listitem ora avvolge il pulsante                                                                                                           |

Nessuna migrazione nuova è stata necessaria: tutti i difetti erano nel frontend.

## Comandi eseguiti e risultati (stesso commit)

| Comando                                                                                                                                             | Esito                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run test:e2e:live` (stack + 2 test live)                                                                                                       | 2/2 superati                                                                  |
| `npx playwright test` (e2e con fixture HTTP)                                                                                                        | 21/21 (prima della correzione 4: 20/21, fallimento presente anche sulla base) |
| `npm run test:unit`                                                                                                                                 | 121/121                                                                       |
| `npm run test:db` (PGlite)                                                                                                                          | 177 superati, 4 saltati                                                       |
| `npm run typecheck`, `npm run lint`, `npm run format:check`                                                                                         | OK                                                                            |
| `npm run check:migrations`                                                                                                                          | 483 migrazioni verificate                                                     |
| `check:kitchen-pass-ux`, `check:cashier-ux`, `check:waiter-ux`, `check:admin-ux`, `check:super-admin-ux`, `check:host-ux`, `check:kitchen-admin-ux` | OK                                                                            |
| `npm run build`                                                                                                                                     | OK                                                                            |

Node.js 24.13.0, Chromium di Playwright preinstallato (`PLAYWRIGHT_CHROMIUM_EXECUTABLE`).

## Come rieseguire

```sh
npm run test:e2e:live          # installa PostgREST/GoTrue in /tmp/plateform-e2e, crea il DB, esegue i test
npm run e2e:stack -- down      # ferma lo stack
```

Richiede i binari PostgreSQL 16+ (`E2E_POSTGRES_BIN`, default `/usr/lib/postgresql/16/bin`) e `psql`.
Il database template si ricostruisce da solo quando cambiano migrazioni, bootstrap o seed; ogni test
riparte da una copia pulita. Lo script rifiuta URL di database non locali.

## Prove mancanti e rischi

- Realtime e Edge Functions non coperti: aggiornamento live tra dispositivi, step-up (sconti, storni,
  chiusura forzata), pagamenti provider. Servono Supabase locale completo o staging.
- PostgreSQL 16 invece di 17; gateway sostitutivo invece di Kong.
- Utenti con MFA (Admin, Super Admin) non coinvolti nel flusso.
- Osservazione per il thread audit: in questo stack non esiste la partizione `audit_log` del mese
  corrente; gli eventi finiscono in `audit_log_default`. Va verificato che la manutenzione pg_cron
  crei le partizioni sugli ambienti reali.
- Concorrenza vera (due camerieri sulla stessa consegna, doppio incasso simultaneo) non ancora provata
  sullo stack live.

## Release gates interessati

Flusso operativo end-to-end (parziale: stack locale), regressione UI cucina/Pass/cassa,
autorizzazione server-side per ruolo (parziale).

## Prossimo task

Estendere la suite live a: concorrenza sulle consegne e sugli incassi, divisione del conto,
resi dal Pass, ruoli con MFA via TOTP; poi eseguirla in CI (thread CI) e contro staging quando esiste.
