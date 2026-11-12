# Gestione incidenti

La dashboard tecnica consente creazione e aggiornamento di incidenti con componente, sede opzionale, gravità, impatto, stato e cronologia. I salvataggi hanno versione/idempotenza; risoluzione richiede un aggiornamento/postmortem. Per la continuità backup/restore esiste anche rilevazione automatica: il reconciler server-side ogni 10 minuti apre incidenti deduplicati, registra eventi `AUTO_OPEN`/`AUTO_UPDATED` e li chiude con `AUTO_RESOLVED` quando la condizione rientra. Alert esterni verso email/SMS/pager e una matrice di escalation con responsabili nominativi non sono ancora configurati.

## Procedura

1. Registrare inizio, componente, impatto e gravità. Evitare contatti, credenziali o payload sensibili nelle note. Usare correlazioni per collegare gli eventi.
2. Stabilire chi guida la diagnosi e chi gestisce il servizio. Verificare stato effettivo: probe, code, audit e giornale pertinenti, senza concedere al tecnico accesso economico ordinario.
3. Contenere: sospensione operativa quando necessaria, revoca di device/sessioni compromessi, disattivazione della funzione interessata se il server permette la transizione. Conservare prove e stato originale.
4. Mitigare con procedura specifica. Pagamenti e stampe con esito incerto richiedono riconciliazione esterna; nessun retry massivo. Per dati persi, preservare copie e seguire il piano di restore verificato.
5. Verificare il flusso completo su più utenti/device, non soltanto la raggiungibilità. Registrare tempi e residui, poi riattivare il servizio con autorizzazione e motivo.
6. Risolvere con causa, timeline, impatto, correzioni, prevenzione e follow-up. I cambiamenti al codice invalidano eventuali revisioni pulite della release.

Gravità disponibili: INFO, WARNING, DEGRADED, INCIDENT, CRITICAL. Concordare con il cliente quali impatti interrompono il servizio e i tempi di risposta. Non sono attualmente promessi SLA né avviate comunicazioni automatiche verso terzi.

Per incidenti sui dati personali, raccogliere soltanto le informazioni necessarie e coinvolgere i responsabili del cliente secondo il suo processo. Obblighi e termini di notifica non sono determinati automaticamente dall’applicazione.
