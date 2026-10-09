# CI baseline — 9 ottobre 2026

La [run GitHub 66](https://github.com/ambrogiocorti/plateform-core/actions/runs/37889836463)
è completata con **success** sul commit di branch
`139fb1b1e73f9af371389c32b24bef800fa8e279`. Entrambi i job, `verify` e
`native-clean-install`, passano. Il checkout nativo della PR è il merge commit
`ff8c93514613c4e04b871f7da0586d63d2c38372`; il report conserva questa identità
separata dal commit di branch.

Passano formato, TypeScript, lint, gate sorgente, `npm run check` completo,
**245 test unit/database** in 24 file, **13 test Edge**, build pubblico/staff,
browser gate della build e **20 test Playwright**. Quattro test sono esclusi
CORE. I browser usano fixture HTTP esplicite; verificano anche che il cambio
tavolo richieda conferma prima di inviare il comando con versione ottimistica.
I limiti locali di recupero Deno/Chromium non impediscono queste prove su GitHub.

Il secondo job usa Supabase Docker con PostgreSQL **17.11**, Auth, Storage e
PostgREST reali. Esegue l'installatore `psql`, bootstrap, 458 migrazioni e
postlude, verifica i digest originali del ledger e confronta sette cataloghi.
Le **197 definizioni obbligatorie** di test corrispondono esattamente al
riferimento; 31 erano assenti dallo storico SQL e sono recuperate nel postlude,
senza risultati PASS. Il delimitatore aggiunto dal trasporto risolve gli SQL
storici senza punto e virgola finale preservandone i byte nel ledger.

Il database nuovo conserva 25 dichiarazioni PASS contenute nello storico come
claim non verificati, ora PENDING. I 197 risultati test e sette gate manuali
Development non vengono copiati. Due fixture PGlite di upgrade verificano la
conservazione esatta di evidenza, autore e data precedenti. La prova nativa
verifica zero PASS, quattro scritture PASS negate, reinstallazione rifiutata,
health Auth/Storage, gate negativo via JWT service-role e accesso anonimo negato.
Cron è disattivato prima del replay; i cinque container usano porte loopback,
IPv6 disattivato e una regola verificata di blocco dell'egress esterno.

Binding run/commit, metadati dell'artefatto e digest dei log catturati:
[evidence/baseline-native-ci-verification-2026-10-09.json](evidence/baseline-native-ci-verification-2026-10-09.json).
Il [report nativo originale](evidence/native-clean-install-2026-10-09.json)
ha SHA-256 `60071bc90286da18736b047fb71f9cf6199c67cec7cab668c1413d4dd35dc720`.
Le prove precedenti delle run 54 e 64 restano archiviate; la run 64 precede il
recupero delle 31 definizioni. L'artefatto GitHub ha conservazione di 14 giorni;
questa evidenza tecnica non costituisce un canale di attestazione commerciale immutabile.

Restano installazione hosted, login/TOTP/sessioni e scope HTTP/JWT, Storage
upload/download, Realtime, concorrenza, invocazioni Edge hosted e restore dello
schema corrente. Mancano ingestione CI autenticata per singolo requisito,
binding commit/schema e log immutabili, audit delle 158 sezioni e tre revisioni
integrali pulite (attualmente 0/3). Step 0 **IN_PROGRESS**, release bloccata.
La migrazione fail-closed è preparata e non applicata su Development: il
rifiuto automatico richiede ancora autorizzazione remota specifica.
