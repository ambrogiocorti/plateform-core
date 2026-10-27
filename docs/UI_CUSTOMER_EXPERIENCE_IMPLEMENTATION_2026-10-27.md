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
