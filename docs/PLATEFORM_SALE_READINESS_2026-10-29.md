# Plateform — vendita: registro dei blocchi verificabili

Data: 29 ottobre 2026. Branch isolato: `feature/plateform-hospitality-workspaces-20261029`.

## Obiettivo di questo intervento

- Rifare la **struttura** dell'interfaccia pubblica in stile hospitality editoriale;
  menu fotografico a tutta larghezza, guida alla visita, contenuti reali e
  branding configurabile.
- Rendere il gestionale **priority-first**: sidebar espansa, percorso ruolo,
  KPI sintetici, priorità subito visibili e schermate operative più compatte.
- Mantenere ruoli, RPC, validazioni, RLS e modalità chiaro/scuro esistenti.
- Non fare modifiche SQL, non fare merge e non pubblicare la versione commerciale
  senza esito positivo dei controlli di release.

## Evidenze richieste per chiudere la UX

- [ ] `npm run format:check`, `npm run build:pages` e controllo CSS bundle.
- [ ] Suite UX Admin, Host, Cashier, Waiter e test unitari/database.
- [ ] Browser Chromium desktop 1280, smartphone 390, temi chiaro e scuro.
- [ ] QA effettivo delle dashboard con identità **autenticate** di ogni ruolo.
- [ ] Collaudo con dispositivi fisici e screenshot approvati dal titolare.

## Blocchi per la vendita (Step 13 della roadmap)

- **Migrazioni:** PR #51 conserva 14 migrazioni estratte da staging. La
  promozione è intenzionalmente bloccata dal controllo
  `BLOCKED_BACKDATED_MIGRATIONS`. Necessario replay in database sacrificabile,
  verifica dei privilegi e piano di adozione; non effettuare automaticamente.
- **Funzionalità cliente:** il guest checkout è presente; per avere un vero
  account cliente facoltativo persistente, con storico tra visite, occorre
  completare Auth, RLS e privacy; la UX non equivale alla sua implementazione.
- **Pagamenti:** dimostrare incasso, webhook, retry, idempotenza, rimborso,
  caparra e riconciliazione con provider realmente configurati in sandbox.
- **Operatività:** verificare stampanti, KDS, chiamate, rete offline/reconnect,
  duplicati e ruoli cross-venue con casi di test replicabili.
- **Sicurezza:** verificare MFA, autorizzazioni, RLS/cross-role,
  `SECURITY DEFINER`, Storage, backup/restore e controllo dei secrets.
- **Infrastruttura:** la build GitHub Pages ospita solo file statici;
  database, Edge Functions, push worker e servizi di pagamento richiedono
  infrastrutture indipendenti, monitoraggio e corretta configurazione.
- **Commerciale:** dominio root personalizzato, isolamento dati per cliente,
  DNS, HTTPS/headers, SEO indexable e documentazione operativa.

## Definizione di rilascio

Non dichiarare `vendibile` soltanto perché la UI compila. Servono evidenze
della pipeline Step 13 completa, un'installazione pulita replicata e un
collaudo firmato di almeno un servizio reale o sandbox realistico. Lo stato
rimane **DRAFT / NO-GO commerciale** fino a quel momento.
