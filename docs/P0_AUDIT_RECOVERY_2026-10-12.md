# P0-01 — Audit capture recovery (2026-10-12)

Status: **partial verification; not a release gate PASS**.

Target: development Supabase project `abdxvlykasqmknexxhjo` only.

## Applied change

A managed migration `20261012075338_restore_dev_audit_capture_keep_immutability` was applied to the development project. It checked that `audit_immutable` and `audit_no_truncate` were enabled on `public.audit_log` before executing:

```sql
ALTER TABLE public.audit_log DISABLE TRIGGER plateform_dev_pause_audit;
```

Post-change catalog verification showed the pause trigger disabled on the parent and existing child partitions (November 2026, December 2026, January 2027, February 2027, and default). The immutable-row trigger remains enabled on the parent and those child partitions; the truncate-protection trigger remains enabled where installed.

A transient `DO` block tested an INSERT into `public.audit_log`, verified visibility during the same transaction, then deliberately rolled back the insert using a PL/pgSQL exception subtransaction. The SQL completed without an error. This is an isolated SQL smoke test, **not** evidence that real application commands generate expected audit events.

## Not yet proven

- Real authenticated staff actions produce the expected immutable audit record.
- Forbidden UPDATE, DELETE, TRUNCATE are rejected under representative roles.
- New partition creation inherits the intended guard state.
- Archive delivery, recovery verification, retention governance and alerting are functional.
- Production environments or release gates are certified.

## Migration history caveat

This migration exists in the managed remote history, **but the full remote SQL source inventory remains unreconciled** (479 before this change, 480 after). Do not assume the local repository's `supabase/migration-manifest.json` is canonical or append a single file while its inventory is inconsistent.

Required next operation: export the entire authoritative remote migration history (version/name/exact statements), compare against local files and SHA-256 manifest, preserve displaced content, reconcile non-destructively, then replay on an isolated clean project. Never invent migration history rows.

## Safety

No user, venue, order, or payment data was intentionally modified by this recovery. Do not enable advanced feature licenses or set release gates PASS based on this change.
