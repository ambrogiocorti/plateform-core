# Plateform — completamento in due macro-step (2026-10-13)

## Regola di esecuzione
I due macro-step raggruppano i 14 step originari (0–13), ma NON riducono il perimetro dei requisiti del Master Prompt. Una funzione resta IN PROGRESS fino a prova UI + DB + RLS + API + concorrenza + audit + test pertinente. Nessun gate viene impostato PASS senza evidenza sullo stesso commit.

## Baseline verificata in sola lettura il 13/10/2026
- Progetto Supabase development: `abdxvlykasqmknexxhjo`
- Dimensione DB: 63.993.523 byte
- Migrazioni remote: 480
- Eventi audit: 21
- Righe `public.backup_metadata`: 0
- Trigger `plateform_dev_pause_audit`: sei occorrenze, tutte `tgenabled='D'` (disabilitate)
- Registro storico Git `docs/ROADMAP_STATUS.json` aggiornato all'8/10: step 0–6 DONE/COMPLETE, step 7–12 non certificati, step 13 non completato.
- **Non eseguiti in questa baseline:** operazioni di servizio, test browser, restore, pagamento reale, prova stampante o certificazione go-live.

## Macro-step A — Stabilizzazione operativa e base certificabile
Comprende consolidamento step 0–7, parte di 11–12 e difetti critici precedenti.
1. Riconciliare versione, nome e SHA-256 di tutte le migrazioni remoto/Git; nessuna falsa migration history.
2. Testare audit append-only e trigger su tabella parent/partizioni; revoca accessi impropri e controllo SECURITY DEFINER.
3. Configurare copia di backup indipendente DB/Auth/Storage e restore su progetto disposable; registrare hash, RPO/RTO e prova.
4. Creare staging separato, CI per commit, build e test con Node >=24.13.0.
5. Eseguire onboarding nuovo ristorante e flusso E2E menu→tavolo→conto→ordine→cucina→Pass→cassa→pagamento→quadratura, usando utenti veri su almeno due dispositivi.
6. Eseguire test negativi cross-role, cross-venue, idempotenza, doppio pagamento, ultima porzione, offline non autorizzato, timeout e websocket reconnect.
7. Validare sito pubblico/booking, dashboard staff, accessibilità ed error UX su HTTPS.
**Gate A:** tutti i P0 risolti e flusso core ripetibile con evidenze versionate; non dichiarare COMPLETE in loro assenza.

## Macro-step B — Moduli avanzati, hardening e rilascio
Comprende completamento step 7–13 e requisiti delle release avanzate.
1. PWA/offline autorizzato, coda, sync, revoca e Conflict Center su device reali.
2. Notifiche e stampa Epson/ePOS con hardware, resilienza e outcome unknown.
3. Multi-sede isolata, feature flag/server-side, sala avanzata, analytics, dispositivi.
4. Pagamenti provider sandbox HTTPS, webhook/refund/idempotenza e successivo rollout autorizzato.
5. Food cost/ricette, menu multipli e QR, promozioni, reminders/messaging, caparre, waitlist e takeaway: per ognuno matrice requisito→UI→DB→RLS→workflow→test.
6. Continuità, incident response, GDPR/retention, documenti fiscali correttamente qualificati, SEO e WCAG.
7. Hardening, chaos, performance, CI/CD, staging→production, tre review pulite sullo stesso digest, release dossier e accettazione pilot.
**Gate B:** tutti i gate pertinenti all'edizione completa PASS per prove reali, backup/restore corrente, produzione isolata e approvazione al rilascio.

## Registro operativo
| Voce | Stato | Evidenza / blocco |
| --- | --- | --- |
| Rilettura baseline remota | DONE | Query read-only 13/10/2026 |
| Branch di lavoro | DONE | `plateform/two-phase-completion-20261013`, commit sorgenti `6654118c76bc554e0de8ab53e2ce7f28126f7377` |
| Coerenza migrazioni (sorgenti) | BYTE-VERIFIED | 480/480 versioni, nomi e blob SHA-1 Git esattamente corrispondenti al SQL remoto; ripristino su nuova installazione ancora PENDING |
| Audit trigger di sospensione | VERIFIED DISABLED | Verificare test append-only e altre policy |
| Backup recuperabile | BLOCKED | 0 record nel catalogo corrente; non implica assenza assoluta di oggetti |
| Test flusso operativo | PENDING | Mancano E2E sulla release candidata |
| Macro-step A | IN PROGRESS | Non certificato |
| Macro-step B | TODO | Dipende da gate A |
| Go-live | NO-GO | Non attestato |

## Regole di sicurezza
Nessuna eliminazione di dati/oggetti, modifica production, attivazione di pagamenti o disattivazione protezioni senza verifica delle dipendenze e rollback. Non dichiarare riuscito un test mai eseguito.
## Aggiornamento tecnico verificato — 13/10/2026
La riconciliazione del codice SQL storico è stata realizzata sul branch: 347 file mancanti recuperati, 24 divergenze sostituite con SQL applicato, 1 migrazione non applicata inizialmente isolata e poi eliminata dal branch dopo verifica che fosse un duplicato byte-identico di una migrazione già applicata. Il confronto **byte-per-byte** ha confrontato gli SHA-1 Git blob di tutti i 480 SQL in Git con gli SHA-1 calcolati sul testo SQL storico in PostgreSQL usando il prefisso binario Git `blob <size>\\0`: **git_only=0, remote_only=0, name_mismatches=0, byte_mismatches=0**. Evidenza completa: `docs/MIGRATION_RECONCILIATION_2026-10-13.md`.

Il recovery delle migrazioni sorgenti **non** chiude il gate di ricostruzione su staging né quello backup/restore. Non cambiare `commercial_release_ready`.

### Risoluzione migrazione local-only
Verificato il contenuto della versione locale `20261012120000` rispetto alla migrazione già applicata `20261011221212`: 4450 caratteri identici (byte-for-byte). Il duplicato locale è stato rimosso dalla coda pending su questo branch; non è stato eseguito SQL, né falsificato lo storico remoto.


## Progress report verificato — stessa giornata, candidate 481
- **P0 migrazioni:** recuperate tutte le 480 remote storiche senza modificarne i byte; aggiunta una nuova migrazione *candidata* per 7 tabelle private di continuità, collocata prima del primo riferimento storico. Manifest locale a **481**; remoto Development a **480**. Installazione pulita ancora da eseguire in staging isolato.
- **P0 preflight restore:** i due worker interrompono --check e --once con BLOCKED se la destinazione contiene tabelle, funzioni applicative, utenti Auth o oggetti Storage; il blocco avviene prima di acquisire job, senza toccare i dati di destinazione.
- **CI senza runner:** l'attuale workflow GitHub full/Playwright self-hosted è queued/pending. Come controllo intermedio, il processo Vercel preview esegue automaticamente audit npm, verifica hash SQL, bootstrap schema, preflight restore, typecheck e build pubblico/staff.
- **Dipendenze:** vulnerabilità HIGH `source-map-js@1.2.1` (CVE-2026-93749) corretta con aggiornamento mirato a `1.2.2` e integrità SHA-512 nel lockfile. Build Vercel `69058246bee9` completata con **0 vulnerabilità** e controlli statici PASS. Le future HIGH/CRITICAL bloccano il processo di build.
- **Restano BLOCCANTI:** backup/restore DB+Auth+Storage indipendente corrente; staging disposable; esecuzione completa E2E real-time multi-ruolo su dispositivi; test provider/stampa/offline; audit 3/3; sicurezza e legalità commerciale. Il database di restore-test già esistente contiene dati reali di prova e non deve essere azzerato automaticamente.

**Verdetto:** Macro-step A IN PROGRESS; Macro-step B NOT CERTIFIED; COMMERCIAL RELEASE NO-GO. Non confondere i test di compilazione con i collaudi reali.
