# Verifica Audit Auth nativo dopo attivazione dichiarata — 11 ottobre 2026

**Progetto:** Supabase `plateform-development` (`abdxvlykasqmknexxhjo`).

L'utente ha confermato l'attivazione di **Write audit logs to the database** nel pannello Auth. Non confondere questa dichiarazione con una prova di ingestione.

## Prova live dopo la modifica

Sono state inviate **due sole richieste sintetiche**, senza usare o modificare account reali:

| Canale | Esito server | Evidenza |
|---|---|---|
| GoTrue POST `/auth/v1/token?grant_type=password` con email fittizia inesistente | HTTP 400 `invalid_credentials` | richiesta PostgreSQL HTTP id `15224` |
| Edge `auth-audit-gateway`, azione `PASSWORD_LOGIN`, email fittizia inesistente | HTTP 200 `REJECTED` | richiesta PostgreSQL HTTP id `15225` |

- `public.audit_log`: **due eventi** `AUTH_LOGIN_FAILED` osservati nel totale, uno aggiunto dalla seconda prova. I log staff attraverso il gateway sono confermati.
- `auth.audit_log_entries`: **zero righe** subito dopo la prova. Quindi **l'ingestione nativa nel database NON è stata ancora verificata**.
- Supabase `auth_logs` di infrastruttura: **sei eventi** nell'intervallo di controllo dopo le 17:30 UTC, con due eventi associati a endpoint token/invalid credentials. Questo non prova un salvataggio nella tabella Postgres.
- Verificare la persistenza anche dopo una richiesta di **login realmente riuscita** eseguita dall'utente nel progetto giusto, senza inviare password all'assistente. Controllare eventuale ritardo del provider prima di diagnosticare il toggle come errato.
- Secondo la [documentazione Supabase Audit Logs](https://supabase.com/docs/guides/auth/audit-logs), il nome dell'impostazione può essere formulato al negativo: **`Disable writing auth audit logs to project database`**; per scrivere nella tabella il controllo di disabilitazione deve essere spento.

**Stato:** login falliti in audit applicativo Plateform PASS; sink Audit Auth nativo nel database ancora non provato; MFA con fattore reale non collaudata. Non cambiare automaticamente gli stati di certificazione, non cancellare log, non generare segreti o dati personali nella documentazione.
