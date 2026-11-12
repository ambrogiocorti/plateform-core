
begin;
revoke select on public.layout_revisions from anon;
revoke select on public.table_join_rules from anon;
commit;
