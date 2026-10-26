-- Frontend clients read through RLS and write only through authorized RPCs.
begin;
revoke insert,update,delete,truncate,references,trigger on all tables in schema public from anon,authenticated;
revoke all on all sequences in schema public from anon,authenticated;
notify pgrst,'reload schema';
commit;
