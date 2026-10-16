# Plateform — stato di implementazione

> **Aggiornamento prevalente — 16 ottobre 2026.** Il candidato integra ora
> avvio guidato, menu della sede, anomalie di servizio e miglioramenti alla
> cassa/consegne della PR #38. Verifiche, limiti e blocchi correnti sono in
> [OPERATIONAL_INTEGRATION_2026-10-16.md](OPERATIONAL_INTEGRATION_2026-10-16.md).
> La piattaforma resta incompleta e il rilascio commerciale resta NO-GO.

> **Aggiornamento prevalente — 8 ottobre 2026.** I conteggi di seguito sono
> checkpoint storici e non descrivono lo stato corrente del progetto remoto.
> Supabase Development contiene **455** migrazioni applicate; il sorgente locale
> ne contiene **132**. L'inventario differisce e non è ancora riconciliato:
> nessuna distribuzione commerciale è autorizzata. Vedere
> `STEP11_PROGRESS_2026-10-08.md` e
> `STEP11_CONTINUATION_VERIFICATION_2026-10-08.md` per le evidenze più recenti.

Aggiornamento: 3 ottobre 2026. **Sviluppo incompleto; non pronto per la vendita.**
Specifica di riferimento: §§0–150 del master, senza riduzione dello scope.
Revisioni integrali consecutive pulite: **0/3**. Tutte le sezioni restano pending/partial
finché non sono verificate integralmente; non viene attribuita una percentuale commerciale
al numero dei test o ai moduli presenti.

## Evidenze locali

- 71 migrazioni applicate in ordine nei test PostgreSQL PGlite e sul nuovo Supabase development.
- 196 test unitari/database, 19 test browser Chromium con fixture, 11 test Deno passati.
- Il checkpoint storico ha superato TypeScript strict, ESLint, Edge Functions Deno check e build pubblico/staff; le modifiche più recenti usano transpile mirato e gate embedded/live perché i binding Linux non sono disponibili nel runner corrente.
- Suite TLS del bridge: firma autentica/contraffatta, origine, digest, singolo invio,
  risultato persistito e SENT recuperato come UNKNOWN.
- Screenshot privacy mobile ispezionato; mappa Host verificata anche da tastiera.
- Documenti obbligatori presenti e aggiornati con limiti dell’implementazione.
- Gate ZIP commerciale attivo; mancano collaudi reali e tre revisioni sullo stesso digest.

PGlite usa schema Auth/Storage di test e serializza le richieste: non prova GoTrue,
PostgREST, websocket, trasporto Storage o concorrenza tra connessioni PostgreSQL separate.
Browser usa fixture HTTP esplicite. Nessuna delle misure locali certifica un servizio reale.

## Parti presenti, ancora soggette a verifica integrale

- Vanilla TypeScript/Vite, due origini/PWA, un cliente per DB e multi-sede opzionale.
- Ruoli/scope, MFA/PIN, sessioni/device, grant step-up, RLS e audit append-only.
- Catalogo/composizione/allergeni/varianti, override e disponibilità per sede.
- Sala/editor/zone/QR, pianta operativa, gruppi/spostamenti e responsabilità.
- Turni, servizi, pacing e form builder; prenotazioni/manual booking/walk-in/editing.
- Conti/ordini/cliente, richieste/approvazioni, KDS/Pass/consegne/resi/correzioni.
- Addebiti in centesimi, sconti/omaggi, quote uguali, trasferimenti/unioni, rimborsi/storni,
  giornale, quadrature e ciclo prepagato separato dall’occupazione.
- Adapter Stripe/Satispay, verifiche provider server, callback/webhook e riconciliazione.
- Job stampa, leasing, browser/Epson, bridge HTTPS firmato e registro persistente.
- Notifiche persistenti, badge, priorità/suoni/volume configurabili con gesto locale.
- Snapshot offline firmati con trust anchor, dati per ruolo, queue AES-GCM, sync dei tre
  comandi sicuri, conflitti Admin e protezione da code corrotte o di altri utenti.
- Branding/Storage con quote, ricerca globale, job staff, impersonazione autorizzata.
- Licenze/limiti, sospensione, health/heartbeat/metrics, incident workflow e analytics aggregate.
- Privacy prenotazioni: export, rettifica, anonimizzazione/hold; retention configurata e
  worker di pulizia/pseudonimizzazione tecnica con lease/backoff, ancora da collaudare live.
- Workflow CI e cron retention inattivo salvo configurazione; gate di release e manifest archive.

## Lavoro obbligatorio aperto

1. **Backup/restore:** implementare worker e copie coerenti di database/Auth/Storage,
   manifest/cifratura/retention, pre-restore backup, conferme e audit, prove di integrità e RPO/RTO.
   Oggi esistono solo schema e indicatori: vedere BACKUP_RESTORE.md.
2. **Dismissione protetta:** workflow PENDING_DELETION/ARCHIVED/PERMANENTLY_DELETED,
   dipendente dal backup; confronto del nome del ristorante, password e conferme.
3. **Privacy completa:** export/gestione dei dati non collegati a una prenotazione, dati staff,
   policy della cronologia locale/backup, verifica reale GoTrue e scheduling/volumi del worker.
4. **Offline/conflicts:** editor di risoluzione più completo, aggiornamento della cronologia
   locale dopo risoluzione server, limiti/retention della coda e gestione di tutti i fallimenti
   di preparazione/sync. Prove su Safari/iOS e dispositivi condivisi/revocati.
5. **Observability:** alert automatici, soglie/deduplica/escalation, probe esterno indipendente,
   instrumentation di tutte le RPC/frontend, gestione/retention dei log infrastrutturali.
6. **Audit puntuale UX/API:** verificare ogni requisito, tutti gli strumenti avanzati dell’editor,
   assegnazioni/recovery, configurazioni, navigazione, input, query residue e volumi. I moduli
   presenti non implicano che ogni dettaglio del master sia già completo.
7. **Integrazione Supabase:** Auth/TOTP/recovery, RLS/PostgREST/Realtime/Storage,
   revoche a servizio aperto, gateway/IP/CORS, setup e upgrade dati esistenti.
8. **Concorrenza reale:** ultima porzione, pacing, cassa/quote/saldi, gruppi/layout,
   retry dopo timeout/commit, callback duplicati/fuori ordine e distribuzione websocket.
9. **Provider sandbox:** Stripe/Satispay, addebiti/rimborsi reali di test, ritorni/callback,
   esito incerto, rate limit e riconciliazione oltre la finestra idempotente.
10. **Stampa fisica:** modelli/firmware Epson, certificati/rete, spooling, carta esaurita,
    bridge su hardware reale, restart/timeout dopo stampa e verifica della ricevuta.
11. **Deployment/QA:** CI reale, staging/prod separati, DNS/headers/CSP, migrazioni e rollback
    collaudati, accessibilità, browser/mobile/PWA, carico/SLO e prove chaos.
12. **Tre revisioni complete consecutive** di tutti i §§0–150 senza modifiche né rilievi;
    solo dopo il completamento dei punti precedenti. I test verdi non costituiscono tali revisioni.

## Collegamento remoto

Creato il nuovo progetto development `plateform-development` (`abdxvlykasqmknexxhjo`,
eu-west-1). Applicate 55 migrazioni del checkpoint e tre correzioni delle fondamenta;
verificate invarianti, RLS/scope/sessioni, audit/telemetry e rate limit su PostgreSQL reale,
proiezioni e rifiuti anon tramite PostgREST. I progetti precedenti non sono stati modificati.
La cronologia locale coincide con il progetto nuovo ed è controllata mediante manifest SHA-256.

Configurazione Auth/secrets development completata tramite dashboard autorizzata.
Verificati 13 casi HTTP, 10 casi gateway/rate limiting e roundtrip telemetry: dettagli in
`docs/REMOTE_CONFIGURATION.md` e `docs/STEP_0_VERIFICATION.md`. Nessun account staff
commerciale, workflow operativo o integrazione dei successivi step viene certificato da queste prove.
Il gate ZIP richiede anche il completamento documentato di tutta la Roadmap.

Non sono configurati account provider/hardware/hosting production o copie dati esterne.
Il checkpoint sorgenti è una copia di sviluppo, non un backup del ristorante né una release commerciale.
