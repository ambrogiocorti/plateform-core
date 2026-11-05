# Prompt completo per Claude Code — rifacimento di Plateform

Copia il testo dalla riga seguente fino alla fine in Claude Code, con accesso al repository GitHub indicato.

---

Lavora realmente sul repository GitHub `ambrogiocorti/plateform-core` e riprogetta completamente l'interfaccia di **Plateform**, il mio gestionale per ristoranti. Devi realizzare un prodotto professionale, moderno, coerente e riconoscibile, con una progettazione curata nei dettagli e adatta all'uso durante un servizio reale.

Non mi soddisfa la grafica attuale. Autorizzo il rifacimento completo dell'esperienza visiva: architettura delle pagine, gerarchie, navigazione, disposizione dei contenuti, tipografia, componenti, spaziature e interazioni. Cambiare soltanto colori, font, bordi o ombre non soddisfa la richiesta. Devi intervenire nel codice e consegnare un risultato utilizzabile, non limitarti a una proposta o a un mockup.

## 1. Parti dal lavoro corretto su GitHub

- Repository: `https://github.com/ambrogiocorti/plateform-core`.
- Il lavoro recente dell'interfaccia è nella PR #58, ramo `redesign/experience-shell-20261104`, basata sulla candidata funzionale della PR #57, `fix/release-edition-contracts-20261103`.
- Il commit di riferimento verificato il 5 novembre 2026 è `da64978e4f3c579d22854a52ccccc54f1c13a815`. Prima di iniziare controlla se il ramo ha aggiornamenti: non ripristinare questo commit sopra lavoro successivo.
- Non presumere che `main` contenga già tutte le funzionalità. Verifica branch, PR, commit, stato locale e dipendenze. Crea il ramo di redesign dalla candidata aggiornata che contiene il lavoro, preservando eventuali modifiche locali.
- Usa GitHub per versionamento, commit, PR e verifiche. Rispetta la scelta di usare GitHub Pages per l'anteprima; non introdurre Vercel come requisito per vedere il risultato.
- Distingui pubblicazione dell'anteprima e rilascio commerciale. Usa il workflow Pages appropriato dopo averne controllato configurazione, backend e permessi. Non dichiarare pubblicata una build che esiste solo come artifact.

## 2. Leggi le specifiche e accerta cosa esiste

Prima di implementare, leggi `CLAUDE.md`, `README.md`, `package.json` e questi documenti, se presenti:

1. `docs/plateform-handoff/MASTER_PROMPT_PLATEFORM_COMMERCIALE_AGGIORNATO.md`, specifica integrale §§0–157, con attenzione alle sezioni 124–126.
2. `docs/plateform-handoff/ROADMAP_IMPLEMENTAZIONE_STEP_0_13.md` e la roadmap originale.
3. `docs/ROADMAP_STATUS.json` e `docs/IMPLEMENTATION_STATUS.md`.
4. `docs/UI_REDESIGN_FROM_SCRATCH_2026-11-04.md`.
5. `docs/GITHUB_PAGES_HOSTING_2026-10-27.md`.
6. `docs/RELEASE_CANDIDATE_RECONCILIATION_2026-11-03.md` e i registri più recenti.

I report storici descrivono la loro data: controlla il codice e le evidenze attuali. Non ripetere come fatti attuali problemi già risolti né chiamare complete funzionalità ancora da verificare.

Esamina entrambe le applicazioni in `apps/staff` e `apps/public`, le pagine in `src/pages`, i componenti e gli import CSS. Nel repository esistono più fogli di stile, inclusi `styles/tokens.css`, `styles/plateform-design-system.css`, `styles/staff-app.css`, `styles/workspace-v5.css`, `styles/workspace-redesign.css`, `styles/frontdesk-v4.css`, `styles/public.css` e `styles/restaurant-redesign.css`. Ricostruisci quali siano effettivamente usati prima di modificarli.

## 3. Vincoli tecnici e funzionali

- Mantieni **HTML semantico, CSS moderno, TypeScript strict, ES Modules e Vite**. Il progetto è vanilla: non migrarlo a React, Next.js, Vue, Svelte, Angular o a un nuovo framework.
- Riutilizza servizi, tipi, validazioni, RPC ed Edge Functions esistenti. Il redesign può riorganizzare il DOM e i componenti di presentazione, senza riscrivere indiscriminatamente il dominio.
- Preserva autenticazione, MFA, PIN, recupero password, permessi, scope sede, RLS, licenze, feature flag, audit, Realtime, code offline e riconciliazione.
- Prezzi, disponibilità, ordini e pagamenti restano autorevoli sul server. Mantieni importi in centesimi, idempotenza, protezione da doppio invio e gestione degli esiti incerti.
- L'obiettivo concordato è **un solo progetto Supabase cloud per questa installazione**, con sviluppo e test distruttivi in ambienti locali o isolati. Non creare altri progetti cloud per il redesign. L'unificazione dei progetti esistenti è un'attività separata: non cancellare, unire o spostare dati e non cambiare il backend della preview di nascosto.
- Una sola catena per installazione; multi-sede opzionale. Con `MULTI_VENUE=false` evita selettori sede e complessità inutili.
- Nessuna chiave privata, service-role key o credenziale nei bundle, nei commit o nei log. Nessun dato sensibile nelle cache pubbliche.
- Non eliminare funzioni perché difficili da impaginare. Le operazioni secondarie possono essere raggruppate, purché restino facilmente individuabili dagli utenti autorizzati.

## 4. Direzione creativa concreta

Progetta un'identità da software professionale per hospitality: precisa, sobria, contemporanea, calda e leggibile. L'utente deve riconoscere un sistema pensato per sala, cucina e cassa.

Usa come base la palette indicata nel Master Prompt: ossidiana `#111315`, superficie scura `#191C1F`, avorio `#F4F0E8`, pietra `#D8D2C8` e bronzo `#B88A55`. Puoi rifinire i valori per contrasto e coerenza. Il bronzo deve essere un accento controllato; non applicarlo a ogni bordo, titolo o pulsante. I colori di successo, avviso ed errore devono avere un significato operativo costante.

Mantieni il logo originale in `assets/plateform/logo-plateform-originale.png` e usa la versione ottimizzata quando adatta. Non ridisegnarlo, deformarlo o trasformare l'intera interfaccia in una ripetizione del suo effetto metallico. Verifica leggibilità e dimensioni reali del marchio nella UI, nella favicon e nella PWA.

Definisci un sistema, non una raccolta di decorazioni:

- una famiglia sans leggibile per il gestionale, con pochi pesi; evita dipendenze remote superflue e assicurati di avere fallback validi;
- numeri tabulari per prezzi, totali, tempi e indicatori quantitativi;
- scala di spaziatura coerente, ad esempio su multipli di 4 e 8 pixel;
- titoli, testi, didascalie e metadati con gerarchie esplicite;
- superfici piatte ben separate, bordi discreti, ombre limitate a elementi che ne hanno bisogno;
- raggi coerenti e contenuti; niente pulsanti e contenitori tutti a pillola;
- icone della stessa famiglia, con etichette quando il significato non è immediato;
- tema chiaro e tema scuro progettati e controllati entrambi;
- transizioni brevi e funzionali, nel rispetto di `prefers-reduced-motion`.

Voglio evitare l'aspetto generico delle interfacce generate automaticamente: niente gradienti viola/blu decorativi, bagliori, glassmorphism diffuso, enormi hero nell'area staff, griglie di card tutte uguali, ombre pesanti ovunque, emoji come sistema di icone, dati inventati, frasi promozionali vuote e spazi enormi che rallentano il lavoro. Non basta togliere questi elementi: costruisci composizioni specifiche per il compito di ogni schermata.

## 5. Ripensa l'architettura dell'interfaccia

Ogni pagina deve permettere di capire rapidamente: dove sono, cosa sta succedendo e qual è la prossima azione utile.

Desktop: navigazione stabile con etichette chiare, poche destinazioni primarie per ruolo, titolo di pagina unico e area centrale adatta al lavoro. Sede, turno, stato connessione, ricerca e notifiche devono essere accessibili senza competere tutti con il contenuto. Non duplicare la stessa navigazione in sidebar, tab, toolbar e card.

Smartphone: progetta una composizione autonoma con navigazione compatta, controlli raggiungibili e azioni contestuali. Non comprimere la sidebar desktop. Mantieni il contesto quando si apre un dettaglio e assicurati che tastiera, bottom bar e azioni fisse non coprano campi o pulsanti.

Separa il riepilogo dall'azione. Mostra poche informazioni determinanti subito e dettagli su richiesta. Usa tabelle per dati da confrontare, elenchi per sequenze operative, drawer per dettagli contestuali e dialog per decisioni brevi. Non racchiudere ogni testo in una card né usare modali per ogni passaggio.

## 6. Ridisegna tutti i percorsi, con priorità al servizio

| Area                           | Risultato richiesto                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accesso staff                  | Login essenziale e curato; password, PIN, MFA e recupero comprensibili; errori vicini al campo, nessuna distrazione commerciale.                                                                                   |
| Panoramica                     | Riepilogo del servizio e priorità operative basati su dati reali; pochi indicatori pertinenti al ruolo, azioni dirette verso problemi e attività.                                                                  |
| Sala                           | Pianta dominante su desktop/tablet quando utile; elenco leggibile su mobile; ricerca e filtri compatti, legenda e stati chiari; dettaglio tavolo contestuale con conti, coperti, responsabile e azioni consentite. |
| Accoglienza e prenotazioni     | Relazione chiara tra arrivi, prenotazioni, walk-in e tavoli; pianta ed elenco non devono sovrapporsi; mantieni utilizzabili le colonne anche a larghezze intermedie.                                               |
| Cameriere e comanda            | Dal tavolo al conto, scelta piatti, varianti, rimozioni, step e invio in poche interazioni; ricerca rapida, disponibilità e totale leggibili, riepilogo persistente senza coprire il catalogo.                     |
| Cucina e Pass                  | Ticket leggibili a distanza, tavolo, orario, attesa, step, quantità e modifiche evidenti; allergeni ben visibili; azioni coerenti con la state machine e senza modali ripetitive.                                  |
| Cassa                          | Conti e ricerca in una zona, dettaglio e totale in una zona stabile, pagamento in un contesto chiaro; divisioni, parziali e metodi misti comprensibili; residuo, resto ed esito non ambigui.                       |
| Conti e rettifiche             | Dettagli e movimenti ordinati; spostamenti, sconti, rimborsi e storni mantengono permessi e conferme; importi e stato economico sempre coerenti.                                                                   |
| Catalogo e disponibilità       | Elenco o tabella efficiente, ricerca, categorie, prezzi, disponibilità e archiviazione; editor ordinato per informazioni essenziali, ingredienti/allergeni e opzioni avanzate.                                     |
| Amministrazione                | Impostazioni raggruppate per compito; moduli brevi, modifiche non salvate riconoscibili; utenti, ruoli, turni e sedi gestibili senza pagine interminabili.                                                         |
| Stampa e dispositivi           | Stato stampante, coda, esiti e retry comprensibili. Non mostrare una stampa fallita come riuscita; conserva la distinzione tra ricevuta di cortesia e documento fiscale.                                           |
| Notifiche, offline e conflitti | Avvisi proporzionati alla gravità; azioni in attesa, rifiutate o da riconciliare riconoscibili; nessun successo simulato quando il server non ha confermato.                                                       |
| Statistiche e salute           | Dati con periodo, unità e contesto; grafici solo se utili; stato tecnico e dettagli diagnostici visibili ai ruoli appropriati.                                                                                     |
| Sito pubblico                  | Esperienza editoriale del ristorante, distinta dal gestionale: fotografie reali disponibili, menu, contatti, sedi e prenotazioni; branding del locale rispettato, Plateform discreto.                              |
| Cliente e QR                   | Esperienza mobile semplice: menu, ingredienti, allergeni, carrello, chiamata cameriere e stato delle richieste; nessuna terminologia del backend o dell'infrastruttura.                                            |

Questa tabella non autorizza a nascondere pagine secondarie: inventaria tutte le rotte e portale allo stesso livello qualitativo. Mantieni i moduli disabilitati dalle licenze o feature flag correttamente esclusi.

## 7. Componenti e stati completi

Realizza componenti riutilizzabili per navigazione, toolbar, pulsanti, campi, select, ricerca, filtri, tabelle, badge, dialog, drawer, toast, notifiche, ticket cucina, riepilogo conto e pannello pagamento. Usa token semantici comuni per colori, spaziature, tipografia, elevazione e dimensioni.

Per ogni flusso considera caricamento, dati vuoti, ricerca senza risultati, errore recuperabile, mancato permesso, invio in corso, successo, operazione rifiutata, offline e conflitto quando pertinenti. Lo stato vuoto deve aiutare a compiere un'azione reale. Nessun loader infinito e nessun dato dimostrativo inserito al posto di dati assenti.

Testi in italiano semplice e concreto. Etichette come “Invia in cucina”, “Apri conto” e “Registra pagamento” devono chiarire cosa succede. Messaggi tecnici e correlation ID possono essere disponibili nei dettagli, senza invadere il percorso ordinario.

## 8. Implementa senza accumulare strati CSS

Riorganizza i componenti e il markup quando necessario. Non aggiungere un altro grande foglio di override in fondo alla cascata per correggere quello precedente. Identifica le regole effettive, consolida progressivamente il design system ed elimina solo gli stili dimostrati inutilizzati, dopo averne verificato gli impatti anche sul pubblico.

Evita nuove catene di selettori e `!important` generalizzati, HTML costruito con contenuti non fidati, duplicazioni di logica, handler persi dopo il rendering e stili inline ripetuti. Preserva focus, input, scroll e selezioni durante gli aggiornamenti Realtime; un cambiamento di stato non deve cancellare una comanda in preparazione o spostare il pulsante sotto il dito.

Gli asset devono avere dimensioni adatte e non rallentare l'accesso. Non introdurre librerie pesanti per elementi realizzabili con HTML/CSS/DOM. Non alterare migrazioni, API o policy per adattarle a una scelta estetica.

## 9. Verifica qualità visiva e uso reale

Controlla almeno 360, 390, 768/820, 1024, 1280 e 1440 pixel, e le altezze ridotte dei dispositivi in uso. Verifica contenuti lunghi, nomi tavolo lunghi, molti piatti, conto con molte righe, risultati vuoti, errori e notifiche simultanee. Questi casi possono usare fixture di test esplicite; non introdurle come dati reali nell'app.

Requisiti di accettazione:

- nessuna sovrapposizione, testo tagliato o scorrimento orizzontale accidentale dell'intera pagina;
- eventuali tabelle o piante più ampie scorrono in un contenitore riconoscibile;
- tutti i pulsanti e link importanti sono raggiungibili con tastiera e touch;
- target touch di almeno 44×44 pixel per le azioni operative principali;
- focus visibile, label corrette, dialog con focus gestito e chiusura accessibile;
- contrasto WCAG AA, di norma almeno 4,5:1 per testo normale e 3:1 per testo grande e componenti dove previsto;
- gli stati non dipendono soltanto dal colore;
- importi in formato italiano, per esempio `1.234,50 €`, senza cambiare la rappresentazione numerica del dominio;
- light e dark mode coerenti, senza lampeggiamenti o asset illeggibili;
- nessuna regressione su ruoli, sessioni, PWA, Realtime, offline, stampa e percorso cliente.

Esegui davvero il ciclo `login → sala → conto → ordine → cucina → Pass → servizio → cassa → pagamento → chiusura` in un ambiente di prova idoneo. Verifica anche un rifiuto o errore realistico. Distingui test con fixture da prove contro servizi reali.

Leggi gli script attuali e avvia i controlli appropriati: formattazione dei file modificati, TypeScript, lint, unit test pertinenti, build CORE/FULL quando richieste e test browser delle aree toccate. Usa i gate esistenti, inclusi quelli per waiter, kitchen/Pass, host, cashier e amministrazione quando pertinenti. Non disabilitare controlli, ridurre copertura o sostituire un'interazione reale con un mock per ottenere il verde. Aggiorna i test quando cambiano intenzionalmente struttura e interazioni, mantenendo le garanzie funzionali.

Produci screenshot delle schermate completamente caricate, in desktop e mobile, nei due temi dove utile. Guardali realmente e correggi problemi di composizione, densità, contrasto e allineamento: un test passato non dimostra da solo che la grafica sia riuscita.

## 10. Ordine di esecuzione e consegna

1. Ricostruisci lo stato del repository e inventaria rotte, ruoli, componenti e problemi concreti.
2. Scrivi una breve direzione di design con scelte verificabili e mappa dei componenti.
3. Implementa design system, navigazione e accesso come prima porzione funzionante, con almeno una schermata operativa significativa per verificare la direzione.
4. Prosegui con Sala/comande, cucina/Pass, cassa, accoglienza, catalogo e amministrazione.
5. Completa pubblico e cliente, poi le schermate secondarie e gli stati trasversali.
6. Esegui verifiche funzionali, visuali e responsive; correggi i difetti prima di chiudere il lavoro.
7. Aggiorna i registri e prepara commit e PR coerenti, con screenshot e risultati dei test.

Procedi autonomamente sulle scelte reversibili e non fermarti dopo ogni pagina per chiedere se continuare. Se manca un'informazione non critica, usa una scelta ragionevole e documentala. Se un accesso impedisce una verifica ospitata, continua l'implementazione e i controlli indipendenti, poi indica il blocco preciso. Operazioni irreversibili sui dati, spese, migrazioni live e rilascio commerciale richiedono il piano e l'autorizzazione pertinenti; non servono per cominciare il redesign.

Alla consegna fornisci: ramo e commit, PR GitHub, link dell'anteprima se effettivamente pubblicata, schermate prima/dopo o evidenze del risultato, mappa di ciò che è stato ridisegnato, test eseguiti con esito, problemi residui e procedura breve per provare i percorsi principali.

Non dichiarare Plateform completamente vendibile per il solo completamento grafico: backup/ripristino reali, provider, stampante fisica e requisiti fiscali conservano i loro gate. Il risultato di questo incarico deve essere un **rifacimento completo e verificato dell'interfaccia**, integrato nelle funzionalità reali, con una qualità di progettazione riconoscibile in ogni schermata.
