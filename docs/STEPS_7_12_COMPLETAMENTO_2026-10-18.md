# Step 7–12 — confronto con Master Prompt e completamento — 18/10/2026

Branch `plateform/steps-7-12-completion-y2bvpd`, base `plateform/migrations-reconciliation-4dgntr`
(PR #47, integrazione di #42–#47). Nessun merge su `main`, nessun database remoto, nessun segreto.
Stato complessivo: **IN PROGRESS, NO-GO commerciale** finché non ci sono prove su staging HTTPS.

## Metodo

1. Lettura di Master Prompt §§0–157 (sezioni 13–15, 33, 56, 65–66, 90–92, 94, 109–113, 144–145) e
   Roadmap Step 7–12, confronto con `docs/ROADMAP_STATUS.json` e con il codice.
2. Ogni pagina degli step 7–11 aperta in un browser reale con sei ruoli (Admin, Kitchen Admin,
   Cucina, Pass, Cameriere, Cassa, più Super Admin con MFA TOTP reale) sullo stack locale usa e
   getta di PR #46: PostgreSQL 16 con tutte le migrazioni, GoTrue, PostgREST. Realtime, Storage ed
   Edge Functions **non** sono serviti.
3. Ogni difetto è stato riprodotto nel browser, corretto e coperto da un test che lo rieseguirebbe.

Esclusi perché in carico ad altri thread: backup/restore (step 12), verifica RLS/sicurezza,
Realtime fra dispositivi, Edge Functions, MFA, riconciliazione migrazioni.

## Lacune trovate e stato

| #   | Step / §       | Lacuna verificata                                                                                                                                                                    | Effetto in servizio                                                    | Stato                                             |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | 7 / §65        | Il reso era proponibile solo su piatti `READY`. Un piatto rimandato indietro dal tavolo è già `SERVED` e spariva da Pass e Kitchen Admin, anche se il server lo accettava            | Impossibile RIFARE o annullare il caso più frequente                   | **Corretto**                                      |
| 2   | 7 / §56        | Le notifiche `STEP_PREPARED` (Pass) e `STEP_READY` (cameriere) restavano `NEW` per sempre dopo il servizio                                                                           | Centro notifiche pieno di avvisi già gestiti; le critiche si perdono   | **Corretto**                                      |
| 3   | 7 / §66        | La stampa automatica creava un job per ogni riga d'ordine                                                                                                                            | Un ordine di 5 piatti = 5 comande separate in cucina                   | **Corretto**                                      |
| 4   | 7 / §91        | I job automatici (nuovo ordine, RIFARE) non registravano `PRINT_REQUESTED`                                                                                                           | Audit stampe incompleto sul percorso principale                        | **Corretto**                                      |
| 5   | §92            | `get_operational_statistics` rifiutava tutto (`FEATURE_NOT_LICENSED`) senza `ADVANCED_ANALYTICS`: su un'installazione CORE la pagina Statistiche di Admin e Cassa era inutilizzabile | Nessun incasso, scontrino medio o venduto consultabile                 | **Corretto**                                      |
| 6   | 10 / §6, §8    | Nessuna interfaccia per creare, modificare o disattivare sedi: `create_venue`/`update_venue` esistevano solo come RPC                                                                | Un cliente multi-sede non può aggiungere la seconda sede senza SQL     | **Corretto** (pagina Super Admin `/sedi`)         |
| 7   | 11 / §14, §126 | Il salvataggio del branding con un colore a basso contrasto falliva con “Verifica la connessione” (il vincolo WCAG del server non veniva spiegato)                                   | L'Admin non capisce perché il sito non si aggiorna                     | **Corretto**                                      |
| 8   | 8 / §112       | Conflict Center offre “Annulla richiesta” e “Segna verificato”, non “Modifica ordine” / “Annulla item” dell'esempio                                                                  | L'Admin deve correggere l'ordine dalla vista conto                     | **Corretto** (seconda tornata)                    |
| 9   | 8 / §110       | Offline non provabile in locale: lo snapshot firmato arriva dalla Edge Function `offline-authorization`                                                                              | —                                                                      | **Provato** (Edge Function servita)               |
| 10  | 10             | Lo switcher sede aggiorna solo `sessionStorage`; `set_operational_venue` (sede del dispositivo lato server) non è mai chiamata                                                       | Device Management mostra la sede iniziale del dispositivo              | **Corretto** (seconda tornata)                    |
| 11  | 11             | Upload logo/immagini e invio prenotazione online passano da Edge Functions (`asset-upload`, `reservation`)                                                                           | —                                                                      | Prenotazione **provata**; upload aperto (Storage) |
| 12  | 11             | Sul sito pubblico compare “Aggiornamenti da verificare” quando Realtime è degradato                                                                                                  | Messaggio tecnico visibile ai clienti                                  | **Corretto** (seconda tornata)                    |
| 13  | 7 / §90        | Epson ePOS e print bridge esclusi dall'edizione CORE (`docs/CORE_COMMERCIAL_EDITION.md`)                                                                                             | Solo stampa browser/PDF                                                | Non previsto in CORE                              |
| 14  | 8 / §110       | Il service worker installato durante la sessione non mostrava mai “È disponibile un aggiornamento”: il controllo leggeva `registration.installing`, già vuoto a installazione finita | Lo staff resta sulla versione vecchia fino a un ricaricamento completo | **Corretto** (seconda tornata)                    |

Verificato senza difetti nel browser reale: menu della sede, accoglienza, sala, conti, cassa,
conflitti (vuoto), dispositivi, stampe, approvazioni comande, editor sala, pianificazione,
configurazione, sito e branding, regole del servizio, privacy, staff, notifiche per tutti i ruoli.

## Seconda tornata (sera del 18/10, senza GitHub)

Su richiesta di Ambrogio il lavoro è proseguito in locale; ogni commit è salvato anche come
bundle git in `/mnt/project-files/backup-codice/plateform-steps-7-12.bundle`.

- **Conflict Center §112** — nuova migrazione `20261018140000_conflict_center_order_correction.sql`:
  `resolve_order_conflict` (solo ADMIN della sede) invia l'ordine corretto tramite `place_order`
  e chiude il conflitto nella stessa transazione, audit `OFFLINE_CONFLICT_CORRECTED`; l'evento
  offline originale resta non eseguito. In `src/pages/offline.ts` ogni ordine rifiutato mostra le
  righe con “Annulla item” e il pulsante “Modifica ordine” (dialogo precompilato, piatti esauriti
  esclusi); annullare l'unica riga chiude il conflitto come annullato.
- **Switcher sede** — `selectVenue()` in `src/pages/staff-context.ts` chiama
  `set_operational_venue` prima di cambiare scheda; una nuova scheda riapre la sede salvata sul
  dispositivo. Usato anche dalla command palette.
- **Sito pubblico** — nessuna etichetta tecnica per i visitatori quando Realtime è degradato; solo
  un avviso se sono davvero offline. Pagina tavolo QR con messaggi comprensibili.
- **PWA** — corretto l'avviso di aggiornamento (`src/services/pwa.ts`).
- **Stack locale** — `tests/e2e-live/stack` ora serve le Edge Functions `offline-authorization` e
  `reservation` con il Deno del repository dietro il gateway; chiave di firma offline P-256
  generata solo per lo stack.
- **Nuovi test browser**: `step8-conflict-center-live` (2), `step8-offline-live` (offline vero:
  coda IndexedDB, riconnessione, un ordine sincronizzato e uno in conflitto corretto dall'Admin),
  `step8-pwa-release-live` (due build di rilascio: installazione, avvio senza rete,
  aggiornamento su richiesta), `step11-booking-live` (2: prenotazione confermata e richiesta di
  gruppo tramite la Edge Function).

## Modifiche

### Migrazioni nuove (datate dopo `20261018120000`, nel manifest)

- `20261018130000_statistics_core_metrics_without_advanced_license.sql` — senza licenza la
  funzione restituisce le metriche §92 di base con `advanced=false`; con licenza aggiunge capacità,
  permanenza, piatti annullati, errori e incidenti (`advanced=true`). Autorizzazione invariata
  (`private.statistics_base`: ADMIN/CASHIER, aggregato solo CHAIN).
- `20261018130100_step_notifications_follow_step_lifecycle.sql` — trigger su `order_steps`:
  `STEP_PREPARED` si risolve quando lo step lascia `ACTIVE`, `STEP_READY` quando lascia `READY`;
  audit `NOTIFICATIONS_AUTO_RESOLVED`.
- `20261018130200_returnable_served_items.sql` — `get_returnable_items(p_venue)`: piatti `SERVED`
  delle ultime 4 ore su conti con tavolo non liberato, solo PASS e KITCHEN_ADMIN, solo se i resi
  sono attivi. Le regole restano in `return_order_item`.
- `20261018130300_kitchen_print_ticket_per_order_and_audit.sql` — una comanda per ordine e
  stampante nella stessa transazione; `PRINT_REQUESTED` per i job automatici e RIFARE.

### Frontend

- `src/pages/kitchen.ts` — pannello “Piatti serviti di recente” per Pass e Kitchen Admin con
  “Piatto tornato indietro” (RIFARE / annullamento Admin); dialogo reso condiviso.
- `src/pages/venues.ts` (nuovo) e `apps/staff/main.ts` — pagina Super Admin **Sedi**: crea (con
  licenza `MULTI_VENUE`), modifica, disattiva, riattiva; conferma password (step-up) e idempotenza.
- `src/pages/statistics.ts` — schema e resa con e senza licenza avanzata, CSV coerente.
- `src/pages/branding.ts` — controllo di contrasto WCAG AA prima del salvataggio, stesso criterio
  del vincolo server.
- `src/api/client.ts` — messaggi per `INVALID_VENUE`, `VENUE_LIMIT`, `FIRST_VENUE_REQUIRED`.

### Test

- `tests/e2e-live/step7-print-returns-notifications.spec.ts` — stampa comanda unica per ordine,
  esito incerto → `FAILED`, ristampa verificata → `SUCCESS`, audit `PRINT_REQUESTED/FAILED/
REPRINT_AUTHORIZED/SUCCESS` attribuito a KITCHEN_STAFF; notifiche Pass e cameriere chiuse dal
  servizio; reso dopo il servizio: RIFARE (disponibilità −1), poi annullamento chiesto dal Kitchen
  Admin, importo invariato finché l'Admin non approva, poi 0 € e piatto `CANCELLED`.
- `tests/e2e-live/steps-9-11-live.spec.ts` — statistiche CORE e avanzate, Cucina esclusa;
  Super Admin con MFA TOTP reale crea, modifica, disattiva una sede con audit `VENUE_*`; switcher
  per Admin CHAIN; cameriere VENUE che via REST con la propria sessione vede solo la sua sede;
  `/sedi` pubblico; revoca dispositivo con step-up e audit `DEVICE_REVOKED`; Ctrl+K con risultati
  limitati al ruolo.
- `tests/e2e-live/step11-public-site-live.spec.ts` — 6 pagine pubbliche su desktop e mobile:
  `lang=it`, un solo `h1`, `main#main`, skip link, nessun overflow orizzontale, campi etichettati,
  immagini con `alt`, nessun link allo staff, titolo; menu con prezzo e allergeni; prenotazioni
  disattivate senza modulo; branding Admin (colore, titolo, SEO, sezione gallery) visibile sul sito.
- Seed dello stack: aggiunti ADMIN (CHAIN), KITCHEN_ADMIN e SUPER_ADMIN. Solo su questo database
  usa e getta `admin_mfa_required=false` (nessun authenticator per l'Admin); il Super Admin passa
  da TOTP reale perché il server richiede sempre `aal2`.
- Il passo step-up (Edge Function non servita dallo stack) è sostituito **solo nel browser di quei
  test** da un port Node di `supabase/functions/step-up`, con gli stessi controlli nello stesso
  ordine. Non è una prova della Edge Function.

## Test eseguiti (Node 24.13.0, PostgreSQL 16.15, Chromium Playwright)

Tutti eseguiti sullo stesso albero di lavoro del commit che aggiunge questo file.

| Comando                                                                                                                    | Esito                                            |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `npm run format:check`, `typecheck`, `lint`                                                                                | OK                                               |
| `npm run check:migrations`                                                                                                 | OK, 489 migrazioni verificate contro il manifest |
| `check:core-edition`, `check:kitchen-admin-ux`, `check:step7`, `check:step8`, `check:step11`, `check:step12`, `check:edge` | OK                                               |
| `npm run test:edge`                                                                                                        | 13 passati, 0 falliti                            |
| `npm run test:unit`                                                                                                        | 121 passati (19 file)                            |
| `npm run test:db` (PGlite)                                                                                                 | 190 passati, 4 saltati, 0 falliti                |
| `npm run build`                                                                                                            | OK                                               |
| `npm run test:e2e` (fixture HTTP)                                                                                          | 21/21                                            |
| `npx playwright test -c playwright.live.config.ts` (stack reale, cache Vite fredda)                                        | **10/10** in 1,6 min                             |

**Seconda tornata, rieseguito tutto sullo stesso albero di lavoro dei commit finali:** format,
typecheck, lint, `check:migrations` (490), `check:core-edition`, `check:kitchen-admin-ux`,
`check:waiter-ux`, `check:step7/8/11/12`, `check:edge`, `test:edge` 13, `test:unit` 121,
`test:db` 190 (4 saltati), build, `test:e2e` 21/21 e suite browser sullo stack reale **16/16**
(2,2 min, cache Vite fredda).

La suite browser completa falliva 3 test che passavano da soli: i due dev server (staff e
pubblico) condividevano `node_modules/.vite` e si invalidavano a vicenda i moduli pre-compilati
(risposte 504 “Outdated Optimize Dep” durante il test). Ora `vite.staff.config.ts` e
`vite.public.config.ts` usano cache separate; nessun effetto sulla build di produzione.

## Rischi e prove mancanti

- Nessuna prova su Supabase ospitato, staging o production; PostgreSQL 16 locale invece di 17.
- Edge Functions non servite: step-up, upload asset, prenotazione online, offline-authorization e
  telemetria non sono provati qui.
- Stampa provata solo con il driver browser in Chromium headless (`window.print` neutralizzato):
  nessuna stampante fisica.
- Il raggruppamento della comanda usa `created_at = now()` della transazione: righe aggiunte in
  transazioni diverse producono comande diverse, come atteso.
- `ROADMAP_STATUS.json` non è stato toccato, come richiesto.

## Prossimo step

1. Servire le Edge Functions nello stack locale (thread “Servizio completo”) e riprendere offline
   (step 8), upload asset e prenotazione online (step 11) nel browser.
2. Conflict Center: azioni “Modifica ordine” e “Annulla item” (§112).
3. Switcher sede → `set_operational_venue`.
4. Staging HTTPS e ripetizione di queste suite contro Supabase reale prima di qualunque GO.
