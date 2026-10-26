# P0 — Original migration SQL recovery (12 October 2026)

Source: the **live** Development `supabase_migrations.schema_migrations` catalog; SQL reconstructed as `array_to_string(statements, E'\\n')`. The 480 files in this folder are a **read-only archived copy** of the historical SQL, not replacements or newly authored fixes.

Independent SQL query established **480 unique versions**, **2296575 SQL bytes** and inventory fingerprint `fb1fe8c2d07176b9dfee0a788bc2bf164d8769016ebae829f475b49fc81c3fc1` (SHA-256 over sorted `version:name:SHA256(sql)` lines). The exact Git blob SHA-1 of each of the 480 archived files matches the corresponding remote PostgreSQL-computed blob hash. See `manifest.json` for every path, SHA-256 and byte length.

**Quarantine restrictions:** Do not deploy directly from this archive, run these SQL statements on the current Development project, infer they reconstruct Storage/Auth/Edge Function configuration, or mark P0 go-live as passed.

Remaining: reconcile **347 remote-only**, **12 source hash divergences beyond trailing LF**, **12 trailing LF variants**, and **one local-only** migration; preserve the original 134 Git SQL files and manifest; audit any embedded secrets; attempt clean replay in an isolated disposable database; compare grants, RLS, functions, triggers, cron, Auth/Storage semantics, backed up objects and rollback evidence.

The existing `supabase/migrations` and `supabase/migration-manifest.json` are intentionally untouched. This branch must remain unmerged until source review, security scan and replay checks complete.
