# Plateform CORE — Registro dell'intervento (8 ottobre 2026)

**Edizione:** CORE senza Stripe, Satispay ed Epson/bridge.

## Implementato nel sorgente

- `src/services/commercial-scope.ts`: lista chiusa di metodi incasso e driver di stampa inclusi.
- `src/pages/account-payments.ts`: modalità disabilitata e messaggio esplicito se una cassa ha solo metodi esclusi; protezione prima della RPC di incasso.
- `src/pages/operational-settings.ts`: limitazione configurazioni sede/cassa e dispositivi di stampa al perimetro CORE; dispositivi storici Epson visualizzati ma non configurabili nella UI CORE.
- `src/pages/public-booking.ts`: niente offerte caparra checkout; fail-closed quando una prenotazione risulta PENDING_DEPOSIT.
- `scripts/check-release.mjs`: variante commerciale CORE con esclusione controllata dei §§79, 80, 90, più nuovi test obbligatori e mantenimento delle tre revisioni pulite.
- `scripts/check-core-edition.mjs` e `scripts/check-core-release-profile.mjs`: controlli eseguibili senza dipendenze esterne e collegati a `npm run check` e `local:source-gates`.

## Evidenza misurata

- `check:core-edition`: 25/25 controlli mirati eseguiti con Node 22.
- `check:core-release-profile`: 15/15 controlli mirati eseguiti con Node 22.
- Test indipendenti dalle dipendenze: Step 9 UX avanzata, Step 10 UX multi-sede, Step 11 runtime/booking/prerender/deploy fixtures e Step 12 static 34/34 superati.
- Syntax check TypeScript eseguito su nuovi/modificati file; **NON equivale al typecheck strict** con Node 24 e tutte le dipendenze.

## Blocchi reali, non aggirati

1. **Sorgente migrazioni**: 132 SQL locali verificati vs 455 applicati su Supabase Development; 323 mancanti e 24 storici divergenti necessitano adozione remota con backup, impronta SHA-256 indipendente e collaudo clean install. Esportazione SQL remota leggibile, trasferimento file bloccato; nessun file storico modificato.
2. **Guardie backend CORE**: al controllo erano ancora attive licenze Stripe/Satispay su Development. La migrazione proposta per disabilitare i provider, respingere nuovi incassi non CORE e vietare i driver Epson **non è stata applicata**: chiamata bloccata dai controlli di sicurezza; nessuna pretesa di enforcement server-side.
3. **Toolchain**: il runner disponibile è Node 22.16 con dipendenze PGlite/Vite/Vitest incomplete; npm registry non raggiungibile. Restano bloccati typecheck strict, lint completo, Vitest, Deno/Edge check e build reale Node >=24.13.
4. **Staging HTTPS**: non esiste attualmente un progetto Vercel `plateform` disponibile nel connettore; mancano deployment reale, test browser E2E e smoke HTTP indipendente.
5. **Continuità**: restore storico riferito a 130 migrazioni, non all'inventario attuale; collaudo backup/restore completo su ambiente isolato ancora necessario.
6. **Go-live**: verifiche sicurezza/Auth, privacy, accessibilità, multi-device, carico, audit, regressione e tre revisioni integrali consecutive da completare; `docs/REQUIREMENTS.json` non viene marcato fittiziamente come verificato.

**Decisione di release: BLOCKED.** Nessuna modifica a Production e nessun artefatto commerciale distribuito.
