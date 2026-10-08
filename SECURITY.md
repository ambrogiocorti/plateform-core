# Plateform — sicurezza implementata e verifiche aperte

## Confini

Un progetto Supabase per cliente e ambiente. Il profilo catena è singleton.
RLS è attiva su tutte le tabelle pubbliche e private, comprese partizioni audit e tabelle aggiunte
successivamente. Le mutazioni operative avvengono tramite RPC con controlli server.

Tutte le funzioni nascono senza EXECUTE per PUBLIC tramite revoca **globale** dei privilegi
predefiniti PostgreSQL. Le revoche soltanto per schema non rimuovono il default globale:
questo comportamento è coperto da un test che elenca tutte le RPC invocabili da anon.
Le correzioni revocano anche i grant diretti ad anon/authenticated assegnati da Supabase,
che non scompaiono con la revoca a PUBLIC. I grant autorizzati sono elencati in
`private.api_permission_manifest`; il test harness riproduce i default della piattaforma.
Le scritture dirette sui dati public sono revocate ai ruoli browser.
Gli helper risiedono nello schema `private`, non esposto a PostgREST; `search_path` vuoto
e riferimenti qualificati per le funzioni SECURITY DEFINER.

## Autenticazione e autorizzazioni

- Ruoli/scope letti dalle tabelle server, non da user metadata modificabili.
- SUPER_ADMIN richiede `aal2`; Admin richiede MFA di default, Cashier configurabile.
- Il session_id JWT deve esistere in auth.sessions per accesso staff e conto cliente.
- Il timestamp password in AMR limita il periodo di autenticazione completa.
- Blocchi sessione, dispositivi revocati e auth_valid_after sono verificati dal database.
- PIN bcrypt, tentativi e backoff persistiti senza annullare i contatori con un'eccezione.
- Step-up associa grant monouso a utente reale, sessione, azione, risorsa e scadenza.
- Gli endpoint amministrativi verificano il token via Supabase Auth e usano Admin API
  esclusivamente lato server. Password/PIN/codici/token non vengono loggati.

PIN, impersonazione con doppia identità e job amministrativi sono implementati localmente;
recovery MFA, revoche simultanee e provisioning multi-sistema richiedono collaudo reale.
Vedere lo stato di implementazione. Nessuna certificazione
di sicurezza operativa è implicita in questo documento.

## Operazioni economiche

Importi in integer cents; prezzo storico da catalogo server; disponibilità sotto lock
transazionale; chiavi idempotenti vincolate al hash del payload. I pagamenti pending
riservano il saldo. Un browser non può confermare Stripe o Satispay API mediante la RPC
di pagamento manuale. Adapter Stripe/Satispay, verifica webhook/callback, riserve, refund e idempotenza sono presenti.
Non sono ancora stati collaudati con account sandbox e callback reali.

## Audit

Eventi economici e configurazione registrati da trigger, con allowlist dei valori.
Audit append-only con trigger di diniego UPDATE/DELETE/TRUNCATE; Super Admin può leggere
ma non modificare tramite API. Il proprietario infrastrutturale del database può tecnicamente
disabilitare trigger: la protezione operativa di quel privilegio richiede governance e backup
immutabili esterni, ancora da configurare.

## Segreti e HTTP

`.env` ignorato da Git. `.env.example` contiene soltanto nomi e valori locali non segreti.
Chiavi service role/provider/firmatari restano nei secrets delle Edge Functions.
Le Edge rispondono con no-store, origini esatte e errori minimizzati.
Il body JSON ha limite predefinito 32 KiB durante la lettura del flusso; asset upload ha un
limite separato e verificato per tipo/dimensione/checksum. JSON/media type/schema
invalidi vengono rifiutati. Request ID e correlation ID attraversano Edge e RPC in modo indipendente.
Rate limit persistito in transazioni dedicate prima delle operazioni pubbliche.
Il gateway hosted development usa `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`,
con parsing IPv4/IPv6, normalizzazione e digest HMAC. Header assente o invalido blocca
la richiesta; nessun fallback a header client. La prova HTTP ha verificato due richieste
ammesse, terza/quarta negate e impossibilità di cambiare bucket contraffacendo XFF.
Il client server conserva le proprie credenziali e inoltra soltanto request/correlation ID.
Il contratto va ricollaudato dopo cambi di gateway o ambiente.
Template CSP/secure headers e policy Storage sono presenti; verifica dell’hosting reale,
scansione automatica dei bundle e collaudo dei trasporti restano da completare. Nessun host production è stato configurato.

## Realtime

La pubblicazione contiene soltanto `realtime_signals` e pubblica INSERT. I segnali non
contengono prezzi, nomi, telefoni, password o codici; le RLS applicano ruolo, sede,
assegnazione e sessione cliente prima della lettura. La policy anon consente solo PUBLIC.
I dati applicativi vengono recuperati nuovamente tramite API autorizzate. Vedere `REALTIME.md`.

## Fonti tecniche

- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase session lifecycle](https://supabase.com/docs/guides/auth/sessions)
- [TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp)

Queste fonti definiscono il comportamento dell'infrastruttura; i controlli specifici
di Plateform richiedono i propri test e la verifica sul progetto di destinazione.

## Offline e stampa locale

Offline verifica firme P-256 contro un trust anchor configurato nell’app, non contro una
chiave proposta nel record locale. Coda cifrata AES-GCM, Web Locks e controllo server delle
revoche al sync; nessun comando finanziario offline. Vedere OFFLINE.md per limiti e prove aperte.

Il bridge stampa solo documenti vincolati a job/lease/device/hash/origini con firma del
server. HTTPS e certificati verificati; endpoint fisici da configurazione locale;
registro SQLite prima dell’I/O e nessun retry fisico automatico di esiti sconosciuti.
Non sostituisce la verifica fisica del modello/firmware utilizzato.

Privacy prenotazioni usa grant monouso, sede, versione/idempotenza e protezioni di conservazione.
Il worker automatico è disabilitato finché Admin CHAIN configura la policy. Il segreto
schedulatore rimane server-only. Audit e contabilità non vengono purgati dal worker.
