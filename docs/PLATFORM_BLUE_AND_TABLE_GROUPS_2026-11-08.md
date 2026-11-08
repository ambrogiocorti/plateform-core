# Identità Plateform e gruppi di tavoli

La palette bianco e blu è ora condivisa da sito pubblico, menu cliente, login, navigazione, area operativa e finestre. I colori sono definiti in `styles/tokens.css`; le dashboard ereditano gli stessi valori. La modalità scura usa superfici blu notte e accenti azzurri. Restano distinti gli stati operativi e gli avvisi semantici.

Il simbolo piatto/forchetta è un SVG, con scritta Plateform come testo accessibile. La favicon vettoriale e le icone PNG 192/512 e Apple 180 usano lo stesso simbolo bianco su blu. Manifest e cache offline includono le nuove risorse; il collegamento favicon ha una versione esplicita per aggiornare le icone precedenti. I loghi e i colori configurati esplicitamente dal ristorante continuano a usare i controlli di contrasto e sicurezza esistenti.

## Unione e separazione

L’unione era salvata nel database, ma pianta ed elenco non mostravano il gruppo. Aprire un tavolo secondario non offriva la separazione; senza destinazioni compatibili, la conferma ritornava senza spiegazioni.

Ora la pianta mostra un collegamento blu e l’elenco un’etichetta con i numeri uniti. Ogni tavolo apre il gruppo corretto, con capienza complessiva, ospiti, conti e tavolo principale. Unione, spostamento e separazione usano il tavolo principale anche quando si apre un membro secondario. Le destinazioni escludono i membri dello stesso gruppo e, per l’unione, altri gruppi già esistenti. In assenza di destinazioni appare una spiegazione con conferma disabilitata. Gli esiti sono visibili e la pianta viene ricaricata.

I vincoli server su sede, ruolo, layout, conti e prenotazioni restano attivi. La modifica non richiede migrazioni e non modifica i gruppi esistenti in produzione.

## Verifica

- TypeScript, lint, test unitari e build pubblica/staff.
- Contrasto dei campi e controlli statici per temi, risorse e cache offline.
- Browser su desktop e mobile per identità pubblica e login, gruppo dopo ricarica, collegamento nella pianta, separazione dal tavolo secondario e assenza di destinazioni.
- Integrazione con database isolato per unione persistita e successiva separazione dall’interfaccia.
- Pubblicazione GitHub Pages subordinata ai controlli applicativi, browser, database e integrazione del ramo principale.
