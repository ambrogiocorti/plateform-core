# Plateform backup retention worker

Applica fisicamente la retention agli artefatti già scaduti. Il database seleziona solo backup `SUCCEEDED`, scaduti e non coinvolti in restore attivi; il worker cancella esclusivamente `<PLATEFORM_BACKUP_ROOT>/<backup_uuid>` dopo aver verificato che `database_reference` punti esattamente al relativo `manifest.json#database`.

Il metadata storico del backup non viene cancellato: il control plane registra `artifacts_purged_at`, conserva checksum/manifest/verifiche e azzera soltanto i riferimenti a file che non esistono più.

Modalità:

```bash
npm run retention:check
npm run retention:once
```

Il worker è indipendente da Docker/Supabase CLI: richiede soltanto Node, accesso al backup root, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`. Non segue symlink e fallisce chiuso su riferimenti file fuori dal backup root.
