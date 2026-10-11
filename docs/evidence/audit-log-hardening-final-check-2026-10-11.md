# Audit e Log — verifica del 11 ottobre 2026

## Funzionalità in esecuzione

La piattaforma Plateform dispone di una registrazione applicativa server-side dei rifiuti GoTrue nel nuovo Edge gateway `auth-audit-gateway` (ACTIVE v1). Nel flusso login staff, password e MFA passano per il server. Solo il service role può scrivere `AUTH_LOGIN_FAILED` e `MFA_VERIFICATION_FAILED`, e soltanto dopo un rifiuto reale del provider. Il payload Audit esclude password, TOTP, email, token, IP e User-Agent.

**Prova live:** GitHub Action `Auth gateway live denial security probe` PASS; login con identità sintetica inesistente respinto; una riga `AUTH_LOGIN_FAILED` registrata realmente, anonima e priva dei campi sensibili. Richiesta MFA anonima respinta con 401. **Non c'è ancora prova di MFA errata su account di test con fattore TOTP verificato**: non chiamarla certificata.

L'integrazione è circoscritta alle schermate staff Plateform che usano il gateway. Chiamate esterne dirette agli endpoint Supabase Auth non vengono copiate automaticamente nel registro applicativo. `auth.audit_log_entries` resta vuota: l'audit nativo del provider nel database non è stato abilitato/provato, ed è un gate distinto. Vedere [Auth Audit Logs Supabase](https://supabase.com/docs/guides/auth/audit-logs).

## Archivio storico e policy di conservazione

L'archivio esistente contiene **17 blocchi AES-256-GCM, 3.235 eventi**, copie primarie e su un progetto Supabase replica, con checksum, hash chain e witness indipendente. Un test di **ripristino e decifratura completa** ha superato la verifica di 3.235/3.235 righe. Il job ogni 15 minuti acquisisce i nuovi eventi e un job giornaliero verifica il recupero. La presenza di nuove righe dopo la prova iniziale è fisiologica, fino alla successiva esecuzione del job.

La migrazione `20261011160726_audit_retention_immutable_approval_gate_and_gateway_coverage.sql` conserva `legal_hold=true` e `purge_enabled=false` e rende non modificabile la configurazione via update diretto. Prova SQL su Development in transazione con rollback: **PASS** (tentativo di approvare la policy respinto). Nessun evento originale cancellato.

**Non è WORM certificato.** Prima di abilitare la retention distruttiva occorrono tempi legali approvati, chiavi e custodia indipendenti, un servizio con Object Lock/WORM verificato e prove di ripristino da tale servizio. L'archivio attuale usa due progetti del medesimo provider; non equipararlo a immutabilità fisica.

## Test e blocchi

- Test SQL negativo della retention: **PASS** live.
- Gateway login invalid credentials: **PASS** live.
- MFA senza sessione: **PASS** live (401).
- Test DB mirati sul gateway: eseguiti in PGlite in precedenti run, ma la modifica più recente della retention necessita un nuovo run completo.
- La CI generale del repository continua a fallire per gate della piattaforma separati. I job GitHub Actions immediatamente più recenti risultano falliti prima dell'esecuzione dei passi, senza log applicativi utili; non classificarli come test funzionali superati.
- Restano non provati MFA errata con fattore reale, archivio WORM/retention legalmente approvata e test reali end-to-end del frontend con GoTrue, oltre al gate generale delle migrazioni.

**Stato:** funzionalità Audit/Log principali operative; certificazione totale **non conclusa**. Plateform commerciale **NO-GO**.
