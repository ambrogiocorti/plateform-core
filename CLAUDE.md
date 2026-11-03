# CLAUDE.md — Plateform

Istruzioni di lavoro per Claude Code sul repository `ambrogiocorti/plateform-core`.
Handoff predisposto il **17 ottobre 2026**. Non è una certificazione dello stato attuale.

## 1. Identità e fonte di verità

Plateform è un gestionale per ristorazione professionale: **un cliente/catena per installazione Supabase isolata**, con almeno una sede e multi-sede opzionale mediante `MULTI_VENUE`. Non è una demo né un SaaS multi-tenant condiviso. Include sito pubblico, staff, sala, ordini, cucina, Pass, cassa, cliente, prenotazioni e moduli avanzati.

Leggi, nell'ordine:
1. `docs/plateform-handoff/MASTER_PROMPT_PLATEFORM_COMMERCIALE_AGGIORNATO.md` — **specifica integrale fornita dal proprietario, §§0–157**; non sintetizzarla o sostituirla con la versione più corta eventualmente presente nel repository.
2. `docs/plateform-handoff/ROADMAP_IMPLEMENTAZIONE_STEP_0_13.md` — sequenza e Definition of Done.
3. `docs/plateform-handoff/ADDENDUM_E_CONFLITTI_2026-10-17.md` — interpretazioni, contraddizioni da risolvere con prudenza.
4. `docs/plateform-handoff/STATO_VERIFICATO_E_PRIORITA_2026-10-17.md` — ultimo handoff, con date ed evidenze.
5. `docs/plateform-handoff/REPORT_COMPLETO_2026-10-12.md` e `AUDIT_GO_LIVE_2026-10-10.md` — report storici, **non** fotografia live definitiva.

Confronta sempre questi file con il codice, i test e i documenti più recenti del repository. Il codice dimostra cosa esiste; **non** modifica automaticamente i requisiti di prodotto. In caso di differenza fra documenti, annota l'ADR e non inventare una risoluzione irreversibile.

## 2. Stack non negoziabile, salvo nuova decisione esplicita

- Frontend: **vanilla TypeScript strict + HTML/CSS + Vite**, senza React/Vue/Next/Svelte/Angular.
- Backend: **Supabase PostgreSQL, Auth, RLS, Realtime, Storage, RPC, Edge Functions**; no backend Node parallelo se non motivato.
- Una installazione/database production per singolo cliente/catena. `MULTI_VENUE=false` di default.
- Server autorevole per autorizzazioni, prezzi, disponibilità, pagamenti e workflow; niente controlli affidati soltanto alla UI.
- Importi in unità minime intere, transazioni, lock e idempotenza per operazioni concorrenti.
- Le funzionalità sono complete solo con DB/migration, RLS, API, UI, audit, error handling, test, documentazione e recovery quando pertinenti.
- Usa il logo originale in `assets/plateform/logo-plateform-originale.png`, senza ricreare o rinominare il brand.

## 3. Prima di modificare

1. Controlla `git status`, branch/HEAD, commit remoto, PR aperte e differenze. Non sovrascrivere lavoro locale.
2. Leggi `README.md`, `package.json`, `docs/ROADMAP_STATUS.json`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REVIEWS.md`, `docs/REQUIREMENTS.json`, `supabase/migration-manifest.json` e documenti operativi.
3. Esamina **PR #41** (`plateform/two-phase-completion-20261013`) e le PR di recupero migrazioni **#32/#33**, valutando dipendenze, conflitti e stato CI. Al 17/10/2026 risultavano aperte e draft: non supporre che siano su `main`.
4. Riconcilia lo stato dei report con evidenze di commit, SQL, test e ambiente, distinguendo `IMPLEMENTATO`, `VERIFICATO`, `BLOCCATO`, `NON VERIFICATO` e `NON PREVISTO`.
5. Identifica un solo macro-step prioritario e avvia il lavoro concreto senza reimplementare ciò che è già presente.

## 4. Ordine e priorità

Segui Step 0–13 della Roadmap. Poiché esistono criticità P0 anche in un progetto parzialmente sviluppato, **prima riduci i rischi**:
- audit applicativo sospeso (verifica attuale; al 12/10 esisteva trigger di scarto `plateform_dev_pause_audit`);
- migrazioni remote/locali non riproducibili e PR di recovery ancora draft;
- backup DB/Auth/Storage e restore indipendente non certificati;
- assenza di staging/production e CI/E2E di rilascio certificati;
- validazione Auth/MFA, RLS, cross-role/cross-venue, privilegi SQL e release gates;
- flusso reale `login → tavolo → conto → ordine → cucina → Pass → servizio → cassa → pagamento → chiusura`.

Non avviare nuove funzionalità decorative se impediscono la correzione di questi blocchi. La PR #41 può contenere progressi operativi: revisiona e riutilizza in sicurezza; non dichiarare superato un gate da test statici o PGlite.

## 5. Politica operativa e sicurezza

- **Non effettuare** reset, `DROP`, `TRUNCATE`, `DELETE` massivi, pulizie Storage, `supabase db reset` su ambienti condivisi, restore sostitutivi, cambi di credenziali, modifiche destructive alle migrazioni, merge/deploy in production, incassi veri o test pagamenti live **senza autorizzazione esplicita e piano di backup/rollback**.
- Non usare il database Development come target disposable; non assumere che il Free garantisca backup o SLA.
- Non mettere JWT, API key, service-role key, connection string con password o dati personali nei commit, log, report o output.
- Le migrazioni applicate restano immutabili: per fix creare migrazione nuova, salvo processo di recovery documentato, verificato e non distruttivo.
- Mai bypassare RLS/permessi per far passare i test; niente mock spacciati per prove live.
- Mai segnare `PASS`, `COMPLETE` o `GO` senza evidenza dello **stesso commit/ambiente**.
- Non aprire accessi pubblici ai servizi amministrativi; validate ogni operazione lato server.
- Per task di sola analisi o sviluppo locale non servono segreti production.

## 6. Comandi di verifica (solo dove ambiente/configurazione lo permettono)

Il `package.json` di `main` al 17/10 richiedeva Node.js `>=24.13.0`:
```sh
node --version
npm ci
npm run format:check
npm run typecheck
npm run lint
npm run check:migrations
npm run check
npm run test:e2e
npm run release:check
```
Scegli prima i test mirati per lo step e poi le regressioni necessarie; non affermare l'esecuzione di comandi non lanciati. `npm run format` **modifica molti file**: usare `format:check` come prima verifica. Le prove reali Supabase, browser, concorrenza, provider, printer, disaster recovery richiedono target indipendenti e opportuni permessi.

## 7. Formato obbligatorio del resoconto dopo ogni intervento

Riporta: branch/commit, requisito e step, cambiamenti per file, schema/API/RLS coinvolti, test **eseguiti e risultati**, prove mancanti, rischi, migrazioni necessarie, release gates interessati, decisione `DONE/IN PROGRESS/BLOCKED` e prossimo task. Aggiorna i registri di avanzamento **solo dopo prove attendibili**.

L'obiettivo è Plateform realmente funzionante, vendibile **solo dopo** rilascio certificato; non un insieme di schermate accattivanti.
