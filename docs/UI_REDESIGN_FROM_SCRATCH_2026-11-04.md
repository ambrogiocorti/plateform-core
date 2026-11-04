# Plateform — riprogettazione dell'esperienza, 4 novembre 2026

## Decisione

Il precedente intervento estetico non soddisfaceva il proprietario del prodotto.
La nuova direzione **non consiste in un cambio palette**: si cambia prima la
gerarchia dell'applicazione e poi il linguaggio visivo dei singoli flussi.
Il lavoro resta confinato a un ramo separato; nessun rilascio in produzione.

## Nuova architettura UX staff

1. **Navigazione primaria ridotta:** al massimo sei sezioni importanti per
   ruolo, preordinate in modo operativo. Il default desktop è il rail a icone,
   espandibile e persistente.
2. **Directory autorizzata:** tutte le funzioni non primarie si trovano in una
   finestra organizzata per servizio, flussi, ristorante e amministrazione. Le
   rotte sono filtrate per ruolo e funzionalità/licenza esattamente come prima;
   gli RPC server rimangono autorevoli.
3. **Mobile:** prime quattro destinazioni e pulsante “Tutte” nella bottom bar;
   le destinazioni nascoste rimangono raggiungibili dalla directory.
4. **Una sola intestazione per vista:** eliminati i tab orizzontali duplicati
   da tutte le pagine staff. Topbar compatta per sede, connessione, ricerca,
   notifiche, tema, blocco e profilo.
5. **Panoramica ADMIN ricostruita:** sintesi operativa compatta, quattro KPI
   realmente provenienti dalla RPC esistente, matrice aree e colonna priorità
   con azioni; niente mega-hero e niente dati fittizi.
6. **Accessibilità:** etichette dei controlli, dialog nativo con Escape,
   stato current, tab/focus, `prefers-reduced-motion`, tema chiaro/scuro,
   contrasto e stampa conservati.

## Vincoli preservati

- Autenticazione e autorizzazioni per ruolo, RLS, realtime, offline e
  operazioni idempotenti rimangono intatti.
- La sidebar non offre rotte o moduli senza licenza.
- Menu cliente/QR, KDS, cassa, accoglienza e configurazione conservano per ora
  le interazioni già collaudate: nessun redesign di facciata può nascondere la
  perdita di funzioni operative.
- L'app è ancora candidata in PR: lo stato go-live resta **NO-GO** fino a
  backup reale, restore, stampa fisica, provider e accettazione.

## Percorso per il completamento dell'interfaccia

- **Fase 1, in questo ramo:** shell comune e dashboard operativa ADMIN reali.
- **Fase 2:** progettare e implementare vista a vista i workspace sala,
  accoglienza, cucina/Pass, cassa e prenotazioni; prove di utilizzo a 1440,
  1280, 820, 390 e 360 pixel con utenti/ruoli di staging.
- **Fase 3:** sito pubblico, menu fotografico, carrello e prenotazioni con
  esperienza autonoma dal gestionale; rispettare brand dei ristoranti.
- **Fase 4:** sistemi trasversali (stati, errori, form, modali, grafici,
  accessibilità, tema scuro), regressioni visuali ed E2E, revisione con
  Ambrogio prima di promuovere la PR.

### Criterio di accettazione

Una fase non è chiusa da soli test statici: richiede navigazione reale per
ruolo, verifica delle azioni e un confronto visivo con l'utilizzatore. Gli
Screenshot e risultati del collaudo vanno allegati al ramo prima di
un'eventuale promozione.
