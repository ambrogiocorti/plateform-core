# Plateform — verifiche di prosecuzione (2026-10-08)

Ambiente remoto: `plateform-development` soltanto. Le sole modifiche SQL permanenti di questa prosecuzione sono due migrazioni versionate (manifesto RPC e fixture privata di test). Gli altri test SQL sono stati eseguiti in transazioni con rollback. Nessun intervento o rilascio production; nessuna credenziale di produzione.

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
| Authorization snapshot offline firmato | PASS | rollback |
| Job di stampa claimable e separazione ruoli | PASS | rollback |
| Command Palette con scope e RLS | PASS | rollback |
| No-show e rimborsi caparra server-authoritative | PASS | rollback |
| Lista d'attesa e messaggistica, token privati | PASS | rollback |
| Logout e revoca sessione idempotente | PASS | rollback |

Il test Notification Center eseguito senza aggiornare il fixture falliva con
`NOTIFICATION_TEST_AUTH_CONTEXT_FAILED`, perché `full_auth_expires_at` del
fixture era trascorso. Verificata la validità del controllo `private.real_role()`;
il test è riuscito dopo il rinnovo temporaneo della finestra di autenticazione
**dentro un BEGIN/ROLLBACK esterno**. Va aggiornato il fixture di regressione
nella futura migrazione versionata (non eseguire una modifica SQL fuori storia).

Il primo tentativo in batch del test logout non ha restituito un risultato
interpretabile; ripetuto isolatamente in una nuova transazione di verifica,
ha confermato la revoca, l'audit e l'idempotenza. Nessuna modifica alla
sessione di sviluppo è stata conservata.

## Evidenze non ottenute

- Build con Node.js >=24.13, `npm ci`, strict TypeScript, ESLint, Vitest/PGlite.
- E2E browser con JavaScript/IndexedDB/Auth/Realtime su HTTPS dedicato.
- Esportazione e adozione verificata della cronologia completa di 455 migrazioni.
- Verifica hardware stampante, provider reali, test chaos e performance staging.
- Tre revisioni commerciali pulite sullo stesso digest (attualmente 0/3).

**Verdetto:** sviluppo in corso, Beta e release commerciale NON certificate.
## Correzione gate di sicurezza RPC

Rilevati quattro endpoint pubblici di sola lettura mancanti da `private.api_permission_manifest` nonostante fossero correttamente esposti. Eseguite prove con ruolo `anon` sulle RPC di menu, navigazione, SEO e sitemap. Applicata soltanto a `plateform-development` la migrazione `20261008163112_step11_public_rpc_permission_manifest.sql` (8 voci già autorizzate; nessun nuovo GRANT). Test post-migrazione: `public.release_security_gate()->>'ok' = true` con zero voci non documentate. Conteggio DB 455, sorgente locale 132: rimangono 323 file da recuperare e i release gate esterni invariati.

## Verifica Step 12 e stabilizzazione test — 8 ottobre 2026

- Il validatore della prova di restore storica (130 migrazioni, 6 ottobre) ora viene esercitato in una directory fixture temporanea. I suoi **8 test** includono la conferma esplicita che il validatore reale rifiuti la prova come vecchia rispetto allo schema corrente. La prova di restore nuova **non è stata eseguita e il gate resta chiuso**.
- Migrazione `20261008163715_step11_notification_probe_expiring_fixture_fix.sql` su Development: corretta esclusivamente la funzione di **test privata** affinché aggiorni temporaneamente `full_auth_at`, `full_auth_expires_at` e `unlocked_until` del proprio fixture in transazione; nessuna modifica alle regole applicative di autenticazione. SQL locale di 1054 byte, SHA-256 `533726aa7a4c485db44758ddac4dadcba55bc7c7115d3e879095a55307e46388` identico al remoto. Test Notification Center con rollback **PASS senza setup manuale**.
- Database Development (ultimo inventario): **455** migrazioni, **132** sorgenti locali e **323** versioni remote ancora mancanti; fingerprint aggregato `cf82ef8189d3645c4d07586e2c4a31a2f381a9e567a8e9d96d46811b2a41da92`. Gate di sicurezza, regressione database e catalogo di test Supabase **PASS**, ma Beta ancora **7 blocchi aperti**.
