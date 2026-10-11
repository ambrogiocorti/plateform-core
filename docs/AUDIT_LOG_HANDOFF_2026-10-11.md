# Plateform — Consegna tecnica Audit/Log e gate commerciali (11 ottobre 2026)

**Fonti di progetto:** Master Prompt, sezioni 100–107 (Security & Business Audit Log, separazione da Telemetry, attributi, immutabilità, dashboard, redazione dati sensibili, audit automatico, scalabilità); Roadmap, requisiti trasversali e Definition of Done.

**Verifica live: 11/10/2026 ore 17:58 UTC. Ambiente:** Supabase `plateform-development`, replica su `plateform-restore-test`. **Ultima migrazione:** `20261011175254_audit_certification_fail_closed_release_gates.sql`.

## Verificato dal sistema reale

| Controllo | Evidenza | Risultato |
|---|---|---|
| Audit applicativo append-only | UPDATE di un evento esistente rifiutato in transazione con ROLLBACK | PASS |
| Login staff con credenziali errate | GoTrue respinge credenziali sintetiche, gateway scrive `AUTH_LOGIN_FAILED` senza password, email, token o IP | PASS, 1 evento |
| MFA priva di sessione attendibile | Richiesta browser non autenticata respinta; RPC servizio rifiuta sessione fittizia | PASS sicurezza negativa |
| MFA errata su fattore TOTP verificato | Nessun evento `MFA_VERIFICATION_FAILED` osservato, manca test con account TOTP dedicato | NON CERTIFICATO |
| Audit Auth nativo Postgres | `auth.audit_log_entries` contiene 0 righe | NON CERTIFICATO |
| Archivio cifrato AES-256-GCM | 3.245 eventi in 20 blocchi privati nel primario, con 20 witness e 3.245 eventi attestati nel progetto replica | PASS |
| Recuperabilità completa archivio | 11/10/2026 17:51:31 UTC: scaricati e decifrati i 20 blocchi da primario e replica, confrontati SHA-256 e catena | PASS |
| Integrità witness esterno | UPDATE sul witness rigettato, test SQL con ROLLBACK | PASS |
| Governance retention | `legal_hold=true`, `purge_enabled=false`; modifica diretta dei flag bloccata | PASS |
| Restrizioni API | `anon` non ha EXECUTE su `get_audit_certification_gates`, né sulla scrittura dei rifiuti di autenticazione | PASS |
| Storage | Bucket privati; nessuna policy di SELECT per i bucket Audit concessa a client pubblici | PASS configurazione corrente |
| CI GitHub recente | Job falliti prima delle normali fasi; log con BlobNotFound; test della versione più recente non certificati | BLOCCATO |
| Immutabilità WORM indipendente | Due progetti Supabase, ma non storage Object Lock/compliance certificato | NON CERTIFICATO |
| Chiavi indipendenti/KMS e tempi legali | Key custody indipendente e retention formalmente approvata assenti | NON CERTIFICATO |

## Interventi conclusi in questa verifica

- Nuova RPC read-only `public.get_audit_certification_gates`, Super Admin-only, per impedire di dichiarare certificato un sistema con prove mancanti. Rende visibili dieci famiglie di controlli (Auth, MFA, backlog, recuperabilità, legal hold, WORM, custodia chiavi e policy).
- Dashboard tecnica aggiornata per visualizzare esito della certificazione e codici precisi dei blocchi.
- Regression test aggiunto a `tests/database/audit-professional.test.ts`: non può risultare `AUDIT_CERTIFIED` con MFA, audit Auth nativo, WORM, custodia chiavi e retention non certificati; accesso staff non autorizzato rifiutato. **Il test non può essere dichiarato PASS fino a un runner GitHub effettivamente eseguito.**
- Test negativi reali in transazione rollback: autenticazione MFA fittizia rifiutata, witness replica immutabile, modifica audit respinta.
- Nessuna eliminazione di dati Audit né modifica alla retention legale.

## Azioni necessarie per certificazione totale

1. **Audit Auth nativo:** nel progetto Supabase Development, Dashboard → Authentication → Audit Logs → abilitare `Write audit logs to the database`. Verificare i dati successivi, senza dedurre fallimenti dal solo campo `action`; eventuali dati personali del provider devono rispettare le regole di conservazione e accesso.
2. **MFA reale:** utilizzare un *account di test* con fattore TOTP verified e una sessione valida; verificare una OTP errata e una OTP corretta via `auth-audit-gateway`. Controllare una riga `MFA_VERIFICATION_FAILED` con `emitter_source=EDGE_AUTH_GATEWAY`, esito `DENIED`, senza token, OTP o dati personali; eliminare l'account temporaneo senza cancellare l'audit.
3. **WORM/KMS:** scegliere e connettere un provider di object storage con versioning e Object Lock/retention non aggirabile dai normali amministratori. Definire chiavi cifratura Audit indipendenti con KMS/escrow, versionamento e test di rotazione/decrypt; copiare i blocchi e il witness, controllare hash, versionId e prova readback. La replica Supabase già verificata NON equivale a WORM.
4. **Policy retention:** responsabile/titolare approva formalmente scopi, classi di dati, durate, base giuridica e gestione delle richieste privacy; preservare `legal_hold` e `purge_enabled=false` finché Object Lock, chiavi, legittimità e prove di recuperabilità non sono certificati. Non inventare durata di 5/7/10 anni senza requisiti legali applicabili.
5. **CI/integrazione:** eseguire di nuovo i test mirati e il replay completo delle migrazioni, verificare workflow, autenticazione frontend con GoTrue e browser, staging, restore e permessi; sbloccare i fallimenti infrastrutturali dei runner prima di marcature PASS.

**Stato:** implementazione applicativa Audit/Log molto avanzata, recuperabilità archivio dimostrata. La certificazione di compliance e la Definition of Done completa sono ancora **NO-GO** per i gate non sotto controllo del codice. Non generare ZIP e non forzare merge/main/produzione.
