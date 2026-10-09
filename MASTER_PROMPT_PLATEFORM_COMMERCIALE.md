# MASTER PROMPT — PLATEFORM | VERSIONE COMMERCIALE · UNA CATENA, UNA O PIÙ SEDI

## 0. Istruzione fondamentale

Devi progettare e sviluppare **Plateform**, una piattaforma gestionale professionale, production-ready e commercializzabile per ristoranti.

Il modello commerciale e architetturale è il seguente:

- ogni cliente Plateform corrisponde a **una sola catena, brand o attività ristorativa**;
- ogni cliente utilizza una **installazione isolata** di Plateform, con proprio progetto Supabase, propri dati, proprie chiavi e proprio ciclo di deployment;
- ogni installazione contiene **almeno una sede fisica**;
- la gestione **multi-sede è opzionale** e può essere attivata tramite feature flag `MULTI_VENUE`;
- quando `MULTI_VENUE = false`, l'interfaccia deve comportarsi come un gestionale mono-sede senza mostrare selettori o complessità inutili;
- quando `MULTI_VENUE = true`, possono esistere più sedi, ma **tutte appartengono alla stessa catena**;
- non devono esistere catene concorrenti, tenant commerciali differenti o clienti Plateform differenti nello stesso database di produzione.

La home e il sito pubblico del ristorante/catena fanno parte integrante del prodotto. La struttura base degli indirizzi resta:

```text
https://dominio.it/
https://dominio.it/staff
```

Il dominio pubblico rappresenta il brand/catena. In modalità multi-sede, le singole sedi possono avere pagine dedicate sotto il dominio principale, ad esempio `https://dominio.it/sedi/{venue_slug}`, senza trasformare il prodotto in un SaaS multi-tenant condiviso.

Plateform **non deve essere una demo, un mockup o un prototipo con funzionalità simulate**.

Il risultato deve essere una vera applicazione:

- funzionante;
- sicura;
- vendibile e distribuibile a ristoranti reali;
- isolata per cliente/catena;
- mono-sede di default e multi-sede opzionale;
- utilizzabile da più utenti e dispositivi contemporaneamente;
- responsive;
- realtime;
- installabile come PWA;
- utilizzabile parzialmente offline;
- auditabile;
- osservabile;
- scalabile;
- modulare;
- documentata;
- testata;
- versionata;
- distribuibile tramite ambienti separati;
- pronta per essere utilizzata durante un vero servizio di ristorazione.

Non inventare semplificazioni che contraddicano questa specifica.

Prima di sviluppare una funzionalità complessa, progettare sempre:

- schema database;
- scope catena/sede;
- autorizzazioni;
- transazioni;
- workflow;
- stati;
- concorrenza;
- audit;
- telemetry quando pertinente;
- comportamento realtime;
- comportamento offline;
- gestione conflitti;
- error handling;
- privacy e retention;
- test;
- observability;
- strategia di rollout e rollback.

---

# 1. Ruolo dell'AI

Agisci come un team composto da:

- Senior Software Architect;
- Senior Frontend/TypeScript Developer;
- Senior Supabase Engineer;
- PostgreSQL Database Architect;
- Cybersecurity Engineer;
- Privacy & Data Governance Engineer;
- UX/UI Designer specializzato in hospitality premium;
- QA / Test Automation Engineer;
- DevOps / CI-CD Engineer;
- Site Reliability / Observability Engineer;
- Product Engineer;
- Technical Product Manager.

Ogni decisione tecnica non esplicitamente definita deve privilegiare, in quest'ordine:

1. sicurezza;
2. integrità dei dati;
3. affidabilità durante il servizio;
4. isolamento tra clienti e sedi;
5. UX professionale;
6. privacy e minimizzazione dei dati;
7. manutenibilità;
8. osservabilità;
9. scalabilità;
10. semplicità operativa per il personale del ristorante.

La sicurezza non è una fase finale del progetto: è un requisito trasversale presente in architettura, schema dati, RLS, API, UI, deployment, test e operations.

---

# 2. Nome e identità del prodotto

Il prodotto si chiama esclusivamente:

# Plateform

Non rinominare il prodotto e non utilizzare nomi precedenti o placeholder.

Plateform mantiene un'identità visiva proprietaria e riconoscibile. Il logo deve essere professionale, minimale, premium e adatto sia a una web app gestionale sia a documentazione commerciale, favicon, PWA e materiali di vendita.

Il ristorante/catena deve comunque poter personalizzare fortemente il proprio ambiente pubblico:

- nome;
- logo del ristorante;
- favicon;
- colori;
- font;
- fotografie;
- hero;
- contenuti;
- menu;
- informazioni delle sedi;
- dominio pubblico e sottodominio staff;
- identità visiva.

Nel gestionale staff il brand Plateform resta riconoscibile ma discreto. Sul sito pubblico può comparire elegantemente, dove opportuno:

> Powered by Plateform

senza rovinare il branding premium del ristorante.

Il design system del gestionale Plateform è definito nella sezione 125 e nelle sezioni dedicate alla UX commerciale.

---

# 3. Stack tecnologico obbligatorio

## Frontend

Utilizzare:

- HTML5 semantico;
- CSS3 moderno;
- **TypeScript**;
- ES Modules;
- DOM APIs native;
- Supabase JavaScript SDK;
- Vite come build tool/dev server.

L'applicazione resta **vanilla**, senza framework applicativi. TypeScript deve compilare in JavaScript browser standard.

Non utilizzare framework applicativi come:

- React;
- Vue;
- Angular;
- Svelte;
- Next.js;
- Nuxt;
- framework SPA equivalenti.

Sono ammesse librerie specialistiche leggere quando realmente necessarie, per esempio per:

- editor grafico sala;
- grafici;
- QR Code;
- stampa;
- accessibilità;
- validazione runtime dei payload;
- date/timezone;
- testing.

Non utilizzare librerie per sostituire inutilmente la logica applicativa.

Per l'editor sala è ammessa, se utile, una libreria come Fabric.js o Konva.js.

## Qualità del codice frontend

Obbligatori:

- TypeScript `strict`;
- ESLint;
- Prettier;
- moduli piccoli e coesi;
- tipi condivisi per stati e payload;
- niente `any` salvo eccezione documentata;
- niente funzioni globali applicative;
- niente logica business duplicata nelle pagine;
- validazione runtime degli input non fidati;
- source map gestite in modo sicuro in produzione;
- test automatici per servizi e state machine.

Definire tipi espliciti per almeno:

```text
UserRole
UserScope
VenueId
ReservationStatus
TableStatus
AccountStatus
OrderStatus
OrderItemStatus
PaymentStatus
RefundStatus
PrintJobStatus
SyncStatus
IncidentSeverity
NotificationStatus
```

---

# 4. Backend e Supabase

Utilizzare Supabase come backend principale.

Componenti:

- PostgreSQL;
- Supabase Auth;
- Supabase Realtime;
- Supabase Storage;
- Row Level Security;
- Database Functions;
- Trigger;
- RPC;
- Edge Functions.

Non creare un backend Node.js separato salvo necessità tecnica documentata.

Le operazioni sensibili devono avvenire tramite:

- Edge Functions;
- RPC SQL protette;
- transazioni PostgreSQL;
- funzioni server-side.

La `service_role_key` non deve mai essere:

- inserita nel JavaScript client;
- esposta nel browser;
- inserita nell'HTML;
- inviata al frontend;
- inserita in repository pubblici.

---

# 5. Architettura commerciale: una catena per installazione, multi-sede opzionale

Plateform è distribuita secondo un modello **single-customer isolated deployment**.

Ogni installazione production appartiene a una sola catena/brand cliente.

Struttura:

```text
Plateform Installation
└── Restaurant / Chain Profile
    ├── Venue 1  (obbligatoria)
    ├── Venue 2  (opzionale)
    └── Venue N  (opzionale)
```

Non implementare nello stesso database production:

- più clienti Plateform indipendenti;
- marketplace di ristoranti;
- tenant commerciali appartenenti a proprietari diversi;
- self-service signup di nuovi clienti;
- selettore di catene;
- dati di ristoranti non collegati fra loro.

La modalità multi-sede è regolata da:

```text
MULTI_VENUE = false | true
```

Quando `false`:

- deve esistere una sola sede attiva;
- non mostrare selettori di sede;
- non mostrare dashboard aggregate inutili;
- l'utente deve percepire Plateform come un gestionale mono-sede.

Quando `true`:

- Admin autorizzati possono creare e gestire più sedi della stessa catena;
- ogni sede ha indirizzo, contatti, orari, sale, tavoli, casse, stampanti, servizi, prenotazioni, staff assignments e configurazioni operative proprie;
- menu e catalogo possono essere condivisi a livello catena con configurazioni per sede;
- utenti e ruoli possono avere scope `CHAIN` oppure uno o più scope `VENUE`;
- le dashboard aggregate devono essere disponibili solo ai ruoli autorizzati a livello catena.

## Isolamento commerciale

Per i primi deployment commerciali, ogni cliente deve avere almeno:

- progetto Supabase dedicato;
- database dedicato;
- Auth dedicato;
- Storage dedicato;
- secrets dedicati;
- dominio/i dedicati;
- ambiente production dedicato;
- backup dedicati.

Non utilizzare `chain_id` o `tenant_id` come falsa sicurezza per mettere clienti diversi nello stesso database.

## Scope sede

Le entità fisicamente legate a una sede devono essere riconducibili in modo non ambiguo a `venue_id` direttamente o attraverso una relazione forte.

Esempi location-scoped:

- rooms;
- room_layouts;
- zones;
- tables;
- services;
- reservations;
- operational assignments;
- cash registers;
- print devices;
- service sessions;
- local availability;
- ordini e conti attraverso tavolo/sessione/sede.

RLS e controlli server-side devono verificare sempre:

- identità;
- ruolo;
- scope catena/sede;
- assegnazione operativa;
- relazione con la risorsa;
- eventuale customer session.

Un utente non deve ottenere accesso non autorizzato tramite modifica URL, query, console browser, SDK, REST, WebSocket, Storage, RPC o manipolazione degli ID.

La sicurezza non deve mai dipendere esclusivamente dall'interfaccia.

---

# 6. Configurazione catena e sedi

Gestire un solo profilo di catena/brand per installazione.

Il profilo catena contiene almeno:

- nome commerciale;
- ragione sociale dove necessario;
- branding Plateform-side;
- dominio pubblico;
- sottodominio staff;
- configurazioni generali;
- feature flags;
- configurazioni condivise;
- dati di contatto centrali;
- impostazioni privacy e retention.

Creare entità `venues`.

Ogni sede contiene almeno:

```text
id
name
slug
code
address
phone
email_optional
opening_hours
timezone
currency
locale
active
operational_status
```

La prima sede viene creata durante il setup iniziale ed è obbligatoria.

Quando `MULTI_VENUE = false`, impedire a livello server la creazione di una seconda sede attiva.

Quando `MULTI_VENUE = true`, consentire nuove sedi esclusivamente a utenti autorizzati.

Le configurazioni possono essere:

- `CHAIN_LEVEL` se devono essere condivise;
- `VENUE_LEVEL` se appartengono alla singola sede;
- `CHAIN_DEFAULT_WITH_VENUE_OVERRIDE` solo nei casi esplicitamente previsti.

Evitare sistemi di ereditarietà generici e difficili da comprendere. Gli override devono esistere solo per requisiti concreti, per esempio menu, prezzo, disponibilità, servizi o branding locale.

---

# 7. Ruoli e scope

Implementare almeno:

```text
SUPER_ADMIN
ADMIN
HOST
CASHIER
KITCHEN_ADMIN
KITCHEN_STAFF
PASS
WAITER
CUSTOMER
SYSTEM
```

`SYSTEM` identifica processi automatici e non è un account umano.

`RUNNER` **non è un ruolo RBAC**: è una modalità operativa del ruolo `WAITER`.

Ogni account staff deve avere uno scope esplicito:

```text
CHAIN
VENUE
```

- `CHAIN` consente le operazioni previste dal ruolo su tutte le sedi autorizzate della catena;
- `VENUE` limita l'utente a una o più sedi assegnate.

Nessun ruolo deve ottenere automaticamente accesso cross-venue solo perché appartiene alla stessa installazione.

---

# 8. SUPER_ADMIN

Il Super Admin è il responsabile tecnico dell'installazione Plateform del cliente.

È tipicamente riservato al gestore tecnico/fornitore Plateform e non al normale personale operativo.

Può:

- eseguire setup iniziale della catena e prima sede;
- attivare/disattivare `MULTI_VENUE` secondo contratto/configurazione;
- creare o disattivare sedi quando la feature è autorizzata;
- modificare configurazioni tecniche;
- sospendere e riattivare l'installazione;
- avviare la dismissione protetta;
- configurare domini;
- creare/modificare/disattivare Admin;
- configurare limiti tecnici e feature flags;
- vedere stato tecnico e observability;
- gestire backup e restore;
- gestire release e migrazioni autorizzate;
- impersonare utenti secondo la sezione dedicata;
- consultare audit tecnico completo;
- gestire incidenti tecnici.

Non può creare una seconda catena/cliente dentro la stessa installazione.

## Commercializzazione Plateform

Plateform può essere venduta o concessa in licenza a ristoranti conosciuti dal fornitore.

Il billing commerciale di Plateform non deve essere confuso con i pagamenti dei clienti del ristorante.

Non implementare automaticamente Stripe Billing o un portale SaaS self-service per Plateform salvo requisito futuro esplicito. Contratti, canoni, attivazioni e fatturazione del software possono restare inizialmente gestiti esternamente.

---

# 9. ADMIN del ristorante/catena

Il cliente può avere più Admin.

Ogni Admin possiede scope esplicito:

```text
CHAIN
VENUE
```

Un `ADMIN CHAIN` può, secondo permessi, gestire tutte le sedi della catena.

Un `ADMIN VENUE` può gestire soltanto le sedi assegnate e non deve poter elevare il proprio scope.

Può gestire, nello scope autorizzato:

- staff;
- turni;
- ruoli e assegnazioni;
- menu;
- menu multipli e relativi QR;
- categorie;
- piatti;
- promozioni e contenuti in evidenza nel menu digitale;
- ingredienti;
- ricette e food cost;
- allergeni;
- disponibilità;
- varianti;
- ingredienti rimovibili;
- stazioni;
- cucina;
- Pass;
- sala;
- tavoli;
- zone;
- layout;
- prenotazioni;
- promemoria e comunicazioni prenotazione;
- configurazione WhatsApp/Telegram/SMS/messaggistica transazionale;
- policy caparra/deposito prenotazione;
- lista d’attesa;
- moduli;
- Host;
- casse;
- stampanti;
- pagamenti;
- Stripe;
- Satispay;
- sito e branding;
- impostazioni;
- feature consentite;
- ordini;
- ordini da asporto / takeaway;
- richieste modifica;
- chiusure forzate;
- rimborsi;
- riapertura conti;
- conflitti offline;
- notification center operativo;
- incidenti applicativi consentiti.

Un Admin non deve vedere dati economici o operativi di una sede non compresa nel proprio scope.

---

# 10. Staff del ristorante

Tutti gli account staff appartengono alla stessa catena cliente.

Ogni account deve avere una o più sedi autorizzate quando `MULTI_VENUE = true`.

Gestire ruoli, turni e assegnazioni operative a:

- sede;
- zona;
- tavolo;
- stazione;
- cassa.

In modalità mono-sede non mostrare alcun selettore di sede.

In modalità multi-sede:

- se un utente è assegnato a una sola sede, aprirla automaticamente;
- se è assegnato a più sedi, mostrare un selettore compatto e chiaro;
- memorizzare la sede operativa corrente senza considerarla una fonte di autorizzazione;
- il server deve validare comunque lo scope ad ogni operazione.

Il trasferimento di un dipendente tra sedi deve essere un'operazione amministrativa auditata.

---

# 11. Camerieri

Utilizzare un unico ruolo:

```text
WAITER
```

con tre tipi operativi:

```text
ZONE
TABLE
RUNNER
```

## ZONE

Cameriere assegnato a una zona.

Esempio:

```text
Terrazza → Luca
```

## TABLE

Cameriere assegnato direttamente a uno o più tavoli.

L'assegnazione TABLE ha sempre precedenza su ZONE.

Esempio:

```text
Zona Terrazza → Luca
Tavolo 8 → Marco
```

Responsabile Tavolo 8:

```text
Marco
```

## RUNNER

Cameriere senza tavoli propri.

Si occupa principalmente del trasporto dei piatti dal Pass ai tavoli.

Normalmente non riceve chiamate cliente.

L'Admin può cambiare assegnazioni durante il servizio.

---

# 12. HOST

L'Host gestisce l'accoglienza.

Può:

- vedere prenotazioni;
- vedere sala;
- vedere tavoli;
- creare walk-in;
- registrare arrivo;
- assegnare tavoli;
- cambiare tavolo;
- unire tavoli;
- separare tavoli;
- gestire stati prenotazione;
- segnare no-show;
- segnare cancellazione;
- utilizzare suggerimenti automatici Plateform.

Non può:

- creare ordini;
- modificare ordini;
- modificare conti;
- gestire pagamenti;
- modificare menu;
- modificare disponibilità;
- cambiare configurazioni amministrative.

---

# 13. Sito pubblico

Mantenere una vera **home pubblica del ristorante**, elegante e completa, insieme alle altre pagine del sito.

La home deve essere la pagina iniziale del sito pubblico, accessibile direttamente su `https://dominio.it/`, secondo la struttura definita nella sezione 15. Deve essere accessibile senza login e non deve essere sostituita da una dashboard, da una schermata di accesso o da un selettore di ristoranti/sedi.

Non creare una home con tre pulsantoni.

Creare un sito da ristorante premium.

Sezioni possibili:

- hero;
- storia;
- filosofia;
- chef;
- ristorante;
- menu;
- gallery;
- contatti;
- orari;
- indirizzo;
- mappa;
- social;
- prenotazioni;
- footer.

Navigazione indicativa:

```text
Home
Menu
Il Ristorante
Gallery
Prenota
Contatti
```

Non mostrare pulsante STAFF.

Il gestionale è accessibile direttamente su:

```text
https://dominio.it/staff
```

Se l'utente non è autenticato, mostrare il login su `https://dominio.it/staff/login`; se è autenticato, aprire la dashboard prevista per il suo ruolo. Tutte le pagine operative, incluse Admin e Super Admin, appartengono al sottodominio staff.

L'accesso al gestionale resta protetto da autenticazione e autorizzazioni server-side.

---

# 14. Personalizzazione sito

L'Admin può modificare:

- logo;
- favicon;
- immagini;
- colori;
- font;
- hero;
- testi;
- sezioni;
- contatti;
- partita IVA;
- indirizzo;
- social;
- footer;
- dark mode;
- layout base.

Il sito deve essere completamente responsive.

---

# 15. Dominio pubblico e sottodominio staff

La struttura base resta:

| Area | Indirizzo |
| --- | --- |
| Home pubblica catena/ristorante | `https://dominio.it/` |
| Menu pubblico | `https://dominio.it/menu` |
| Elenco sedi, se multi-sede | `https://dominio.it/sedi` |
| Pagina sede, se multi-sede | `https://dominio.it/sedi/{venue_slug}` |
| Prenotazioni | `https://dominio.it/prenota` |
| Accesso cliente tramite QR | `https://dominio.it/tavolo/{public_table_id}` |
| Gestionale personale | `https://dominio.it/staff` |
| Login personale | `https://dominio.it/staff/login` |

`dominio.it` è un segnaposto per il dominio effettivo del cliente.

## Sito pubblico

Il dominio principale rappresenta il brand/catena.

Quando esiste una sola sede:

- non mostrare selettori sede;
- home, contatti, orari, menu e prenotazioni possono riferirsi direttamente a quella sede.

Quando esistono più sedi:

- mostrare sedi in modo elegante;
- consentire pagine dedicate;
- prenotazioni e menu devono conoscere la sede selezionata;
- la sede può essere scelta esplicitamente o determinata dal percorso pubblico;
- non mischiare disponibilità o orari tra sedi.

Il QR tavolo usa un `public_table_id` non prevedibile e univoco nell'intera installazione, così il percorso non necessita di esporre `venue_id`.

## Gestionale staff

Tutte le dashboard operative restano sotto `dominio.it/staff`.

Aprendo la radice:

- se non autenticato → login;
- se autenticato con una sola sede operativa → dashboard;
- se autenticato con più sedi e il ruolo lo richiede → selezione/contesto sede oppure dashboard chain-level.

La selezione UI della sede non sostituisce RLS e controlli server-side.

## Configurazione URL

Centralizzare almeno:

```text
PUBLIC_BASE_URL=https://dominio.it
STAFF_BASE_URL=https://dominio.it/staff
```

Non hardcodare hostname nelle feature.

## Hosting, Auth e PWA

Configurare DNS e HTTPS per entrambi gli host.

Gestire manifest, service worker, cache, redirect Auth e origini consentite esplicitamente per area pubblica e area staff.

Le cache dei due host devono restare separate.

---

# 16. Identificatori staff

Gli account staff possono utilizzare identificatori in formato email, ad esempio:

```text
mario.rossi@dominio.it
```

Questi identificatori possono essere caselle reali oppure alias tecnici, secondo configurazione del cliente.

Non assumere che ogni identificatore sia una mailbox funzionante.

Configurare un dominio stabile per gli identificatori staff.

Quando viene creato Mario Rossi, Plateform può proporre:

```text
mario.rossi@dominio.it
```

In caso di duplicato:

```text
mario.rossi2@dominio.it
```

Il cambio del dominio pubblico o del sottodominio staff non deve rinominare automaticamente gli identificatori esistenti.

Se il cliente sceglie email reali, notifiche e recovery possono essere abilitate in futuro; non dipendere da questo meccanismo per il funzionamento base.

---

# 17. Password, MFA e recovery

La sicurezza degli account privilegiati è obbligatoria.

## Password

- applicare policy password adeguata;
- proteggere reset e cambio password;
- invalidare sessioni quando necessario;
- auditare reset amministrativi;
- non mostrare password in chiaro dopo la creazione.

L'Admin può resettare password dello staff nel proprio scope.

Il Super Admin può resettare password degli Admin.

Creazione/reset tramite Edge Functions sicure e Supabase Admin API server-side.

## MFA

Obbligatoria per:

```text
SUPER_ADMIN
```

Fortemente raccomandata e configurabile come obbligatoria per:

```text
ADMIN
CASHIER
```

Supportare TOTP come metodo minimo. Predisporre architettura compatibile con WebAuthn/passkey senza implementarla necessariamente nella prima release.

Per azioni ad alto rischio richiedere **step-up authentication** recente, anche se l'utente possiede già una sessione valida.

Esempi:

- restore;
- refund;
- force close;
- modifica ruoli privilegiati;
- disattivazione MFA;
- impersonazione write-enabled;
- variazioni critiche pagamenti;
- dismissione installazione.

## Recovery

Non dipendere obbligatoriamente dalla posta elettronica.

Prevedere recovery amministrativa sicura con:

- verifica identità;
- MFA/step-up del soggetto autorizzante;
- audit;
- invalidazione sessioni precedenti.

---

# 18. PIN operativo

Lo staff deve periodicamente effettuare autenticazione completa:

```text
email + password
```

L'Admin può configurare quanto dura questa autenticazione:

- 30 minuti;
- 1 ora;
- 2 ore;
- 4 ore;
- intero turno;
- altri valori sensati.

Durante l'intervallo può essere utilizzato un PIN.

Il PIN:

- scelto dall'utente;
- hashato;
- mai in chiaro;
- modificabile;
- resettabile dall'Admin;
- protetto da brute force;
- dopo troppi errori richiede password completa.

---

# 19. Turni

L'Admin crea esclusivamente la pianificazione dei turni.

Campi:

```text
staff_id
date
start_time
end_time
```

Non implementare:

- timbratura;
- presenza;
- ritardi;
- pause;
- rilevamento entrata/uscita.

---

# 20. Servizi del ristorante

L'Admin può creare liberamente i servizi.

Esempi:

```text
Pranzo
Cena
Brunch
Aperitivo
Evento privato
```

Ogni servizio può avere:

- nome;
- orario inizio;
- orario fine;
- giorni;
- limite prenotazioni/coperti;
- stato attivo/inattivo.

Non assumere che esistano solamente pranzo e cena.

---

# 21. Menu

Gestire:

- categorie;
- piatti;
- bevande;
- immagini;
- descrizione;
- prezzo;
- disponibilità;
- ingredienti;
- allergeni;
- informazioni dietetiche;
- varianti;
- ingredienti rimovibili;
- stazioni;
- disponibilità temporale;
- menu multipli o viste menu differenti, ad esempio colazione, pranzo, cena, aperitivo, carta vini, evento;
- associazione di menu a servizi, fasce orarie, giorni o periodi;
- QR pubblici differenti per menu differenti;
- piatti/categorie messi in evidenza;
- promozioni e popup informativi/promozionali configurabili nel menu digitale.

I menu multipli non devono duplicare inutilmente le entità `dish`: devono riutilizzare il catalogo e definire appartenenza, ordinamento, visibilità e configurazioni contestuali.

I popup/promozioni devono essere configurabili per:

- menu;
- sede;
- periodo di validità;
- servizio/fascia oraria dove pertinente;
- priorità;
- frequenza di visualizzazione;
- call to action opzionale;
- stato attivo/inattivo.

Non utilizzare popup invasivi ripetuti ad ogni navigazione. Rispettare accessibilità, sessione utente e preferenze essenziali.

---

# 22. Ingredienti

Ogni piatto, tranne le bevande, deve mostrare tutti gli ingredienti.

Gli ingredienti devono essere entità strutturate.

Non salvarli solo come testo concatenato.

Per il modulo ricette/food cost, ogni ingrediente può inoltre possedere, dove applicabile:

```text
purchase_unit
base_unit
conversion_factor
current_cost
cost_currency
cost_updated_at
waste_percentage_optional
```

I costi devono essere storicizzabili: il ricalcolo del food cost non deve modificare retroattivamente snapshot economici già registrati.

Il food cost **non equivale a un inventario quantitativo di magazzino**. Plateform può conoscere quantità di ingrediente necessarie a una ricetta e relativo costo senza introdurre giacenze, lotti, carichi/scarichi o riordino automatico.

---

# 23. Allergeni

Gestire allergeni strutturati.

Ogni ingrediente può contenere uno o più allergeni.

Esempio:

```text
Pecorino → LATTE
```

Se un piatto contiene Pecorino:

```text
Carbonara → contiene LATTE
```

Plateform deve ereditare automaticamente gli allergeni dagli ingredienti.

Non implementare:

```text
può contenere tracce
```

Gestire solo:

```text
CONTIENE
```

L'Admin deve poter verificare l'elenco allergeni risultante.

Eventuali override sensibili devono richiedere conferma e audit.

---

# 24. Informazioni dietetiche

Supportare badge strutturati:

- vegetariano;
- vegano;
- senza glutine;
- altre caratteristiche configurabili.

---

# 25. Disponibilità giornaliera

La disponibilità è gestita per piatto.

Non creare inventario quantitativo ingredienti. Il modulo food cost/ricette usa quantità teoriche per porzione e costi unitari, ma non trasforma automaticamente Plateform in un sistema di magazzino.

Esempio:

```text
Carbonara = 10
```

Ordine:

```text
2 × Carbonara
```

Nuovo valore:

```text
8
```

Aggiornamento:

- server-side;
- atomico;
- transazionale;
- realtime.

Mai permettere disponibilità negativa.

---

# 26. Badge disponibilità

```text
> 10
nessun badge
```

```text
6–10
Ultime X porzioni
warning non urgente
```

```text
2–5
Ultime X porzioni
warning urgente
```

```text
1
Ultima porzione
warning urgente
```

```text
0
Esaurito
```

Quando `0`:

- il piatto rimane visibile;
- mostra badge Esaurito;
- non è ordinabile;
- controlli di ordinazione disabilitati.

---

# 27. Prezzo storico

Quando viene creato un `order_item`, memorizzare snapshot del prezzo.

Esempio:

Carbonara ordinata a €18.

Se successivamente Admin modifica menu a €20:

- ordine precedente resta €18;
- nuovi ordini usano €20.

Lo stesso principio vale per informazioni necessarie alla storicità del documento.

---

# 28. Archiviazione entità

Piatti, categorie, utenti, tavoli, stazioni e altre entità già referenziate storicamente non devono essere cancellate fisicamente tramite operatività ordinaria.

Utilizzare:

```text
ARCHIVED
```

o soft-delete equivalente.

---

# 29. Ingredienti rimovibili

L'Admin decide quali ingredienti possono essere rimossi.

Esempio Carbonara:

```text
Pasta
Uova
Guanciale
Pecorino
Pepe
```

Configurazione:

```text
Guanciale → removibile
Pepe → removibile
Pecorino → non removibile
```

UI:

```text
[ ] Senza guanciale
[ ] Senza pepe
```

NON sostituire con campo note.

NON consentire aggiunte.

---

# 30. Varianti

Supportare gruppi di varianti.

Esempio:

```text
Cottura hamburger
```

Opzioni:

```text
Al sangue
Media
Ben cotta
```

Configurazione:

```text
required: true/false
max_selections: N
```

Non implementare extra a pagamento.

---

# 31. Piatti del giorno / temporanei

L'Admin può configurare disponibilità:

- sempre;
- data specifica;
- giorni specifici;
- intervallo date.

La visibilità deve aggiornarsi automaticamente.

---

# 32. Menu dell'unico ristorante

Categorie e piatti sono definiti direttamente nel menu del ristorante.

Ogni piatto ha una sola configurazione corrente per:

- prezzo;
- disponibilità;
- visibilità;
- stazione principale e stazioni osservatrici;
- periodo di disponibilità;
- configurazioni operative.

Non duplicare inutilmente l'intero menu per sede. Usare un catalogo condiviso con override per sede solo dove previsto.

Restano validi i requisiti relativi a disponibilità transazionale, prezzo storico, piatti temporanei, ingredienti, allergeni e varianti.

---

# 33. Editor sala

Creare un editor professionale simile concettualmente a un'app di disegno.

L'Admin deve avere "carta bianca".

Supportare:

- più sale;
- muri;
- porte;
- finestre;
- banconi;
- forme;
- elementi decorativi;
- testo;
- zone;
- tavoli;
- drag & drop;
- resize;
- rotazione;
- zoom;
- snap opzionale;
- undo;
- redo;
- duplicazione;
- selezione multipla;
- livelli.

Tavoli:

- rotondi;
- quadrati;
- rettangolari;
- altre forme sensate.

---

# 34. Tavoli

Ogni tavolo deve avere almeno:

```text
id
room_id
layout_id
number
name
seats
zone_id
technical_status
position_x
position_y
width
height
rotation
active
```

---

# 35. Layout sala

Supportare layout multipli:

```text
Pranzo
Cena
Evento
Matrimonio
Terrazza estiva
```

L'Admin sceglie quale layout è attivo.

---

# 36. Stati tavolo

Plateform mantiene stati tecnici interni.

Esempi:

```text
AVAILABLE
RESERVED
ARRIVING
OCCUPIED
ORDERING
WAITING_SERVICE
WAITING_BILL
PAYMENT
TO_RESET
```

L'Admin può personalizzare:

- nome visibile;
- colore;
- icona;
- ordine;
- eventuali stati aggiuntivi.

La personalizzazione non deve compromettere la state machine interna.

---

# 37. Unione tavoli

Host/Admin possono unire temporaneamente tavoli.

Esempio:

```text
Tavolo 4 + Tavolo 5
```

Durante il servizio sono trattati come gruppo coordinato.

Dopo il servizio possono essere nuovamente separati.

Tutto deve essere auditato.

---

# 38. Cambio tavolo

Quando un gruppo passa:

```text
Tavolo 8 → Tavolo 12
```

devono seguire automaticamente:

- conti;
- ordini;
- sessioni;
- codice conto;
- waiter assignment;
- chiamate;
- stato;
- storico operativo.

Il vecchio QR non deve consentire l'accesso al conto dopo lo spostamento.

---

# 39. Prenotazioni ON/OFF

L'Admin può configurare:

```text
reservations_enabled = true/false
```

Quando OFF:

- link Prenota nascosto;
- pagina prenotazioni non utilizzabile;
- API operative prenotazione disabilitate.

Quando ON:

- link Prenota visibile;
- modulo interno disponibile;
- possono essere attivati reminder, messaggistica, caparra e lista d’attesa secondo feature flag e configurazione della sede.

---

# 40. Modulo prenotazioni interno

Non utilizzare Google Forms/Jotform come soluzione principale.

Creare builder interno Plateform.

Tipi campo:

- text;
- textarea;
- number;
- tel;
- date;
- time;
- select;
- radio;
- checkbox.

Ogni campo ha:

```text
label
placeholder
required
order
options
visible
```

Campi standard disponibili:

- nome;
- cognome;
- telefono;
- persone;
- data;
- ora;
- note;
- allergie;
- occasione speciale.

L'Admin può creare anche Select personalizzati.

---

# 41. Prenotazione automatica e booking pacing

La prenotazione automatica non deve basarsi soltanto sul massimo coperti totale del servizio.

Ogni servizio può configurare:

```text
max_covers_service
slot_interval_minutes
max_arrivals_per_slot
max_covers_per_slot
max_party_size_auto_confirm
large_party_mode
deposit_policy
deposit_amount_or_percentage_optional
deposit_expiry_minutes_optional
```

Esempio:

```text
Cena
max_covers_service = 120
slot_interval_minutes = 30
19:00 max_covers_per_slot = 20
19:30 max_covers_per_slot = 30
20:00 max_covers_per_slot = 25
```

Plateform deve verificare atomicamente:

- sede;
- servizio;
- data;
- fascia oraria;
- coperti totali servizio;
- pacing della fascia;
- eventuali chiusure/blocchi;
- dimensione gruppo.

Per gruppi oltre `max_party_size_auto_confirm` usare, se configurato:

```text
REQUESTED
```

invece di confermare automaticamente.

L'Host/Admin può approvare o rifiutare richieste grandi.

Quando la policy caparra è attiva, l'esito della prenotazione deve dipendere da un pagamento server-authoritative. Il browser non può impostare autonomamente la caparra come pagata.

Policy minime supportate:

```text
DISABLED
OPTIONAL
REQUIRED
CONDITIONAL
```

`CONDITIONAL` può dipendere da condizioni configurabili come dimensione gruppo, servizio, giorno/data speciale o fascia oraria. Le condizioni devono essere deterministiche e auditate.

Non utilizzare una stima automatica della durata del tavolo per promettere rotazioni future salvo feature futura specifica.

---

# 42. Duplicati prenotazione

Implementare protezioni contro prenotazioni duplicate.

Utilizzare dati come:

- telefono;
- data;
- servizio;
- orario;

per individuare richieste sospette/duplicate.

Gestire con UX chiara.

---

# 43. Cancellazione prenotazione

Il cliente non cancella autonomamente dalla piattaforma.

Mostrare istruzione:

> Per modificare o cancellare la prenotazione, contatta il ristorante.

---

# 43A. Conferme e promemoria prenotazione

Plateform deve supportare comunicazioni transazionali automatiche collegate al ciclo di vita della prenotazione.

Canali supportabili tramite provider configurabile:

```text
WhatsApp/Telegram
SMS
EMAIL
```

WhatsApp/Telegram/SMS è il canale prioritario quando il cliente lo configura e il provider scelto lo consente.

Eventi minimi configurabili:

- prenotazione ricevuta;
- prenotazione confermata;
- richiesta grande gruppo ricevuta;
- caparra richiesta;
- caparra ricevuta;
- reminder prima della prenotazione;
- modifica prenotazione;
- cancellazione;
- offerta posto da lista d’attesa.

L'Admin può definire uno o più reminder, ad esempio 24 ore e 3 ore prima. Il sistema deve impedire invii duplicati mediante idempotenza e registrare stato di consegna quando il provider lo rende disponibile.

Creare un sistema di template con variabili controllate, per esempio:

```text
customer_name
venue_name
reservation_date
reservation_time
party_size
service_name
deposit_amount
```

Non consentire template che espongano dati di altri clienti o informazioni interne.

Segreti/API key dei provider di messaggistica devono restare server-side. Gestire retry, rate limit, provider error, opt-out/consensi dove richiesti e retention coerente con la privacy.

---

# 43B. Gestione no-show assistita da reminder e caparra

Plateform deve ridurre i no-show combinando:

- reminder automatici;
- conferme prenotazione;
- eventuale caparra;
- stato di arrivo;
- regole configurabili per ritardo/grace period.

Il sistema non deve dichiarare automaticamente `NO_SHOW` prima che sia trascorso il grace period configurato.

L'Admin può scegliere:

```text
NO_SHOW_MANUAL
NO_SHOW_SUGGESTED
NO_SHOW_AUTOMATIC_AFTER_GRACE_PERIOD
```

In modalità automatica il passaggio a `NO_SHOW` deve essere eseguito server-side, auditato e annullabile/correggibile solo secondo permessi espliciti.

L'eventuale trattamento economico della caparra in caso di no-show deve seguire una policy configurata dal ristorante e non deve essere dedotto o inventato da Plateform.

---

# 43C. Lista d'attesa

Implementare una lista d'attesa per sede, data e servizio.

Ogni voce contiene almeno:

```text
id
venue_id
service_id
date
preferred_time_or_window
party_size
customer_name
customer_phone
notes_optional
status
created_at
offered_at
offer_expires_at
confirmed_at
```

Stati minimi:

```text
WAITING
OFFERED
CONFIRMED
EXPIRED
CANCELLED
CONVERTED_TO_RESERVATION
```

Quando si libera capacità, Plateform può suggerire al personale i candidati compatibili. L'Admin può configurare un'offerta automatica tramite messaggistica, ma la creazione definitiva della prenotazione deve verificare nuovamente la capacità in modo atomico.

L'ordine di priorità deve essere deterministico e trasparente, normalmente basato su compatibilità e ora di inserimento; evitare algoritmi opachi che discriminino clienti.

La lista d'attesa non deve promettere disponibilità futura finché il posto non viene effettivamente confermato.

---

# 44. Stati prenotazione

Implementare:

```text
REQUESTED
PENDING_DEPOSIT
RESERVED
ARRIVED
SEATED
COMPLETED
NO_SHOW
CANCELLED
EXPIRED
```

L'Host gestisce operativamente questi stati.

Un tavolo preassegnato torna realmente libero quando l'Host lo imposta su stato disponibile/libero secondo il workflow.

---

# 45. Assegnazione tavolo prenotazione

L'Admin può preassegnare i tavoli prima del servizio.

Se preassegnato:

- Host vede chiaramente l'assegnazione;
- può modificarla;
- deve confermare il cambio.

Se non assegnato:

Plateform suggerisce tavoli.

Il suggerimento considera:

- coperti;
- capacità;
- zona;
- disponibilità;
- tavoli unibili;
- altre prenotazioni.

NON utilizzare stime della durata media del tavolo per promettere riutilizzo.

È perfettamente possibile che lo stesso tavolo resti occupato per l'intero servizio.

Decisione finale sempre Host.

---

# 46. Walk-in

Host può creare cliente senza prenotazione.

Esempio:

```text
3 persone
walk-in
```

Plateform suggerisce tavoli.

Host decide.

---

# 47. QR Code

Ogni tavolo possiede un QR permanente.

Il QR contiene un URL dell'area cliente e identifica il tavolo dell'unica installazione tramite un identificatore pubblico stabile, ad esempio `public_table_id`.

Non includere selettori o identificatori di ristorante e sede nel routing del QR. Il QR deve puntare al dominio pubblico con il percorso `https://dominio.it/tavolo/{public_table_id}`, usando l'indirizzo base configurato nella sezione 15, anche quando viene generato dal gestionale su `staff.dominio.it`.

Il QR non identifica direttamente il conto e non autorizza da solo l'accesso ai suoi dati. Il codice conto e la customer session restano obbligatori.

Separatamente dai QR tavolo, Plateform deve poter generare **QR pubblici per menu specifici**. Esempi:

```text
/menu/colazione
/menu/pranzo
/menu/aperitivo
/menu/carta-vini
```

Ogni QR menu deve essere revocabile/rigenerabile senza modificare i dati del tavolo e può puntare a un menu, a una sede o a una combinazione configurata. I QR menu sono pubblici e non autorizzano l'accesso a conti o customer session.

---

# 48. Creazione conto

Solo il cameriere responsabile del tavolo può creare un conto operativo.

Il cliente non crea conti.

Il cameriere entra dal contesto del tavolo.

Il numero del tavolo viene quindi compilato automaticamente.

Campi conto:

```text
account_name
covers
internal_note
```

Plateform genera automaticamente codice conto temporaneo.

---

# 49. Più conti per tavolo

Un tavolo può avere più conti contemporaneamente.

Esempio:

```text
Tavolo 12
├── Rossi
├── Bianchi
└── Verdi
```

Ogni conto ha codice separato.

Il cliente non deve vedere alcun dato degli altri conti.

---

# 50. Codice conto

Il codice conto deve essere semplice da comunicare ma sufficientemente resistente a tentativi casuali.

Default:

```text
6 cifre
```

Esempio:

```text
Rossi → 482193
Bianchi → 739421
```

Il codice deve:

- essere generato server-side con CSPRNG;
- essere temporaneo;
- essere associato al tavolo/conto corretto;
- essere protetto da brute force;
- essere rate-limited per IP/device/sessione;
- avere lockout/backoff progressivo;
- essere invalidato alla chiusura;
- poter essere rigenerato dal cameriere responsabile;
- non essere salvato in chiaro se non strettamente necessario: preferire hash/verifica sicura.

Quando viene rigenerato:

- vecchio codice invalidato;
- customer session esistenti invalidate;
- cliente deve autenticarsi nuovamente.

---

# 51. Accesso cliente

Flusso:

1. cliente scansiona QR;
2. Plateform identifica tavolo;
3. chiede codice conto;
4. verifica codice + tavolo + stato conto e che l'operatività dell'installazione sia abilitata;
5. crea customer session;
6. registra audit.

Più dispositivi possono utilizzare lo stesso conto.

Nessun limite rigido di dispositivi.

Ogni sessione deve essere tracciabile.

---

# 52. Funzioni cliente

Cliente autenticato può:

- vedere menu;
- categorie;
- immagini;
- descrizioni;
- ingredienti;
- allergeni;
- badge alimentari;
- disponibilità;
- storico del proprio conto;
- prodotti già ordinati;
- totale corrente;
- chiamare cameriere;
- eventualmente ordinare;
- eventualmente richiedere conto.

Non vede:

- altri conti;
- workflow cucina;
- dati staff;
- dati di altri clienti.

---

# 53. Ordinazione cliente

Admin configura:

```text
DISABLED
WAITER_APPROVAL
DIRECT
```

Default:

```text
WAITER_APPROVAL
```

## DISABLED

Cliente non può ordinare.

## WAITER_APPROVAL

Cliente crea carrello e invia richiesta.

Cameriere responsabile deve:

```text
APPROVE
REJECT
```

Solo dopo approvazione diventa ordine.

## DIRECT

Solo se l'Admin abilita esplicitamente questa modalità.

L'ordine entra direttamente.

Il cameriere responsabile deve comunque ricevere notifica informativa del nuovo ordine.

---

# 54. Carrello cliente

Prima di inviare può:

- cambiare quantità;
- rimuovere prodotti;
- scegliere ingredienti rimovibili;
- scegliere varianti.

Dopo invio:

- non può modificare;
- non può cancellare;
- deve contattare staff.

---

# 54A. Ordini da asporto / takeaway

Plateform deve supportare ordini da asporto con ritiro presso il ristorante. Questa funzione è distinta dagli ordini al tavolo e **non introduce automaticamente delivery a domicilio o gestione fattorini**.

L'Admin può configurare:

```text
takeaway_enabled
pickup_services_or_windows
slot_interval_minutes
max_orders_per_slot_optional
max_items_per_slot_optional
minimum_order_optional
advance_order_limit_days
preparation_buffer_minutes
payment_modes_allowed
```

Il cliente può:

1. aprire la pagina takeaway pubblica;
2. scegliere sede se necessario;
3. selezionare fascia di ritiro disponibile;
4. aggiungere prodotti, varianti e ingredienti rimovibili;
5. inserire i dati minimi richiesti;
6. scegliere il metodo di pagamento consentito;
7. inviare l'ordine;
8. ricevere conferma e aggiornamenti.

Stati minimi:

```text
DRAFT
PENDING_CONFIRMATION
CONFIRMED
IN_PREPARATION
READY_FOR_PICKUP
COLLECTED
CANCELLED
REJECTED
```

L'ordine takeaway deve riutilizzare il catalogo, disponibilità, snapshot prezzo, varianti, ingredienti rimovibili, stazioni e cucina di Plateform.

La disponibilità deve essere scalata server-side con le stesse garanzie transazionali degli ordini al tavolo.

L'Admin configura se l'ordine takeaway è:

```text
STAFF_APPROVAL
DIRECT
```

In `STAFF_APPROVAL`, la richiesta non entra in produzione finché un ruolo autorizzato non la conferma. In `DIRECT`, l'ordine entra automaticamente solo se tutti i controlli server-side e l'eventuale pagamento richiesto sono validi.

Gli ordini takeaway devono essere chiaramente distinguibili nei KDS/ticket e nel Pass, senza richiedere un tavolo.

Il ritiro deve essere associato a una sede e a una fascia oraria. In multi-sede non è consentito ritirare in una sede diversa da quella dell'ordine.

Creazione pubblica dell'ordine, prenotazione slot e pagamento online richiedono connessione al server; non simulare successo offline.

---

# 55. Chiamata cameriere

Cliente clicca:

> Chiama cameriere

Routing:

```text
1. WAITER TABLE
2. altrimenti WAITER ZONE
```

Non broadcast a tutto lo staff.

Runner normalmente escluso.

Un tavolo operativo dovrebbe avere sempre un waiter responsabile risolvibile.

Se non esiste, Plateform deve segnalare la configurazione mancante all'Admin senza inviare indiscriminatamente a tutto lo staff.

Registrare:

```text
created_at
assigned_waiter_id
accepted_at
completed_at
response_time
```

---

# 56. Notifiche e Notification Center

Utilizzare:

- toast;
- badge;
- suoni;
- notifiche contestuali;
- Notification Center persistente.

Eventi importanti non devono dipendere da un toast effimero.

Creare entità `notifications` con almeno:

```text
id
venue_id
recipient_user_id
recipient_role
category
priority
status
created_at
acknowledged_at
resolved_at
expires_at
resource_type
resource_id
```

Stati:

```text
NEW
ACKNOWLEDGED
RESOLVED
EXPIRED
```

L'Admin può configurare i suoni per ruolo/postazione/evento.

Eventi tipici:

- chiamata cameriere;
- nuovo ordine;
- richiesta ordine cliente;
- step pronto;
- richiesta conto;
- operazioni cucina;
- conflitto offline;
- stampante guasta;
- pagamento in stato anomalo.

Le notifiche critiche devono essere tracciabili fino alla presa in carico.

---

# 57. Ordine cameriere

Il cameriere seleziona:

- conto;
- piatti;
- quantità;
- ingredienti rimossi;
- varianti;
- step.

Non associare piatti ai singoli coperti.

NON creare Seat 1 / Seat 2.

---

# 58. Step

Non utilizzare rigidamente categorie gastronomiche come sequenza.

Utilizzare:

```text
STEP 1
STEP 2
STEP 3
```

Piatti diversi possono essere nello stesso step.

Esempio:

```text
STEP 1
Tagliere
Grigliata

STEP 2
Carbonara
Filetto
```

Admin configura chi può avviare step successivo fra:

- WAITER;
- PASS;
- KITCHEN_ADMIN.

---

# 59. Stati ordine

Almeno:

```text
RECEIVED
IN_PREPARATION
READY
SERVED
CANCELLED
```

Gestire stato:

- ordine;
- item;
- step.

---

# 60. Modifiche ordine

Solo Admin modifica direttamente un ordine già creato.

Cameriere può inviare:

```text
REQUEST_MODIFICATION
REQUEST_CANCELLATION
```

Admin approva/rifiuta.

Ogni modifica aggiorna atomicamente:

- order;
- item;
- disponibilità;
- totale;
- step;
- stazioni;
- audit;
- realtime.

---

# 61. Stazioni

Admin può creare liberamente stazioni.

Esempi:

- Cucina calda;
- Griglia;
- Primi;
- Freddi;
- Pasticceria;
- Bar;
- Pizzeria.

Ogni piatto ha:

```text
1 stazione principale
0..N stazioni osservatrici
```

Solo stazione principale modifica lo stato di preparazione.

Osservatrici vedono soltanto.

Admin decide quali categorie/piatti vede ogni stazione.

---

# 62. KITCHEN_ADMIN

Può:

- vedere tutte le stazioni;
- coordinare cucina;
- vedere ordini;
- cambiare stati consentiti;
- coordinare step;
- gestire piatti tornati indietro se funzione attiva.

---

# 63. KITCHEN_STAFF

Può:

- vedere propria stazione;
- vedere item pertinenti;
- aggiornare preparazione.

Non può:

- modificare conti;
- modificare prezzi;
- effettuare modifiche economiche;
- cambiare configurazioni.

---

# 64. PASS

Il Pass coordina piatti pronti e servizio.

Esempio:

```text
Tavolo 12 — Step 2

Filetto → pronto
Risotto → pronto
Verdure → pronto
```

Quando tutto è coordinato:

```text
PRONTO PER IL SERVIZIO
```

Admin configura chi riceve notifica:

- Runner;
- waiter table;
- waiter zone;
- combinazioni.

---

# 65. Piatti tornati indietro

Feature configurabile Admin.

Motivo previsto:

```text
ERRORE ORDINE
```

Possono gestire:

- PASS;
- KITCHEN_ADMIN.

Azioni:

```text
RIFARE
ANNULLARE
```

Se `ANNULLARE` comporta rimozione economica:

**approvazione Admin obbligatoria.**

---

# 66. Stampanti stazioni

Una stazione può avere stampante termica.

Admin decide:

- se abilitata;
- quali eventi stampano;
- quale stampante;
- stampa automatica/manuale.

Tablet e ticket cartaceo possono coesistere.

---

# 67. Stati conto

Implementare:

```text
OPEN
BILL_REQUESTED
AT_CASHIER
PARTIALLY_PAID
PAID
CLOSED
```

---

# 68. Richiesta conto

Admin configura se cliente può premere:

> Richiedi conto

Se abilitato, notifica:

- cameriere responsabile;
- Cassa.

Default operativo può restare richiesta tramite cameriere.

---

# 69. Casse multiple

Ogni sede può avere più `cash_register`.

Esempio:

```text
Cassa Reception
Cassa Sala
Cassa Terrazza
```

Ogni cassa ha:

- nome;
- codice;
- posizione o area all'interno del ristorante;
- stato;
- stampante;
- metodi pagamento;
- configurazione.

---

# 70. Più utenti nella stessa cassa

Più Cashier possono utilizzare contemporaneamente la stessa cassa.

Ogni operazione conserva sempre:

```text
cash_register_id
operator_user_id
```

---

# 71. Apri / Chiudi Cassa

I pulsanti:

```text
APRI CASSA
CHIUDI CASSA
```

servono a:

- attivare;
- disattivare;

la postazione.

Non equivalgono alla chiusura contabile del servizio.

---

# 72. Servizio di cassa

Creare entità separata `service_session`.

Ad apertura del servizio/ciclo contabile, la Cassa registra il fondo iniziale.

Esempio:

```text
Fondo cassa: €300
```

Per ogni cassa coinvolta mantenere, se necessario:

```text
opening_float
cash_theoretical
cash_actual
difference
```

---

# 73. Chiudi Servizio

Il ruolo CASHIER può avviare:

> CHIUDI SERVIZIO

Plateform calcola:

- fondo iniziale;
- incassi;
- contanti teorici;
- contanti reali;
- differenza;
- pagamenti per metodo;
- mance;
- rimborsi;
- conti chiusi;
- anomalie.

Il Cashier inserisce il contante reale.

Esempio:

```text
Teorico: €1245
Reale: €1240
Differenza: -€5
```

Se differenza != 0:

- serve approvazione Admin;
- Admin deve inserire la propria password;
- differenza e autorizzazione devono essere auditati.

La cassa/postazione non deve poter essere eliminata o archiviata in modo incompatibile finché tutte le verifiche del servizio non sono completate.

Alla chiusura creare snapshot immutabile della quadratura.

---

# 74. Concorrenza casse

Più casse possono operare sugli stessi conti.

Impedire:

- doppio pagamento;
- doppia selezione prodotto;
- doppio rimborso;
- race conditions.

Utilizzare:

- transaction;
- locking;
- idempotency key;
- constraints;
- Realtime.

---

# 75. Operazioni Cassa

CASHIER può:

- dividere conto equamente;
- dividere per importo;
- dividere per prodotti;
- creare più pagamenti;
- spostare prodotti fra conti;
- creare nuovo conto durante divisione;
- unire conti;
- gestire pagamenti misti.

Queste operazioni appartengono alla Cassa.

Non al cameriere.

---

# 76. Pagamento prodotti

Cassa può selezionare prodotti.

Dopo saldo:

```text
PAID
```

Gli stessi prodotti non possono essere saldati due volte.

---

# 77. Metodi pagamento

Supportare:

```text
CASH
CARD_POS
STRIPE
SATISPAY_POS
SATISPAY_API
```

Admin attiva/disattiva ciascun metodo.

---

# 78. POS tradizionale

Prima versione:

- Plateform mostra importo;
- cassiere usa POS esterno;
- conferma manualmente esito.

Predisporre abstraction layer per future integrazioni hardware dirette.

---

# 79. Stripe

Stripe deve essere configurato realmente ma attivabile/disattivabile da Admin.

Implementazione server-side tramite Edge Functions.

Gestire:

- pagamento;
- stato;
- webhook;
- idempotenza;
- errore;
- conferma.

Mai considerare completato un pagamento in base alla sola UI/browser.

---

# 80. Satispay

Supportare:

## SATISPAY_POS

Pagamento su POS esterno + conferma manuale.

## SATISPAY_API

Integrazione reale server-side.

Gestire:

- richieste;
- stato;
- callback/webhook;
- errori;
- idempotenza.

---

# 81. Pagamenti

Stati:

```text
PENDING
COMPLETED
FAILED
CANCELLED
REFUNDED
PARTIALLY_REFUNDED
```

---

# 82. Mance

Supportare mance.

Il cliente può lasciare mancia tramite:

- contanti;
- carta/POS;
- Stripe;
- Satispay;
- metodo compatibile.

La mancia deve essere contabilizzata separatamente dal conto.

Esempio:

```text
Conto: €180
Mancia: €20
Pagamento carta: €200
```

Registrare:

```text
revenue = €180
tip = €20
```

Non implementare distribuzione mance a singoli dipendenti.

Mostrare solo totale separato.

---

# 83. Sconti e omaggi

Admin configura, separatamente:

```text
DISABLED
ADMIN_APPROVAL_REQUIRED
CASHIER_AUTONOMOUS
```

Applicabile a:

- sconto percentuale;
- sconto fisso;
- piatto offerto;
- conto offerto.

---

# 84. Storno pagamento manuale

Se il conto è ancora aperto, Cassa può correggere un pagamento manuale inserito erroneamente.

Dopo chiusura conto:

- interviene Admin;
- operazione auditata.

---

# 85. Rimborsi

Supportare:

- rimborso totale;
- rimborso parziale.

Ogni rimborso richiede:

- autorizzazione Admin;
- inserimento password Admin.

Per:

- Stripe;
- Satispay API;

utilizzare API provider.

Per:

- cash;
- POS;

registrare operazione manuale.

Non modificare retroattivamente il pagamento originale.

Creare collegamento:

```text
original_payment_id
refund_id
amount
method
authorized_by
status
```

---

# 86. Chiusura conto

Normalmente:

```text
residuo = 0
```

solo allora può essere chiuso.

Se residuo > 0:

pulsante bloccato.

Solo Admin può forzare la chiusura.

Richiedere:

- password Admin;
- conferma;
- motivo;
- audit.

---

# 87. Riapertura conto

Solo Admin.

Richiede:

- password/autorizzazione;
- motivo;
- audit.

---

# 88. Conto di cortesia

Stampabile prima del pagamento.

Contiene:

- logo;
- ristorante;
- indirizzo della sede operativa;
- tavolo;
- conto;
- prodotti;
- quantità;
- prezzi;
- totale.

Non fiscale.

Admin decide quali postazioni possono stamparlo.

---

# 89. Ricevuta finale

Dopo pagamento completo stampare ricevuta termica:

> DOCUMENTO NON FISCALE

Contenuti:

- logo/nome;
- indirizzo della sede operativa;
- data;
- ora;
- conto;
- tavolo;
- prodotti;
- quantità;
- prezzi;
- sconti;
- totale;
- metodi pagamento;
- mance separate.

---

# 90. Epson

Supportare stampanti termiche Epson.

Strategie:

- Epson ePOS SDK/API dove compatibile;
- local print bridge/agent;
- fallback browser print.

Admin configura:

- dispositivo;
- cassa;
- stazione;
- tipo stampa;
- permessi.

Supportare più stampanti per sede.

---

# 91. Print jobs

Creare entità `print_jobs`.

Stati:

```text
QUEUED
SENT
SUCCESS
FAILED
CANCELLED
```

Auditare:

```text
PRINT_REQUESTED
PRINT_SUCCESS
PRINT_FAILED
```

---

# 92. Statistiche

Visibili secondo scope almeno a:

```text
ADMIN
CASHIER
```

In modalità multi-sede:

- utenti `VENUE` vedono solo la propria sede;
- utenti `CHAIN` autorizzati possono vedere aggregati e confronto sintetico tra sedi.

Metriche:

- fatturato;
- piatti più venduti;
- scontrino medio;
- tempo medio permanenza;
- tempo medio preparazione piatto;
- piatti annullati;
- piatti tornati indietro;
- chiamate cameriere;
- tempo medio risposta chiamate;
- categorie più vendute;
- prenotazioni/no-show;
- reminder inviati/consegnati/falliti;
- conversione lista d'attesa → prenotazione;
- ordini takeaway e valore medio takeaway;
- utilizzo capacità per servizio;
- food cost teorico per piatto;
- margine lordo teorico per piatto;
- food cost percentage;
- contributo vendite/margine per menu engineering;
- errori/incidenti operativi rilevanti.

NON implementare classifiche o performance individuali dei camerieri.

Default: dashboard semplice e leggibile. Filtri avanzati possono essere aggiunti solo se non degradano la UX.

---

# 93. Super Admin e dati economici

Il Super Admin non deve avere normalmente una dashboard economica del ristorante.

Può vedere quei dati solamente tramite impersonazione autorizzata di:

- Admin;
- Cashier.

---

# 94. Feature flags

Due livelli.

## Super Admin / licenza installazione

Può autorizzare funzionalità per l'installazione:

```text
MULTI_VENUE
CLIENT_ORDERING
STRIPE
SATISPAY_API
OFFLINE
ADVANCED_ROOM_EDITOR
ADVANCED_ANALYTICS
RESERVATION_MESSAGING
WhatsApp/Telegram/SMS_MESSAGING
BOOKING_DEPOSITS
WAITLIST
TAKEAWAY
FOOD_COST
MENU_PROMOTIONS
MULTI_MENU_QR
```

## Admin

Può attivare/disattivare soltanto feature consentite dal Super Admin e compatibili con il proprio scope.

Le feature flag devono essere server-authoritative e auditabili.

---

# 95. Limiti operativi e tecnici

Il Super Admin può configurare limiti per l'installazione:

- utenti massimi;
- sedi massime quando `MULTI_VENUE` è attivo;
- tavoli massimi per sede;
- piatti massimi;
- storage massimo;
- dispositivi registrati;
- retention tecnica dove previsto.

Con `MULTI_VENUE = false`, il limite sedi è strutturalmente 1.

Questi limiti sono controlli tecnici/commerciali dell'installazione, non sicurezza tra clienti.

---

# 96. Sospensione operativa dell'installazione

Quando il Super Admin sospende l'operatività dell'unico ristorante:

## Restano disponibili

- home pubblica;
- contenuti sito;
- menu pubblico in sola lettura.

## Vengono disabilitati

- login operativo di Admin e staff;
- dashboard operative;
- customer session operativa;
- ordini;
- chiamate;
- prenotazioni;
- pagamenti;
- realtime operativo.

Non cancellare dati.

L'accesso tecnico riservato al Super Admin deve restare disponibile per diagnosi e riattivazione, con le relative autorizzazioni e audit.

---

# 97. Dismissione protetta dell'installazione

La dismissione riguarda l'intera installazione della catena cliente.

Stati del ciclo di vita:

```text
ACTIVE
SUSPENDED
PENDING_DELETION
ARCHIVED
PERMANENTLY_DELETED
```

La sospensione segue la sezione 96.

Per avviare la dismissione richiedere:

- password Super Admin;
- digitazione del nome del ristorante;
- conferma;
- backup.

In modalità multi-sede consentire archiviazione controllata di una sede solo quando non compromette storico e riferimenti. Non cancellare fisicamente dati storici. L'archiviazione ordinaria delle altre entità resta regolata dalla sezione 28.

---

# 98. Dashboard tecnica Super Admin — Operational Health

Mostrare lo stato tecnico dell'installazione in modo leggibile, non come pannello DevOps eccessivamente complesso.

Esempio:

```text
Application        v1.4.2
Database schema    v37
Supabase DB        OK
Auth               OK
Realtime           OK
Storage            OK
Stripe             OK / DISABLED
Satispay           OK / DISABLED
Printer bridge     WARNING
Offline queue      3 pending
Sync conflicts     1 open
Last backup        02:00
Last restore test  2026-09-04
Open incidents     1
```

Monitorare almeno:

- database;
- Auth;
- Realtime;
- Storage;
- Edge Functions;
- provider pagamenti attivi;
- print bridge;
- error rate;
- latency;
- sessioni attive;
- dispositivi online/offline;
- queue offline;
- conflitti sync;
- webhook pending/falliti;
- backup;
- restore test;
- versione applicazione;
- versione schema DB;
- incidenti aperti.

I dettagli sensibili devono essere visibili solo a soggetti autorizzati.

---

# 99. Impersonazione

Super Admin può impersonare qualsiasi ruolo.

All'inizio:

# READ ONLY

Mostrare banner:

> MODALITÀ ASSISTENZA — Stai impersonando [utente] ([ruolo])

Se vuole modificare dati deve premere:

> ABILITA INTERVENTO

Richiedere conferma.

Solo allora può eseguire azioni compatibili con il ruolo impersonato.

Ogni azione viene auditata sia con:

- utente impersonato;
- Super Admin reale.

---

# 100. Audit log — requisito assoluto per eventi rilevanti

Plateform deve mantenere un **Security & Business Audit Log** immutabile per tutte le operazioni rilevanti dal punto di vista di sicurezza, economico, amministrativo e operativo.

Includere almeno eventi di:

- login/logout e autenticazione fallita;
- MFA e recovery;
- creazione/modifica/disattivazione utenti;
- modifiche ruoli/scope;
- accessi a risorse sensibili quando richiesto;
- creazione/modifica/cancellazione logica ordini;
- modifiche prezzi/disponibilità;
- pagamenti;
- rimborsi;
- sconti/omaggi;
- cassa e quadrature;
- prenotazioni contenenti dati personali quando opportuno;
- esportazioni dati;
- modifiche configurazioni;
- impersonazione;
- backup/restore;
- deploy/migration ad alto impatto;
- sync offline e conflitti risolti;
- incidenti e azioni amministrative.

Attori possibili:

- Super Admin;
- Admin;
- Host;
- Cashier;
- Kitchen Admin;
- Kitchen Staff;
- Pass;
- Waiter;
- Customer;
- System;
- Edge Functions;
- processi automatici.

Non trasformare l'audit in analytics di navigazione.

---

# 101. Audit vs Telemetry

Separare nettamente:

```text
AUDIT
```

da:

```text
TELEMETRY / ANALYTICS
```

## Audit

Serve a ricostruire chi ha fatto cosa, su quale risorsa, con quale esito.

## Telemetry

Serve a comprendere:

- pagine utilizzate;
- performance;
- latenza;
- errori UI;
- funnel e utilizzo feature;
- metriche tecniche aggregate.

Eventi come apertura pagina, visualizzazione categoria o piatto, click e ricerca non devono essere inseriti automaticamente nell'audit di sicurezza salvo che l'accesso riguardi dati sensibili o sia richiesto da una policy specifica.

La telemetry deve rispettare privacy, minimizzazione e retention definite nella sezione Data Governance.

---

# 102. Struttura audit

Ogni record deve avere, se applicabile:

```text
id
timestamp

actor_type
actor_user_id
actor_role

customer_session_id

action
resource_type
resource_id
operation
result

ip_address
user_agent
device_id
session_id

cash_register_id
service_session_id
table_id
account_id
order_id
payment_id

old_values
new_values
metadata

correlation_id
request_id

offline_origin
synced_at

impersonated_by
impersonation_write_enabled
```

Aggiungere campi professionali necessari.

---

# 103. Audit immutabile

Nessuno può:

- modificare;
- cancellare;
- sovrascrivere;

eventi audit.

Nemmeno Super Admin.

Il Super Admin può soltanto visualizzare.

---

# 104. Dashboard Audit

Solo Super Admin.

Read-only.

Supportare:

- ricerca;
- data;
- utente;
- ruolo;
- azione;
- risorsa;
- esito;
- request ID;
- correlation ID;
- dettaglio old/new;
- impersonazione;
- pagination.

Mai mostrare:

```text
EDIT
DELETE
UPDATE
```

---

# 105. Dati sensibili audit

Non registrare in chiaro:

- password;
- PIN;
- JWT;
- refresh token;
- service role key;
- API secrets;
- Stripe secrets;
- Satispay secrets;
- CVV;
- dati completi carta.

Auditare l'evento, non il segreto.

---

# 106. Audit automatico

`SYSTEM` deve registrare:

- disponibilità scalata;
- webhook;
- sync;
- retry;
- payment confirmation;
- payment failure;
- invalidazione codice;
- generazione codice;
- stampa;
- backup;
- restore;
- processi automatici;
- errori importanti.

---

# 107. Scalabilità audit

L'audit produrrà milioni di eventi.

Progettare:

- partizionamento;
- indici;
- pagination;
- query ottimizzate;
- archiviazione storica;
- hot storage;
- historical storage.

Nessuna perdita intenzionale dei dati audit.

---

# 108. Realtime

Utilizzare Supabase Realtime per aggiornamenti pertinenti a:

- menu;
- disponibilità;
- ordini;
- cucina;
- Pass;
- tavoli;
- assegnazioni;
- chiamate;
- conti;
- pagamenti;
- casse;
- prenotazioni;
- lista d'attesa;
- takeaway;
- notifications.

**PostgreSQL è sempre la fonte autoritativa dello stato. Realtime è un meccanismo di propagazione, non la source of truth.**

Ogni risorsa concorrente importante deve avere almeno `updated_at` e, dove utile, `version`/revision.

Ogni subscription deve essere autorizzata secondo:

- ruolo;
- scope sede;
- assegnazione;
- conto/customer session;
- feature attive.

Non creare subscription globali inutili.

Dopo reconnect o sospetta perdita eventi:

```text
reconnect
→ fetch authoritative snapshot
→ reconcile local state
→ resume subscription
```

Non assumere che un evento Realtime venga sempre ricevuto una sola volta o nell'ordine desiderato.

---

# 109. PWA

Implementare:

- manifest;
- service worker;
- icone;
- installazione;
- cache;
- gestione aggiornamenti;
- stato connessione.

La PWA del gestionale deve avviarsi su `staff.dominio.it`, con manifest e service worker serviti da quell'origine e ambito coerente con le pagine staff. La PWA e la cache dell'area pubblica/cliente devono avere manifest e service worker propri sul dominio principale.

Mantenere separate le cache delle due aree; il service worker del dominio pubblico non deve essere usato per gestire le pagine staff e viceversa. Le operazioni offline e le relative code restano soggette ai permessi e alle regole delle sezioni 110–113.

---

# 110. Offline

Quando offline mostrare chiaramente:

> MODALITÀ OFFLINE

Consentire, dove sicuro:

- menu cache;
- sala cache;
- tavoli cache;
- ordini già sincronizzati;
- creazione ordini in coda;
- operazioni non finanziarie autorizzate.

Creare queue locale persistente.

## Offline authorization snapshot

Prima di consentire operazioni offline, il dispositivo deve possedere uno snapshot autorizzativo firmato/logicamente verificabile contenente almeno:

```text
user_id
role
scope
venue_ids
operational_assignments
device_id
issued_at
expires_at
```

Lo snapshot deve avere durata limitata.

Se scaduto, consentire soltanto letture offline non sensibili finché non avviene una nuova autenticazione/sincronizzazione.

Un utente disabilitato mentre il device è offline non deve poter continuare indefinitamente a generare operazioni valide.

---

# 111. Sincronizzazione offline

Alla riconnessione:

- verificare nuovamente identità e autorizzazioni;
- mantenere l'ordine causale dove necessario;
- usare idempotency keys;
- evitare duplicati;
- considerare server e PostgreSQL autoritativi;
- auditare sync rilevanti;
- confrontare revision/version;
- gestire conflitti esplicitamente;
- non scartare silenziosamente operazioni.

Ogni evento offline deve avere almeno:

```text
client_event_id
idempotency_key
created_at_local
user_id
device_id
venue_id
resource_type
operation
base_version
payload
sync_status
```

---

# 112. Conflitti offline e Conflict Center

Se due dispositivi offline producono operazioni incompatibili, il server decide lo stato valido senza violare invarianti.

Esempio ultima porzione:

- nessuna disponibilità negativa;
- prima operazione valida secondo regola server;
- seconda operazione entra in `CONFLICT`;
- non fingere successo;
- auditare il conflitto.

Creare **Conflict Center** per Admin autorizzati.

Ogni conflitto deve mostrare:

- sede;
- risorsa;
- utente/dispositivo;
- ora locale e ora sync;
- motivo;
- stato server corrente;
- operazione richiesta;
- possibili azioni sicure.

Esempio:

```text
ORDINE #492 — Tavolo 12
Creato offline da Mario Rossi
Problema: Carbonara esaurita durante la sincronizzazione

[MODIFICA ORDINE]
[ANNULLA ITEM]
[SEGNA RISOLTO]
```

La risoluzione deve essere auditata.

---

# 113. Vietato offline

Non consentire offline:

- Stripe;
- Satispay API;
- conferma definitiva di pagamenti online;
- rimborsi online;
- modifica ruoli/scope;
- reset password/MFA;
- restore;
- modifiche amministrative sensibili;
- operazioni dopo scadenza authorization snapshot;
- operazioni che richiedono server immediato.

Per pagamenti POS esterni o cash registrati durante perdita rete, definire una procedura operativa separata e prudente; non considerarli automaticamente confermati nel sistema senza riconciliazione.

---

# 114. Storage

Utilizzare Supabase Storage.

Bucket/logica:

```text
branding/
dishes/
gallery/
documents/
```

All'interno dei bucket usare percorsi basati sulla risorsa. È consentito includere `venue_id` nei percorsi quando migliora policy e organizzazione; non usare tenant di clienti diversi nello stesso bucket production.

Applicare policy rigorose su lettura e scrittura: rendere pubblici soltanto gli asset destinati al sito, proteggere documenti e contenuti riservati e consentire gli upload esclusivamente ai ruoli autorizzati.

---

# 115. Backup, RPO e RTO

Backuppare tutti i dati rilevanti:

- PostgreSQL;
- utenti/Auth;
- Storage;
- immagini/documenti;
- menu;
- sedi;
- sala/layout/tavoli;
- prenotazioni;
- conti/ordini;
- pagamenti/casse/quadrature;
- turni;
- impostazioni;
- feature;
- audit;
- configurazioni.

Definire per ogni installazione production:

```text
RPO = Recovery Point Objective
RTO = Recovery Time Objective
```

Usare valori configurati/documentati dal piano operativo. Per un deployment professionale iniziale, progettare affinché sia realisticamente possibile ottenere obiettivi come RPO nell'ordine dei minuti e RTO nell'ordine di un'ora, senza dichiararli garantiti se l'infrastruttura scelta non li supporta.

Un backup non è considerato realmente affidabile se non viene periodicamente verificato con un **restore test**.

Registrare:

- ultimo backup riuscito;
- ultimo backup fallito;
- ultimo restore test;
- durata;
- integrità verificata;
- retention backup.

---

# 116. Restore

Dashboard Super Admin deve includere:

> RIPRISTINA BACKUP

Richiedere:

- password Super Admin;
- conferma;
- selezione backup;
- selezione ambito restore.

Il Super Admin può ripristinare l'intera installazione dell'unico ristorante. Dove tecnicamente supportato, può selezionare ambiti di dati coerenti e documentati, preservando le dipendenze tra database, Auth, Storage e audit.

Il restore riguarda l'installazione cliente. Restore parziali per sede sono ammessi solo se tecnicamente sicuri, coerenti con le dipendenze e documentati.

Prima del restore:

- mostrare impatto;
- creare snapshot/pre-restore backup;
- chiedere conferma forte.

Auditare interamente il restore.

---

# 117. Sicurezza — requisito continuo

Implementare fin dall'inizio:

- RLS;
- least privilege;
- scope chain/venue;
- MFA;
- step-up authentication;
- validation server-side;
- CSP;
- protezione XSS;
- sanitizzazione dove necessaria;
- output encoding;
- secure headers;
- brute-force protection;
- rate limiting;
- session security;
- device/session revocation;
- idempotenza;
- transazioni;
- protezione secrets;
- dependency review;
- secure logging;
- separazione ambienti;
- secret rotation procedure;
- security tests automatizzati.

Non inserire il security hardening come attività eseguita soltanto a fine progetto.

Ogni release deve superare un security gate proporzionato al rischio.

---

# 118. Client non autoritativo

Non fidarsi mai di valori client come:

```text
user_id
customer_session_id
table_id
account_id
role
price
availability
total
payment_status
discount
account_status
```

Verificare server-side.

---

# 119. Importi

Non usare floating point JS come fonte finanziaria autoritativa.

Utilizzare:

- integer cents;

oppure:

- PostgreSQL numeric appropriato.

Totali calcolati server-side.

---

# 120. Database

Creare schema PostgreSQL professionale, normalizzato e versionato tramite migration.

Prevedere almeno tabelle equivalenti a:

```text
restaurant_profile
restaurant_settings
venues
venue_settings
feature_flags
system_limits

users
staff_profiles
staff_venue_assignments
staff_pins
shifts
mfa_metadata_if_needed
registered_devices

services
service_booking_rules
booking_time_slots

rooms
room_layouts
zones
tables
table_status_definitions
table_assignments
table_merges

reservations
reservation_form_definitions
reservation_form_fields
reservation_answers
reservation_reminder_rules
reservation_message_templates
reservation_message_jobs
reservation_message_deliveries
reservation_deposit_policies
reservation_deposits
waitlist_entries
waitlist_offers

categories
dishes
ingredients
allergens
ingredient_allergens
dish_ingredients
recipe_items
ingredient_cost_history
dish_cost_snapshots
removable_ingredients
dietary_tags
dish_dietary_tags
variant_groups
variant_options
venue_dish_settings
menus
menu_categories
menu_dishes
menu_public_qr_codes
menu_promotions
menu_promotion_targets

stations
dish_station_assignments

accounts
customer_access_codes
customer_sessions

orders
order_steps
order_items
takeaway_orders_or_order_context
takeaway_pickup_slots
order_item_removed_ingredients
order_item_variants
order_change_requests

waiter_calls
notifications

cash_registers
cash_register_sessions
service_sessions
cash_reconciliations

payments
payment_allocations
tips
refunds
discounts
account_splits

print_devices
print_jobs

audit_log
telemetry_events_or_external_sink

offline_sync_events
offline_authorization_snapshots
sync_conflicts

system_errors
system_metrics_if_persisted
incidents
incident_events

backup_metadata
restore_jobs

application_releases
database_migrations_metadata
```

`restaurant_profile` rappresenta la singola catena/brand dell'installazione ed è singleton.

`venues` contiene una o più sedi della stessa catena.

`restaurant_settings` e `system_limits` sono singleton a livello installazione.

`feature_flags` contiene feature dell'installazione, inclusa `MULTI_VENUE`.

Quando `MULTI_VENUE = false`, vincoli server/database devono impedire una seconda sede attiva.

Le entità location-scoped devono avere `venue_id` direttamente quando utile per sicurezza, performance e chiarezza, oppure derivarlo tramite una relazione forte e non ambigua.

Menu: mantenere catalogo condiviso e usare `venue_dish_settings` soltanto per override realmente necessari, come:

- enabled;
- local_price;
- availability;
- local_station;
- temporal availability.

Non duplicare l'intero piatto per sede senza necessità.

Food cost: mantenere separati costo corrente dell'ingrediente, storico dei costi e snapshot calcolati del piatto. Le quantità di ricetta devono usare unità normalizzate e conversioni esplicite.

Menu multipli: `menus` e relative tabelle di relazione organizzano lo stesso catalogo in viste differenti senza clonare `dishes`.

Takeaway: preferire, se coerente con lo schema finale, un unico modello `orders` con contesto/source esplicito anziché duplicare tutta la logica ordine; una tabella dedicata può contenere solo i dati specifici del ritiro.

---

# 121. RLS

Scrivere policy SQL vere, testate automaticamente.

Le policy devono verificare:

- auth identity;
- ruolo;
- scope `CHAIN`/`VENUE`;
- venue assignment;
- relazione con risorsa;
- assegnazione operativa;
- customer session quando pertinente.

Esempi:

- Admin CHAIN → operazioni consentite su sedi della catena;
- Admin VENUE → solo sedi assegnate;
- Host → prenotazioni/sala/tavoli delle sedi assegnate;
- Cashier → conti/pagamenti/casse della sede operativa autorizzata;
- Kitchen → ordini pertinenti alla propria sede/stazione;
- Waiter → dati operativi necessari secondo sede e assegnazioni;
- Customer → esclusivamente proprio conto/sessione;
- Super Admin → privilegi tecnici controllati;
- Audit → append-only tramite percorsi autorizzati, update/delete vietati.

Non è sufficiente essere autenticati.

Testare esplicitamente il tentativo di accesso cross-venue.

---

# 122. RPC / Edge Functions critiche

Creare operazioni authoritative per:

```text
create_staff_user
reset_staff_password

create_account
regenerate_account_code

create_order
create_customer_order_request
approve_customer_order
reject_customer_order

create_takeaway_order
approve_takeaway_order
reject_takeaway_order
reserve_takeaway_pickup_slot
update_takeaway_status

modify_order
request_order_change
approve_order_change

decrement_availability

create_reservation_with_policy
create_reservation_deposit
confirm_reservation_deposit
queue_reservation_reminder
process_reservation_reminder
create_waitlist_entry
offer_waitlist_slot
accept_waitlist_offer
expire_waitlist_offer

recalculate_dish_food_cost
create_dish_cost_snapshot

create_menu_public_qr
create_menu_promotion

assign_table
move_table
merge_tables
split_tables

call_waiter

open_cash_register
close_cash_register

open_service_session
close_service_session
approve_cash_difference

split_account
merge_accounts
move_account_items

create_payment
confirm_payment
cancel_manual_payment

create_refund
approve_refund

force_close_account
reopen_account

create_print_job

create_backup
restore_backup
```

Operazioni composte devono essere atomiche.

---

# 123. State machine

Definire state machine esplicite per:

- installazione, inclusi sospensione e ciclo di vita;
- configurazione di pubblicazione dei due host, se il provider scelto richiede un workflow applicativo;
- prenotazione;
- caparra prenotazione;
- reminder/messaggio prenotazione;
- lista d'attesa/offerta lista d'attesa;
- takeaway;
- tavolo;
- conto;
- ordine;
- item;
- step;
- chiamata;
- pagamento;
- rimborso;
- cassa;
- servizio;
- stampa;
- backup;
- restore.

Non consentire transizioni arbitrarie.

---

# 124. UX per ruolo e performance operativa

## Cliente

- mobile-first;
- elegante;
- semplice;
- minima;
- niente linguaggio tecnico.

## Waiter

- smartphone-first;
- grandi touch target;
- azioni rapide;
- feedback immediato;
- flusso `apri tavolo → aggiungi piatto → invia ordine` in idealmente 3–4 interazioni principali dopo il contesto tavolo.

## Runner

Runner è una modalità `WAITER`.

- smartphone-first;
- lista consegne dal Pass;
- presa in carico rapida;
- nessuna UI amministrativa.

## Host

- tablet/desktop;
- mappa sala dominante;
- prenotazioni e walk-in sempre raggiungibili;
- cambio tavolo con conferme chiare.

## Kitchen / Pass

- tablet/display;
- leggibilità da distanza;
- evitare modali ripetitive;
- comandi grandi;
- stato ordine leggibile in meno di un secondo.

## Cashier

- desktop;
- supporto tastiera esteso;
- ricerca conto immediata;
- pagamenti eseguibili con pochi passaggi.

Scorciatoie indicative configurabili:

```text
Ctrl/Cmd + K → Command Palette
F2 → cerca conto
F4 → nuovo pagamento
Esc → chiudi dialog
/ → ricerca contestuale
```

## Admin / Super Admin

- desktop;
- Command Palette globale;
- ricerca per tavolo, cliente, prenotazione, conto, piatto, utente, cassa;
- operazioni distruttive separate dalle azioni comuni.

## Requisiti UX operativi

- nessun loader indefinito;
- ogni azione deve mostrare stato pending/success/error;
- pulsanti critici devono prevenire doppio click;
- operazioni lente devono avere request/correlation id recuperabile;
- touch target almeno adeguati a dispositivi operativi;
- niente dipendenza esclusiva dal colore per gli stati.

---

# 125. Design system Plateform

Plateform deve sembrare un prodotto premium per hospitality, non un template amministrativo economico.

## Direzione visiva

- minimalista;
- elegante;
- contemporanea;
- calda ma tecnica;
- alta leggibilità;
- densità informativa controllata;
- gerarchia forte;
- animazioni brevi e funzionali;
- dark mode e light mode;
- responsive.

## Brand UI Plateform

Usare un'identità neutra-premium adatta a ristoranti di fascia diversa.

Palette indicativa del gestionale:

```text
Obsidian       #111315
Surface Dark   #191C1F
Warm Ivory     #F4F0E8
Soft Stone     #D8D2C8
Bronze Accent  #B88A55
Success        semantic token
Warning        semantic token
Danger         semantic token
Info           semantic token
```

I colori semantici devono rispettare contrasto/accessibilità; i valori definitivi possono essere rifiniti dal design system.

## Tipografia

- font sans moderno e altamente leggibile per UI;
- numeri tabulari per importi, cassa e tempi;
- peso tipografico usato per gerarchia, non decorazione;
- evitare font eccentrici nell'area operativa.

## Componenti

Creare componenti coerenti per:

- sidebar;
- top bar;
- venue switcher;
- command palette;
- cards KPI;
- data table;
- status pill;
- drawer;
- modal;
- confirmation dialog;
- toast;
- notification center;
- floor map;
- KDS ticket;
- payment panel;
- offline banner;
- incident banner;
- sync conflict card;
- empty/error/loading states.

## Layout gestionale

Desktop:

```text
┌ Sidebar ┬──────────────────────────────┐
│         │ Top bar / sede / ricerca     │
│         ├──────────────────────────────┤
│         │ Workspace                    │
│         │                              │
└─────────┴──────────────────────────────┘
```

Smartphone staff:

- top bar compatta;
- bottom navigation o actions contestuali;
- niente sidebar desktop compressa artificialmente.

## Stato e priorità

Utilizzare design tokens, non colori hardcoded nelle singole pagine.

Gli stati devono avere combinazione di:

- colore;
- label;
- icona dove utile;
- posizione coerente.

## Motion

- 120–220 ms per transizioni comuni;
- niente animazioni decorative durante flussi operativi;
- rispettare `prefers-reduced-motion`.

---

# 126. Accessibilità

Target WCAG AA dove realistico.

Implementare:

- focus visibile;
- tastiera;
- ARIA;
- contrasto;
- label corrette;
- target touch grandi;
- messaggi errore chiari.

---

# 127. Performance e SLO applicativi

Ottimizzare:

- lazy loading;
- immagini;
- query;
- realtime;
- indici;
- pagination;
- caching;
- asset;
- service worker;
- liste grandi;
- bundle splitting per aree;
- preload solo dove utile.

Non creare subscription realtime globali inutili.

Definire budget misurabili.

Target progettuali indicativi su rete stabile e infrastruttura sana:

```text
interazione UI locale percepita     < 100 ms
apertura vista operativa comune     ~ < 1 s dove cache/dati lo consentono
RPC operativa comune p95            target < 500 ms
propagazione realtime               target < 1 s
```

Non dichiarare SLO contrattuali senza misurazioni reali.

Misurare in produzione:

- p50/p95/p99 latency;
- error rate;
- failed RPC;
- reconnect realtime;
- queue offline;
- web vital del sito pubblico;
- performance dei flussi staff principali.

---

# 128. Error handling

Ogni errore applicativo deve avere struttura simile:

```text
code
message
human_message
context
request_id
```

Frontend mostra `human_message`.

Non esporre:

- SQL;
- stack trace;
- segreti;
- dettagli infrastrutturali sensibili.

---

# 129. Testing

Creare test reali automatici.

## Unit

- disponibilità;
- allergeni;
- totali;
- mance;
- rimborsi;
- varianti;
- state machine;
- codici conto;
- sconti;
- booking pacing;
- calcolo food cost e conversioni unità;
- margine piatto;
- classificazione menu engineering;
- regole reminder;
- policy caparra;
- priorità lista d'attesa;
- capacità slot takeaway;
- scope chain/venue;
- conflict resolution pure logic.

## Integration

- RLS;
- Supabase;
- RPC;
- Edge Functions;
- audit;
- storage;
- auth;
- MFA paths;
- realtime;
- multi-venue isolation;
- idempotenza;
- migrations;
- provider messaggistica tramite adapter/mock affidabili;
- webhook/callback caparra;
- calcolo food cost con storico costi;
- takeaway + disponibilità atomica.

## E2E

Testare tutti i flussi principali già definiti nel master prompt e aggiungere:

- mono-sede senza selettore;
- attivazione multi-sede;
- utente assegnato a una sola sede;
- utente multi-sede;
- accesso cross-venue negato;
- menu con override per sede;
- booking pacing;
- grande gruppo in REQUESTED;
- reminder prenotazione senza duplicati;
- conferma WhatsApp/Telegram/SMS/messaggistica;
- caparra prenotazione;
- no-show dopo grace period;
- lista d'attesa → offerta → prenotazione;
- takeaway → cucina → READY_FOR_PICKUP → COLLECTED;
- food cost e menu engineering con dataset controllato;
- popup/promozione menu con periodo di validità;
- QR menu differenti;
- Notification Center;
- Conflict Center;
- MFA Super Admin;
- command palette e scorciatoie critiche dove automatizzabili.

## Chaos / failure tests

Simulare almeno:

```text
database indisponibile durante operazione
Realtime disconnesso durante servizio
browser chiuso dopo create_payment ma prima della risposta
webhook pagamento duplicato
webhook pagamento fuori ordine
due casse tentano stesso pagamento
due device ordinano ultima porzione
stampante offline dopo enqueue
utente revocato mentre dispositivo è offline
retry Edge Function
network timeout dopo commit server
provider WhatsApp/Telegram/SMS indisponibile durante reminder
callback caparra duplicata o fuori ordine
due clienti accettano l'ultimo slot di lista d'attesa
due clienti tentano l'ultimo slot takeaway
costo ingrediente aggiornato durante calcolo analytics
```

Il sistema deve privilegiare integrità e riconciliazione rispetto a una falsa sensazione di successo.

---

# 130. Audit acceptance test

Scrivere test automatici che dimostrino che:

- operazioni sensibili generano audit;
- modifiche economiche generano audit;
- modifiche ruoli/scope generano audit;
- customer action rilevante genera audit dove previsto;
- system action rilevante genera audit;
- impersonazione registra attore reale e impersonato;
- old/new corretti dove applicabile;
- Super Admin autorizzato può leggere;
- Admin non può leggere audit tecnico completo salvo viste esplicitamente consentite;
- nessuno può modificare o cancellare audit;
- eventi di pura navigazione vanno in telemetry, non nell'audit di sicurezza;
- dati sensibili sono redatti/minimizzati.

---

# 131. Security test

Testare almeno:

- accesso non autorizzato tra ruoli;
- accesso cross-venue;
- aggiramento scope chain/venue;
- aggiramento assegnazioni operative;
- tentativo di creare seconda sede con MULTI_VENUE=false;
- tentativo di creare seconda catena nella stessa installazione;
- brute force codice conto;
- brute force PIN;
- bypass MFA;
- session fixation/revocation;
- manipolazione prezzo;
- manipolazione disponibilità;
- manipolazione payment status;
- accesso Storage;
- accesso audit;
- endpoint amministrativi;
- impersonazione;
- force close;
- refund;
- offline authorization scaduta;
- replay idempotency key;
- escalation di scope;
- venue_id manipolato dal client.

---

# 132. Struttura progetto suggerita

```text
plateform/
│
├── apps/
│   ├── public/
│   └── staff/
│
├── src/
│   ├── config/
│   ├── types/
│   ├── api/
│   ├── auth/
│   ├── mfa/
│   ├── permissions/
│   ├── venues/
│   ├── audit/
│   ├── telemetry/
│   ├── observability/
│   ├── notifications/
│   ├── incidents/
│   ├── components/
│   ├── services/
│   ├── realtime/
│   ├── offline/
│   ├── conflicts/
│   ├── room-editor/
│   ├── payments/
│   ├── printing/
│   ├── reservations/
│   ├── messaging/
│   ├── waitlist/
│   ├── takeaway/
│   ├── food-cost/
│   ├── menu-promotions/
│   ├── utils/
│   └── pages/
│
├── styles/
│   ├── tokens.css
│   ├── reset.css
│   ├── base.css
│   ├── components.css
│   ├── layouts.css
│   ├── utilities.css
│   └── responsive.css
│
├── assets/
│
├── supabase/
│   ├── migrations/
│   ├── seed/
│   ├── functions/
│   ├── policies/
│   └── tests/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── security/
│   └── chaos/
│
├── scripts/
│   ├── deploy/
│   ├── backup/
│   └── restore-test/
│
├── .github/workflows/  # se GitHub Actions è il CI scelto
├── .env.example
├── package.json
├── tsconfig.json
├── eslint.config.*
├── README.md
├── ARCHITECTURE.md
├── DATABASE.md
├── SECURITY.md
├── PRIVACY.md
├── AUDIT.md
├── OBSERVABILITY.md
├── OFFLINE.md
├── DEPLOYMENT.md
├── OPERATIONS.md
├── RUNBOOK.md
├── BACKUP_RESTORE.md
├── INCIDENT_RESPONSE.md
├── TESTING.md
└── CHANGELOG.md
```

La struttura può essere migliorata senza perdere modularità.

Servire l'ingresso pubblico su `dominio.it` e l'ingresso staff sulla radice di `staff.dominio.it`.

---

# 133. Documentazione obbligatoria

## README.md

- setup;
- sviluppo;
- configurazione;
- ambienti;
- Supabase;
- env;
- PWA;
- seed;
- test.

## ARCHITECTURE.md

- modello single-customer;
- mono/multi-sede;
- moduli;
- autorizzazioni;
- realtime;
- offline;
- state machine.

## DATABASE.md

- schema;
- relazioni;
- indici;
- trigger;
- RPC;
- RLS;
- migration policy.

## SECURITY.md

- Auth;
- MFA;
- RLS;
- Edge Functions;
- secrets;
- PIN;
- codici;
- pagamenti;
- impersonazione;
- step-up authentication.

## PRIVACY.md

- data inventory;
- classificazione;
- retention;
- minimizzazione;
- export;
- cancellazione/anonimizzazione;
- telemetry;
- subprocessor/infrastruttura da documentare al cliente.

## AUDIT.md

- eventi;
- schema;
- immutabilità;
- retention;
- query;
- impersonazione;
- differenza audit/telemetry.

## OBSERVABILITY.md

- logs;
- metrics;
- traces/correlation;
- dashboard;
- alerting.

## OFFLINE.md

- cache;
- authorization snapshot;
- queue;
- idempotenza;
- conflitti;
- Conflict Center.

## DEPLOYMENT.md

- development;
- staging;
- production;
- CI/CD;
- versioning;
- rollback.

## OPERATIONS.md / RUNBOOK.md

Procedure per:

- Supabase degradato;
- Realtime offline;
- provider pagamento indisponibile;
- webhook pending;
- stampante offline;
- queue offline bloccata;
- conflitto sync;
- restore;
- incident response.

## BACKUP_RESTORE.md

- RPO/RTO;
- schedule;
- retention;
- restore test.

## INCIDENT_RESPONSE.md

- severità;
- escalation;
- comunicazione;
- timeline;
- chiusura/postmortem.

## TESTING.md

- unit;
- integration;
- E2E;
- security;
- chaos;
- release gates.

## CHANGELOG.md

Versionare modifiche applicative e breaking change.

---

# 134. Prima del codice

Prima dell'implementazione definitiva produrre:

1. Architecture Blueprint;
2. Chain/Venue Scope Model;
3. Role Permission Matrix;
4. Database ERD;
5. State Machines;
6. RLS Matrix;
7. Realtime Event Matrix;
8. Audit Event Catalogue;
9. Telemetry Event Catalogue;
10. Offline Strategy;
11. Conflict Resolution Matrix;
12. Data Classification & Retention Matrix;
13. Observability Plan;
14. Environment & Deployment Plan;
15. Migration/Rollback Plan;
16. Release Plan con gate;
17. Threat Model dei flussi critici;
18. UX flow dei ruoli principali.

Solo dopo procedere con implementazione incrementale.

---

# 135. Ordine di sviluppo obbligatorio

La sicurezza e l'observability devono essere trasversali, non fasi finali.

Procedere indicativamente:

1. architettura + threat model;
2. ambienti development/staging/production;
3. schema PostgreSQL + migration framework;
4. RLS baseline + security tests;
5. Auth + MFA + scope catena/sede;
6. setup catena + prima sede;
7. audit + telemetry separation;
8. observability baseline;
9. Super Admin;
10. Admin;
11. dominio pubblico/staff;
12. menu/catalogo + venue overrides;
13. sala;
14. servizi;
15. prenotazioni + pacing;
16. Host;
17. tavoli;
18. waiter assignments;
19. conti + codici;
20. cliente;
21. ordini;
22. disponibilità;
23. cucina;
24. stazioni;
25. Pass;
26. Realtime + reconciliation;
27. Notification Center;
28. casse;
29. quadrature;
30. pagamenti;
31. mance;
32. Stripe;
33. Satispay;
34. rimborsi;
35. stampa;
36. statistiche;
37. reminder e messaggistica prenotazioni;
38. caparre prenotazione + gestione no-show;
39. lista d'attesa;
40. menu multipli + QR menu + promozioni;
41. ricettario + food cost + menu engineering;
42. takeaway;
43. PWA;
44. offline authorization;
45. queue/sync;
46. Conflict Center;
47. backup + restore test;
48. sito pubblico;
49. CI/CD e release gates definitivi;
50. E2E/security/chaos testing;
51. operational runbook e incident response;
52. documentazione commerciale/tecnica finale.

Ad ogni fase:

```text
implementazione
→ test
→ security review
→ observability
→ documentazione minima
→ merge
```

Non costruire prima l'interfaccia per poi aggiungere sicurezza alla fine.

---

# 136. Funzionalità complete obbligatorie

Il prodotto finale deve supportare realmente questi flussi:

```text
VISITATORE
→ HOME PUBBLICA DEL RISTORANTE
→ MENU / CONTENUTI / CONTATTI / PRENOTAZIONI SE ABILITATE
```

```text
SUPER ADMIN
→ CONFIGURA L'UNICO RISTORANTE E I DATI DELLA SUA SEDE
→ CONFIGURA DOMINIO.IT E STAFF.DOMINIO.IT
→ CREA ADMIN
```

```text
ADMIN
→ CONFIGURA SALA
→ CONFIGURA STAFF
→ CONFIGURA SERVIZI
→ CONFIGURA MENU
```

```text
CLIENTE
→ PRENOTA
→ HOST
→ ASSEGNA TAVOLO
```

```text
CAMERIERE
→ CREA CONTO
→ CODICE CONTO
```

```text
QR
→ CODICE
→ SESSIONE CLIENTE
```

```text
CAMERIERE/CLIENTE
→ ORDINE
→ DISPONIBILITÀ
→ STAZIONE
```

```text
CUCINA
→ PASS
→ RUNNER/WAITER
→ SERVIZIO
```

```text
CLIENTE
→ CHIAMA CAMERIERE
→ WAITER CORRETTO
```

```text
CONTO
→ CASSA
→ DIVISIONE
→ PAGAMENTO
→ MANCIA
```

```text
PAGAMENTO
→ RICEVUTA
→ CHIUSURA
```

```text
SERVIZIO
→ QUADRATURA
→ DIFFERENZA
→ APPROVAZIONE ADMIN
→ CHIUSURA
```

```text
PAGAMENTO
→ RIMBORSO
→ PASSWORD ADMIN
```

```text
PRENOTAZIONE
→ CONFERMA / REMINDER
→ EVENTUALE CAPARRA
→ ARRIVO O NO_SHOW
```

```text
LISTA D'ATTESA
→ DISPONIBILITÀ LIBERATA
→ OFFERTA
→ CONFERMA ATOMICA
→ PRENOTAZIONE
```

```text
TAKEAWAY
→ SLOT RITIRO
→ ORDINE
→ DISPONIBILITÀ
→ CUCINA
→ READY_FOR_PICKUP
→ RITIRO
```

```text
RICETTA
→ COSTI INGREDIENTI
→ FOOD COST PIATTO
→ MARGINE
→ MENU ENGINEERING
```

```text
MENU DIGITALE
→ MENU SPECIFICO / QR SPECIFICO
→ PIATTI IN EVIDENZA / PROMOZIONI
```

```text
QUALSIASI OPERAZIONE
→ AUDIT LOG
```

```text
SUPER ADMIN
→ IMPERSONAZIONE READ ONLY
→ ABILITA INTERVENTO
```

```text
OFFLINE
→ QUEUE
→ RECONNECT
→ SYNC
```

```text
BACKUP
→ RESTORE
→ AUDIT
```

---

# 137. Regola finale

Non dichiarare Plateform production-ready finché:

- RLS e scope chain/venue non sono testati;
- MFA Super Admin non è attiva;
- pagamenti non sono server-authoritative;
- disponibilità non è transazionale;
- casse concorrenti non sono protette;
- conti/customer session sono isolati;
- QR/codici sono sicuri;
- impersonazione è auditata;
- audit e telemetry sono separati;
- offline usa authorization snapshot, idempotenza e Conflict Center;
- Realtime può recuperare snapshot autoritativi;
- backup ha restore test;
- privacy/retention sono definite;
- observability e alerting dei flussi critici sono attivi;
- development/staging/production sono separati;
- CI/CD esegue test e migration checks;
- rollback applicativo/migrazione è documentato;
- security e chaos tests critici passano;
- `MULTI_VENUE=false` impedisce seconda sede attiva;
- `MULTI_VENUE=true` mantiene isolamento tra sedi;
- non esiste un secondo cliente/catena nello stesso database production;
- home pubblica e staff host funzionano correttamente;
- documentazione operativa e runbook sono utilizzabili.

Il prodotto finale deve essere una soluzione professionale vendibile a ristoranti reali, dalla singola sede fino alla catena multi-sede dello stesso proprietario/brand.

Il nome definitivo e unico del prodotto è:

# PLATEFORM

---

---

# 138. Ambienti: Development, Staging, Production

Ogni cliente production deve essere separato dagli ambienti di sviluppo.

Prevedere:

```text
DEVELOPMENT
STAGING
PRODUCTION
```

Mai sviluppare direttamente contro il database production.

Ogni ambiente deve avere:

- Supabase project separato dove economicamente/operativamente sostenibile;
- secrets separati;
- redirect URL separati;
- Storage separato;
- dataset di test non contenente copie indiscriminate di dati personali production;
- configurazioni provider pagamenti coerenti con sandbox/live.

Staging deve rappresentare il più possibile production prima di una release.

---

# 139. CI/CD e Release Gates

Pipeline minima:

```text
commit / pull request
→ format/lint
→ TypeScript check
→ unit test
→ database migration validation
→ RLS/security test
→ integration test
→ build
→ deploy staging
→ E2E smoke test
→ approvazione release
→ production
```

Nessuna release production deve dipendere da copie manuali casuali di file.

Definire gate differenti per:

- patch;
- feature;
- schema migration;
- payment change;
- security change.

Registrare ogni release in `application_releases` con almeno:

```text
version
git_commit
build_id
released_at
released_by
database_schema_version
notes
status
```

---

# 140. Migrazioni database e rollback

Tutte le modifiche schema passano da migration versionate.

Mai modificare manualmente production senza produrre una migration equivalente.

Per migration delicate preferire strategia:

```text
EXPAND
→ MIGRATE DATA
→ DEPLOY COMPATIBLE CODE
→ VERIFY
→ CONTRACT
```

Evitare migration distruttive immediate.

Prima di migration ad alto rischio:

- backup/snapshot;
- verifica spazio e durata;
- staging rehearsal;
- piano rollback/roll-forward;
- finestra operativa appropriata.

Versionare schema database e applicazione separatamente.

---

# 141. Privacy & Data Governance

Creare inventario dati e classificare almeno:

```text
PUBLIC
INTERNAL
CONFIDENTIAL
SENSITIVE
```

Esempi:

- menu pubblico → PUBLIC;
- configurazioni operative → INTERNAL;
- dati prenotazione → CONFIDENTIAL;
- credenziali/secrets → SENSITIVE.

Per ogni categoria definire:

- finalità;
- accesso;
- retention;
- cancellazione/anonimizzazione;
- backup retention;
- export;
- logging consentito.

Applicare data minimization.

Non conservare dati personali indefinitamente soltanto perché tecnicamente possibile.

Prevedere procedure per:

- export dati personali quando richiesto dal cliente;
- correzione;
- anonimizzazione/cancellazione compatibile con obblighi contabili e audit;
- gestione prenotazioni storiche;
- customer sessions scadute;
- IP/user-agent nei log;
- telemetry.

Non memorizzare password, PIN o segreti nei log.

La configurazione reale dei termini privacy/cookie/retention deve essere verificata con il cliente e, quando necessario, con consulenza legale competente: il software deve fornire gli strumenti tecnici, non inventare automaticamente basi giuridiche.

---

# 142. Observability

Implementare tre livelli:

```text
LOGS
METRICS
TRACES / CORRELATION
```

## Logs

Strutturati, con campi come:

```text
timestamp
level
environment
release_version
request_id
correlation_id
user_id_redacted_if_needed
venue_id
operation
result
error_code
latency_ms
```

## Metrics

Almeno:

- RPC/Edge Function error rate;
- latency p50/p95/p99;
- DB errors;
- Realtime reconnect;
- payment failure;
- webhook retry;
- print failure;
- offline queue size;
- sync conflicts;
- auth failure;
- active sessions.

## Alerting

Definire soglie e severity.

Esempi:

```text
payment webhook failures ripetuti → HIGH
DB non raggiungibile → CRITICAL
print queue crescente → WARNING
sync conflicts anomali → WARNING
backup fallito → HIGH
```

Non inviare PII non necessaria a sistemi di observability.

---

# 143. Incident Management

Definire severità:

```text
INFO
WARNING
DEGRADED
INCIDENT
CRITICAL
```

Ogni incidente deve poter registrare:

- sede interessata;
- componente;
- inizio;
- stato;
- impatto;
- owner;
- timeline;
- azioni;
- risoluzione;
- postmortem quando necessario.

La dashboard tecnica deve mostrare incidenti aperti.

Creare runbook per incidenti ricorrenti.

---

# 144. Device Management

Per dispositivi staff registrare, dove utile:

```text
device_id
display_name
platform
venue_id
assigned_role_or_station
last_seen_at
app_version
last_sync_at
revoked_at
```

Consentire revoca dispositivo.

Un dispositivo revocato non deve continuare a sincronizzare operazioni offline dopo una nuova connessione.

---

# 145. Command Palette e ricerca globale

Per Admin/Super Admin e, dove utile, Host/Cashier implementare ricerca globale tramite:

```text
Ctrl/Cmd + K
```

Ricercare soltanto risorse autorizzate:

- tavoli;
- conti;
- prenotazioni;
- clienti prenotazione;
- piatti;
- utenti;
- casse;
- sedi;
- impostazioni.

La ricerca non deve bypassare RLS.

---

# 146. Reservation Operations avanzate

Oltre al booking pacing supportare:

- chiusura manuale di slot;
- blocco prenotazioni per data/servizio;
- capacity override auditato;
- note interne;
- grandi gruppi in approval;
- no-show;
- walk-in;
- preassegnazione tavolo.

In multi-sede ogni regola è esplicitamente associata alla sede.

---

# 147. Commercial Deployment Model

Plateform deve poter essere installata presso clienti differenti senza modificare il codice sorgente per ogni ristorante.

Usare configurazione, seed e branding.

Per ogni nuovo cliente prevedere processo ripetibile:

```text
1. crea ambienti
2. configura dominio
3. configura Supabase
4. applica migrations
5. crea Super Admin tecnico
6. crea primo Admin cliente
7. crea catena/profile
8. crea prima sede
9. configura branding
10. importa/configura menu e sala
11. test acceptance
12. go-live
```

Il codice applicativo deve restare lo stesso tra clienti; cambiano configurazione, branding, feature autorizzate e dati.

---

# 148. Release Strategy

Dividere lo sviluppo commerciale in release.

## Release 1 — Core Operations

- Auth/MFA;
- staff;
- sede;
- menu;
- sala;
- tavoli;
- conti;
- ordini;
- cucina;
- Pass;
- cassa;
- cash/card manuale;
- audit;
- observability base.

## Release 2 — Customer Experience

- QR;
- customer session;
- menu cliente;
- chiamata cameriere;
- customer ordering;
- prenotazioni/pacing;
- notification center.

## Release 3 — Advanced

- Stripe;
- Satispay API;
- offline completo;
- Conflict Center;
- advanced room editor;
- print bridge avanzato;
- analytics avanzate;
- multi-sede commerciale se non già abilitata.

## Release 4 — Revenue, Booking & Menu Optimization

- reminder automatici prenotazioni;
- conferme prenotazione tramite WhatsApp/Telegram/SMS/messaggistica;
- caparra/deposito e gestione no-show;
- lista d'attesa;
- ordini takeaway;
- ricettario quantitativo;
- storico costi ingredienti;
- food cost;
- costo reale/teorico del piatto;
- margine piatto;
- menu engineering;
- popup/promozioni menu digitale;
- piatti/promozioni in evidenza;
- menu multipli e QR differenti per menu.

Queste funzionalità devono essere implementate soltanto dopo la stabilizzazione del core operativo da cui dipendono, ma fanno parte dello scope commerciale finale di Plateform.

Una release non deve includere feature incomplete soltanto per rispettare il numero di funzionalità del master prompt.

---

# 149. Definition of Done

Una feature è completa solo quando possiede:

- requisito funzionale;
- UX;
- permessi;
- schema/migration;
- RLS;
- API authoritative;
- validazione;
- error states;
- realtime se necessario;
- offline behavior esplicito;
- audit/telemetry corretti;
- observability;
- unit/integration/E2E pertinenti;
- documentazione;
- comportamento multi-sede definito;
- rollback/compatibilità quando pertinente.

---

# 150. Principio prodotto

Plateform non deve massimizzare il numero di feature.

Deve massimizzare:

```text
AFFIDABILITÀ DURANTE IL SERVIZIO
VELOCITÀ OPERATIVA
INTEGRITÀ ECONOMICA
SICUREZZA
CHIAREZZA UX
MANUTENIBILITÀ
```

Prima di aggiungere ulteriori moduli fuori scope come magazzino quantitativo completo, HR/payroll, CRM avanzato, loyalty, delivery a domicilio con fattorini, marketing automation generalista o altre aree ERP, rendere eccellente e stabile il ciclo centrale.

Le funzionalità esplicitamente incluse in questo Master Prompt — tra cui takeaway, food cost, ricettario, menu engineering, reminder/caparra/lista d'attesa e promozioni menu — restano parte dello scope, ma devono essere implementate nell'ordine previsto senza indebolire il core:

```text
PRENOTAZIONE
→ SALA
→ CONTO
→ ORDINE
→ CUCINA
→ PASS
→ SERVIZIO
→ CASSA
→ PAGAMENTO
→ CHIUSURA
```
---

# 151. Ricettario e food cost

Il ricettario Plateform deve rappresentare la composizione economica teorica di un piatto.

Per ogni ricetta gestire almeno:

```text
dish_id
ingredient_id
quantity
unit
yield_factor_optional
waste_percentage_optional
```

Le unità devono essere normalizzate e convertibili in modo deterministico, per esempio `kg ↔ g`, `l ↔ ml`, `piece`. Non consentire conversioni implicite impossibili tra unità incompatibili.

Il costo ingrediente può variare nel tempo. Conservare storico almeno di:

```text
ingredient_id
cost_per_purchase_unit
purchase_unit
effective_from
effective_to_optional
source_optional
created_by
```

Il costo teorico del piatto deve essere calcolato server-side:

```text
food_cost = Σ costo quantità ricetta
```

considerando conversioni unità e, se configurati, resa/scarto.

Non usare floating point JavaScript come fonte economica autoritativa.

Il sistema deve poter creare snapshot del food cost per analisi storica.

---

# 152. Margine piatto e menu engineering

Calcolare almeno:

```text
food_cost_amount
food_cost_percentage
gross_margin_amount
gross_margin_percentage
```

Dove:

```text
gross_margin_amount = selling_price - food_cost_amount
```

Gli indicatori devono essere chiaramente definiti come **teorici** se Plateform non dispone di costi reali consuntivi completi, scarti effettivi e altri costi operativi. Non chiamare automaticamente il margine lordo del piatto “utile netto”.

Il menu engineering deve combinare almeno:

- volume di vendita;
- fatturato generato;
- food cost;
- margine/contribution margin teorico;
- periodo selezionato;
- sede;
- menu/categoria.

È consentita una classificazione configurabile dei piatti, per esempio alta/bassa popolarità e alto/basso margine, ma Plateform deve mostrare i valori sottostanti e non affidarsi esclusivamente a etichette.

Gli ordini annullati/rimborsati devono essere trattati correttamente nelle metriche.

---

# 153. Menu multipli, QR dedicati e promozioni

Un ristorante può pubblicare più menu usando lo stesso catalogo.

Esempi:

```text
Colazione
Pranzo
Cena
Aperitivo
Carta vini
Menu evento
```

Ogni menu può avere:

- slug pubblico;
- sede/sedi autorizzate;
- categorie incluse;
- piatti inclusi;
- ordinamento;
- giorni;
- fasce orarie;
- intervallo date;
- stato pubblicato/non pubblicato;
- QR dedicato.

Il QR dedicato non deve contenere dati sensibili e deve puntare a una risorsa pubblica stabile.

Le promozioni/menu highlights possono mostrare:

- banner;
- card evidenziata;
- badge;
- popup controllato;
- call to action verso categoria/piatto/menu.

Configurazioni minime:

```text
start_at
end_at
venue_id_optional
menu_id_optional
priority
max_impressions_per_session_optional
active
```

Le promozioni non devono alterare in modo nascosto il prezzo authoritative del piatto. Eventuali sconti economici devono usare il sistema sconti/omaggi e relative autorizzazioni.

---

# 154. Messaggistica prenotazioni

Implementare un abstraction layer per provider di comunicazione.

Il dominio applicativo deve produrre eventi, mentre un adapter provider gestisce il trasporto.

Esempio:

```text
RESERVATION_CONFIRMED
→ Message Job
→ WhatsApp/Telegram/SMS provider
→ SENT / DELIVERED / FAILED
```

Stati minimi messaggio:

```text
QUEUED
SENDING
SENT
DELIVERED
FAILED
CANCELLED
```

Supportare idempotency key per evitare duplicati.

I retry devono avere backoff e limite massimo.

Il fallimento del provider di messaggistica non deve corrompere lo stato della prenotazione. La prenotazione resta source of truth indipendente dalla consegna del messaggio.

---

# 155. Caparra prenotazione

La caparra/deposito è distinta dai pagamenti del conto al tavolo pur riutilizzando l'astrazione provider dove opportuno.

Ogni deposito deve registrare almeno:

```text
reservation_id
amount
currency
provider
provider_reference
status
created_at
completed_at
refunded_amount
```

Stati minimi:

```text
PENDING
COMPLETED
FAILED
EXPIRED
REFUNDED
PARTIALLY_REFUNDED
```

Stripe/Satispay, quando usati, devono essere confermati da callback/webhook server-side con idempotenza.

La scadenza di una richiesta caparra può far passare la prenotazione a `EXPIRED` e liberare la capacità secondo policy configurata, con transazione atomica e audit.

Eventuali rimborsi o trattenimenti devono rispettare policy esplicite configurate dal ristorante.

---

# 156. Takeaway

Il takeaway è un canale ordine aggiuntivo con `order_source = TAKEAWAY` o modello equivalente.

Non duplicare la logica di:

- prezzi;
- disponibilità;
- varianti;
- ricette;
- stazioni;
- cucina;
- pagamenti;
- audit.

Riutilizzare gli stessi servizi authoritative del core quando possibile.

Dati specifici takeaway almeno:

```text
pickup_venue_id
pickup_slot_id
pickup_at
customer_name
customer_phone
customer_note_optional
order_source = TAKEAWAY
```

Il numero di ordini accettabili per slot deve essere verificato server-side e protetto da race condition.

Nel KDS il ticket deve mostrare chiaramente:

> TAKEAWAY — ritiro 20:15

Il personale deve poter segnare `READY_FOR_PICKUP`; se la messaggistica è attiva, Plateform può inviare automaticamente “ordine pronto”.

Non implementare automaticamente indirizzo di consegna, delivery fee, rider/fattorini o routing: appartengono a un eventuale modulo delivery futuro separato.

---

# 157. Definition of Done delle nuove funzionalità

Le funzionalità introdotte nelle sezioni 151–156 sono soggette integralmente alla Definition of Done generale.

In particolare non possono essere considerate complete finché non esistono, dove pertinenti:

- schema/migration;
- RLS e scope sede;
- API/RPC/Edge Functions server-authoritative;
- validazione input;
- idempotenza;
- transazioni e protezione concorrenza;
- audit;
- telemetry;
- observability;
- gestione errori/provider failure;
- privacy e retention;
- UX responsive;
- test unit/integration/E2E/security;
- comportamento multi-sede;
- documentazione;
- rollback/migration strategy.

Test di accettazione minimi aggiuntivi:

```text
reminder inviato una sola volta anche con retry
WhatsApp/Telegram/SMS fallisce senza perdere la prenotazione
caparra confermata solo server-side
due utenti non possono ottenere lo stesso ultimo slot di waitlist
due utenti non possono ottenere lo stesso ultimo slot takeaway
food cost ricalcolato dopo variazione costo ingrediente senza alterare snapshot storico
QR colazione non espone menu non autorizzati o dati privati
promozione scaduta scompare automaticamente
takeaway scala disponibilità senza renderla negativa
```

