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
7. **Accesso staff riprogettato:** composizione, gerarchia, spaziatura e
   responsive del login rifatti; login con password, MFA e recupero mantengono
   la stessa logica. Il blocco postazione è accessibile anche dal profilo
   mobile, dove la topbar è volutamente ridotta.
8. **Identità hospitality:** colori e superfici dell'area staff basati sulla
   sezione 125 del Master Prompt (ossidiana, avorio, pietra e bronzo), con
   contrasto e tema scuro. Marchio ritagliato in CSS dal logo originale già
   presente negli asset; il sito cliente mantiene il branding indipendente.

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

- **Fase 1, in questo ramo:** shell comune, accesso staff e dashboard
  operativa ADMIN reali.
- **Fase 2:** progettare e implementare vista a vista i workspace sala,
  accoglienza, cucina/Pass, cassa e prenotazioni; prove di utilizzo a 1440,
  1280, 820, 390 e 360 pixel con utenti/ruoli di staging.
- **Fase 3:** sito pubblico, menu fotografico, carrello e prenotazioni con
  esperienza autonoma dal gestionale; rispettare brand dei ristoranti.
- **Fase 4:** sistemi trasversali (stati, errori, form, modali, grafici,
  accessibilità, tema scuro), regressioni visuali ed E2E, revisione con
  Ambrogio prima di promuovere la PR.

### Avanzamento Sala — 5 novembre

La vista operativa della sala è stata riorganizzata con un riepilogo dei
tavoli visualizzati, ricerca per nome/numero/cameriere e filtri per sala, zona
e stato. Pianta ed elenco mantengono le azioni autorizzate già esistenti; i
tavoli senza pianta corrispondente restano raggiungibili in elenco. I conteggi
descrivono sempre la selezione attuale, anche dopo una ricerca senza risultati.

Il logo originale rimane conservato; l'interfaccia carica una sua versione
ridimensionata da circa 82 KB anziché 1,8 MB. Il verde degli stati positivi è
stato corretto per la leggibilità sullo sfondo chiaro. Il test PWA verifica il
manifest dopo la presa di controllo del service worker, tollerando il reload
previsto alla prima installazione senza saltare le verifiche di funzionamento.

Sul commit `c9a8e0e936cd504e47cacab9393067717f4d106c` sono passati TypeScript,
lint, formattazione, build CORE/FULL, 40 test browser e 41 scenari integrati
su servizi isolati. Le prove di accessibilità, PWA e prestazioni prima fallite
sono passate: l'accesso staff ha trasferito 208 KB nel test su rete lenta.
L'anteprima Vercel dello stesso commit è READY.

Durante la revisione degli screenshot è emerso che il test precedente poteva
fotografare il caricamento invece del contenuto effettivo. Il controllo ora
attende la pagina completa e aggiunge una cattura mobile della Sala; questa
variazione del test richiede una nuova esecuzione. Le verifiche dell'anteprima
ospitata e i gate commerciali rimangono aperti finché non esistono evidenze
aggiornate.

### Criterio di accettazione

Una fase non è chiusa da soli test statici: richiede navigazione reale per
ruolo, verifica delle azioni e un confronto visivo con l'utilizzatore. Gli
Screenshot e risultati del collaudo vanno allegati al ramo prima di
un'eventuale promozione.

## Verifica delle revisioni visuali

- La prima verifica browser reale aveva evidenziato un marchio duplicato
  (pseudo-elemento CSS legacy) e cinque pulsanti di comando illeggibili a
  390 px. Ora il pseudo-logo è eliminato, notifiche e audio usano icone SVG,
  il profilo è compatto e blocco/tema sono accessibili anche dal menu profilo.
- Il test isolato `tests/e2e-live/workspace-v5-live.spec.ts` verifica layout
  desktop/mobile, assenza della duplicazione del logo, limiti della topbar,
  directory con permessi e screenshot di login/Operazioni/Sala/Accoglienza/
  Cucina. Gli screenshot sono nell'artefatto GitHub Actions
  `plateform-v5-design-review` della workflow integrata.
- Preview Vercel della PR #58:
  `https://plateform-development-git-redesign-e-d8ae9a-sambrogiocorti-5259.vercel.app`
  con nove variabili di ambiente **limitate al branch di preview**, collegate
  al progetto Supabase di staging. Nessuna variabile di produzione alterata.
- **Verifica funzionale staging da completare:** la nuova origin della PR #58
  deve essere aggiunta a `ADDITIONAL_ALLOWED_ORIGINS` delle Edge Functions
  senza rimuovere l'origin della PR #57. Il connettore Supabase non gestisce
  secrets, e la dashboard attualmente richiede un nuovo login; fino a quel
  momento le chiamate cross-origin della nuova preview non sono certificate.
