# Plateform — interfaccia cliente, rilascio di lavoro 2026-10-27

## Decisioni e provenienza

Branch dedicato: `feature/customer-experience-light-theme-20261027`, creato dalla
testa della PR #41 (`plateform/two-phase-completion-20261013`) per non perdere
le modifiche già presenti nel candidato di completamento. Nessuna modifica al
database remoto e nessuna pubblicazione in produzione.

| Domanda    | Scelta confermata                | Realizzazione nel branch                                           |
| ---------- | -------------------------------- | ------------------------------------------------------------------ |
| 7          | B — griglia fotografica          | Card responsive e immagine/placeholder                             |
| 8          | B — pagina dedicata al piatto    | `/menu/:slug/piatto/:id` con dati pubblicati                       |
| 9          | B — personalizzazione a sezioni  | Quantità, rimozioni e varianti raggruppate nel selettore QR        |
| 10         | B — pagina dedicata al carrello  | Schermata distinta dal catalogo QR, quantità e rimozioni           |
| 11         | B — conferma a sezioni           | Riepilogo, modalità di invio, conferma                             |
| 12         | A — stato semplice               | Stato esplicito delle richieste del tavolo                         |
| 13         | C — cronologia visuale           | Timeline delle pietanze già ordinate nel conto attuale             |
| 14         | B — dashboard personale a schede | Riepilogo conto, azioni e spazio del cliente                       |
| 15         | A — lista semplice               | Preferiti locali per ristorante, senza dati personali              |
| 16         | B — carosello di offerte         | Promozioni server-side visibili nella carta pubblicata             |
| 17         | B — centro notifiche organizzato | Stato e cronologia delle richieste del conto QR                    |
| 18         | Stile A+B                        | Tema chiaro predefinito, moderno e caldo, toggle scuro persistente |
| Successiva | A — account cliente facoltativo  | QR senza registrazione; nessun finto account permanente            |

Le domande 1–6 **non sono ricostruibili con certezza** dai messaggi consultabili:
occorre recuperare le relative risposte prima di dichiarare completo il design
dell'intera piattaforma.

## Confronto con specifiche e roadmap

- Master Prompt §53: il cliente può ordinare solo se abilitato dal ristorante;
  `WAITER_APPROVAL` resta la modalità predefinita e l'invio chiama la RPC
  esistente, con verifica autorizzativa lato server.
- Master Prompt §54: è possibile modificare il carrello prima dell'invio;
  le modifiche sono bloccate durante un invio di esito incerto, conservando
  la chiave di idempotenza.
- Master Prompt §§55–56: le notifiche del tavolo non sostituiscono il centro
  notifiche operativo dello staff.
- Master Prompt §153: il carosello usa **solo** promozioni restituite dalla RPC
  pubblica con filtri lato server per licenza, visibilità e validità; non applica
  sconti o prezzi calcolati nel browser.
- Roadmap Step 11: frontend pubblico responsive, brand, accessibilità e
  performance. L'intervento non modifica gli step del servizio staff già
  presenti nella PR #41.

## Confini reali dell'implementazione

- La sessione QR resta una sessione temporanea collegata al conto del tavolo.
  Non è un account permanente e non richiede la registrazione del cliente.
- I preferiti sono disponibili **solo su questo browser/dispositivo**. Un
  account opzionale autenticato, con preferiti e ordini tra visite diverse,
  richiederebbe un nuovo disegno di Auth, revoca, privacy/RLS, migrazioni e
  test di sicurezza: **non implementato**. Non si collega un'identità duratura
  alla sessione temporanea solo per presentare una schermata di accesso.
- La cronologia riguarda il conto corrente, non lo storico delle visite.
- Il carosello è basato sui dati pubblici esistenti; prima della release serve
  verificare dal vivo anche limiti d'impressione e comportamento delle varie
  modalità promozionali configurate.
- Le schermate carrello/conferma sono viste distinte nella pagina QR, con
  bozza in memoria durante la sessione SPA. Non sono URL ricaricabili.

## Verifiche e blocchi al rilascio

- TypeScript strict, ESLint: eseguiti con successo.
- Vitest unitari: **125/125 superati** (20 file).
- Vitest database isolato PGlite: **166 superati, 4 saltati** (14 file).
- Gate automatici `check:step11`: **superati**; verifiche statiche,
  prerender, assemblaggio, booking, asset, recovery e fixture HTTP.
- Build Vite pubblico + staff: riuscito; artefatti **non** pubblicati.
- E2E Playwright: test di flusso aggiornati e nuovi test per il menu/tema;
  **non eseguiti** perché Chromium non è installato e il download disponibile
  restituisce un archivio non valido. Il fallimento è prima dell'avvio pagina.
- Test con database reale/staging, dispositivi fisici, screen reader e contrasto:
  ancora necessari.
- La PR #41 mantiene i propri blocchi di migrazioni e rilascio; questa UI non
  li risolve e non autorizza un go-live.

**Gate:** non effettuare merge, promozione ambienti, attivazione dominio o
pubblicazione in produzione prima dei collaudi browser/staging e della
riconciliazione delle migrazioni indipendentemente bloccate.

## Continuazione: lista d’attesa end-to-end (branch della stessa PR)

- Nuova pagina pubblica `/lista-attesa` con account facoltativo (nessun login
  richiesto), scelta sede/servizio/orario, consenso privacy, validazioni e
  idempotenza; l’esito `WAITING` è esplicitamente **non** una prenotazione.
- Quando non ci sono posti prenotabili, la pagina `/prenota` suggerisce la
  lista d’attesa. Licenza `WAITLIST`, disponibilità, servizio e date restano
  verificati dalle RPC PostgreSQL: nessun inserimento aggira il blocco server.
- L’Host consulta i candidati con `get_waitlist_candidates`, legge l’ordine
  di priorità del server e propone il posto tramite `offer_waitlist_slot`.
  Il collegamento d’accettazione contiene un token effimero nel **fragment**
  dell’URL, non nella query string; va inviato individualmente al cliente.
- `/lista-attesa/offerta` elimina subito il fragment dalla barra degli
  indirizzi, esclude questa pagina da SEO e telemetria pubblica e chiama
  l’Edge Function `waitlist` per accettare. `RESERVED` e `PENDING_DEPOSIT`
  producono messaggi distinti, senza dichiarare completata una caparra.
- La Edge Function usa il client `service_role` solo lato server, schema
  richieste rigoroso, limiti per IP verificato e le RPC atomiche già presenti.
  La funzione è pubblica ma la tabella non espone nuove policy anonime.
- Correzione SQL append-only
  `20261027183000_waitlist_acceptance_idempotent_replay.sql`: la funzione
  atomica originaria viene confinata nello schema `private`; un wrapper
  `public` accessibile **solo** a `service_role` permette di recuperare
  l’esito di una conferma già eseguita se coincidono UUID, token e chiave
  di idempotenza. È stato provato il caso reale di risposta persa, che la
  vecchia implementazione rifiutava.
- Aggiornati il router, le rewrite Vercel di staging e i relativi header
  `noindex`/`no-store`, senza deploy.

### Verifiche della continuazione

- Typecheck, lint, formattazione, build Vite pubblico + staff: verificati.
- Unit test Vitest: 131 superati, inclusi token riservati e slot notturni.
- Database isolato PGlite: 169 superati e 4 saltati; nuovi test SQL per
  permessi, doppia richiesta, priorità, token falsificato, conferma e retry.
- `check:step11`: passato, incluse rewrite e header di staging (36 controlli
  sulla configurazione Vercel).
- Playwright: tre nuovi test della lista d’attesa caricati dalla suite, ma
  **non eseguiti**; manca Chromium funzionante nell’ambiente.
- `check:edge`: **non completato** perché l’ambiente non riesce a scaricare
  il manifesto JSR `@supabase/functions-js` già richiesto da
  `payment-return`. Le nuove funzioni devono ancora essere validate in una
  CI con accesso a JSR e in staging.
- Il controllo della build Vercel ha segnalato advisory HIGH su Vite e Zod:
  aggiornati i pin a Vite `8.3.5` e Zod `4.6.7` (anche gli import Edge),
  con audit npm `NO_HIGH_OR_CRITICAL`. Allineati i self-test al nuovo
  conteggio **esatto** di 483 migrazioni; la promozione da una storia remota
  incongruente resta bloccata.
- `npm run build:pages` è arrivato a completare **131 test unitari, 169
  test database, typecheck e bundle Vite**. La sola fase finale di assemblaggio
  GitHub Pages si arresta senza le URL di staging e la chiave pubblicabile,
  necessarie per prerenderizzare dati reali. Configurazione con workflow
  GitHub Pages **solo manuale** in
  `docs/GITHUB_PAGES_HOSTING_2026-10-27.md`.

### Blocchi ancora aperti

Nessuna Edge Function è stata distribuita, nessuna migrazione è stata
applicata a Supabase remoto, nessun dato reale è stato modificato.
Rimangono migrazioni da riconciliare nella PR di base, staging indipendente,
prove browser e dispositivi, ripristino backup, provider esterni/hardware
e verifica giuridico-commerciale. È disponibile il **flusso implementato nel
codice**, non l’autorizzazione a vendere o andare in produzione.
