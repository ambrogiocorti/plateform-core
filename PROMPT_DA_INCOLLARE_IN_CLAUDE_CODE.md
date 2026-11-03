# Prompt iniziale da incollare in Claude Code

Sto continuando lo sviluppo del progetto **Plateform**, già presente nel repository
GitHub privato `ambrogiocorti/plateform-core`. Questa cartella contiene il file
`CLAUDE.md` e `docs/plateform-handoff/` con il **Master Prompt completo §§0–157**,
la **Roadmap Step 0–13**, l'addendum, gli audit e l'handoff del 17 ottobre 2026.

**Non ripartire da zero. Non creare un nuovo progetto.** Lavora sul repository esistente,
recuperando e migliorando il codice realmente presente.

Per prima cosa:
1. Leggi integralmente `CLAUDE.md`, il Master Prompt e la Roadmap;
   utilizza il Master più completo che ti ho fornito, non la versione
   precedente §§0–150 del repository.
2. Controlla il branch e lo stato Git, confronta `main` con la PR #41 e le
   PR #32/#33, poi verifica documenti di progresso, SQL, CI e test;
   distingui ciò che è già implementato da ciò che è solo dichiarato.
3. Determina i blocchi **P0 effettivi** e la loro dipendenza, in particolare
   audit, migrazioni, backup/restore, staging/CI e sicurezza. Evita test
   distruttivi e non toccare live/production senza autorizzazione.
4. Procedi realmente, **uno step e una modifica verificabile per volta**:
   codice, DB/migration, RLS, API, UI, error handling, test e documentazione
   necessari alla funzione corrente. Correggi i difetti emersi e riesegui
   i test pertinenti, senza simulazioni o PASS inventati.
5. Al termine di ogni sessione dammi un rapporto con commit/branch, file
   modificati, test passati/falliti/bloccati, rischi, progressi e prossima
   azione. Mantieni aggiornato il registro di avanzamento con evidenze.

Rispetta i vincoli funzionali e commerciali del Master Prompt: vanilla
TypeScript/Vite + Supabase, una catena per installazione, multi-sede
opzionale, ruoli/scopes/RLS, workflow server-authoritative, qualità premium.

La piattaforma non deve essere dichiarata pronta per vendita o production
finché i gate di rilascio e i collaudi reali non sono superati.
