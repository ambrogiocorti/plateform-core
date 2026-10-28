# Audit di recupero migrazioni — staging (NO-GO)

Data verifica: 2026-10-28. Questo branch è **isolato** dalla preview GitHub Pages
e non autorizza modifiche al database.

- Inventario precedente repository: **483** migrazioni.
- Migrazioni applicate su plateform-staging: **496**.
- Versioni comuni: **482**.
- Versioni presenti solo su staging: **14**, recuperate dalla cronologia
  `supabase_migrations.schema_migrations` con relativo SQL e SHA-256.
- Versione presente solo nella repository: **20261027183000**.
- Inventario candidato con recupero: **497** file con manifest coerente.

## Blocco automatico

Il controllo `check:migration-promotion` segnala
`BLOCKED_BACKDATED_MIGRATIONS`: è un blocco **intenzionale e corretto**.
Non va rimosso per forzare il rilascio.

## Requisiti prima dell'adozione

1. Eseguire un backup verificabile, poi replay completo su database disposable.
2. Confrontare lo schema e gli indici risultanti con plateform-staging.
3. Riesaminare le funzioni SECURITY DEFINER, grants e RLS.
4. Verificare separatamente la migrazione 20261027183000 prima di applicarla.
5. Concludere la promozione della cronologia solo dopo approvazione esplicita.

Questa PR non deve essere unita prima che tutti i punti siano dimostrati.
