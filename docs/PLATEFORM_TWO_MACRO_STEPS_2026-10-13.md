# Plateform — Piano accelerato in due macro-step (13 ottobre 2026)

**Fonte vincolante:** `MASTER_PROMPT_PLATEFORM_COMMERCIALE_AGGIORNATO.md` (§§0–157), `Roadmap.txt` (Step 0–13), `PLATEFORM_REPORT_COMPLETO_2026-10-12.md`, `PLATEFORM_AUDIT_GO_LIVE_E_VENDITA_SUPABASE_2026-10-10.md`.

I due macro-step raggruppano il lavoro **senza modificare Definition of Done, scope, release gates o ordine delle dipendenze**. Non significa che la piattaforma possa essere certificata in due comandi o senza ambiente reale.

## Macro-step A — Completamento reale delle funzionalità (IN PROGRESS)

1. **Fondamenta e accesso:** configurazione nuova sede, setup e login, staff roles/scopes, multi-sede su licenza, revoca, sessioni, stato installazione.
2. **Servizio:** catalogo ingredienti, layout/sala/tavoli, ordine per passo, cucina/KDS, PASS, Runner, consegne e handoff, conflitti, cassa, pagamenti, split, quadratura e chiusura.
3. **Cliente/Host:** menu/QR e ordini cliente, prenotazioni con capienza e pacing, calendario, comunicazioni, privacy.
4. **Operatività:** notifiche, stampanti e bridge, risoluzione eccezioni, offline/PWA e ripresa, dispositivi.
5. **Commerciale avanzato con licenze:** analytics, food cost, ricettario e cost history, menu engineering, menu multipli, promozioni, takeaway, depositi, waitlist, messaggistica multi-provider, multi-sede.
6. **Sito pubblico:** branding, SEO, upload, booking, sicurezza, accessibilità, mobile.
7. La presenza di RPC/tabelle o test statici non è sufficiente: ogni area necessita di una UI reale, autorizzazioni, empty/error/loading states, dati persistenti e funzioni effettive verificabili.

### Implementato sul branch PR #38 (NON ancora accettato)

- Avvio guidato per sede, verifica menu e staff, override e prezzi del menu di sede.
- Handoff cucina→waiter/Runner con claim e successiva conferma SERVED.
- Cassa: elenco conti attivi, recupero pending manuali, protezione contro esiti concorrenti, chiusura conto con conferma e attenzione ai piatti non serviti.
- Eccezioni multioperatore (chiamate, consegne già in carico, pending cash/reconciliation), senza superare i permessi del server.
- **Food cost e menu engineering:** nuova pagina con filtri data/categoria, valori e classificazione teorici calcolati dalla RPC `get_menu_engineering`; dettaglio ricetta/costo da `get_dish_food_cost`. L'UI è nascosta quando il flag `FOOD_COST` non è licenziato. Nessuna ricomputazione degli importi in JS.
- Unit/DB/browser regression aggiunte, non ancora dichiarate PASS su questa revisione.

### Ancora da completare nella macro-fase A

- Implementazioni UX complete **specifiche** di ricette quantitative e storico costo ingredienti, multi-menu QR, promozioni, reminder e template/provider, waitlist, depositi, takeaway e workflow reali sotto i relativi flag. La presenza del DB e delle RPC non dimostra tutti i percorsi.
- Collaudo end-to-end tra più account, sedi, turni e dispositivi senza dati mock, e correzione bug riscontrati. Non vanno marcate DONE prima della prova.
- Flag disattivati sul Development sono **restrizioni commerciali**, non difetti da aggirare.

## Macro-step B — Integrazione, sicurezza, recuperabilità e rilascio (BLOCKED)

1. Verificare su **commit SHA esatto** formattazione, TypeScript strict, lint, unit test, suite DB isolata, Edge e build. Conservare qualsiasi errore anziché saltare test.
2. Audit migrazioni: PR #32 ha archivio remoto SHA-verificato (480 SQL); PR #33 candidata da 481 migrazioni ha replay PGlite verde **solo con fixture di un trigger Development creato fuori dallo storico**. Occorre una installazione autonoma, senza fixture, su una vera istanza isolata; nessun merge/falso storico.
3. Staging indipendente con più utenti e **due sedi**, JWT/RLS, e flussi reali: amministratore→menu→servizio→Pass→Runner→incasso→chiusura, Host/booking/QR, provider webhooks, failed payments/refund, PWA offline/reconnect, cross-venue, accessibilità.
4. Configurare una pipeline **reale** backup DB+Auth+Storage, replica indipendente e cifrata, retention, restore su progetto effettivamente vuoto e validazione RPO/RTO. Il Development aveva zero record backup nel catalogo, quindi NON GO.
5. Audit append-only, sessioni e revoche, security advisors, segreti, HTTPS, perimetro privacy, observability, load/chaos, hardware print/POS, legal/commercial settings.
6. Accettazione dei 15 release gate ancora aperti nel report (numero storico da riconfermare), review 3/3, rollback provato, deploy e smoke tests, checksum/release dossier e licenze coerenti.
7. **Solo dopo il PASS** si può dichiarare la piattaforma completa e pronta alla vendita. Non produrre archivi di download del progetto prima di allora.

## Regole di esecuzione

- Una PR può contenere più sotto-step di implementazione, ma il merge richiede prove automatiche e review.
- Non eseguire scritture o reset sul Development o restore-test senza backup verificato e approvazione per l'ambiente esatto.
- Vietato inserire seed dimostrativi e falsi stati PASS, bypassare SECURITY DEFINER/RLS o applicare permessi indiscriminati.
- Un workflow CI verde con fixture locali non certifica Auth/Storage reali, backup reale, compliance o assenza di errori in produzione.
