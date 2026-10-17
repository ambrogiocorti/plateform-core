# Plateform — stato e priorità per Claude Code (handoff 17/10/2026)

Questo documento **non** è un audit live completo del database in data 17 ottobre.
Combina i report forniti (10 e 12 ottobre) con letture **in sola lettura** del
repository GitHub e della PR #41 eseguite il 17 ottobre.

## Snapshot repository verificato il 17/10/2026

- GitHub: `https://github.com/ambrogiocorti/plateform-core` (repository privato).
- Branch default: `main`.
- HEAD `main`: `a36da14375097fadd4a39630db489ef8a9398ecb` (commit 12/10/2026).
- **PR #41**: aperta, **draft**, branch `plateform/two-phase-completion-20261013`,
  HEAD `9781525a86ff203763d29d86c1fec6d976f8f823`, aggiornata il 16/10.
- **PR #38**: aperta, draft, onboarding operativo.
- **PR #32/#33**: aperte, draft, recupero SQL remote/candidato migrazioni.
- Numerose PR P0 e test dipendenti sono ancora draft. **Non sono integrate in `main`.**

Il branch della PR #41 contiene `docs/OPERATIONAL_INTEGRATION_2026-10-16.md`,
documento di sviluppo più recente rispetto ai due report consegnati.

## Cosa dichiara la PR #41 (fonte: documento del branch, 16/10)

- Avvio guidato per Admin, menu per sede, console anomalie, recupero pagamenti
  manuali in cassa, consegne distinte da SERVED, menu engineering storico.
- Controlli sorgente dichiarati: `23/23` operational-readiness,
  `55/55` core-edition. Il report cita anche 121 test unitari e 166 PGlite
  (4 skipped) su un candidato **precedente** alla correzione di TypeScript.
- 480 migrazioni Development, 482 file nel candidato; 2 migrazioni
  retrodatate non promuovibili al momento del report.
- Ultima lettura DB riportata dalla PR il 16/10: 75.871.923 byte DB,
  3.038 oggetti Storage e **0 backup registrati**.
- Installazione pulita, restore indipendente, E2E HTTPS multi-ruolo e
  verifiche dispositivi/provider/printing rimangono aperti.
- Decisione documentata: **Macro-step A IN PROGRESS, NO-GO commerciale**.

Queste sono **dichiarazioni tracciate nel branch**, non controlli ripetuti in
questa consegna. Verificare CI, log, test e differenze prima del merge.

## Baseline dei problemi emersi nell'audit del 12/10

| Priorità | Problema / prova ancora necessaria |
|---|---|
| P0 | Audit applicativo sospeso tramite trigger di scarto: verificare lo stato attuale e recuperarlo in modo controllato, senza violare immutabilità |
| P0 | Migrazioni remote vs Git divergenti: recovery canonica, versioni/hash, deploy pulito e rollback, senza inserire false migrazioni |
| P0 | Nessun backup DB/Auth/Storage **recente e ripristinato** certificato; test di restore separato e RPO/RTO |
| P0 | Staging/production HTTPS isolati, CI riproducibile, collegamento commit/schema/artefatto e release gate |
| P0 | Test MFA/Auth, leaked-password, RLS, SECURITY DEFINER e isolamento reale fra ruoli e sedi |
| P1 | Configurazione sede reale, servizi/tavoli, end-to-end cameriere → cucina/Pass → cassa e pagamento con più dispositivi |
| P1 | Sito pubblico/booking/QR, Storage branding, SEO, accessibilità e prestazioni E2E |
| P1/P2 | Offline, stampa Epson/print bridge, provider Stripe/Satispay, multi-sede, moduli Release 4 con prove reali, attivabili per flag |

Il 12/10 c'erano **15 gate PENDING su 22**, Step 13 ancora TODO e 0/3
revisioni integrali pulite (fonte: report del 12/10). **Ricontrollare nel
DB e sulla release candidata**: non ripetere questi numeri come stato del 17/10.

## Prima sessione operativa raccomandata

1. Leggere master §§0–157 e Roadmap. Eseguire `git status`, inventario branch e PR.
2. Controllare `main` vs PR #41, PR #32/#33, la dependency chain e i test.
3. Verificare la recovery delle migrazioni **in dry-run** e l'audit, senza
   operazioni distruttive sul database condiviso.
4. Allestire una matrice di requisiti, prove e rischi P0 realmente aggiornati.
5. Risolvere **un** blocco verificabile per volta, con test mirati e regression.
6. Aggiornare la documentazione e proporre un merge solo con CI/evidenze e
   approvazione quando l'operazione modifica ambienti condivisi.

## Verifiche tecniche suggerite

Da `main`, `package.json` richiede Node >=24.13.0 e include script
`check:migrations`, `check`, `test:e2e`, `release:check`, `local:verify`.
I test PGlite/fixture non sostituiscono prove Auth/REST/Realtime/Storage vere.

I rapporti del 10 e del 12 ottobre forniscono dettagli modulo per modulo,
inclusi limiti legali/fiscali della documentazione non fiscale e rilascio commerciale.

**Obiettivo finale:** una release di Plateform stabile e vendibile con
evidenze E2E e gate chiusi, non soltanto incrementi al numero di funzionalità.
