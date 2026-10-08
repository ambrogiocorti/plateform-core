# Plateform — verifiche di prosecuzione (2026-10-08)

Ambiente remoto: `plateform-development` soltanto. Nessuna modifica SQL
permanente, nessun rilascio production, nessuna credenziale di produzione.

## Correzioni al sorgente

1. Selezione esplicita di una sede inesistente: fallimento chiuso invece di
   visualizzare silenziosamente prezzi, menu e contatti di un'altra sede.
2. SEO di URL con selezione non valida: `noindex`, nessuna canonical alternativa,
   nessun dato strutturato attribuito a una sede diversa.
3. Ripristino da 404 limitato a percorsi pubblici riconosciuti e alla medesima
   origine. Il percorso `/staff` senza slash resta nel contesto staff.

## Evidenze del DB eseguite

| Test | Esito | Persistenza fixture |
| --- | --- | --- |
| Storytelling pubblico | PASS | read-only |
| Metadati SEO | PASS | read-only |
| Sitemap | PASS | read-only |
| Visibilità prenotazioni per sede | PASS | rollback |
| Prenotazione, gruppo grande, caparra e idempotenza | PASS | rollback |
| Notification Center e audit transizioni | PASS | rollback |
| Conflict Center e audit risoluzione | PASS | rollback |
| Venue scope/revoca e selector | PASS | rollback |
| Catalogo condiviso e prezzo/disponibilità per sede | PASS | rollback |
| Abilitazione multi-sede e step-up | PASS | rollback |
| Editor sala avanzato e vincoli operativi | PASS | rollback |

Il test Notification Center eseguito senza aggiornare il fixture falliva con
`NOTIFICATION_TEST_AUTH_CONTEXT_FAILED`, perché `full_auth_expires_at` del
fixture era trascorso. Verificata la validità del controllo `private.real_role()`;
il test è riuscito dopo il rinnovo temporaneo della finestra di autenticazione
**dentro un BEGIN/ROLLBACK esterno**. Va aggiornato il fixture di regressione
nella futura migrazione versionata (non eseguire una modifica SQL fuori storia).

## Evidenze non ottenute

- Build con Node.js >=24.13, `npm ci`, strict TypeScript, ESLint, Vitest/PGlite.
- E2E browser con JavaScript/IndexedDB/Auth/Realtime su HTTPS dedicato.
- Esportazione e adozione verificata della cronologia completa di 453 migrazioni.
- Verifica hardware stampante, provider reali, test chaos e performance staging.
- Tre revisioni commerciali pulite sullo stesso digest (attualmente 0/3).

**Verdetto:** sviluppo in corso, Beta e release commerciale NON certificate.