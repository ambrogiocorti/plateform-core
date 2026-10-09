# Collaudo API Supabase nativo — 9 ottobre 2026

Step 0 resta **IN_PROGRESS**. La baseline della PR #5 installa correttamente
lo schema su Supabase Docker; questo intervento aggiunge il collaudo di utenti
reali prima di affrontare l'installazione hosted isolata.

## Perimetro

`scripts/check-native-api.mjs` viene eseguito dal job `native-clean-install`
dopo il replay canonico e la verifica del catalogo. Crea sette identità tramite
GoTrue admin, sei profili staff e due sedi come dati fixture espliciti. Password,
refresh token, device token e segreti TOTP rimangono soltanto in memoria.
Non vengono inserite sessioni Auth/staff fittizie; le sessioni provengono dal
login password e dalle RPC applicative tramite PostgREST.

La configurazione temporanea abilita TOTP mantenendo signup e Auth anonima
disabilitati. Il runner verifica prima di scrivere: endpoint database e API
loopback, rete Docker dedicata senza IPv6/altre reti, binding porte loopback,
regola egress del bridge e substrate PostgreSQL 17/Auth/Storage. Il trasporto
SDK impedisce richieste fuori dall'API loopback e redirect, con timeout.
Il target con fixture preesistenti viene rifiutato; non si effettuano reset.

## Prove previste

- Password login, identità e `session_id` emessi da GoTrue; nessun accesso
  operativo prima di `complete_staff_login`.
- Admin e Super Admin bloccati con `aal1`; enrollment e verifica TOTP reale
  producono `aal2`. Un codice errato non aumenta l'Authentication Assurance Level.
- Due richieste HTTP concorrenti di login della stessa sessione registrano
  esattamente un dispositivo e una sessione operativa.
- SELECT RLS e RPC consentono la sede assegnata e negano quella estranea;
  CHAIN e VENUE vengono confrontati con righe effettivamente presenti.
- `user_metadata` modificabile non può trasformare un Waiter in Super Admin
  o assegnargli una seconda sede; UPDATE diretto del ruolo negato.
- Prenotazione upload idempotente, upload effettivo tramite client server
  locale, finalizzazione RPC e download Storage byte per byte. Documenti
  privati isolati per Admin/sede e negati a anon, Waiter, identità non staff e
  Super Admin tecnico. Scrittura browser diretta e MIME non ammesso negati.
- Refresh mantiene l'identità e la sessione operativa. Lock/PIN, logout
  applicativo e logout GoTrue impediscono il recupero degli accessi con JWT
  precedenti o refresh; una seconda sessione dello stesso utente resta autonoma.
- Revoca dispositivo, rimozione assegnazione e disattivazione staff sono
  iniettate come dati amministrativi fixture: vecchi JWT perdono immediatamente
  accesso HTTP/Storage. Questo non certifica il workflow Edge privilegiato.
- Audit logout osservato; ledger SQL e blocco delle certificazioni PASS restano
  invariati. Nessun requisito commerciale viene marcato verificato.

## Stato delle verifiche

Dieci regressioni mirate passano localmente: sette per confini di connessione,
trasporto, vettori TOTP RFC 6238 e interpolazione UUID, tre per la compatibilità
delle fixture con l'intero schema canonico e il rifiuto di reinizializzazione.
Il runner API nativo richiede Docker/psql, assenti in questa sessione locale;
il collaudo completo viene eseguito nella CI ufficiale, senza sostituire i servizi
con simulazioni. L'esito della nuova run va registrato dopo averlo osservato.

## Evidenze e limiti

Il report `.local/native-ci/api-verification.json` viene salvato anche in caso
di fallimento dopo il controllo del target. Contiene check completati, eventuale
codice errore redatto, commit merge CI, run ID, digest sorgenti e digest del piano
bootstrap/migrazioni/postlude. Viene caricato con il report clean-install;
non include chiavi, JWT, password, segreti TOTP o contenuti scaricati.

Classificazione: `OBSERVED_NATIVE_API_CI_NOT_COMMERCIAL_RELEASE_ATTESTATION`.
Un artefatto GitHub con retention di 14 giorni non sostituisce il canale di
attestazione autenticata per singolo requisito o la conservazione immutabile.

Restano aperti: Supabase hosted, recovery/email, browser/dispositivi reali,
Realtime, concorrenza stock/incassi, Edge HTTP, backup/restore cifrato dello
schema attuale e accettazione commerciale. Development, restore-test e
Production non sono target del runner.
