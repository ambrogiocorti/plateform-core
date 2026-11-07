# GitHub, un progetto Supabase e handoff grafico

## Decisione del proprietario

Il 5 novembre 2026 il proprietario ha richiesto di utilizzare GitHub, ridurre i progetti Supabase di questa installazione a uno e preparare un prompt completo per Claude per rifare l'intera grafica. Ha anche autorizzato l'aggiunta dell'origine Vercel della PR #58 alla configurazione CORS di staging, preservando quella esistente, e l'apertura dell'accesso Vercel.

La scelta di un solo progetto cloud aggiorna il precedente orientamento verso tre ambienti Supabase ospitati. Sviluppo, replay delle migrazioni e prove distruttive devono continuare in ambienti locali o isolati: l'unificazione non autorizza test distruttivi sul database definitivo. Non cambia la regola di un solo cliente/catena per installazione.

## Stato verificato

Sono presenti quattro progetti Plateform, non tre. `torneiScuola` è un altro progetto e non rientra nell'intervento.

| Progetto               | Riferimento            | Stato   | Dati osservati                                                                                                                        |
| ---------------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| plateform-production   | `xzateqavvaparjoybbhr` | Attivo  | Una sede, 15 tavoli, 7 profili staff e 7 utenti Auth; nessun piatto, ordine, pagamento, prenotazione o oggetto Storage.               |
| plateform-staging      | `qfgoatdabgnzozxuzxku` | Attivo  | Una sede distinta, 2 tavoli, 2 piatti, 22 ordini, 23 pagamenti, 18 prenotazioni, 6 profili staff, 7 utenti Auth e 41 oggetti Storage. |
| plateform-development  | `abdxvlykasqmknexxhjo` | Sospeso | Contenuti non ancora inventariati; dashboard con esportazione database e Storage disponibile.                                         |
| plateform-restore-test | `dkbjgvovxgglqhqxmuyb` | Sospeso | Contenuti non ancora inventariati.                                                                                                    |

I conteggi dei due progetti attivi derivano da `count(*)`, non dalle stime delle statistiche PostgreSQL. Entrambi hanno 496 voci nella cronologia delle migrazioni e lo stesso fingerprint dei relativi statement registrati. Questo confronto non dimostra uguaglianza dei dati correnti, delle policy, della configurazione Auth, delle Edge Functions o dei secrets.

La sede di production e quella di staging hanno identificativi diversi. Non è corretto riversare tutte le righe di staging in production come se appartenessero alla stessa installazione senza prima classificarle. In particolare ordini, pagamenti e rimborsi di collaudo non devono diventare movimenti commerciali reali.

L'inventario senza credenziali è in `docs/evidence/database-consolidation-2026-11-05/inventory.json`.

## Destinazione proposta e sequenza di consolidamento

La destinazione proposta è l'attuale `plateform-production`, per conservare configurazione e utenti dell'installazione già collegata al workflow Pages storico. È una destinazione di piano: in questa sessione non è stato effettuato alcun cutover né cancellato alcun progetto.

1. Acquisire backup separati di PostgreSQL, Auth e file Storage di ciascun progetto da dismettere e dell'attuale destinazione; conservare configurazioni, bucket, Edge Functions e riferimenti ai secrets in modo protetto. Non pubblicare dati o credenziali su GitHub.
2. Verificare integrità, leggibilità e ripristino di tali copie su una destinazione isolata idonea, mantenendo i riferimenti tra utenti Auth, profili e dati applicativi.
3. Inventariare anche i progetti sospesi dai backup; selezionare i dati da trasferire e quelli da conservare come archivio di prova. Gestire conflitti di UUID, identità, numeri tavolo e scope sede con una mappa esplicita.
4. Confrontare schema corrente, RLS, RPC, Edge Functions e configurazioni. Le 496 migrazioni registrate uguali non sostituiscono questo controllo. La candidata contiene inoltre tre migrazioni non promosse: non copiarle ciecamente e non modificare migrazioni già applicate.
5. Eseguire importazioni additive e verificabili, con audit, conteggi e controlli referenziali. Nessun reset e nessuna sovrascrittura generalizzata.
6. Aggiornare in modo coordinato il backend usato dal frontend, i GitHub Environments, gli URL Auth, le origini CORS, i callback dei provider, gli eventuali worker, i client e le associazioni del print bridge. Allineare i due workflow Pages oggi presenti per evitare destinazioni discordanti.
7. Collaudare login/MFA, sito pubblico, servizio, Realtime, Storage, pagamenti di prova e stampa nell'ambiente idoneo. L'anteprima collegata allo staging deve restare utilizzabile fino al cutover pianificato.
8. Solo dopo backup/ripristino e cutover verificati, presentare l'elenco preciso dei progetti da eliminare per la conferma della cancellazione definitiva. Le copie e il rollback devono essere disponibili prima di questo passaggio.

## Blocco concreto alla cancellazione

La verifica SQL ha trovato **due backup in coda in production e uno in staging**, tutti con `integrity_verified=false`, `includes_auth=false`, `includes_storage=false` e nessun test di restore registrato. Non esistono restore job nei due progetti. Questi record non sono backup recuperabili verificati.

È stato richiesto il download del database di `plateform-development` dalla dashboard. Il browser ha restituito un percorso, ma i byte completi non sono risultati disponibili nel workspace entro la verifica prevista. L'esportazione Storage è stata avviata e mostrava ancora la preparazione dell'archivio. **Nessuna di queste richieste è stata conteggiata come backup acquisito o verificato.** I progetti sospesi non sono stati riattivati, cancellati o alterati.

Stato dell'unificazione: **BLOCKED prima del trasferimento dei dati**. Il vincolo è l'assenza di un backup completo ripristinabile e della classificazione dei contenuti, non una nuova richiesta di consenso per la modifica CORS già autorizzata.

## CORS completato

Aggiornato solo `ADDITIONAL_ALLOWED_ORIGINS` di staging con le due origini esatte:

- `https://plateform-development-git-fix-releas-94ed70-sambrogiocorti-5259.vercel.app`
- `https://plateform-development-git-redesign-e-d8ae9a-sambrogiocorti-5259.vercel.app`

La voce write-only precedente è stata ricostruita dall'origine documentata della PR #57 e confrontata con il digest SHA-256 mostrato in dashboard: corrispondenza esatta. Dopo il salvataggio la dashboard ha mostrato il messaggio di successo e il nuovo digest atteso. `ALLOWED_ORIGINS` conserva digest e data precedenti; nessun wildcard aggiunto.

Verifica HTTP read-only su staging: 12/12 preflight consentiti per la nuova origine, 12/12 per la precedente e 12/12 rifiuti HTTP 403 per un'origine estranea. Evidenza in `docs/evidence/cors-2026-11-05/verification.json`. Non è un collaudo autenticato delle operazioni applicative.

## GitHub e anteprima

La candidata resta nella PR #58, commit `da64978e4f3c579d22854a52ccccc54f1c13a815`. Il run GitHub Pages `42067303517` è riuscito, ma ha prodotto un artifact e **saltato il deploy**. Non rappresenta una nuova pubblicazione del sito.

Sono stati effettuati due tentativi di avvio manuale del workflow `plateform-github-pages.yml`, selezionando il ramo della candidata, modalità `test` e pubblicazione. GitHub ha mostrato `Workflow dispatch failed — Workflow could not be run. Please try again.` Non è stato verificato alcun nuovo run né un nuovo deployment. Non attribuire questo messaggio a una revisione automatica delle approvazioni: non è stato restituito un tale rifiuto in questa sessione.

La pagina di accesso Vercel è stata aperta come autorizzato. L'anteprima rimane protetta da Vercel; non è stato effettuato un ulteriore accesso Vercel, creato un link di condivisione o disattivata la protezione. Il percorso scelto per l'anteprima da condividere resta GitHub Pages.

## Prompt per Claude

`docs/PROMPT_CLAUDE_REDESIGN_COMPLETO.md` contiene il prompt completo pronto da copiare. Include branch di partenza, specifiche, stack vanilla, identità visiva, rifacimento per ruolo e schermata, componenti, stati, mobile, accessibilità, pulizia della cascata CSS, test e consegna su GitHub. Non avvia un redesign né cambia il backend da solo.
