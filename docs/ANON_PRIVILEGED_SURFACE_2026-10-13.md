# Anonymous SECURITY DEFINER surface inventory

Date: 2026-10-13. Development baseline was queried read-only.

11 signatures are executable by `anon` across `public` and `private`. Ten are published read-only menu, site or booking functions. The remaining `private.can_read_signal(realtime_signals)` is the intentional RLS predicate for public realtime signals, grants limited by topic/venue/recipient.

The new PGlite test `tests/database/anon-exec-surface.test.ts` fails closed if replayed migration SQL exposes additional `SECURITY DEFINER` procedures to anonymous users. It tests exact signatures, not merely counts, against reviewed baseline. This is a regression test only: **it does not prove these 11 functions are free of data leaks**, and does not automatically revoke grants on a live installation. Permission review and negative live Auth/RLS tests remain release gates.

The GitHub-hosted CI also sets up Deno 2.9.6 to typecheck all actual Edge Function entrypoints and run the Edge test suite without Supabase secrets. This expands build evidence but does not replace staging HTTPS tests.
