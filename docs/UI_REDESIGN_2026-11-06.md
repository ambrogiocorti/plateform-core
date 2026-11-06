# Plateform — rifacimento operativo, 6 novembre 2026

## Base e obiettivo

Ramo `redesign/hospitality-workspaces-20261106`, derivato dal commit `12bf1ff` della PR #59 e quindi dalla candidata funzionale/grafica della PR #58. Il prompt allegato dal proprietario richiede di applicare il rifacimento nel codice, mantenendo TypeScript vanilla, Vite, servizi e contratti esistenti.

## Interventi

| Area                    | Comportamento della candidata                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design system           | Token semantici spostati in un solo file condiviso, `styles/tokens.css`; palette calda chiara/scura, controlli, bordi e superfici coerenti anche nei dialog aperti fuori dalla shell.                                                                                |
| Accesso                 | Composizione compatta con marchio originale, form centrale e informazioni essenziali; rimossi il grande messaggio promozionale e i suoi elementi decorativi. Login, MFA e recovery mantengono i servizi esistenti.                                                   |
| Navigazione             | Menu desktop con etichette visibili come impostazione iniziale; preferenza esplicita per la modalità compatta conservata. Navigazione mobile e directory autorizzata rimangono disponibili.                                                                          |
| Panoramica              | Stato del servizio compatto, indicatori allineati e aree operative in elenco; rimossi il grande pannello a gradiente e la griglia di schede sovradimensionate.                                                                                                       |
| Comande                 | Catalogo e riepilogo affiancati su desktop; due viste dedicate su telefono con totale/invio sempre raggiungibili. Ricerca, categorie, quantità, uscite, ingredienti e varianti conservano la selezione. Prezzi indicativi, conferma server e idempotenza preservati. |
| Conti                   | Elenco compatto al posto delle card ripetute; dettaglio con saldo allineato, azioni, storico e sezione finanziaria distinta, senza cambiare le operazioni economiche.                                                                                                |
| Cassa                   | Conto selezionato riconoscibile nella ricerca anche dopo un aggiornamento; conservati protezione dalle risposte obsolete, scorciatoie, residui e pagamenti parziali/misti.                                                                                           |
| Accoglienza             | Intestazione e indicatori compatti; sala, arrivi, prenotazioni e lista d'attesa conservano i workspace e le azioni autorizzate.                                                                                                                                      |
| Cucina/Pass             | Filtro conservato per sede e ruolo nella sessione, con stato vuoto esplicito; nessuna modifica alle transizioni o ai dati allergeni.                                                                                                                                 |
| Catalogo/configurazione | Navigazione verticale per modulo su desktop e scorrimento orizzontale su mobile; ricerca dei record già autorizzati, conteggio e azioni di modifica conservati.                                                                                                      |
| Pubblico                | Fallback della home con indirizzo e contatti reali al posto di grandi monogrammi decorativi; nessuna fotografia simulata per i piatti. I link alle sezioni disabilitate restano esclusi e la personalizzazione del ristorante è preservata.                          |
| Altre schermate         | Componenti condivisi, token, superfici, controlli e dialog aggiornati; i moduli, le rotte, le licenze e i permessi restano quelli della candidata. Il completamento della revisione visiva va distinto dall'applicazione dei componenti comuni.                      |

La logica dell'editor comande è separata in `src/components/order-composer.ts`; `src/pages/accounts.ts` continua a gestire autorizzazioni contestuali, validazione delle selezioni, invio, coda offline e navigazione. L'editor non calcola prezzi autorevoli né risolve disponibilità concorrenti sul client.

La panoramica ha un solo proprietario CSS, `styles/operations.css`, importato dal componente. Sono state rimosse 155 regole dashboard preesistenti dai due fogli workspace: nessuna altezza ereditata del vecchio hero, righe operative con azione dedicata e pannello priorità alto quanto il suo contenuto. Un controllo browser misura la densità effettiva dei due pannelli principali.

La revisione delle schermate secondarie ha portato a ricomporre anche Statistiche: indicatori economici compatti, periodo in una toolbar, criteri di lettura su richiesta e sezioni di dettaglio affiancate. Importi, aggregazioni, licenze ed esportazione CSV restano quelli della RPC autorevole. Il selettore d'ambito appare quando ci sono più sedi abilitate.

L'editor del sito ha sei sezioni dedicate, con campi sempre montati durante la navigazione, avviso delle modifiche da salvare e pubblicazione unica. La storia usa un campo multilinea; un valore non valido riapre la sezione corretta prima della segnalazione. Il test integrato modifica più sezioni e verifica il risultato nel sito pubblico; ogni sezione viene sottoposta all'audit di accessibilità anche se inizialmente chiusa.

La riconciliazione periodica conserva la bozza del sito anche quando il focus passa a un pulsante di sezione: mostra l'avviso di aggiornamento anziché rimontare il modulo. Il caricamento di file e gli errori di contrasto hanno un esito vicino ai controlli, senza coprire il pulsante di salvataggio. Il test di upload verifica esplicitamente la conservazione del logo durante una riconciliazione, poi il salvataggio di logo e galleria nello Storage reale isolato.

Gli screenshot vengono copiati tra un gruppo di test e il successivo in una cartella di sole immagini, esterna a quella che Playwright ripulisce automaticamente. Il workflow conserva esclusivamente i PNG previsti, includendo le pagine per ruolo e il ciclo del servizio.

## Verifiche locali eseguite

- 389 test applicativi passati prima dell'ultima riorganizzazione dei layout; la CI ripete la suite sulla candidata pubblicata.
- TypeScript, lint e formattazione dei sorgenti passati sulle modifiche correnti.
- Build CORE pubblica e staff passata; profilo FULL verificato separatamente dalla CI.
- Contratti strutturali Admin, Host, Cashier, Waiter, design system e Step 11 passati dopo gli interventi pertinenti.
- Contrasto dei bordi dei controlli verificato: 4,12:1 chiaro e 7,19:1 scuro contro la superficie corrispondente.
- Handoff originale conservato, verifica dei suoi 11 file immutabili passata.

La distribuzione Chromium nell'ambiente locale ha restituito un archivio non valido. L'anteprima gestita disponibile è HTTP su `terminal.local`, che non fornisce il contesto sicuro richiesto da `crypto.randomUUID` usato dall'app. Non è stato inserito un fallback meno sicuro per aggirare questo limite: il collaudo browser viene eseguito nei runner GitHub e sull'anteprima HTTPS.

## Verifiche browser richieste

Aggiunti casi UI reali con fixture HTTP esplicite a 360, 390, 768, 820, 1024, 1280 e 1440 pixel: ricerca, categorie, varianti obbligatorie, ingredienti rimossi, uscita, conservazione della selezione, viste mobile e payload di invio. Gli screenshot del composer coprono entrambi i temi. Un ulteriore caso copre ricerca e azioni autorizzate della configurazione a 390 pixel. Le fixture non vengono incluse nell'applicazione.

La prima esecuzione su GitHub, commit `17c8028`, ha passato 44 scenari browser con fixture e le suite applicative/database, inclusi i profili CORE/FULL. Il collaudo integrato ha trovato un'etichetta ambigua tra input quantità e pulsante di decremento, corretta nel componente. La revisione degli screenshot ha inoltre portato a rimuovere il riquadro duplicato del login, correggere l'avatar mobile e sostituire il riepilogo compresso su telefono con viste Menu/Comanda. Il controllo integrato conserva anche screenshot delle schermate secondarie sottoposte all'audit di accessibilità e del ciclo completo del servizio.

I workflow hardening e integrazione isolata riconoscono questo ramo. Il primo conserva gli screenshot dell'accesso, del pubblico, del composer e della configurazione; il secondo ripete i percorsi con Auth, database, API e servizi isolati. Non chiamare questi risultati collaudi del database ospitato.

## Anteprima richiesta su GitHub Pages

Il workflow Pages può costruire e pubblicare automaticamente **solo questa candidata di test**, dal ramo esatto sopra indicato, dopo i suoi gate e l'intera suite browser. Gli altri rami conservano il comportamento precedente e il rilascio commerciale mantiene il percorso manuale. Eventuali regole di approvazione degli Environments GitHub restano applicate dal servizio.

La preview usa l'ambiente GitHub `staging` già configurato e il progetto Supabase di prova esistente. Non modifica lo schema, Auth, RLS, Storage o i secrets del progetto production e non crea nuovi progetti cloud. L'unificazione Supabase resta un'attività separata, con il piano della PR #59.

Il controllo iniziale del 6 novembre ha trovato GitHub Pages respinto su tutti i 12 endpoint browser. È stato aggiunto l'origin esatto `https://ambrogiocorti.github.io` a `ADDITIONAL_ALLOWED_ORIGINS` dello staging, conservando le due anteprime Vercel e il digest di `ALLOWED_ORIGINS`. Dopo il salvataggio: 12/12 preflight HTTP 204 per ciascuno dei tre origin autorizzati e 12/12 rifiuti HTTP 403 per un origin estraneo. Evidenze prima/dopo nella cartella `docs/evidence/redesign-2026-11-06/`.

Due gate strutturali preesistenti cercavano ancora il vecchio schema allergeni e la selezione sede locale. Sono stati riallineati alla normalizzazione degli allergeni e al contesto autorevole server già presenti nella candidata, mantenendo le garanzie funzionali.

Prima di indicare l'URL come aggiornato, controllare il successo del job deploy, il commit effettivamente distribuito e il caricamento delle pagine HTTPS. Prima di chiudere il rifacimento, rivedere gli screenshot completamente caricati e i percorsi per ruolo. Finché tali verifiche non sono concluse, la candidata resta **IN PROGRESS**.

Il primo job deploy del run `42135588803` è stato respinto dalle regole di protezione dell'ambiente `github-pages`: il nuovo ramo non è autorizzato a distribuire. Non è stato rimosso o aggirato l'ambiente, né promosso il ramo a main. La pubblicazione richiede l'eventuale aggiunta esplicita del solo ramo di questa candidata alle regole esistenti; il bundle di test e gli screenshot sono già disponibili come artifact GitHub.

Il completamento grafico non risolve i gate aperti di backup/ripristino ospitato, provider e stampante fisica.

Il runner integrato Ubuntu 24.04 usa le librerie e i font di sistema già installati, controlla il font Arial/fallback con `fc-match` e installa Chromium con la verifica delle dipendenze Playwright attiva. È stato rimosso il download ridondante di pacchetti font aggiuntivi che bloccava l'avvio sul mirror Ubuntu; nessuno scenario o controllo applicativo è stato escluso.
