# Step 0 — configurazione remota verificata

Aggiornamento: 3 ottobre 2026. Progetto autorizzato: `plateform-development`,
`abdxvlykasqmknexxhjo`, eu-west-1. L’utente ha autorizzato espressamente il fallback
alla dashboard del nuovo progetto. Le impostazioni sono state salvate e ricontrollate.
Nessun progetto precedente è stato modificato.

| Area                     | Configurazione development verificata                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| Signup pubblico          | Disabilitato; provisioning tramite Admin API server                      |
| Accesso anonimo          | Disabilitato                                                             |
| Email/password           | Abilitato; minimo 12 caratteri                                           |
| Site URL                 | `http://localhost:5174`                                                  |
| Redirect                 | `http://localhost:5174/` e `http://localhost:5174/login`, senza wildcard |
| JWT expiry               | 900 secondi; rotazione refresh token attiva                              |
| TOTP                     | Abilitato; limitazione AAL1 a 15 minuti attiva                           |
| ENVIRONMENT              | `development`                                                            |
| RELEASE_VERSION          | `0.1.0`                                                                  |
| TELEMETRY_ENABLED        | `true`                                                                   |
| ALLOWED_ORIGINS          | `http://localhost:5173,http://localhost:5174`                            |
| RATE_LIMIT_SECRET        | Generato da 32 byte casuali; valore escluso dalle evidenze               |
| TRUSTED_CLIENT_IP_HEADER | `cf-connecting-ip`, collaudato sul gateway hosted                        |

I secrets Supabase di piattaforma restano server-only. La dashboard ha mostrato il
primo valore rate-limit nell’anteprima: è stato rigenerato prima del salvataggio.
Il valore remoto corrente non è contenuto nei sorgenti, nei report o nelle immagini.
Nessuna credenziale provider, stampa o offline è stata anticipata.

## Prove reali

- `check:runtime`: Auth raggiungibile, signup/anon disabilitati, proiezione pubblica e
  dinieghi RPC staff/bootstrap verificati.
- `check:edge-http`: 13 casi passati per autenticazione, CORS/preflight, media type,
  JSON/schema/body limit, metodi, contesto diagnostico e minimizzazione degli errori.
- `check:gateway`: 10 casi passati. Due richieste ammesse; terza e quarta rifiutate
  con 429. XFF contraffatto non cambia il digest né il bucket; header alternativi
  respinti a monte con 403. Il database contiene un solo bucket, tre tentativi,
  blocked_until valorizzato. Il quarto diniego non incrementa il contatore bloccato.
- Nove errori HTTP della prima suite corrispondono a nove eventi telemetry con
  request/correlation ID, ambiente e versione corretti; nessun evento economico
  nell’audit e nessun system_error per gli errori client verificati.
- Il collaudo gateway usa temporaneamente l’endpoint health-probe con capability
  casuale, scadenza di dieci minuti e blocco fuori development. Al termine è stato
  ripristinato l’entrypoint normale; i tre file remoti coincidono con i sorgenti.
  Le 13 prove HTTP sono state ripetute dopo il ripristino e passano.

Il collaudo ha corretto due difetti: inoltro di Authorization/apikey del chiamante
nel client server e fiducia implicita in XFF. Il client server inoltra ora solo
request/correlation ID; il client address usa un header esplicito, IP valido e
normalizzato. Una nuova regressione Deno prova la separazione delle credenziali.

## Ripetizione dei controlli

```sh
PLATEFORM_CHECK_PROJECT_REF=abdxvlykasqmknexxhjo npm run check:runtime
PLATEFORM_CHECK_PROJECT_REF=abdxvlykasqmknexxhjo npm run check:edge-http
```

Il probe gateway è un collaudo controllato: preparare con `check:gateway -- prepare`,
distribuire il payload locale mediante il connettore autorizzato, eseguire il check,
ripristinare immediatamente i file health-probe ordinari e verificarne la corrispondenza.
Non distribuire il probe su staging/production e non archiviare la capability.
Le evidenze sono in `docs/evidence/step0-*.json`; le immagini delle policy in
`docs/evidence/screenshots/` non contengono credenziali.

Auth/TOTP/provisioning/reset e workflow operativi vengono collaudati nello Step 1.
Queste prove certificano le fondamenta development, non il go-live commerciale.

## Step 6 — provider pagamenti

Nel development sono deployate le funzioni provider e il ritorno HTTPS. Il gate Stripe
sandbox end-to-end è PASSED: Checkout reale di test, webhook, riconciliazione, ledger,
refund e idempotenza. `STRIPE` è abilitato esclusivamente nel progetto development in
modalità test; nessun account live è stato toccato. `SATISPAY_API` resta disabilitato:
il solo blocco residuo dello Step 6 è ottenere un account Satispay sandbox con activation
code staging, configurare i relativi secrets e completare MATCH_CODE/callback/refund.
Vedere `STEP6_PROVIDER_CONFIGURATION.md`.
