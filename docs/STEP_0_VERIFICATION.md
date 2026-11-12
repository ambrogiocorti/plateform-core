# Plateform — verifica dello Step 0

Aggiornamento: 3 ottobre 2026. Stato: **DONE**.
Le dipendenze dello Step 0 sono state implementate e verificate. Lo Step 1 può iniziare.
Non è stata prodotta né consegnata una release ZIP.

## Sorgenti e dipendenze

Il checkpoint esistente è stato recuperato e confrontato con il Master Prompt e la
Roadmap forniti dall'utente. Il progetto conserva TypeScript vanilla strict, DOM nativo,
Vite e Supabase. La presenza di moduli di step successivi nel checkpoint non costituisce
una loro verifica o il loro completamento.

È stato creato un nuovo progetto Supabase isolato di sviluppo, `abdxvlykasqmknexxhjo`.
Sono state applicate sequenzialmente le 55 migrazioni già presenti e tre correzioni delle
fondamenta. La cronologia dei file ora coincide con le versioni assegnate dal progetto;
`supabase/migration-manifest.json` conserva anche nomi originali e SHA-256.
I progetti Supabase precedenti non sono stati modificati.

## Implementazioni e correzioni reali

| Requisito                   | Risultato verificato                                                                             | Limite ancora aperto                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Architettura e toolchain    | TypeScript strict, lint, Vite e build separate passano                                           | CI remota e hosting finale nello Step 13                                     |
| Ambienti                    | Validazione development/staging/production, HTTPS fuori development, template distinti           | Staging e production non sono stati provisionati                             |
| URL pubblico/staff          | Validazione separazione su `/staff` oppure origini distinte; asset con base configurata          | Header e routing vanno verificati sull'hosting scelto                        |
| Chiavi e secrets            | Rifiuto chiavi server nella configurazione browser; file privati esclusi dal pacchetto           | Secrets development salvati e verificati via HTTP                            |
| Database                    | 58 migrazioni applicate sul nuovo PostgreSQL Supabase, relazioni e singleton verificati          | Upgrade di vecchie installazioni e restore appartengono alle fasi successive |
| RLS e permessi              | RLS public/private, scope e isolamento sede; grant RPC espliciti; scritture dirette API revocate | Collaudi completi dei singoli moduli nei rispettivi step                     |
| Session security            | MFA claim, session_id esistente, revoca e ruolo server verificati in PostgreSQL reale            | Auth configurata; workflow GoTrue/TOTP nello Step 1                          |
| Validazione e rate limiting | Schema payload, limite body, digest IP; contatore server e parametri errati provati su Supabase  | Contratto hosted collaudato; ricollaudare cambi di gateway                   |
| Request/correlation ID      | Validazione UUID e propagazione indipendente client/Edge/database                                | Roundtrip Edge e telemetry remota verificati                                 |
| Audit                       | Append-only, redazione secrets, context e correlazione provati su database reale                 | Verifica puntuale eventi dei moduli e archiviazione nelle fasi previste      |
| Telemetry e log             | Telemetry distinta dall'audit; correlation ID; log strutturati minimizzati                       | Telemetry attiva e nove eventi correlati verificati                          |
| Secure headers              | CSP, HSTS, nosniff, frame/referrer/permissions policy generate e testate                         | La presenza di `_headers` non prova l'applicazione HTTP                      |

## Difetto di sicurezza corretto

Supabase assegnava grant diretti ad `anon` e `authenticated` oltre al grant PostgreSQL
`PUBLIC`. Revocare soltanto `PUBLIC` lasciava accessibili RPC staff e server. I test locali
precedenti non riproducevano questi default della piattaforma.

La correzione revoca i grant API esistenti, riapplica una manifestazione esplicita dei
permessi autorizzati, protegge i default per nuove funzioni/tabelle e revoca le scritture
dirette sulle tabelle. Il test harness ora riproduce i grant iniziali di Supabase.
Gli utenti anonimi possono eseguire soltanto `get_public_site`, `get_public_menu` e
`get_booking_configuration`. Le RPC riservate al server non sono invocabili dallo staff.

## Evidenze eseguite

- **196 test unitari/database** in 19 file: tutti passati.
- **19 test browser Chromium**: tutti passati. Usano fixture HTTP dichiarate e server Vite,
  quindi non sono prove del servizio Supabase completo.
- **11 test Deno** e check delle 12 Edge Functions: passati.
- TypeScript strict, lint, formato e build pubblico/staff: passati.
- `npm run check:migrations`: 58 versioni e digest verificati.
- `supabase/tests/foundation.live.sql`: eseguito sul PostgreSQL reale con ROLLBACK delle
  fixture. Verifica singleton/sedi, RLS, metadati contraffatti, ruolo/scope, sessioni revocate,
  MFA Super Admin, grant, audit redatto/immutabile, telemetry/correlazione e rate limiting.
- REST PostgREST reale: proiezione pubblica 200; RPC staff/bootstrap/server da anon
  rifiutate con 401 e codice `42501`.
- Controllo Auth reale: raggiungibile; accesso anonimo e signup pubblico disabilitati.
  Dashboard: password 12, JWT 900s, TOTP e redirect esatti verificati.
- 13 controlli HTTP Edge e 10 controlli gateway/rate limiting passati.
- Separazione credenziali server/caller corretta e verificata con una regressione Deno.
- Header IP esplicito CF-Connecting-IP, parsing/normalizzazione IP e prova anti-spoof XFF.
- Nove eventi telemetry correlati, nessun audit economico o system_error per gli errori client.
- Probe temporanea ripristinata con file remoti identici ai sorgenti ordinari.
- Regressione carrello corretta: gli input aggiornano lo stato condiviso e il riepilogo
  attualmente montato, anche quando una riconciliazione sostituisce la vista durante l'editing.

L'advisor continua a segnalare funzioni SECURITY DEFINER intenzionalmente invocabili
e tabelle RLS senza policy intenzionalmente chiuse. Non si dichiara un audit globale pulito.
La revisione di ogni autorizzazione resta parte dei collaudi dei rispettivi moduli.
Riferimenti dell'advisor:
[RLS senza policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy),
[funzioni anon](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable),
[funzioni authenticated](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

## Chiusura dello Step 0

Configurazione e collaudi remoti completati sulla dashboard autorizzata del nuovo
progetto. Evidenze: `docs/REMOTE_CONFIGURATION.md`, report runtime/HTTP/gateway e
immagini delle policy. Le prove hanno rilevato e corretto difetti effettivi nel client
server e nella scelta dell’header IP, senza mascherare il fallimento iniziale.

La suite completa delle fondamenta, Deno e build è stata ripetuta dopo le correzioni.
I test browser con fixture rimangono un controllo dell’interfaccia; non certificano
TOTP, provisioning/reset, Storage, Realtime o un servizio operativo. Tali workflow
sono verificati negli step di competenza. Staging, production e hosting finale
rimangono nell’hardening/go-live, con configurazione e collaudi distinti.

Lo ZIP commerciale richiede tutti gli step DONE con controlli passati, tutte le 151 sezioni
del Master Prompt verificate, i collaudi reali previsti e tre revisioni complete pulite sullo
stesso digest. I test verdi delle fondamenta non dichiarano il prodotto pronto alla vendita.
