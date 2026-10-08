# Database Plateform

Stato: schema di sviluppo, verificato con PostgreSQL PGlite; integrazione Supabase da eseguire. Le migrazioni SQL sono la fonte autoritativa. Una installazione contiene un solo `restaurant_profile` e una o più `venues` dello stesso cliente. `MULTI_VENUE=false` impedisce l’attivazione di più sedi.

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

La nuova installazione development usa 58 migrazioni. Il manifest
`supabase/migration-manifest.json` conserva versioni remote, nomi originali e SHA-256.
`npm run check:migrations` impedisce modifica o perdita di una migrazione applicata.
La storia dei progetti precedenti non è stata modificata; il loro eventuale upgrade
richiede riconciliazione esplicita delle versioni prima di usare questi sorgenti.

Applicare i file di `supabase/migrations` in ordine, su un database di sviluppo dedicato. Le migrazioni 28–30 trasformano addebiti e ciclo di occupazione: confrontare gli storici esistenti prima di migrare dati reali. `accounts.admitted_covers` evita che trasferimenti contabili modifichino i coperti storici; il backfill non può ricostruire spostamenti avvenuti prima dell’introduzione del campo.

Non riscrivere migrazioni già applicate a una installazione. Una correzione successiva richiede una nuova migrazione. Il codice attuale non include ancora una procedura collaudata di upgrade/rollback da ogni versione commerciale. Vedere DEPLOYMENT.md e BACKUP_RESTORE.md.
