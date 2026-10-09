# Database Plateform

Stato al 9 ottobre 2026: storico Development recuperato; replay PGlite verificato; installazione Supabase isolata ancora da collaudare. Le migrazioni SQL sono la fonte autoritativa. Una installazione contiene un solo `restaurant_profile` e una o più `venues` dello stesso cliente. `MULTI_VENUE=false` impedisce l’attivazione di più sedi.

## Domini e invarianti

| Dominio      | Tabelle principali                                                       | Invariante                                                                                         |
| ------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Identità     | `staff_profiles`, assegnazioni, `registered_devices`, sessioni private   | Ruolo e scope provengono dal database; accesso operativo con sessione, MFA e dispositivo validi    |
| Sala         | `rooms`, `room_layouts`, `tables`, `zones`, `table_merges`               | Un layout attivo per sala; QR permanente; nessuna modifica strutturale durante il servizio         |
| Prenotazioni | `services`, booking rules/slots, `reservations`, form/answers            | Pacing atomico; duplicati bloccati; assegnazioni e storico separati dai conti                      |
| Catalogo     | categorie, piatti, ingredienti/allergeni, varianti, override sede        | Solo ingredienti rimovibili; varianti senza supplemento; prezzo storico e disponibilità server     |
| Produzione   | `orders`, `order_steps`, `order_items`, consegne/resi/correzioni         | Stazione primaria comanda; observer legge; step e responsabilità verificati                        |
| Contabilità  | `accounts`, `billing_units`, allocazioni, payments/refunds, equal splits | Centesimi interi; riserve pending; allocazioni e giornale immutabili; mance separate               |
| Cassa        | registri, servizi, `cash_journal`, `cash_reconciliations`                | Le rettifiche successive appartengono al servizio corrente, senza riscrivere la quadratura storica |
| Stampa       | dispositivi e `print_jobs`                                               | Snapshot immutabile; lease singolo; ristampa con conferma del rischio di duplicato                 |
| Offline      | snapshot firmati, eventi e conflitti                                     | Tre comandi non finanziari; idempotenza, versione e autorizzazione ricontrollate al sync           |
| Governance   | audit, telemetry, health, incidents, backup metadata, releases           | Audit append-only; Super Admin tecnico senza statistiche economiche                                |

Le FK composite `(venue_id,id)` impediscono collegamenti tra sedi per le risorse locali. Le configurazioni singleton usano una chiave booleana vincolata a `true`. Ogni importo monetario è `bigint` in centesimi; il browser non è l’autorità del saldo.

## Accesso e transazioni

Lo schema `private` non è esposto a PostgREST. I ruoli browser hanno grant SELECT limitati e mutano attraverso RPC. Le funzioni SECURITY DEFINER usano `search_path=''`, nomi qualificati e controlli applicativi di ruolo/sede/sessione. EXECUTE per PUBLIC è revocato anche nei privilegi predefiniti globali.

Le chiavi idempotenti sono associate a utente, comando e hash del payload. Un retry identico riproduce l’esito; un payload diverso produce `IDEMPOTENCY_MISMATCH`. Versioni ottimistiche impediscono salvataggi obsoleti. Lock delle risorse e della sala coordinano movimenti, stock, servizi e riserve di saldo. Le prove di contesa tra connessioni separate restano obbligatorie.

La pubblicazione Realtime contiene soltanto INSERT di `realtime_signals`, senza dati economici o contatti. Le query di dettaglio riapplicano l’autorizzazione. Audit, conti, stampe e accoglienza hanno paginazione server; alcune liste di configurazione e storico residue usano ancora `readRows` e richiedono una verifica con grandi volumi.

## Migrazioni e storico

**Verifica live 9 ottobre 2026:** `plateform-development` conserva 457
migrazioni applicate, ultima `20261009001127`. Il repository contiene tutte le
457 versioni con il SQL originale e SHA-256 verificato; recuperati 324 file
mancanti e riconciliati 24 file divergenti, con originali nel parent Git/backup.
La fingerprint canonica è
`ae79b608e86dfe6c7ca8dd93c88170cdd4dc38dd6324ccb3391342b135a59f41`.
Una nuova migrazione fail-closed delle evidenze è preparata, non applicata:
458 file locali. `check:migrations` verifica tutti i file; `check:clean-install`
vincola anche il sottoinsieme immutabile delle 457 versioni applicate.

Un'installazione vuota richiede `npm run db:install`: bootstrap delle sette
tabelle private mancanti dallo storico, SQL originali, postlude di due RPC.
Il piano e le impronte sono in `supabase/clean-install/manifest.json`.
Non eseguire il bootstrap su installazioni esistenti. Il replay locale e il
confronto delle colonne/indici/vincoli/policy passano; il collaudo ospitato e
l'upgrade/rollback restano aperti. Vedere `docs/BASELINE_RECOVERY_2026-10-09.md`.

Per gli aggiornamenti applicare soltanto le nuove migrazioni in ordine dopo aver verificato la versione di partenza su un database di sviluppo dedicato. Le migrazioni 28–30 trasformano addebiti e ciclo di occupazione: confrontare gli storici esistenti prima di migrare dati reali. `accounts.admitted_covers` evita che trasferimenti contabili modifichino i coperti storici; il backfill non può ricostruire spostamenti avvenuti prima dell’introduzione del campo.

Non riscrivere migrazioni già applicate a una installazione. Una correzione successiva richiede una nuova migrazione. Il codice attuale non include ancora una procedura collaudata di upgrade/rollback da ogni versione commerciale. Vedere DEPLOYMENT.md e BACKUP_RESTORE.md.

Per adottare lo storico remoto originale completo, con backup del precedente
sorgente e dopo avere verificato indipendentemente numero e fingerprint:

```bash
node scripts/reconcile-migrations.mjs --input-file /percorso/export-completo.jsonl --write \
  --adopt-remote-with-backup --expected-remote-count 457 \
  --expected-inventory-sha256 ae79b608e86dfe6c7ca8dd93c88170cdd4dc38dd6324ccb3391342b135a59f41
```

Questi valori valgono esclusivamente per l'istantanea verificata il 9 ottobre;
un'ulteriore migrazione su Development richiede un nuovo confronto indipendente.
