
drop trigger if exists audit_no_truncate on public.audit_log_default;
create trigger audit_no_truncate
before truncate on public.audit_log_default
for each statement
execute function private.immutable_record();

revoke update,delete,truncate,references,trigger
on public.audit_log
from service_role;

revoke update,delete,truncate,references,trigger
on public.audit_log_default
from service_role;
