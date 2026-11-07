# Plateform · Interfaccia 2.0 · specifica e verifica (28 ottobre 2026)

## Ambito

Sostituisce i precedenti overlay grafici incompleti con un design system reale
condiviso fra app pubblica, menu, tavolo/QR e tutte le viste del gestionale
staff. Le funzioni degli ordini, RLS, Realtime, pagamenti e workflow operativi
**non** sono state riscritte per ragioni estetiche: mantenere i percorsi
server-authoritative previsti dal Master Prompt e dagli Step 0–13.

## Decisioni utente da rispettare

- Premium, minimalista, moderno, accogliente, palette **bianco, nero, blu**.
- Tema chiaro iniziale, alternabile con dark, preferenza persistente.
- Staff: sidebar compatta a icone, espandibile; KPI panoramici e viste dense.
- Cliente: homepage in stile applicazione **senza maxi-hero pubblicitario**.
- Menu: fotografie solo nelle schede prodotto, griglia, navigazione categorie,
  ricerca locale dei piatti, dettaglio dedicato con allergeni e ingredienti.
- Tavolo QR: l'ordine resta possibile senza registrazione; carrello,
  personalizzazioni autorizzate, checkout a sezioni, stato e storico conto.
- Preferiti sul dispositivo finché l'autenticazione cliente cross-visita non è
  completa; evitare descrizioni false della sincronizzazione cloud.
- Promozioni e notifiche soltanto se backend e licenza le rendono disponibili.

## Architettura visiva

`styles/plateform-design-system.css` contiene tokens semantici chiaro/scuro,
campi, focus, pulsanti, tabelle, modali, messaggi di errore, KPI, tipografia,
spaziature e breakpoints. `styles/public-app.css` e
`styles/staff-app.css` importano il sistema condiviso e compongono layout
differenti. I vecchi `public.css` / `staff.css` restano per gli
elementi specialistici e la stampa; l'overlay precedente
`public-experience.css` non fa più parte del bundle.

Il brand del singolo ristorante viene rispettato: font, logo, sfondo e accento
passano sempre dalle proprietà del sito validate dal codice esistente.
La sidebar staff rappresenta invece il prodotto Plateform.

## Gate CI di corrispondenza artifact

`scripts/check-step11-static.mjs` verifica componenti e import sorgente.
`scripts/check-visual-design.mjs` viene eseguito **dopo** la build Pages e
controlla che i CSS distribuiti contengano davvero design system, home,
schede, nav cliente, carrello, login, sidebar staff, KPI, KDS e modal.
Questo è un controllo tecnico: non è un giudizio estetico né sostituisce
screenshot e test con i dispositivi.

## QA obbligatorio prima del go-live

1. Desktop 1440 e 1280, tablet 820 e mobile 390/360: home cliente, menu e
   dettaglio, tavolo con QR, carrello, conferma, prenotazioni e contatti.
2. Staff per **ogni ruolo autorizzato**, incluse login, sidebar collassata,
   topbar, dashboard, sala, cassa, comande, cucina, configurazione ed errori.
3. Persistenza light/dark dopo refresh; dati leggibili in entrambi i temi.
4. Navigazione a tastiera, focus, contrasto AA, testo al 200%, aria-label,
   zero overflow orizzontale non intenzionale.
5. PWA: verifica URL e cache; staging non riusa asset della release precedente.
6. Conferma E2E con Supabase staging, nessun dato reale, nessun merge o
   pubblicazione commerciale senza la relativa approvazione.

Il test non autorizza il rilascio sul dominio di vendita.
