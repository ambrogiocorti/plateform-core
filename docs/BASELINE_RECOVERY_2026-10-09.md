# Recupero baseline — 9 ottobre 2026

Lo Step 0 resta **IN_PROGRESS**. Lo storico SQL e il replay locale sono stati
recuperati; il collaudo su Supabase isolato e la provenienza delle evidenze
di rilascio restano aperti. Nessuna release commerciale è certificata.

## Storico canonico

Base sorgente: `bba9b44cc2af738aff0ad0c0cfd99b80a2c749c8` di
`ambrogiocorti/plateform-core`. Al controllo Development contiene 457 migrazioni,
ultima `20261009001127`. Recuperati 324 file assenti nel checkpoint da 133 file;
24 file già presenti differivano dal SQL originale applicato e sono stati
riconciliati con lo storico remoto, conservando gli originali nel parent Git
e nei backup locali della procedura. Il database non è stato riscritto.

Impronta indipendente delle 457 migrazioni, calcolata sulle righe
`version:name:sha256` ordinate e separate da newline:

```text
ae79b608e86dfe6c7ca8dd93c88170cdd4dc38dd6324ccb3391342b135a59f41
```

I 457 SQL applicati restano immutabili. Il manifest locale contiene inoltre
`20261009003541_release_evidence_fail_closed`, preparata e non applicata:
458 file complessivi. `check:clean-install` verifica separatamente le impronte
di bootstrap, postlude, storico canonico e inventario completo.

## Installazione da zero

Il solo replay delle migrazioni falliva: alcune funzioni storiche dipendono da
sette tabelle private create fuori dallo storico. Due RPC usate dal frontend
erano anch'esse presenti soltanto nel catalogo live. La pipeline esplicita è:

1. `supabase/clean-install/bootstrap.sql`: sette tabelle vuote, RLS attiva,
   nessun accesso diretto anon/authenticated/service_role, nessuna chiave o payload iniziale.
2. Tutti i file SQL ordinati, con il testo originale registrato nel migration ledger.
3. `supabase/clean-install/postlude.sql`: le due RPC operative recuperate,
   con autorizzazioni e grant del catalogo originale.

Il bootstrap rifiuta schemi applicativi già popolati o uno storico migrazioni
non vuoto prima di scrivere. L'installatore non esegue reset/drop. Un errore
intermedio interrompe la procedura; un database parzialmente installato richiede
diagnosi su quel target sacrificabile, non un tentativo automatico su dati esistenti.

Su un nuovo progetto Supabase isolato, con `psql` disponibile e connection URL
iniettata nell'ambiente del processo, il comando è:

```sh
npm run db:install
```

Richiede `SUPABASE_DB_URL`; usa TLS e passa i segreti solo nell'ambiente del
processo figlio, mai negli argomenti o nei log. Il SQL temporaneo ha permessi 0600
ed è rimosso al termine. Non utilizzare questa procedura su Development,
restore-test esistente o installazioni cliente. Gli upgrade usano soltanto
migrazioni successive dopo collaudo e verifica della versione di partenza.

Le tabelle recuperate sono elencate nel manifest e documentate in
`evidence/clean-install-catalog-2026-10-09.json`. Le RPC operative sono
`get_account_transfer_targets(uuid)` e `get_order_change_center(uuid)`.
`private.debug_menu_experience_e2e()` e
`public.continuity_rehearsal_export_chunk(uuid, integer, integer, text)` usano
identificatori fissi di Development: sono catalogate, ma non installate né eseguite
come flussi cliente o prove di rilascio.

## Confronto del catalogo

`npm run check:clean-install` non accede a un database remoto. Esegue il replay
PGlite con il medesimo piano versionato e lo confronta con il catalogo acquisito
in sola lettura da Development.

| Oggetti    | Riferimento live | Replay locale | Esito                                                  |
| ---------- | ---------------: | ------------: | ------------------------------------------------------ |
| Relazioni  |              163 |           163 | Nessuna differenza                                     |
| Routine    |              553 |           552 | Escluse due diagnostiche, aggiunto un controllo        |
| Trigger    |              311 |           313 | Aggiunti i due blocchi delle certificazioni            |
| Colonne    |            1.485 |         1.485 | Tipi, default, nullabilità e generazione corrispondono |
| Indici     |              444 |           444 | Definizioni corrispondenti                             |
| Vincoli    |              903 |           903 | Definizioni corrispondenti                             |
| Policy RLS |              110 |           110 | Ruoli, comandi e predicati corrispondenti              |

La comparazione normalizza esclusivamente la qualificazione opzionale
`public`/`extensions` nelle espressioni SQL decompilate; le identità rimangono
esatte. La rappresentazione PG18 dei vincoli `NOT NULL` (`contype=n`) è esclusa
dal conteggio dei vincoli: la nullabilità viene confrontata separatamente per
tutte le colonne. Routine: verificate identità e proprietà SECURITY DEFINER;
questo confronto non certifica ogni corpo PL/pgSQL o comportamento concorrente.

## Evidenze di rilascio

Lo storico remoto contiene 197 risultati test `PASS` e sette gate manuali `PASS`;
non presenta il binding verificabile a CI autenticata e artefatti immutabili
necessario per usarli come certificazione della release corrente.

La nuova migrazione riclassifica questi risultati `PENDING`, conservando stato,
evidenza, autore e data precedenti. Blocca `PASS` attraverso le RPC legacy e
trigger sulle due tabelle, aggiunge `RELEASE_EVIDENCE_PROVENANCE` obbligatorio
e impedisce un gate positivo con catalogo obbligatorio vuoto.
Non esiste ancora un nuovo writer di attestazioni CI: fino alla sua realizzazione
ogni certificazione positiva resta bloccata. Non è una chiusura completa del
problema di provenienza, ma una protezione contro certificazioni non dimostrate.

Il controllo automatico ha respinto l'applicazione persistente su Development:
autorizzazione remota specifica mancante e replay isolato incompleto. Non è stata
tentata un'applicazione indiretta. Il progetto remoto conserva le 457 migrazioni
e le evidenze precedenti; la proposta è disponibile nel sorgente per revisione.

## Specifica e verifiche

Il master aggiornato è copiato integralmente dalla fonte fornita: 158 sezioni
§§0–157. Il gate verifica il digest del documento, titoli, ordine e digest di ogni
sezione. Le sezioni nuove o modificate restano pending; CORE esclude soltanto
79, 80 e 90. Nessun requisito avanzato è escluso implicitamente.

- `npm test`: 242 passati, quattro esclusi CORE, 24 file test passati.
- `npm run local:source-gates`: passato, inclusi TypeScript, ESLint e Prettier.
- `npm run build`: passati entrambi i bundle production pubblico/staff.
- `npm run check:clean-install` e `check:migrations`: passati.
- `requirements`, `release:check` e `release:zip`: blocco previsto con requisiti
  e dossier incompleti; nessun archivio commerciale prodotto.

Formattazione Prettier riallineata per rendere ripetibile il gate già previsto;
gli SQL applicati e il master originale non vengono formattati.

## Limiti ancora aperti

PGlite esegue PostgreSQL reale in WASM, ma usa adattatori espliciti Auth/Storage,
Vault e cron; il DDL applicativo proviene dal piano versionato. Non certifica
GoTrue, PostgREST, websocket, Storage HTTP o contesa tra connessioni separate.
Il PostgreSQL nativo non è stato avviato per limiti di permessi dell'ambiente.
La capacità Supabase per ottenere costo/provisionare un nuovo target isolato
non è disponibile nella connessione corrente; restore-test esistente non è stato toccato.

I check/test Edge sono bloccati dal recupero delle dipendenze Deno/JSR/npm.
Il download Chromium è fallito; nessun Playwright E2E è stato eseguito.
`npm run check` complessivo non passa finché tali dipendenze non sono disponibili.
Restano CI con prove autentiche, installazione e restore Supabase isolati,
integrazione HTTP/JWT, audit della specifica e tre revisioni complete pulite.
