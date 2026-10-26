# Plateform — chiusura tecnica e Go/No-Go

**Verifiche del 26 ottobre 2026.** Ramo di integrazione:
`plateform/gpt6-prerender-preview-resilience-20261026` (PR #49 sopra PR #48);
il ramo `main` e Production non sono stati modificati.

**Decisione: NO-GO per rilascio commerciale e dati reali di clienti.**
Il criterio di completamento della Roadmap (Step 12–13) richiede una copia
di backup verificata mediante restore reale, collaudi hosted multi-ruolo,
provider e hardware, più le tre revisioni integrali consecutive del Master.
Non è corretto sostituirli con test isolati o aggiornare i gate a PASS.

## Cosa è stato verificato

| Area                  | Evidenza reale                                                                                                                                   | Limite                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Sorgente              | `npm ci` e `npm run check` **PASS**, Node 24.22.1, commit `667c62a`                                                                              | Prove locali/sandbox                                          |
| Frontend browser      | Playwright **21/21 PASS** nella validazione precedente della stessa PR; successiva conferma richiesta a ogni modifica                            | Fixture API per i flussi staff                                |
| Edge                  | `check:edge` PASS, `test:edge` **74/74 PASS** nell'audit PR #49                                                                                  | Test isolati, non provider live                               |
| Unit/database         | **339/339 PASS** nell'audit PR #49                                                                                                               | Database di test / PGlite                                     |
| Migrazioni            | **496** su Staging e **496** su Production, stesse coppie versione/nome, ultima `20261021090000`                                                 | Non è una verifica degli hash né delle configurazioni esterne |
| RPC pubbliche         | Staging: Auth settings 200, sito pubblico 200, sitemap 200 e noindex                                                                             | Non dimostra il ciclo ordini con staff autenticato            |
| Anon/Staff            | GET diretto `staff_profiles` anon: 401                                                                                                           | Verifica una superficie, non tutta la matrice RLS             |
| Browser pubblico live | Build contro Supabase Staging, servita localmente con rewrite coerenti con Vercel: Home/Menu/Prenota/Staff HTTP 200, nessun `pageerror` Chromium | NON prova HTTP del nuovo deployment Vercel, protetto SSO      |
| Prerender             | `npm run build:pages` contro Staging **PASS**, HTML ristorante E2E e robots noindex                                                              | Non equivale al go-live della build                           |
| Audit database        | Staging: trigger di sospensione audit assenti; trigger di immutabilità presenti e attivi                                                         | Non dimostra il ripristino/replay di un backup                |

### Limite dei test sulle Edge Function

Una POST anonima con oggetto JSON vuoto ha ottenuto 400
`INVALID_PAYLOAD` per alcune funzioni staff/provider e 401 per
`offline-authorization`. Il 400 indica che la validazione dello schema
ha bloccato la richiesta: **non dimostra** che un payload valido sarebbe
rifiutato a livello JWT/RLS. La matrice negativa completa richiede
credenziali di test distinte e chiamate controllate.

## Blocco P0: continuità non attivata

Lettura diretta (26 ottobre):

- Staging: **1** backup registrato, `QUEUED`, non completato, non
  verificato, senza dump/oggetti associati e mai ripristinato.
- Production: **2** backup registrati, entrambi `QUEUED`, nessuno
  completato o restore-tested.
- Entrambi gli ambienti: **0** heartbeat nei registri
  `private.continuity_worker_heartbeats`; **0** job di restore.
- Production ha soltanto i quattro bucket `branding`, `dishes`,
  `documents`, `gallery`. Mancano i due bucket privati
  `plateform-continuity-audit-archive` e
  `plateform-continuity-audit-archive-replica` presenti in Staging.
- I cron `plateform-daily-backup` sono schedulati e riportano esiti
  SQL `succeeded`, ma questo **non** certifica l'esecuzione del backup
  esterno. Non presentare il cron verde come prova di disaster recovery.
- Le impostazioni Staging dichiarano RPO e RTO target entrambi di
  60 minuti, ma non costituiscono misure raggiunte.

**Per chiudere il blocco:** configurare un worker esterno durevole con
permessi minimi e destinazione indipendente; produrre un backup
Postgres+Auth+Storage cifrato con checksum e metadata verificabili;
ripristinarlo in ambiente distinto non produttivo, misurare RPO/RTO e
allegare la prova. Solo successivamente attivare il piano Production.

## Altri blocchi residui

1. **Rilascio Vercel aggiornato:** le ultime build Git vengono rifiutate
   dalla quota Free; il build locale contro Staging non è un deployment
   HTTPS verificato. Non cambiare le variabili Production.
2. **Auth:** l'advisor Supabase segnala leaked-password protection
   disabilitata (vedere la
   [documentazione ufficiale](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)).
3. **SQL e RLS:** advisor Supabase segnalano dieci RPC
   `SECURITY DEFINER` pubbliche anon (la superficie del sito), 229
   accessibili a `authenticated`, 66 tabelle RLS senza policy
   (molte interne) e 83 foreign key senza indice. Non revocare
   indiscriminatamente: esaminare implementazioni e permessi con i
   relativi test cross-role/cross-venue.
4. **Provider:** completare checkout+webhook+callback+rimborso realmente
   verificati su Stripe e Satispay Sandbox, inclusi duplicati e timeout.
5. **Staff E2E hosted:** sessioni reali, ruoli, MFA, tavolo→conto→
   ordine→cucina→pass→servizio→cassa→pagamento→chiusura.
6. **Client/hardware:** QR reale, offline device revocation/sync, PWA su
   telefono, stampante fisica o procedura di PDF/fallback, stress test.
7. **Privacy/legal/fiscal:** retention per cliente, informativa e
   trattamento dati, policy commerciale e incassi.
8. **Master e release:** dossier Step 13 e tre revisioni integrali pulite
   sullo stesso digest, senza test dichiarati PASS senza evidenza.

## Anomalia dati da triagiare

Staging contiene **64** eventi audit con timestamp oltre il tempo
dell'interrogazione, di cui 48 oltre una settimana nel futuro.
Potrebbero essere fixture dei test sulle partizioni: non cancellarli
(append-only), ma escludere che alterino retention, dashboard o allarmi
e distinguere il dataset reale dal collaudo.

## Decisione operativa

- **STEP 0–11:** ampia implementazione sorgente e buona copertura di
  test, ma non tutti i contratti Master sono stati collaudati hosted.
- **STEP 12:** `IN PROGRESS / BLOCKED` per backup e restore reali.
- **STEP 13:** `IN PROGRESS / BLOCKED`; `release:check` deve rimanere
  fail-closed.
- **Commercial CORE o FULL:** `NO-GO` finché questi blocchi non sono
  risolti con evidenza.

Non eseguire merge in `main`, deploy Production o attivazione di
funzionalità a pagamento solo per rispettare una scadenza temporale.
