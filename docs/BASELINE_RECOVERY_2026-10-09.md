# Recupero baseline — 9 ottobre 2026

Lo Step 0 resta **IN_PROGRESS**. Lo storico SQL e il replay locale sono stati
recuperati; il replay Supabase Docker nativo passa. Restano il collaudo hosted,
le sessioni utente, il restore corrente e la provenienza delle evidenze di rilascio. Nessuna release commerciale è certificata.

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
   con autorizzazioni e grant del catalogo originale, e 31 definizioni obbligatorie
   del catalogo di test assenti dallo storico. La nuova installazione contiene
   tutte le 197 definizioni originali; nessun risultato PASS viene copiato.

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

Il trasporto `psql` aggiunge un delimitatore tra ogni SQL storico e il relativo
INSERT nel ledger: alcuni statement applicati terminano senza punto e virgola.
Il testo registrato e il digest di ciascuna migrazione restano originali.
Il replay nativo ha individuato e verificato questa correzione.

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
autorizzazione remota specifica mancante e replay isolato incompleto al momento
del rifiuto. Il replay Docker nativo ora passa; la migrazione rimane non applicata.
Il progetto remoto conserva le 457 migrazioni
e le evidenze precedenti; la proposta è disponibile nel sorgente per revisione.

## Specifica e verifiche

Il master aggiornato è copiato integralmente dalla fonte fornita: 158 sezioni
§§0–157. Il gate verifica il digest del documento, titoli, ordine e digest di ogni
sezione. Le sezioni nuove o modificate restano pending; CORE esclude soltanto
79, 80 e 90. Nessun requisito avanzato è escluso implicitamente.

- CI run 66, `npm test`: 245 passati, quattro esclusi CORE, 24 file test passati.
- CI run 66: 13 test Edge e 20 contratti browser passati, `npm run check` completo passato.
- `npm run local:source-gates`: passato, inclusi TypeScript, ESLint e Prettier.
- `npm run build`: passati entrambi i bundle production pubblico/staff.
- `npm run check:clean-install` e `check:migrations`: passati.
- `requirements`, `release:check` e `release:zip`: blocco previsto con requisiti
  e dossier incompleti; nessun archivio commerciale prodotto.

Formattazione Prettier riallineata per rendere ripetibile il gate già previsto;
gli SQL applicati e il master originale non vengono formattati.

## Collaudo Supabase Docker nativo

La run GitHub 66 sul commit `139fb1b1e73f9af371389c32b24bef800fa8e279`
verifica lo stesso installatore tramite `psql` su PostgreSQL **17.11**, con
Auth, Storage e PostgREST reali e senza adattatori applicativi. Bootstrap,
458 migrazioni, postlude e digest del ledger passano; i sette cataloghi
corrispondono al riferimento e il dizionario contiene **197 definizioni**.
Confrontati chiave, categoria, obbligatorietà e descrizione, con ordine ASCII
indipendente dalla locale PostgreSQL.

Il replay conserva 25 dichiarazioni PASS già scritte nello storico come
`UNVERIFIED_LEGACY_CLAIM/PENDING`. Le sette dichiarazioni manuali di gate
Development non sono presenti in un database nuovo; due fixture esplicite
di upgrade verificano la conservazione esatta di evidenza, autore e data
prima/dopo la migrazione. La nuova installazione ha **zero PASS** e il gate
commerciale resta negativo con 197 prove obbligatorie.

Verificati quattro tentativi di successo non attestato (RPC e scritture dirette),
rifiuto della reinstallazione senza variazione del ledger, health HTTP di
Auth/Storage e gate PostgREST con JWT service-role locale; JWT anonimo negato.
Cinque container su bridge dedicato, porte loopback, IPv6 disattivato ed egress
bloccato da regola verificata; cron disattivato prima dello storico. La sola
configurazione del server usa l’amministratore del container; l’installatore
applicativo usa `postgres`. Nessuna credenziale o dato operativo Development
viene copiato. Report originale e log sono conservati nelle evidenze CI.

## Limiti ancora aperti

PGlite usa adattatori espliciti Auth/Storage/Vault/cron e serializza le richieste.
Il replay nativo copre ora trasporto `psql`, piattaforma locale e i controlli
HTTP indicati; non certifica login/TOTP/sessioni utente, scope multi-sede,
Realtime, contesa simultanea, invocazione Edge hosted o Storage upload/download.
Non esegue un restore da backup dello schema corrente. I worker storici con
riferimenti fissi Development richiedono verifica/configurazione prima di un
installatore cliente; nel replay non sono eseguiti automaticamente.

La capacità Supabase per ottenere costo/provisionare un nuovo target hosted
isolato non è disponibile nella connessione corrente; restore-test esistente
non è stato toccato. Nel solo ambiente locale i download Deno/Chromium restano
limitati; le categorie Edge/browser passano su GitHub. La CI tecnica non popola
le attestazioni commerciali: restano ingestione autenticata, log immutabili,
binding commit/schema per singolo requisito, audit delle 158 sezioni e tre
revisioni integrali pulite. Migrazione Development ancora non applicata.
Vedere `CI_BASELINE_VERIFICATION_2026-10-09.md`.
