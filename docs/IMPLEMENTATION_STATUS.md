# Plateform — stato di implementazione

Aggiornamento: **9 ottobre 2026**. Sviluppo incompleto; release commerciale bloccata.
La specifica vigente comprende **158 sezioni, §§0–157**. La matrice requisiti è
legata tramite SHA-256 al master completo e a ogni sua sezione. Il profilo CORE
esclude soltanto §§79, 80 e 90; tutti gli altri requisiti rimangono obbligatori.
Revisioni integrali consecutive pulite: **0/3**.

## Baseline corrente

- Recuperate le **457 migrazioni applicate** su `plateform-development` dal suo
  storico SQL, verificando indipendentemente l'impronta completa. Il repository
  conserva anche una nuova migrazione preparata, **non applicata**: 458 file locali.
- Ripristinate sette tabelle private e due RPC operative che il catalogo live
  conteneva senza corrispondente DDL nello storico. Bootstrap e postlude sono
  versionati e condivisi dall'installatore reale e dai test. Il postlude recupera
  anche 31 definizioni obbligatorie di test: 197 totali, senza copiare risultati.
- CI corrente, inclusi test PGlite senza DDL applicativo nascosto:
  **255 test passati, 4 esclusi CORE**, 13 test Edge e 20 contratti browser.
  La run GitHub 70 include anche 15 scenari Auth/JWT/MFA/RLS/Storage nativi.
  TypeScript strict, ESLint, gate sorgente, formattazione e build pubblico/staff passano.
- Confronto del catalogo: 163 relazioni, 1.485 colonne, 444 indici, 903 vincoli e
  110 policy RLS corrispondono. Due strumenti diagnostici specifici di Development
  restano esclusi; i soli oggetti aggiunti sono il nuovo controllo delle evidenze.
- Preparata una protezione che riclassifica i vecchi `PASS` come dichiarazioni
  non verificate, ne conserva evidenza/autore/data e impedisce nuovi `PASS`.
  Il canale CI autenticato con log immutabili e binding commit/schema è ancora aperto.

Il collaudo nativo della run 66 passa su Supabase Docker/PostgreSQL 17.11:
installatore `psql`, ledger originale, cataloghi, definizioni release, guardie
PASS, rifiuto reinstallazione, health Auth/Storage e RPC service-role/anon.

Le evidenze non certificano Supabase ospitato. Il harness PGlite usa adattatori
espliciti Auth/Storage/Vault/cron e serializza le richieste: non prova contesa
tra connessioni separate. I risultati storici
nei documenti precedenti non certificano la versione attuale.

## Collaudo API nativo verificato

Aggiunto un runner che crea identità e sessioni GoTrue reali e prova TOTP, JWT,
RLS/scope HTTP, revoca/refresh, login concorrente e Storage privato. La run
GitHub 70 sul commit `7f2244e7cef49e5f77f87e585b8d4652082706ba` passa entrambi
i job: 15 scenari nativi, 255 test unit/database, 13 Edge e 20 contratti browser.
Dieci nuove regressioni mirate passano anche localmente. Nessuna certificazione
commerciale viene scritta dal runner; il collaudo hosted rimane aperto.
Dettagli: [NATIVE_API_VERIFICATION_2026-10-09.md](NATIVE_API_VERIFICATION_2026-10-09.md).

## Gate aperti

1. **Step 0, IN_PROGRESS:** installazione su un nuovo Supabase hosted isolato,
   prove HTTP/JWT di login/TOTP/sessioni, scope/RLS, Storage upload/download,
   Realtime ed Edge. Il replay Docker nativo e il confronto del catalogo passano.
   Il progetto restore-test esistente contiene dati e non va azzerato.
2. **Applicazione remota della protezione evidenze:** il controllo automatico
   ha respinto la modifica persistente su Development perché manca autorizzazione
   specifica e il replay isolato era incompleto al momento del rifiuto. Il replay Docker
   nativo ora passa; il collaudo hosted resta aperto. Il database remoto è rimasto invariato.
3. **Attestazioni CI:** la run GitHub 66 passa check completi, 245 test,
   13 test Edge, 20 contratti browser e replay nativo
   sul commit `139fb1b1e73f9af371389c32b24bef800fa8e279`. I limiti di download
   dell’ambiente locale restano documentati. Mancano sessioni utente e scenari di scope HTTP/JWT reali
   e ingestione di attestazioni per singolo requisito commerciale.
4. **Backup/restore:** i worker e il control plane sono presenti; rimangono un
   backup verificato della versione corrente, un restore da artefatto cifrato
   su target isolato e RPO/RTO misurati. Le prove storiche non chiudono questo gate.
5. **Verifica funzionale:** audit puntuale di tutte le sezioni aggiornate,
   UX/API/database/permessi, dati e volumi, privacy, offline e dispositivi revocati.
6. **Go-live:** concorrenza reale, staging HTTPS, accessibilità, carico, chaos,
   dismissione protetta e tre revisioni integrali pulite sullo stesso digest.
   Le integrazioni provider/Epson restano obbligatorie nel profilo FULL.

Dettaglio riproducibile e limiti: [BASELINE_RECOVERY_2026-10-09.md](BASELINE_RECOVERY_2026-10-09.md).
Ordine degli step: [ROADMAP_STATUS.json](ROADMAP_STATUS.json).
Non è stata distribuita una release commerciale né modificato Production.

CI verificata e relativi limiti: [CI_BASELINE_VERIFICATION_2026-10-09.md](CI_BASELINE_VERIFICATION_2026-10-09.md).
