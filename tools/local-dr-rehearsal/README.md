# Prova locale di disaster recovery (Step 12)

`npm run continuity:local-dr -- --evidence docs/evidence/<file>.json`

Crea un cluster **PostgreSQL 16 usa-e-getta** (solo socket Unix, nessuna porta TCP,
cancellato a fine esecuzione), installa tutte le migrazioni del repository e
inserisce dati di un ristorante tramite le RPC reali (conto → ordine → sessione di
cassa → pagamento contanti → chiusura conto). Poi esegue:

1. **backup** con la pipeline reale del worker (`tools/backup-worker`): dump,
   AES-256-GCM, manifest HMAC, replica verificata, `finish_backup_job`;
2. **restore test** con la pipeline reale (`tools/restore-test-worker`): 16 gate e
   `finish_restore_job` sul control plane sorgente;
3. **disastro**: elimina database sorgente, byte Storage e copia primaria del backup;
4. **ripristino da disastro** dalla sola replica (`tools/disaster-restore`) in
   un'installazione vuota, con registrazione `CUTOVER_REQUIRED`;
5. verifiche: tabelle identiche (contenuto SHA-256), audit identico e ancora
   append-only, superficie di sicurezza identica, sessioni invalidate, menu
   pubblico servito, controlli fail-closed (chiave errata, manifest/cifrato
   manomessi, target occupato), riattivazione esplicita delle schedulazioni.

Requisiti: `pg_config`/binari PostgreSQL 16 (o `PLATEFORM_PG_BIN`), Node, utente
`postgres` di sistema se eseguito come root.

## Cosa NON dimostra

Sono locali soltanto i trasporti: `supabase-cli.mjs` sostituisce `supabase db dump`
con `pg_dump` 16 applicando le stesse esclusioni degli schemi gestiti, e
`local-supabase.mjs` sostituisce PostgREST/Storage su `127.0.0.1`. Non prova
GoTrue, il servizio Storage ospitato, Vault, la rete, né tempi RPO/RTO di
produzione. Il gate commerciale `backup_restore_database_auth_storage` resta
aperto finché la stessa sequenza non gira su progetti Supabase di staging.
