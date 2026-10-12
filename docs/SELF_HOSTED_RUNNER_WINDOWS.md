# Plateform — GitHub Actions sul PC Windows (self-hosted)

## Scopo

Evita di consumare i minuti GitHub-hosted della quota mensile durante i controlli di sviluppo.
Il workflow `.github/workflows/ci.yml` ora usa solo `workflow_dispatch` (avvio manuale),
solo il branch verificato `main`, e richiede un runner con etichette
`self-hosted`, `Windows`, `X64`, `plateform-local`.

**Non è una pipeline di release commerciale** e non effettua deploy, migrazioni,
backup, restore o test contro il database reale. Non impostare segreti
production/staging sul computer del runner.

## Sicurezza

- Il repository deve restare privato e l'accesso in scrittura va limitato a utenti fidati.
- Evitare eventi automatici `pull_request`, `pull_request_target`, `push` su
  branch arbitrari e qualsiasi checkout di ref introdotti da terzi.
- Usare preferibilmente un **account Windows locale standard dedicato** o una
  macchina dedicata; non eseguire il runner come amministratore e non usarlo
  con profili browser o SSH personali disponibili.
- Non configurare il runner come servizio automatico sulla macchina personale.
  Avviarlo con `run.cmd` soltanto quando serve e interromperlo con Ctrl+C.
- Il runner esegue codice dal repository. Verificare e proteggere `main`
  (branch protection/rulesets, review delle modifiche ai workflow).
- Non inserire token di registrazione, `.env.local`, password o API key nel
  repository, nei log GitHub o nella chat.
- Isolare sempre il runner da dati production, file personali e segreti locali.
  L'installazione sul PC principale è un compromesso di sicurezza: una VM
  o computer dedicato resta preferibile.

## Installazione (azione necessaria sul PC Windows x64)

1. Aprire <https://github.com/ambrogiocorti/plateform-core/settings/actions/runners>
   e scegliere **New self-hosted runner**.
2. Selezionare **Windows** e **x64**.
3. Accedere a Windows con l'account standard dedicato, quindi aprire PowerShell
   **senza privilegi amministrativi**.
4. Usare i **comandi di download ed estrazione mostrati da GitHub** per la
   versione corrente del runner in una directory accessibile al solo account
   del runner (es. `$env:USERPROFILE\plateform-actions-runner`).
   Non copiare un URL/versione del runner da istruzioni vecchie.
5. Eseguire il `config.cmd` mostrato nella pagina, usando **solo** il token
   temporaneo visualizzato da GitHub. Non incollare mai qui quel token.
6. Quando richiesto:
   - Runner name: `plateform-local-win`
   - Additional labels: `plateform-local`
   - Work folder: lasciare `_work`
   - Windows service: **No**, per l'uso manuale.
7. Avviare ` .\run.cmd ` nella directory del runner. Lasciare PowerShell
   aperto durante l'esecuzione. La pagina Runners deve mostrarlo `Idle`.

Il token di registrazione è temporaneo: se scade, generarne uno nuovo
dalla stessa pagina di impostazioni.

## Avvio della pipeline

Il workflow modificato deve essere prima revisionato e unito su `main`.
La PR non viene unita automaticamente perché un push su `main` può
innescare altri sistemi, compreso il deploy Git/Vercel.

1. Aprire <https://github.com/ambrogiocorti/plateform-core/actions>.
2. Selezionare **Plateform development checks (local Windows)**.
3. Premere **Run workflow**, scegliere `main` e `quick`.
4. Dopo un run `quick` verde, eseguire `full` per tutti i controlli
   di sorgente, Edge, database fixture, build e Playwright.
5. Controllare log, exit code e commit SHA. `PASS` significa controlli
   locali superati, **non** test live/staging/sicurezza certificati.

`quick` esegue `npm ci`, Prettier, inventario migrazioni locale,
TypeScript, ESLint, unit test e build.
`full` esegue `npm ci`, `npm run check`, Chromium e Playwright E2E.

Il PC deve rimanere acceso, online e con `run.cmd` aperto. Se è spento,
i job restano in coda: non equivale a test riuscito.

## Limiti operativi

- GitHub-hosted `staging-readiness.yml` resta un workflow distinto,
  manuale e ancora dipendente dai suoi gate/runner e credenziali.
- `maintenance.yml` continua a essere un workflow di retention separato,
  abilitato soltanto dalla sua configurazione.
- In una futura release production riattivare una CI isolata con controlli
  su staging, revisione e test contro infrastruttura reale. Non usare
  l'esito delle fixture locali per marcare `P0`, `P1`, `P2` come conclusi.
- Se `main` non ha protezione, prima di distribuire software a clienti
  attivare ruleset / branch protection e review obbligatoria.

## Riferimenti

- <https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners>
- <https://docs.github.com/en/actions/reference/security/secure-use>
- <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
