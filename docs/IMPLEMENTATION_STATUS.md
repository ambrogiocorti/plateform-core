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
  versionati e condivisi dall'installatore reale e dai test.
- Replay PGlite senza DDL applicativo nascosto: **242 test passati, 4 esclusi CORE**.
  TypeScript strict, ESLint, gate sorgente, formattazione e build pubblico/staff passano.
- Confronto del catalogo: 163 relazioni, 1.485 colonne, 444 indici, 903 vincoli e
  110 policy RLS corrispondono. Due strumenti diagnostici specifici di Development
  restano esclusi; i soli oggetti aggiunti sono il nuovo controllo delle evidenze.
- Preparata una protezione che riclassifica i vecchi `PASS` come dichiarazioni
  non verificate, ne conserva evidenza/autore/data e impedisce nuovi `PASS`.
  Il canale CI autenticato con log immutabili e binding commit/schema è ancora aperto.

Le evidenze locali non certificano Supabase ospitato: Auth, Storage, Vault e cron
usano adattatori di piattaforma espliciti nel test harness. PGlite serializza
le richieste e non prova contesa tra connessioni separate. I risultati storici
nei documenti precedenti non certificano la versione attuale.

## Gate aperti

1. **Step 0, IN_PROGRESS:** installazione completa su un nuovo Supabase isolato,
   confronto del catalogo e prove HTTP/JWT di Auth, RLS, Storage, Realtime ed Edge.
   Il progetto restore-test esistente contiene dati e non va azzerato.
2. **Applicazione remota della protezione evidenze:** il controllo automatico
   ha respinto la modifica persistente su Development perché manca autorizzazione
   specifica e il replay isolato è incompleto. Il database remoto è rimasto invariato.
3. **CI e browser:** la run GitHub 54 passa check completi e 20 contratti browser
   sul commit `3f35d78a0bb6a2e80772393bcc01327980504dbf`. I limiti di download
   dell’ambiente locale restano documentati. Mancano integrazioni HTTP/JWT reali
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
