# Addendum di trasferimento a Claude Code — 17 ottobre 2026

## Natura del documento

Questo file è un **addendum operativo redatto per il trasferimento**, non una modifica silenziosa del Master Prompt.
Il documento autoritativo fornito dall'utente rimane:
`MASTER_PROMPT_PLATEFORM_COMMERCIALE_AGGIORNATO.md` (§§0–157, preservato integralmente).
La roadmap originale è anch'essa inclusa senza omissioni. Non trattare informazioni di test o congetture come nuovi requisiti ufficiali.

## Gerarchia delle fonti

1. Decisioni esplicite più recenti del proprietario, se verificabili.
2. Master Prompt completo consegnato per questo handoff, con tutte le sezioni 0–157.
3. Roadmap Step 0–13, per ordine dei lavori e criteri di accettazione.
4. Decisioni architetturali e documentazione versionata nel repository, quando non contraddicono i requisiti del proprietario.
5. Audit e report con la **data a cui si riferiscono**; i conteggi non sono eternamente validi.
6. Stato del codice e verifiche ripetibili per stabilire ciò che è stato **realmente implementato**, non ciò che è stato richiesto.

## Due contraddizioni da non ignorare

**Routing pubblico e staff.** Le sezioni iniziali del Master Prompt e la tabella della §15 specificano
`https://dominio.it/` e `https://dominio.it/staff`, ma §§47, 109, 132, 134 e parte
della documentazione citano `staff.dominio.it` e cache/PWA su due origini.
Il repository usa due build/Vite app (localmente porte 5173 e 5174). Non riscrivere hosting,
Auth callback, cookie, routing o service worker assumendo una sola delle due interpretazioni.
Documenta la decisione architetturale e conserva entrambe le capacità quando tecnicamente
possibile; se la decisione cambia domini/deploy di un cliente, richiedi scelta esplicita.
Il percorso `/staff` è quello ripetuto nell'elenco pubblico degli URL della §15;
non assume, da solo, la stessa origine nel deployment definitivo.

**Specifica del repository vs file più nuovo.** Il `README.md` di `main` rimanda a
`MASTER_PROMPT_PLATEFORM_COMMERCIALE.md` e documenta §§0–150; il Master Prompt
fornito in questa consegna contiene **§§0–157**, incluse food cost, menu engineering,
menu multipli, messaggistica, caparra e takeaway. Usare la versione qui fornita per la
copertura dei requisiti, senza perdere le integrazioni già realizzate nel codice.

## Decisioni che il codice non deve reinterpretare

- Stack obbligatorio TypeScript vanilla/Vite e Supabase, niente migrazione a React
  o sostituzione con Nhost in assenza di istruzioni aggiornate. L'audit del 10/10
  riportava la migrazione Nhost sospesa; verificarne sempre la validità prima di agire.
- Un database production per cliente/catena; multi-sede solo **interna a quella catena**.
- Funzionalità premium/licenziate devono restare fail-closed quando disabilitate.
  Abilitare un flag non è un sostituto del collaudo funzionale.
- Audit e telemetry separati; audit append-only e niente chiavi/token nei log.
- Core operativo e pagamenti sempre server-authoritative, auditabili e idempotenti.
- Stampe di cortesia / ricevute non fiscali non sono automaticamente documenti fiscali validi.

## Evidenze e limiti

Gli audit del 10/10 e 12/10 sono utili per problemi e accettazione, ma il loro
stato di database, Storage, migrazioni, branch e funzionalità può essere superato.
Il rapporto tecnico della PR #41 del 16/10 riporta 480 migrazioni Development e
482 file nel candidato, con **due migrazioni retrodatate bloccate dal preflight**.
Questo NON prova un merge o una ricostruzione pulita, e non equivale a una
ricertificazione integrale di tutte le release.

Quando un dato non è verificato dal codice o dal servizio attuale, scrivere
`NON VERIFICATO` e specificare la prova necessaria. Non dedurre dai file che un
pagamento, restore o integrazione hardware funzioni davvero.
