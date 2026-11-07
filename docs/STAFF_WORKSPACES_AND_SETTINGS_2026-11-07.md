# Schermate staff, impostazioni e cucina — 7 novembre 2026

## Comportamento

- Dashboard su superfici bianche e blu, metriche separate e gerarchie più leggibili. Struttura della navigazione conservata.
- Finestre con spaziature coerenti e barra delle azioni; nessuna barra di scorrimento visibile. Il dettaglio tavolo distingue capienza, ospiti, conti e modifica della pianta. Le azioni relative a gruppi/ospiti compaiono quando pertinenti.
- Editor con strumenti, area di disegno e proprietà separate; snap facoltativo, pan libero, zoom con rotella e modifiche con le frecce. L'elenco tavoli seleziona gli elementi. La gestione anagrafica dei tavoli apre lo stesso editor.
- Impostazioni operative protette dagli aggiornamenti automatici durante la modifica. Il salvataggio rilegge e verifica i tre interruttori, aggiorna la versione e rinnova la chiave del comando.
- Licenze, limiti, sedi, sospensione reversibile e modifiche staff ordinarie usano la sessione già autorizzata. Restano controlli su ruolo, MFA, dispositivo, sede, versione, audit e dipendenze. Credenziali, amministratori privilegiati, recuperi e operazioni sensibili mantengono la verifica aggiuntiva.
- Gli errori spiegano limiti delle verifiche, dipendenze delle licenze e vincoli dei tavoli.
- Link interni corretti anche sotto `/plateform-core/staff/`, conservando query e destinazioni esterne.
- Cucina: filtri combinati per categoria del piatto, reparto e stato. La scelta è personale e modificabile durante il servizio. Il personale cucina lavora sui reparti attivi della propria sede senza un'assegnazione fissa; restano separate le autorizzazioni delle altre sedi e le operazioni del Pass.

## Verifiche e rilascio

La migrazione è un aggiornamento delle funzioni esistenti: nessuna tabella, ordine, pagamento, file o utenza viene eliminato. Le migrazioni precedenti mantengono i byte registrati nel manifest.

La suite locale ha superato 398 test. Il browser locale non è avviabile per le restrizioni sui socket: il collaudo grafico e integrato viene eseguito sui runner GitHub. I percorsi includono la persistenza dopo ricaricamento, i filtri cucina, la creazione consecutiva di sei utenti, l'editor e le licenze senza password ripetuta. Il percorso completo di servizio viene eseguito anche senza assegnazione cucina a una stazione.

La PR registra gli esiti finali, le prove visuali e la pubblicazione. Le modifiche ospitate vengono verificate prima del rilascio del frontend.
