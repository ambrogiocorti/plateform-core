# Step 6 — Configurazione provider pagamenti

Stato al 4 ottobre 2026: integrazione applicativa e funzioni Edge implementate. Il gate
Stripe sandbox end-to-end è PASSED (Checkout reale di test, webhook, ledger, refund e
idempotenza). Resta da completare il gate `SATISPAY_API`, bloccato unicamente dalla
necessità di un account/negozio sandbox e dell'activation code staging forniti da Satispay.

## Funzioni Edge

- `payments`: endpoint staff autenticato (`verify_jwt=true`) che prepara l'operazione dal
  ledger server-side e interroga il provider; il browser non decide importo o stato.
- `stripe-webhook`: endpoint pubblico (`verify_jwt=false`) che verifica `Stripe-Signature`,
  quindi rilegge la risorsa Stripe autorevole prima di aggiornare il ledger.
- `satispay-callback`: endpoint pubblico (`verify_jwt=false`) protetto da token callback e
  rate limit; la callback non determina lo stato, ma innesca una GET firmata a Satispay.

## Secrets richiesti per il sandbox

Configurare come secrets Supabase Edge, mai nel bundle Vite:

```text
PUBLIC_BASE_URL=https://abdxvlykasqmknexxhjo.supabase.co/functions/v1/payment-return
PAYMENTS_VENUE_ID=<uuid-sede>
PAYMENTS_MODE=test
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
SATISPAY_API_BASE_URL=https://staging.authservices.satispay.com
SATISPAY_KEY_ID=<sandbox-key-id>
SATISPAY_PRIVATE_KEY_PKCS8=<private-key-pkcs8-pem>
SATISPAY_CALLBACK_TOKEN=<random-secret>
```

Per una futura installazione multi-sede è supportato anche il suffisso
`_<VENUE_UUID_SENZA_TRATTINI_MAIUSCOLO>` per i secrets provider.

## Configurazione Stripe sandbox

1. Impostare `PAYMENTS_MODE=test` e una chiave `sk_test_...`.
2. Creare un webhook test verso:
   `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`.
3. Sottoscrivere almeno gli eventi gestiti dal codice: Checkout Session completata,
   successo/fallimento asincrono, scadenza e aggiornamenti/creazione/fallimento refund.
4. Salvare il signing secret dell'endpoint come `STRIPE_WEBHOOK_SECRET`.
5. Lasciare la feature `STRIPE` non licenziata e non attiva nelle impostazioni finché il
   gate pagamento + webhook + refund non passa.

## Configurazione Satispay sandbox

Satispay non fornisce credenziali sandbox generiche. La richiesta sandbox (shop + user) è
stata inviata il 4 ottobre 2026; siamo in attesa dell'email Satispay con accesso staging e
activation code. Una volta disponibile:

1. Eseguire `npm run setup:satispay:sandbox` dalla root del progetto. Lo script genera una
   coppia RSA 4096 con chiave privata PKCS#8 e pubblica SPKI, registra la public key sullo
   staging e restituisce il `KeyId`. Subito dopo esegue anche il test ufficiale di autenticazione sandbox e accetta solo un ruolo `ONLINE_SHOP` o `DEVICE`. L'activation code non viene salvato.
2. Gli artefatti vengono scritti in `.local/satispay-sandbox/`, directory gitignored.
3. Impostare in Supabase Edge Secrets `SATISPAY_KEY_ID`, il contenuto di `private.pem` come
   `SATISPAY_PRIVATE_KEY_PKCS8` e il callback token generato come `SATISPAY_CALLBACK_TOKEN`.
4. Usare esclusivamente `https://staging.authservices.satispay.com` con `PAYMENTS_MODE=test`.
5. Il codice crea `MATCH_CODE` con `callback_url`, `redirect_url`, `external_code`, metadata
   e `Idempotency-Key`; i refund usano `REFUND` + `parent_payment_uid`. Il token callback è
   derivato con HMAC per singola provider operation: il secret master non viene inserito nella URL.
   Il redirect è accettato soltanto su HTTPS e sugli host Satispay allowlisted.
6. Lasciare `SATISPAY_API` non licenziata/non attiva finché pagamento + callback +
   cancellazione + refund non passano. `SATISPAY_POS` è già verificato come flusso manuale.

Per verificare soltanto la generazione locale delle chiavi senza chiamare Satispay:
`node scripts/setup-satispay-sandbox.mjs --dry-run`.

## Gate obbligatorio prima di chiudere Step 6

Eseguire su sandbox, senza mock:

- **Stripe — PASSED 2026-10-04:** Checkout server-side reale, pagamento test completato,
  webhook firmato `200`, riconciliazione/ledger, refund reale e retry idempotente senza
  duplicazione. `payment-return` è HTTPS e non autorevole.
- **Satispay API — PENDING:** creazione `MATCH_CODE`, callback, refresh autorevole
  `PENDING→ACCEPTED`, cancellazione, retry idempotente, refund parziale/totale e
  callback/token invalido.
- Verificare per entrambi importo, valuta EUR, provider id, eventi duplicati/fuori ordine,
  stato ledger, audit e assenza di segreti nei log/browser.
- Solo dopo il pass abilitare la feature flag e il metodo di pagamento sulla sede/cassa.

Il sandbox provider è un gate dello Step 6, non un controllo rinviabile al go-live.

## Messaggi delle prenotazioni (reservation-message-worker)

- `MESSAGE_DELIVERY_MODE` è obbligatoria: `dry_run` (nessuna chiamata ai provider, i job MOCK risultano
  inviati) oppure `live`. Se manca, ogni chiamata risponde `SERVICE_UNAVAILABLE` senza prendere job.
- `MESSAGE_WORKER_TOKEN` deve coincidere con il segreto Vault `plateform_message_worker_token`.
- Provider opzionali, anche per sede con suffisso `_<UUID sede senza trattini, maiuscolo>`:
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` (SMS/WhatsApp),
  `RESEND_API_KEY`, `RESEND_FROM` (email), `TELEGRAM_BOT_TOKEN`. Senza chiavi un job reale resta in
  riprova con `PROVIDER_NOT_CONFIGURED`.
- `continuity-retention-worker` non ha un cron nel database: lo chiama l'host continuity, che esegue anche la
  cancellazione reale dei backup scaduti.
