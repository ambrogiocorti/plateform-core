# Plateform — Step 11: integrazione e verifiche (8 ottobre 2026)

## Ambito e sorgente

Checkpoint applicativo integrato (frontend pubblico e staff), non il solo modulo pubblico isolato. Il repository è stato recuperato dal checkpoint del 6 ottobre e proseguito sul branch locale. Non è una release commerciale.

## Correzioni implementate

- Prenotazioni: disponibilità autorevole Supabase, validazione sede/servizio/data/party, limiti di data e controllo degli slot obsoleti, risultato `RESERVED`/`REQUESTED`/`PENDING_DEPOSIT`, idempotenza lato client e separazione dal completamento del pagamento.
- Avvio caparra: provider bloccato dopo la prima richiesta, validazione contestuale di deposito/provider, redirect HTTPS allowlisted; gestioni distinte `WAITING`, `FAILED`, `COMPLETED` senza attribuire al client la conferma del tavolo.
- Navigazione mobile: Escape, focus, link, clic esterno, breakpoint, chiusura degli eventi al cambio pagina.
- SEO: metadati e prerender editoriali da sole RPC pubbliche, robots/sitemap, escaping e blocco quando i dati sono incoerenti.
- Rendering iniziale: il contenuto statico già pronto resta leggibile durante il caricamento dell'API, evitando un cambio improvviso verso «Caricamento…».
- Release assembly: pulizia di `dist/site` prima della copia per non conservare pagine pubbliche ritirate da versioni precedenti.
- Verifiche di rilascio: test del vero HTML applicativo con mock solo al confine RPC, browser JavaScript disabilitato in due viewport, controlli base di tastiera, menu, allergeni e contrasto.
- CI: test assemblaggio senza dipendenze esterne nel gate `check:step11`; test Node Playwright eseguibile dopo installazione di Chromium nel job GitHub Actions.

## Verifiche ripetibili nell'ambiente locale

```sh
npm run check:step11-static
npm run check:step11-runtime
npm run check:step11-booking
npm run check:step11-prerender
npm run check:step11-build-assembly
node scripts/check-step11-build-assembly.mjs --browser-python
python scripts/check-step11-mobile-dom.py
```

I test locali usano risposte RPC controllate quando simulano la rete. **Non** sono una prova della raggiungibilità del backend o della correttezza dei parametri di deployment.

Per CI, dopo `npm ci` e `npx playwright install --with-deps chromium`:

```sh
node scripts/check-step11-build-assembly.mjs --browser-node
```

## Condizioni tuttora obbligatorie prima di chiudere lo Step 11

1. **Sorgente e database:** riconciliare le 130 migrazioni nel checkpoint originale con le 450 registrate nello sviluppo Supabase e verificare l'assenza di drift e l'eseguibilità di una nuova installazione.
2. **Build completo:** Node >=24.13, `npm ci`, typecheck strict, lint/format, Vite public e staff, test di tutte le suite senza mock fuori dai casi unitari.
3. **Prenotazioni end-to-end:** deploy HTTP verificato, CORS, una prenotazione controllata persistita realmente, risposta persa/idempotenza, modifiche a capacità, campi dinamici, caparra e provider sandbox.
4. **Sito pubblico distribuito:** dominio effettivo e TLS, correttezza delle route con refresh, sitemap/robots HTTP, favicon/asset, locale e URL canonici, separazione totale `/staff` e `/tavolo`.
5. **Qualità:** WCAG 2.2 AA audit completo (tastiera e screen reader inclusi), Core Web Vitals, performance mobile, immagini/font e test cross-device.

Il database di sviluppo usa ancora `https://plateform-test.example`, riservato al collaudo. Non pubblicare né contrassegnare come `PASS` un gate dipendente da DNS, provider o hardware che non è stato realmente verificato.

**Esito:** codice migliorato, Step 11 _non ancora certificato_. Nessuno ZIP finale.
