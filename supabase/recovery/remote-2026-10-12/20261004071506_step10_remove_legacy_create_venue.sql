begin;

revoke all on function public.create_venue(text,text,text,text,text,text)
from public,anon,authenticated,service_role;

drop function public.create_venue(text,text,text,text,text,text);

delete from private.api_permission_manifest
where function_identity='public.create_venue(text,text,text,text,text,text)';

commit;