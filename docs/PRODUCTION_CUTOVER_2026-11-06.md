# Passaggio del sito al progetto production — 6 novembre 2026

## Richiesta e destinazione

Il proprietario ha autorizzato il passaggio del sito pubblicato a
`plateform-production` (`xzateqavvaparjoybbhr`), per poter successivamente
dismettere `plateform-staging`. La base grafica approvata è il commit `c696dd8`
della PR #60. Il contenuto applicativo di production resta quello del SACER;
non vengono importati gli ordini e i pagamenti della Trattoria E2E di staging.

## Preparazione verificata

- Entrambi i database registrano 496 migrazioni, con lo stesso fingerprint.
- Coincidono inoltre i fingerprint correnti di definizioni delle funzioni
  SQL pubbliche/private, colonne, policy e flag RLS. Il controllo riguarda
  lo schema applicativo effettivo, non soltanto la cronologia.
- Production restituisce il sito `Ristorante SACER` e una sede tramite le
  RPC pubbliche. Il menu non contiene piatti: nessun contenuto di collaudo
  viene aggiunto per mascherare questo stato.
- Le origini GitHub Pages sono già ammesse in production: i preflight dei
  servizi browser rispondono HTTP 204 con l'origin esatto.
- Le 21 Edge Functions sono state aggiornate dai sorgenti della candidata
  già verificata, conservando `verify_jwt` e le verifiche applicative.
  Prima della sostituzione sono stati acquisiti i sorgenti delle 21 versioni
  precedenti per il rollback. Nessuna migrazione o modifica ai dati commerciali.

## Collegamento del frontend

I due workflow Pages usano l'ambiente GitHub `Production` con `SUPABASE_URL`
e `SUPABASE_PUBLISHABLE_KEY`. La chiave del browser resta separata dai sorgenti.
Il controllo precedente alla build richiede il riferimento esatto di production
e rifiuta un URL di un altro progetto prima di eseguire la RPC pubblica.

Il percorso `/plateform-core/` mantiene la modalità di hosting Pages `test`
per i prefissi degli asset e l'esclusione dai motori di ricerca. Questo valore
non sceglie più un secondo database cloud: il runtime del frontend è production.
La pubblicazione non costituisce certificazione di un rilascio commerciale.

## Verifica finale e rollback

Prima di dichiarare concluso il passaggio: completare il job Pages sul nuovo
commit, verificare in HTTPS nome del ristorante, menu e accesso staff, controllare
che i bundle pubblicati contengano il riferimento production e nessun riferimento
staging, e confermare il collegamento Auth al progetto corretto.

Durante il passaggio l'artefatto precedente della PR #60 resta disponibile come
rollback del sito; i sorgenti Edge precedenti sono conservati separatamente.
Le configurazioni Auth e i risultati HTTP vanno riportati nell'evidenza finale
della PR. Stato di questo registro: **IN PROGRESS** fino al deploy verificato.

## Dismissione di staging

Questo intervento cambia il backend del sito e non cancella progetti. I dati
e i file di staging non sono trasferiti automaticamente in production.
L'eliminazione definitiva di staging richiede che eventuali contenuti da
conservare siano stati esportati e verificati: i backup associati a un progetto
Supabase vengono eliminati insieme al progetto. Le prove di ripristino ospitato,
provider e stampante restano distinte dal cambio di collegamento del frontend.
