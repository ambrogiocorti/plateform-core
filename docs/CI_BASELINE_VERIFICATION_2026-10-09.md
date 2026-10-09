# CI baseline — 9 ottobre 2026

La run GitHub **54** sul commit
`3f35d78a0bb6a2e80772393bcc01327980504dbf` è completata con esito **success**.
[Run verificata](https://github.com/ambrogiocorti/plateform-core/actions/runs/37885540456).
Passano installazione dipendenze, formato, `npm run check` completo (inclusi
Edge, test unit/database e build), installazione Chromium, browser gate della
build e **20 test Playwright**. Test unit/database: **242 passati, 4 esclusi CORE**.

La prima esecuzione aveva 13 test browser passati e sei falliti. I controlli
cassa erano nascosti nella sezione secondaria non aperta dai test; Host cercava
nomi di azioni precedenti; le fixture pubbliche e tecniche omettevano le RPC
navigation/continuity introdotte successivamente. Aggiornati i quattro file
E2E per usare i percorsi reali e risposte conformi agli schemi correnti.
Conservate le verifiche su importi, step-up e isolamento di ruolo. Una nuova
prova verifica che il cambio tavolo non invii il comando prima della conferma,
poi controlla destinazione, flag di conferma e versione ottimistica.

I log catturati e il binding run/commit sono in
`evidence/baseline-ci-verification-2026-10-09.json`. I limiti locali di download
Deno/Chromium rimangono documentati come osservazioni dell'ambiente locale;
questa CI ha eseguito quelle categorie su GitHub.

I test browser usano fixture HTTP esplicite. Questo esito non certifica Auth,
PostgREST, Realtime, Storage HTTP, concorrenza nativa o installazione Supabase
isolata. Non popola i risultati commerciali nel database. Servono ancora
attestazioni per singolo test obbligatorio, log immutabili e ingestione CI
autenticata con binding commit/schema. La migrazione fail-closed resta
preparata e non applicata su Development. Step 0 IN_PROGRESS; release bloccata.
