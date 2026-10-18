# Verifica di sicurezza RLS, Auth/MFA, Storage, Realtime e RPC — 18/10/2026

Stato: **IN PROGRESS** (verifica locale completata; mancano le prove sui servizi Supabase reali).

## Contesto

- Branch: `plateform/rls-security-63oe51`, basato su `plateform/a1-audit-append-only-inbac1` (PR #42, commit `759c8fe`), a sua volta basato sulla PR #41.
- Requisito: Roadmap Step 0 / release gate "Validazione Auth/MFA, RLS, cross-role/cross-venue, privilegi SQL" (CLAUDE.md §4).
- Ambiente: PostgreSQL **16.15** locale e usa-e-getta (`plateform_security_<pid>`), nessun database remoto toccato. Lo script rifiuta host non locali e database con nome diverso.
- Una installazione Plateform serve un solo cliente/catena: "cross-tenant" qui significa **utente autenticato senza profilo staff attivo** (es. cliente QR o account estraneo) e **chiave anon**.

## Come si esegue

```sh
PG_SECURITY_URL=postgres://postgres:<password>@localhost:5432/postgres npm run check:security-pg
```

Lo script (`scripts/check-security-pg.mjs`) crea un database temporaneo, applica la fixture di piattaforma Supabase (`supabase/tests/security/00_supabase_platform_fixture.sql`: ruoli `anon`/`authenticated`/`service_role`, GUC dei claim JWT, `auth.users/sessions`, metadati Storage, contratti `pg_cron`/`pg_net`/Vault senza I/O, grant di default dell'API), riapplica **tutte le 484 migrazioni** e lancia le sonde `supabase/tests/security/1*.sql`. Ogni sonda gira come i ruoli API reali (`SET ROLE` + claim JWT, come PostgREST) dentro `BEGIN … ROLLBACK`; alla fine il database viene eliminato.

## Sonde (10/10 PASS sullo stesso commit)

| Sonda                                 | Cosa dimostra                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `10_rls_cross_venue`                  | Per ogni tabella leggibile dall'API: lo staff di una sede (8 ruoli) non legge righe di un'altra sede; outsider e anon non leggono nulla (salvo segnali Realtime `PUBLIC`); nessuna partizione raggiungibile direttamente; controlli positivi (admin di sede vede la sua sede, admin di catena entrambe).                                                                                                         |
| `11_rls_role_matrix`                  | 52 aspettative ruolo×tabella nella stessa sede (cameriere solo il proprio tavolo, host senza conti/pagamenti, cassa senza prenotazioni, cucina senza conti/pagamenti, SUPER_ADMIN senza dati di business).                                                                                                                                                                                                       |
| `12_auth_mfa_sessions`                | MFA aal2 obbligatoria per ADMIN/SUPER_ADMIN (e CASHIER se configurato); sessione staff revocata, bloccata, full-auth scaduta, assente; logout Auth; JWT anteriore a `auth_valid_after`; profilo, assegnazione, sede o installazione disattivati; `session_id` di un altro utente; header di impersonazione falsificato; dispositivo revocato; nessun privilegio di scrittura diretta per `anon`/`authenticated`. |
| `13_storage_documents`                | Bucket `documents` privato: ogni admin vede solo i documenti della propria sede, admin di catena anche quelli di catena, nessun altro ruolo/outsider/anon; file non registrati invisibili; nessuna policy di scrittura Storage per ruoli API.                                                                                                                                                                    |
| `14_realtime_signals`                 | Topic Realtime visibili per ruolo (ADMIN, HOST, WAITER, CASHIER, KITCHEN_*, PASS), nessun segnale privato di altra sede, segnali `ACCESS` solo al destinatario, pubblicazione `supabase_realtime` limitata a `realtime_signals`.                                                                                                                                                                                 |
| `15_customer_session`                 | Cliente QR: legge solo il conto della propria sessione; altre sedi/tavoli negati per lettura, saldo, chiamata cameriere e ordine; sessione revocata, scaduta, epoch cambiata o logout bloccano; solo `service_role` può collegare sessioni.                                                                                                                                                                      |
| `16_rpc_surface`                      | Tutte le 221 RPC eseguibili da `authenticated` chiamate da 5 ruoli della sede A e da un outsider con argomenti che puntano a risorse della sede B (sottotransazioni annullate): nessun identificativo della sede B restituito, nessuna chiamata riuscita dell'outsider oltre a 4 punti self-service revisionati, ≥50 esiti `VENUE_FORBIDDEN` (sonda non vuota).                                                  |
| `17_anon_public_api`                  | Solo le 10 RPC pubbliche revisionate sono eseguibili da anon, nessuna è VOLATILE, nessuna espone PII, documenti, ID operativi o sedi disattivate.                                                                                                                                                                                                                                                                |
| `18_privilege_escalation`             | `update_staff_access` con step-up valido: un admin di sede non promuove ad ADMIN/SUPER_ADMIN, non concede scope CHAIN, non assegna altre sedi, non tocca staff di altre sedi o condiviso, non modifica sé stesso né altri admin; impersonazione non riusabile da altri utenti, sola lettura, scade.                                                                                                              |
| `19_policy_predicates_and_references` | Ogni funzione `private.*` richiamata da una policy è eseguibile dal ruolo della policy; `responsible_waiter` non eseguibile dai ruoli API; ogni riferimento a colonna singola tra tabelle per-sede è protetto; inserimento cross-sede rifiutato con `CROSS_VENUE_REFERENCE`.                                                                                                                                     |

Controprova: senza la nuova migrazione le sonde 10 e 19 falliscono (`permission denied for function can_manage_shared_catalog`, policy `menu_categories_admin_read` con predicato non eseguibile): 8/10.

## Falle trovate e correzioni

Migrazione nuova, additiva e non distruttiva: `supabase/migrations/20261018120000_security_policy_predicates_and_venue_references.sql` (solo grant/revoke, una `ALTER POLICY`, una funzione e trigger `BEFORE`; nessuna riga esistente letta per riscriverla, modificata o cancellata). **Non applicata a nessun database remoto.**

1. **Policy dei menu con predicati non eseguibili (media, funzionale + RLS).** Le policy di `menus`, `menu_venues`, `menu_categories`, `menu_dishes` chiamavano `private.can_read_menu(uuid)` e `menu_promotions` chiamava `private.can_manage_shared_catalog()`, entrambe revocate a `authenticated`: ogni `SELECT` diretto falliva con 42501 invece di filtrare (fail-closed, ma rompe letture REST e Realtime su quelle tabelle). Correzione: `can_read_menu` diventa eseguibile (predicato di riga come `can_read_account`); `can_manage_shared_catalog` resta helper interno non eseguibile (decisione già coperta da `tests/database/foundation.test.ts`) e la policy promozioni usa il nuovo predicato `private.can_read_menu_promotion(venue_id)` con la stessa logica.
2. **Oracolo cross-sede `private.responsible_waiter(uuid)` (bassa).** Eseguibile da qualunque utente autenticato, anche cliente, restituiva l'ID utente del cameriere assegnato a un tavolo di qualsiasi sede. Nessuna policy né routine SECURITY INVOKER lo usa: revocato a `public`, `anon`, `authenticated`. I tre test PGlite che lo osservavano ora lo leggono come owner mantenendo i claim JWT (`tests/database/service.test.ts`).
3. **Riferimenti cross-sede possibili su 18 FK a colonna singola (hardening).** Le altre relazioni per-sede usano FK composite `(venue_id, id)`; queste 18 no (`discount_requests`, `discount_unit_allocations`, `equal_split_plans`, `message_jobs`×2, `offline_sync_events`, `provider_operations`×2, `reservation_deposits`, `step_deliveries`, `step_delivery_history`, `takeaway_orders`×3, `takeaway_requests`×2, `waitlist_entries`×2). Nessuna RPC le sfrutta oggi (sonda 16), ma una riga della sede A poteva puntare a un genitore della sede B. Correzione: trigger `BEFORE INSERT/UPDATE` `venue_reference_<colonna>` con `private.enforce_reference_venue()`; la migrazione si blocca se lo schema delle FK non corrisponde a quello revisionato. Le righe esistenti non vengono toccate.

Query **di sola lettura** da eseguire su staging/produzione prima di promuovere la migrazione, per scoprire eventuali incoerenze già presenti (atteso: zero righe):

```sql
select 'reservation_deposits' t, c.id from public.reservation_deposits c join public.reservations p on p.id=c.reservation_id where p.venue_id<>c.venue_id
union all select 'waitlist_entries', c.id from public.waitlist_entries c join public.services p on p.id=c.service_id where p.venue_id<>c.venue_id
union all select 'takeaway_orders', c.id from public.takeaway_orders c join public.orders p on p.id=c.order_id where p.venue_id<>c.venue_id
union all select 'provider_operations', c.id from public.provider_operations c join public.payments p on p.id=c.payment_id where p.venue_id<>c.venue_id
union all select 'step_deliveries', c.id from public.step_deliveries c join public.order_steps p on p.id=c.step_id where p.venue_id<>c.venue_id;
-- estendere alle altre 13 relazioni elencate sopra con lo stesso schema
```

## Aspetti verificati senza falle

RLS attiva su tutte le 118 tabelle/partizioni di `public`; nessuna vista esposta; nessun grant di scrittura diretta ai ruoli API; tutte le 225 funzioni SECURITY DEFINER con `search_path` fissato; schema `private` non esposto da PostgREST (`config.toml`: `public`, `graphql_public`); `enable_signup=false`, `enable_anonymous_sign_ins=false`; SQL dinamico nelle RPC di configurazione limitato da whitelist e `%I`; FK composite su sale/zone/tavoli/casse.

## Test eseguiti (stesso commit di questo documento)

| Comando                                                                                                         | Esito                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run check:security-pg` (PostgreSQL 16.15 locale)                                                           | 484 migrazioni riapplicate, **10/10 sonde PASS**                                                  |
| stesso comando senza la nuova migrazione (controprova)                                                          | 8/10, falliscono 10 e 19 come atteso                                                              |
| `npm run test:db` (PGlite)                                                                                      | 16 file, **182 passati, 4 saltati** (incluso il nuovo `tests/database/security-rls.test.ts`, 5/5) |
| `npm run test:unit`                                                                                             | 19 file, 121/121                                                                                  |
| `npm run typecheck`, `npm run lint`, `npm run format:check`                                                     | OK                                                                                                |
| `npm run check:migrations`                                                                                      | 484 migrazioni verificate contro il manifest                                                      |
| `node scripts/plan-migration-promotion.mjs --self-test`, `node scripts/check-continuity-bootstrap-recovery.mjs` | PASSED                                                                                            |

Non eseguiti: `npm run build`, `npm run check` completo (richiede Deno per le Edge Functions), `npm run test:e2e`, `npm run release:check`.

## Prove mancanti e rischi residui

- **Servizi reali non coperti**: GoTrue (emissione JWT, `amr`, aal), PostgREST, Storage API (URL firmati), Realtime (consegna `postgres_changes` con RLS) e le Edge Functions con `verify_jwt=false` sono stati verificati solo sul contratto SQL o con revisione statica. Serve un progetto Supabase di staging indipendente con JWT reali (vedi branch storici `test/p0-real-jwt-cross-venue-http-20261011`, `test/p0-realtime-ws-tenant-20261011`).
- **Oracolo di esistenza**: 26 RPC rispondono `NOT_FOUND` prima di `VENUE_FORBIDDEN`; con UUID casuali il rischio è basso, non corretto.
- **Telemetria**: `record_navigation_telemetry` è chiamabile da qualunque autenticato (anche cliente) senza limite di frequenza; rischio di crescita della tabella, non di accesso ai dati.
- La fixture non riproduce i ruoli `supabase_admin`/`authenticator` hosted né i default privileges esatti del progetto remoto: confermare i grant su staging con lo stesso catalogo.

## Migrazioni e release gate

- Nuova migrazione `20261018120000` (forward-dated, aggiunta all'insieme `forward` di `scripts/plan-migration-promotion.mjs`; conteggi aggiornati a 484 negli script di bootstrap e nel workflow). Va promossa **dopo** la riconciliazione migrazioni e la query di sola lettura sopra.
- Gate interessati: RLS cross-role/cross-venue, Auth/MFA, privilegi SQL. Restano **NON VERIFICATI su ambiente reale**: questa evidenza non chiude il gate.

## Decisione e prossimo task

**IN PROGRESS.** Prossimo task: eseguire le stesse sonde (o il loro equivalente HTTP) contro uno staging Supabase isolato con utenti reali per ruolo e MFA TOTP, inclusi Storage firmato e Realtime via WebSocket.
