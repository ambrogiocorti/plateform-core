# Staging hosted Plateform — 9 ottobre 2026

`plateform-staging-clean`, ref `kghactswtabakkkbojmo`, è attivo su Free
nell'organizzazione AmbrogioCorti, Irlanda `eu-west-1`, PostgreSQL 17.11.
Il preflight API ha osservato zero utenti/sessioni Auth, oggetti/bucket Storage,
relazioni applicative public/private e migrazioni. Development non è stato
modificato. Il restore-test preesistente resta in pausa senza reset/drop.

## Trasporto temporaneo per l'installazione

L'installer usa le credenziali server predefinite di Edge Functions all'interno
di Supabase. Non le restituisce né le scrive in artefatti o log. Il corpo HTTP
ammette soltanto `prepare`, `replay`, `finish`; non ammette SQL, URL, credenziali
o versioni scelti dal chiamante. Il payload completo e ciascuna migrazione
sono verificati con SHA-256 prima di aprire la connessione.

La distribuzione è legata soltanto al nuovo ref, all'API e al database diretto
di quel ref e al ruolo postgres. Richiede JWT del gateway e un token casuale
di 256 bit separato, verificato tramite la sua impronta. Il codice scade entro
un'ora e viene sostituito da una risposta inerte al termine. Token e file
di distribuzione generati rimangono in `.local/hosted-installer`, esclusa da git.
L'accesso concorrente è escluso da un advisory lock di sessione; ogni fase
ricontrolla dati Auth/Storage, barriera Cron e prefisso del ledger.

Il trasporto esegue gli stessi bootstrap/postlude e i 458 SQL del piano canonico,
conservando versione, nome e testo originali nel ledger. Nessuna riga di storico
applicato viene cancellata, rinominata o riscritta. Non usa apply_migration per
re-timestampare le 457 migrazioni storiche recuperate; usa un client Postgres
server-side con dipendenza `postgres@3.4.9` bloccata a versione esatta.

## Barriera Cron prima del replay

Il progetto hosted parte con `cron.launch_active_jobs=on`, una configurazione
SIGHUP che il ruolo postgres non può modificare come superuser. Il file
versionato `supabase/clean-install/disarm-cron.sql` installa pg_cron e un trigger
su `cron.job` che forza `active=false` su INSERT e UPDATE. Rifiuta una tabella
job già popolata. Tutti i cron.schedule storici restano identici; gli indirizzi
Development presenti in vecchi worker non vengono invocati automaticamente.

La barriera è un controllo della piattaforma staging nel namespace
plateform_installation, fuori dal catalogo applicativo public/private. Rimane
attiva dopo il replay. L'attivazione futura dei worker richiede configurazione
degli endpoint/segreti per il singolo ambiente e una modifica esplicita del
controllo; l'installazione non certifica operatività di backup/messaggistica.

La CI nativa mantiene anche il blocco globale Cron e il blocco dell'egress Docker.
Collauda la barriera con il ruolo postgres, tentando sia cron.schedule sia
UPDATE active=true, poi verifica che il replay completo lasci zero job attivi
e zero esecuzioni. Le prove del confine HTTP coprono credenziali mancanti,
scadenza, altro target, SQL fornito dal client, payload/storico alterati,
contesa del lock e redazione degli errori driver.

## Stato di questo checkpoint

Codice preparato e otto regressioni locali passate; TypeScript e lint passano.
Distribuzione, replay hosted e cataloghi hosted ancora da eseguire dopo la CI.
Nessun PASS commerciale viene scritto. Step 0 resta IN_PROGRESS.

Evidenza del progetto vuoto:
[hosted-staging-created-2026-10-09.json](evidence/hosted-staging-created-2026-10-09.json).
L'osservazione precedente del modulo pronto rimane conservata come checkpoint
storico e non viene reinterpretata come installazione riuscita.
