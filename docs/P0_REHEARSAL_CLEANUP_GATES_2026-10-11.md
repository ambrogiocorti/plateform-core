# P0 — Cleanup rehearsal controllato (11 ottobre 2026)

**Stato: BLOCKED — NON eseguire cancellazioni finché non sono soddisfatti i gate qui sotto.**
Ambiente: Supabase `plateform-development` (`abdxvlykasqmknexxhjo`).
Questo documento non autorizza cancellazione automatica né fa parte del release gate production.

## Dimensionamento osservato

- Database: 1.570.600.627 byte alla rilevazione delle 06:28 UTC del 11 ottobre.
- `private.continuity_rehearsal_snapshot_rows`: 1.318.813.696 byte.
- `private.continuity_rehearsal_transfer_chunks`: 185.524.224 byte.
- `private.continuity_rehearsal_snapshot_tables`: 8.822.784 byte.
- Totale tabelle rehearsal: circa 1.513.742.336 byte; teoricamente restano circa 56,8 MB.
- Manifest snapshot: 155; 91 relativi a backup falliti, 63 a backup/restore test riusciti, 1 senza backup metadata.
- Storage backup falliti: circa 205,8 MB separati dalla dimensione DB.
- Backup verificato più recente: ID `656dcf01-ca49-4f85-9526-11f223d2b053`, `2026-10-09T08:37:30Z`, schema `20261009001127`.
- Restore test registrati: 2 SUCCEEDED su backup precedente del 6 ottobre. **Nessuna prova di restore attuale**. Non confondere `verification.replica=true` con restore end-to-end su target isolato.

## Preflight: SQL di sola lettura

```sql
select pg_database_size(current_database()) as database_bytes;
select b.status, b.purpose, count(*) as snapshots, sum(m.row_count) as copied_rows
from private.continuity_rehearsal_snapshot_manifest m
left join public.backup_metadata b on b.id=m.snapshot_id
group by b.status,b.purpose order by b.status,b.purpose;
select b.id, b.status, b.completed_at, b.integrity_verified,
       b.schema_version, b.retention_until,
       b.verification->>'replica' as replica,
       b.verification->>'manifest_auth' as manifest_auth
from public.backup_metadata b where b.status='SUCCEEDED'
order by b.completed_at desc limit 5;
select id,status,backup_id,pre_restore_backup_id from public.restore_jobs;
select jobid,active,command from cron.job
where command ilike '%backup%' or command ilike '%retention%';
```

## Gate obbligatori PRIMA di modificare qualsiasi tabella

1. Acquisire un backup *nuovo* di database/Auth/Storage/migration history con controllo hash, cifratura, chiavi disponibili e copia indipendente dal progetto. Conservare il manifest, l'inventario di tutti gli oggetti e il digest della cronologia SQL.
2. Ripristinare su `plateform-restore-test` disposable separato, verificando 457 migrazioni e relativo digest, numero utenti Auth, byte/hash Storage, RLS, conti, pagamenti e audit. Non azzerare un target che contenga dati non sostituibili.
3. Congelare nuove creazioni di snapshot; verificare di nuovo `backup_metadata` (nessun job QUEUED/RUNNING) e `restore_jobs` (nessun restore attivo), acquisire inventario per snapshot e Storage; mantenere il rapporto dell'operazione.
4. Approvare espressamente una retention per gli artefatti dei backup completati; distinguere snapshot di backup falliti, riusciti e orfani. Conservare `backup_metadata`, audit e referenze di restore. Ogni rimozione deve utilizzare un manifest esplicito di UUID, non una cancellazione indiscriminata di tutti i manifest.
5. Testare in staging con dump disponibile, riconciliazione contatori e un test di restore *dopo* la bonifica. Le copie in Storage si cancellano tramite Storage API, mai con `DELETE FROM storage.objects`.
6. Solo dopo il recupero logico valutare recupero fisico: VACUUM ordinario riutilizza pagine ma non garantisce che la quota DB diminuisca. `VACUUM FULL` richiede lock esclusivo e spazio aggiuntivo: non avviarlo automaticamente su Free oltre quota. Valutare `pg_repack` solo dopo verifica estensioni, permessi e headroom, o ricostruzione isolata pulita con cutover controllato.

## Requisiti per la bonifica per batch

Un futuro runner deve prima ricontrollare atomicamente la allowlist per UUID e i gate; preservare record di successo e ogni backup referenziato da restore, verificare per ogni batch righe in `continuity_rehearsal_snapshot_rows`, `continuity_rehearsal_transfer_chunks`, `continuity_rehearsal_snapshot_tables` e `continuity_rehearsal_transfer_key`. La FK `snapshot_rows -> snapshot_manifest` ha ON DELETE CASCADE; le altre relazioni vanno controllate esplicitamente. Usare batch limitati e transazioni brevi; registrare UUID, quantità e differenze prima/dopo. Non usare `TRUNCATE`, `DROP TABLE` o `CASCADE` indiscriminato.

**Zero modifiche applicate al database da questo documento.** Il target di circa 56,8 MB è una stima calcolata sottraendo l'occupazione delle tabelle rehearsal dal totale, non una misura post-pulizia.
