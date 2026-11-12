# Osservabilità

La pagina Super Admin `/salute` mostra dati tecnici e contatori senza importi economici. Nessun componente viene marcato raggiungibile in assenza di un esito registrato. Un probe più vecchio di cinque minuti viene indicato da aggiornare.

| Controllo                | Misura effettiva                                 | Limite                                                 |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------ |
| DATABASE                 | Esecuzione RPC service-only                      | Non misura tutte le query o la contesa                 |
| AUTH                     | Admin API listUsers, un elemento                 | Non collauda login, TOTP o recovery                    |
| STORAGE                  | Elenco bucket                                    | Non prova upload/download, policy o ripristino oggetti |
| REALTIME                 | Collegamento a un canale, timeout cinque secondi | Non prova consegna degli eventi né isolamento RLS      |
| EDGE                     | Handler autenticato eseguito e risultati salvati | Non rappresenta la disponibilità di ogni funzione      |
| Stripe, Satispay, stampa | Nessun probe reale ancora registrato             | Restano non collaudati o disattivati                   |

`health-probe` richiede Super Admin, sessione sbloccata e MFA; il server salva stato, codice, durata e request ID. Solo service role registra risultati. Fallimenti non vengono trasformati in successo.

## Misure delle Edge Functions

Con `TELEMETRY_ENABLED=true`, ENVIRONMENT e RELEASE_VERSION nei segreti server, il confine HTTP registra eventi minimizzati. La scrittura telemetry ha timeout di un secondo e non cambia l’esito del comando principale. Il pannello calcola richieste, percentuale di errori server e latenza p95 negli ultimi quindici minuti. Senza osservazioni, percentuale e latenza sono sconosciute.

Questo strumento misura le Edge che usano il confine condiviso. Query PostgREST dirette, tempi di rendering, gateway e probe esterni non sono ancora strumentati integralmente. `system_errors`, telemetry e audit sono separati. Request/correlation ID collegano una richiesta ai suoi eventi senza conservarne payload o segreti.

Heartbeat staff registra l’attività del dispositivo all’accesso e agli aggiornamenti. Il contatore recente non è una garanzia che un dispositivo sia online adesso. Le code mostrate sono ricevute dal server; operazioni ancora solo in IndexedDB non sono conteggiabili.

## Alert e SLO

Il workflow incidenti è implementato. Per backup/restore è attiva la rilevazione automatica ogni 10 minuti con deduplica e auto-risoluzione per: cron backup inattivo, assenza di backup verificato, backup fallito senza recovery, queue/lease bloccati, restore fallito/bloccato e assenza di restore test verificato. Le condizioni attive sono mostrate come banner nella dashboard tecnica e restano nella timeline incidenti. Mancano ancora alert esterni indipendenti, escalation verso persone/canali configurati e copertura automatica equivalente per tutte le altre metriche. Non sono stati misurati uptime, p50/p99 del servizio completo, carico massimo o RPO/RTO reali; vanno verificati su staging. La retention dei dati tecnici usa la policy descritta in PRIVACY.md.

## Sito pubblico — Web Vitals minimizzati

Lo STEP 11 invia in modalità best-effort `PUBLIC_PAGE_VIEW` e le metriche browser TTFB, FCP, LCP, CLS e INP alla Edge Function pubblica `public-telemetry`. Il payload è chiuso a percorsi pubblici noti, non contiene IP, user-agent, nomi cliente, contenuti prenotazione o identificativi di customer session; il percorso `/tavolo/{public_table_id}` è escluso. La funzione verifica l’eventuale sede attiva, applica rate limiting sul client IP fornito dal gateway fidato e scrive in `telemetry_events` con request/correlation ID. La scrittura diretta anon alla tabella resta revocata. Un errore telemetry non deve interrompere navigazione, menu o prenotazione.

Queste metriche sono diagnostiche e non costituiscono da sole il gate prestazionale: prima di chiudere STEP 11 serve ancora una misura real-browser sul deployment HTTPS effettivo.
