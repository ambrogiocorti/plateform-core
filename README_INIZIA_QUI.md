# Plateform → Claude Code | Pacchetto di trasferimento
**Preparato il 17 ottobre 2026.**

Questo ZIP contiene tutte le **fonti originali ricevute** più gli strumenti
di handoff per continuare sul codice **esistente**. Non contiene il repository
completo né credenziali, dump del database o segreti.

## Contenuto

- `CLAUDE.md` — istruzioni persistenti per Claude Code. Va nella **root del repository**.
- `PROMPT_DA_INCOLLARE_IN_CLAUDE_CODE.md` — primo messaggio pronto all'uso.
- `docs/plateform-handoff/MASTER_PROMPT_PLATEFORM_COMMERCIALE_AGGIORNATO.md` —
  **master ufficiale completo dell'utente, §§0–157**, mantenuto esattamente.
- `docs/plateform-handoff/ROADMAP_ORIGINALE.txt` — roadmap originale identica.
- `docs/plateform-handoff/ROADMAP_IMPLEMENTAZIONE_STEP_0_13.md` — copia
  identica in estensione Markdown, comoda per Claude.
- `docs/plateform-handoff/ADDENDUM_E_CONFLITTI_2026-10-17.md` —
  note sul passaggio e incoerenze presenti nel Master (senza alterarlo).
- `docs/plateform-handoff/STATO_VERIFICATO_E_PRIORITA_2026-10-17.md` —
  confronto aggiornato con `main` e PR #41 e blocchi prioritari.
- `docs/plateform-handoff/AUDIT_GO_LIVE_2026-10-10.md` — audit storico completo.
- `docs/plateform-handoff/REPORT_COMPLETO_2026-10-12.md` — rapporto storico completo.
- `assets/plateform/logo-plateform-originale.png` — logo originale fornito.
- `SHA256SUMS.txt` — impronte dei file del pacchetto.

## Come usarlo (Windows / Claude Code)

1. Apri/clona il repository Plateform sul computer:
   `https://github.com/ambrogiocorti/plateform-core`
2. Estrai lo ZIP in una cartella temporanea.
3. **Copia il CONTENUTO dello ZIP dentro la root di `plateform-core`**
   (devono risultare `plateform-core/CLAUDE.md`,
   `plateform-core/docs/plateform-handoff/...` e
   `plateform-core/assets/plateform/...`).
4. Da terminale, nella cartella del repository, controlla `git status`
   e apri `claude` (dopo aver installato e autenticato Claude Code).
5. Incolla il contenuto di `PROMPT_DA_INCOLLARE_IN_CLAUDE_CODE.md`.
6. Prima di committare, verifica il diff: evita dati personali,
   credenziali e modifiche ai file non correlati. Non sovrascrivere
   la storia delle migration.

Non serve incollare a mano tutte le 5.700 righe del Master Prompt:
Claude Code può leggerle dal file nel filesystem del repository.
Se serve un'unica fonte autoritativa, **il Master qui allegato resta esatto**;
l'addendum va letto separatamente, non è una revisione arbitraria del testo.

## Situazione da non confondere

Il `main` visto il 17/10 puntava al commit `a36da143` del 12/10.
La PR #41 aggiornata al 16/10 è ancora draft e non era stata integrata
nel branch principale. Il report 12/10 e le statistiche database storiche
non descrivono automaticamente lo stato corrente.

**Esito ultimo report sviluppo:** NO-GO per produzione/vendita.

## Sicurezza

Lo ZIP non include file `.env`, chiavi, password né un dump dei dati reali.
Le integrazioni devono essere configurate in Claude Code con accessi
appropriati, per ambiente, e i segreti non vanno committati.
