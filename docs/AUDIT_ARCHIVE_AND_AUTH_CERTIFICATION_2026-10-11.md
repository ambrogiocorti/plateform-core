# Plateform — Archivio Audit e verifica Auth (11 ottobre 2026)

**Ambiente:** Supabase `plateform-development` (`abdxvlykasqmknexxhjo`); progetto replica `plateform-restore-test` (`dkbjgvovxgglqhqxmuyb`).

**Certificazione limitata ai fatti testati.** Non significa certificazione legale di conservazione a norma o prontezza commerciale.

## Stato reale e recuperabilità

- PostgreSQL Development: 475 migrazioni remote; database circa 63 MB; **3.235 righe audit originarie preservate**.
- Storico archiviato: **3.235/3.235 eventi**, in 17 blocchi cifrati AES-256-GCM in bucket **privati** e separati:
  - origine: `plateform-audit-archive-primary`;
  - replica: `plateform-audit-archive-replica` nel secondo progetto.
- Ogni blocco include una lista ordinata dei record audit con campo `metadata`, IP, User-Agent e `authorization_context` esclusi dall'esportazione. Il contenuto è cifrato prima dell'upload; ogni blocco genera SHA-256 del plaintext, ciphertext e una catena SHA-256 che collega la sequenza di batch.
- `private.audit_archive_batches` è append-only nello sviluppo; `private.audit_archive_witness` è append-only nel database replica. Le RPC di lettura/scrittura dei checkpoint sono concesse solo a `service_role`.
- **Verifica di recupero reale PASS:** file scaricati dal bucket primario e dalla replica, SHA-256 controllati, decifrati con AES-GCM, JSON e numero di eventi recuperati convalidati, catena verificata. Risultato 17 batch e 3.235 righe senza differenze. Prova salvata in `private.audit_archive_verification_runs`.
- Protezioni negative validate in transazione con rollback: UPDATE di un witness rifiutato, tentativo di testimoniare una catena falsa rifiutato. I file non sono stati rimossi o modificati.
- Ogni 15 minuti `plateform-audit-archive-encrypted` archivia nuovi eventi con almeno 5 minuti di ritardo (massimo cinque batch da 200 per run). Alle 03:17 UTC `plateform-audit-archive-recovery-verify` confronta e recupera i più recenti 25 batch; la prima prova ha coperto l'intero storico allora presente. La rotazione delle partizioni future è distinta da questa archiviazione.
- `/salute` mostra gli eventi archiviati, gli eventi ancora da archiviare, l'ultimo esito di recovery e lo stato della cattura Auth provider. La UI è fail-closed se la RPC non risponde.

### Gestione delle chiavi: limite dichiarato

AES-256-GCM usa una chiave derivata dal token di canale delle repliche di continuità con separazione di contesto. Il token di recupero è conservato anche nel progetto replica e il suo escrow è stato verificato **senza esporlo**. Non ruotare/eliminare il token storico prima di re-cifrare l'archivio e provare nuovamente il restore. Per una distribuzione commerciale occorre separare le chiavi Audit dalle credenziali del canale, preferendo un KMS dedicato, versionamento delle chiavi, controlli di accesso e un piano di rotazione/recupero testato.

**Non è WORM:** i bucket privati Supabase proteggono gli accessi ordinari, ma un amministratore del provider o un ruolo infrastrutturale altamente privilegiato potrebbe modificare/annullare le copie. Un vero obbligo di conservazione immutabile richiede un archivio esterno con Object Lock/retention enforcement e relative prove contrattuali, organizzative e tecniche. Non presentare l'implementazione attuale come conservazione a norma.

## Retention e privacy

- **Audit commerciale, finanziario e sicurezza:** nessun purge automatico attivo; non cancellare eventi finché non esistono policy approvate, archiviazione esterna adeguata e prove di restore e cancellazione selettiva (privacy compliance).
- **Log tecnici di salute:** funzione `run_health_log_retention` predisposta, ma inattiva per `restaurant_settings.retention.enabled=false`. L'attivazione richiede `configured_at` e giorni di conservazione validi. Non impostare automaticamente un periodo legale.
- **Audit Auth:** conservazione nel provider separata da PostgreSQL; includere nella valutazione privacy anche IP e user agent che Supabase può registrare nei propri audit nativi. Plateform espone soltanto la categoria d'azione redatta e lo stato di raccolta, senza copiare payload sensibili.

## Login iniziali e MFA falliti — gate ancora NON superato

La documentazione Supabase (`https://supabase.com/docs/guides/auth/audit-logs`) descrive le azioni `login` e `verification_attempted`, ma il codice dell'azione da solo **non dimostra un esito fallito**.

- **Verifica reale:** una richiesta di login usando indirizzo fittizio inesistente e password volutamente errata ha restituito HTTP 400 `invalid_credentials`; `auth.audit_log_entries` è rimasta a **0 righe**.
- La configurazione ospitata GoTrue per scrivere gli audit nel DB non è modificabile dalle RPC SQL/Edge disponibili in questa sessione. **Operazione necessaria nella dashboard:** Supabase → progetto `plateform-development` → Authentication → Audit Logs → abilitare **Write audit logs to the database**. Questo incrementa la dimensione DB: controllare quota/retention.
- Dopo l'attivazione, eseguire un login staff riuscito e fallito su account di test, e una verifica MFA riuscita e fallita su un account di test realmente iscritto a MFA. Confermare eventi nel DB e **verificare prima la presenza di un campo di esito attendibile**: non dedurre FAILURE dall'azione `login` o `verification_attempted` senza evidenza provider. Se il provider non espone l'esito, sviluppare un gateway Auth server-side adeguatamente rate-limited, non affidarsi a eventi di errore inviati dal browser.
- La RPC Super Admin `get_auth_audit_readiness` segnala `DATABASE_SINK_NOT_VERIFIED` se non ci sono eventi e `NATIVE_EVENTS_PRESENT_OUTCOMES_UNCLASSIFIED` altrimenti. Le due bandiere di certificazione `login_failures_certified` e `mfa_failures_certified` restano false in assenza di prova autorevole.

## Sicurezza, test e stato di rilascio

- Test live: 3.235 eventi ripristinati dai due progetti, hash e sequenza coincidono; prove negative SQL di tampering PASS.
- Test PGlite GitHub Actions focalizzati: include controlli su lease, sequenza, falsi hash, ruoli e immutabilità, oltre ai test Audit/Log precedenti. La CI focalizzata non dimostra che una installazione riproduca tutte le 475 migrazioni.
- Persistono blocchi indipendenti: full CI e test browser cassa/configurazione, riconciliazione dell'intera migrazione GitHub-Supabase, test GoTrue/MFA reali, WORM esterno/KMS e approvazione policy di conservazione. L'ultimo backup generale deve essere aggiornato alle nuove migrazioni prima del go-live.
- **Stato commerciale: NO-GO.** Conservare PR come draft; non pubblicare come prodotto vendibile e non generare ZIP finché non sono soddisfatti i gate.
