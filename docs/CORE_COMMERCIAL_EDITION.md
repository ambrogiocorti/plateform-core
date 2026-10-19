# Plateform — Profilo commerciale CORE (sorgente in sviluppo)

## Ambito approvato

**Aggiornamento del 19 ottobre 2026 (decisione del titolare):** Stripe e Satispay (online e POS Satispay) entrano nel primo prodotto commerciale, dietro le licenze di installazione `STRIPE` e `SATISPAY_API` che solo un SUPER_ADMIN con step-up può concedere. Per ora si usano account sandbox; le credenziali reali di ogni ristorante vengono configurate dal tecnico come secret delle Edge Function per sede (procedura in `docs/STEP6_PROVIDER_CONFIGURATION.md`). Restano esclusi le caparre online sulle prenotazioni (non esiste ancora la Edge Function dedicata) e i driver Epson/ePOS/print bridge; la stampa inclusa è browser/PDF.

Senza licenza valgono contanti e registrazione di incasso verificato con **POS esterno**, senza integrazione col provider. L'incasso con POS esterno **non prova automaticamente** l'avvenuta transazione sul terminale fisico: è l'operatore a verificarla prima di confermare l'incasso.

La migrazione `supabase/migrations/20261019100000_payment_providers_by_license.sql` sostituisce il divieto incondizionato con il controllo `private.payment_method_licensed`: metodi di sede e cassa, nuovi pagamenti, rimborsi e comandi verso i provider sono rifiutati (`PAYMENT_METHOD_UNLICENSED`, `CORE_REGISTER_PAYMENT_METHODS_FORBIDDEN`) senza la licenza corrispondente; la licenza non può essere revocata finché casse o sede offrono il metodo (`PROVIDER_STILL_CONFIGURED`) o restano operazioni in corso (`PROVIDER_OPERATIONS_PENDING`). La licenza `BOOKING_DEPOSITS` resta vietata (`CORE_PROVIDER_LICENSE_FORBIDDEN`).

Lo scope è codificato in `src/services/commercial-scope.ts`, applicato alla selezione del metodo di pagamento, alle impostazioni di sede/cassa/stampa e alle prenotazioni con caparra, e controllato dal test `npm run check:core-edition`.

## Condizione server-side obbligatoria

Il frontend da solo non è una barriera di sicurezza. Prima di qualsiasi pubblicazione commerciale bisogna verificare che l'istanza di destinazione impedisca **anche via API diretta** la creazione di pagamenti Stripe/Satispay e l'attivazione dei metodi Satispay senza la licenza corrispondente, e nuove configurazioni Epson in ogni caso; i flag di licenza e i permessi di sede devono restare coerenti con l'edizione CORE. Qualsiasi attività di rimborso/provider preesistente deve essere riconciliata prima della disattivazione dei servizi.

**Enforcement Development verificato (8 ottobre 2026, divieto poi sostituito dalla licenza il 19 ottobre):** la migrazione
`supabase/migrations/20261008181605_core_edition_payment_and_print_denial.sql`
è stata applicata al progetto **plateform-development**, dopo preflight transazionale. Quattro pagamenti già `REFUNDED`/`CANCELLED` e tre rimborsi `COMPLETED` sono stati mantenuti senza alterazioni; nessun provider, caparra o job di stampa esterno risultava in sospeso. Sono attivi otto trigger che negano nuove operazioni escluse, re-licenziamenti e configurazioni hardware non comprese. Dieci tentativi negativi e tre aggiornamenti autorizzati sono stati verificati in transazioni con rollback. Il relativo file SQL è stato recuperato dalla storia applicata e verificato tramite SHA-256.

**Limite ancora aperto:** queste prove sono a livello SQL su Development, non sostituiscono test PostgREST/RPC con JWT reali di ruoli diversi, né il deploy/collaudo su staging HTTPS e Production. Rimane vietata una release commerciale senza tali verifiche. I 323 file SQL remoti storici mancanti nel repository devono ancora essere recuperati prima di un restore riproducibile.

### Prove SQL transazionali CORE

`supabase/tests/core_booking.live.sql` esegue su **Development** prove di disponibilità, prenotazione confermata, replay idempotente, richiesta gruppo, assenza depositi, divieto di ri-licenziamento e fail-closed in presenza di una regola residua `REQUIRED`. Tutto avviene in una transazione conclusa da `ROLLBACK`, senza persistenza di fixture. Il test di creazione senza caparra e quello del blocco per configurazioni residue sono stati eseguiti con esito `PASS`.

**Regressioni precedenti da non presentare come PASS attuale:** `private.test_step11_public_booking_transaction()` e `private.test_public_booking_availability_server_authority()` attivano deliberatamente il flag `BOOKING_DEPOSITS` per collaudare l'edizione completa; entrambi ora falliscono con `CORE_PROVIDER_LICENSE_FORBIDDEN`. La suite CORE li sostituisce solo per la funzionalità in-scope: non vengono disabilitati sul database e il loro risultato storico non costituisce certificazione corrente.

## Gestione prenotazioni con caparra

Il cliente non riceve offerte di slot che richiedono caparra online; in caso di variazione delle condizioni durante la richiesta, la pagina avverte che la prenotazione non è confermata e invita a contattare il ristorante, senza fare tentativi di pagamento né promettere automaticamente la prenotazione. La configurazione della sede deve vietare caparre che richiedono un provider escluso. Il filtro è fail-closed anche se una risposta incoerente segnala `RESERVED` o `REQUESTED` ma include metadati `deposit`.

## Gate non derogabili

Non sono state eliminate le condizioni su RLS, audit, sessioni, backup/restore, integrità dei dati, compatibilità del database, tenant isolation, test E2E, HTTPS staging, accessibilità e sicurezza. L'assenza di provider integrati riduce i collaudi sui gateway di pagamento, ma **non** sostituisce il collaudo dei pagamenti manuali, dell'incasso e del rimborso.

**Stato: sviluppo; non ancora autorizzato alla vendita.** Il controllo `check:core-server-policy` verifica il file SQL versionato e la sua impronta locale; le prove SQL live su Development sono registrate separatamente, non dimostrano la sicurezza dei flussi API completi. Il gate commerciale richiede separatamente `stripe_satispay_sandbox` (collaudo con account sandbox) e `server_denies_unlicensed_providers_and_epson` con evidenze di test negativi contro RPC reali, oltre a `server_denies_online_booking_deposits` e `core_booking_without_deposit_sql_live` su staging.
