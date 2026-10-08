# Plateform — Profilo commerciale CORE (sorgente in sviluppo)

## Ambito approvato

Il primo prodotto commerciale non include Stripe, Satispay (online né POS Satispay) e i driver Epson/ePOS/print bridge. Le funzionalità finanziarie utilizzabili sono contanti e registrazione di incasso verificato con **POS esterno**, senza integrazione col provider; la stampa inclusa è browser/PDF. L'incasso con POS esterno **non prova automaticamente** l'avvenuta transazione sul terminale fisico: è l'operatore a verificarla prima di confermare l'incasso.

Lo scope è codificato in `src/services/commercial-scope.ts`, applicato alla selezione del metodo di pagamento, alle impostazioni di sede/cassa/stampa e alle prenotazioni con caparra, e controllato dal test `npm run check:core-edition`.

## Condizione server-side obbligatoria

Il frontend da solo non è una barriera di sicurezza. Prima di qualsiasi pubblicazione commerciale bisogna verificare che l'istanza di destinazione impedisca **anche via API diretta** la creazione di pagamenti Stripe/Satispay, l'attivazione dei metodi Satispay POS e nuove configurazioni Epson; i flag di licenza e i permessi di sede devono restare coerenti con l'edizione CORE. Qualsiasi attività di rimborso/provider preesistente deve essere riconciliata prima della disattivazione dei servizi.

**Blocco operativo aperto:** l'istanza Development aveva ancora licenze Stripe/Satispay abilitate al momento del controllo. La proposta di guardia server-side è in `docs/CORE_EDITION_SERVER_POLICY_PENDING.sql`, ma la sua applicazione remota è stata bloccata: non può essere dichiarata implementata o verificata. Una release CORE rimane vietata finché questo gate non è risolto.

## Gestione prenotazioni con caparra

Il cliente non riceve offerte di slot che richiedono caparra online; in caso di variazione delle condizioni durante la richiesta, la pagina avverte che la prenotazione non è confermata e invita a contattare il ristorante, senza fare tentativi di pagamento né promettere automaticamente la prenotazione. La configurazione della sede deve vietare caparre che richiedono un provider escluso.

## Gate non derogabili

Non sono state eliminate le condizioni su RLS, audit, sessioni, backup/restore, integrità dei dati, compatibilità del database, tenant isolation, test E2E, HTTPS staging, accessibilità e sicurezza. L'assenza di provider integrati riduce i collaudi sui gateway di pagamento, ma **non** sostituisce il collaudo dei pagamenti manuali, dell'incasso e del rimborso.

**Stato: sviluppo; non ancora autorizzato alla vendita.**
