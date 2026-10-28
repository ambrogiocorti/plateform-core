# Plateform — Decisioni di design confermate · 28 ottobre 2026

Questo documento blocca l'interpretazione delle 18 risposte raccolte il 27 ottobre.
Non sostituisce il Master Prompt commerciale né i requisiti di sicurezza della roadmap.

| Q | Risposta | Vincolo operativo |
|---|---|---|
| 1 | A — Elegante e premium | Estetica di prodotto software, non template rustico |
| 2 | A — Bianco, nero e blu | Palette tecnologica; non verde/avorio come precedente esperimento |
| 3 | C — Sidebar compatta a icone | Desktop collassabile, label accessibili; bottom nav mobile |
| 4 | A — Dashboard panoramica | Indicatori e moduli operativi in unica vista autorizzata |
| 5 | D — Compatto e operativo | Densità superiore per gestione ordini, tavoli e cassa |
| 6 | D — Home cliente tipo applicazione | Accessi diretti a menu/prenotazioni, NO grande hero fotografico |
| 7 | B — Griglia fotografica | Foto nelle schede piatto, non nel maxi hero della home |
| 8 | B — Pagina dettaglio piatto | Info, ingredienti, allergeni e varianti |
| 9 | B — Personalizzazioni a sezioni | Solo opzioni autorizzate dal backend |
| 10 | B — Carrello dedicato | Totali e quantità verificati |
| 11 | B — Conferma a sezioni | Rispetta DIRECT/WAITER_APPROVAL |
| 12 | A — Stato ordine semplice | Server authoritative e Realtime |
| 13 | C — Cronologia visuale | Solo dati conto/autorizzazioni corrette |
| 14 | B — Dashboard cliente a schede | Account facoltativo, nessun obbligo per QR |
| 15 | A — Preferiti a lista semplice | Persistenza locale finché non c'è identity customer |
| 16 | B — Carosello offerte | Solo promozioni abilitate e pubblicate |
| 17 | B — Centro notifiche organizzato | Per categoria e stato; privacy cliente |
| 18 | A+B — Moderno/minimalista/accogliente | Light default; dark toggle accessibile |

Account cliente facoltativo deciso successivamente. La sincronizzazione cross-device
richiede un'implementazione server/autenticazione separata: non dichiararla pronta se
in codice esistono soltanto preferiti in Local Storage.

## Due identità visive distinte

- **Sito cliente:** brand del ristorante, esperienza applicativa mobile-first,
  menu fotografico, pulsanti chiari, nessun link STAFF pubblico. La home rimane
  una pagina pubblica autentica (Master §13) e conserva informazioni su ristorante,
  orari, sedi, contatti e prenotazioni quando abilitate.
- **Gestionale Plateform:** brand di piattaforma, sidebar compatta/espandibile,
  dashboard di ruolo, dense data table, KDS e cassa. Tokens chiari/scuri
  coerenti, leggibilità, stati semantici non comunicati dal solo colore.

## Accettazione del redesign

Non basta che GitHub Pages abbia un deploy verde. Per dire che il nuovo design
funziona bisogna verificare in un browser pulito (senza service worker precedente):

1. Homepage senza maxi hero e con gli accessi alle funzioni autorizzate.
2. Tema chiaro bianco/nero/blu; scuro coerente; persistenza del toggle.
3. Menu/piatti fotografici e carrello/checkout con reali funzioni Supabase.
4. Sidebar staff a icone e toggle espandi/comprimi; bottom nav mobile.
5. Dashboard staff per ruolo con KPI e stati coerenti, verificata con dati reali.
6. Test di contrasto/tastiera, PWA e cache, viewport desktop/mobile.
7. Nessun effetto su RLS, workflow d'ordine, pagamenti o sicurezza del backend.

L'esperimento verde/avorio e il relativo mega hero del 28 ottobre sono
**esclusi dalla direzione di design definitiva**.
