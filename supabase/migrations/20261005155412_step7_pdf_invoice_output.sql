begin;

insert into public.print_devices(
  venue_id,
  name,
  driver,
  endpoint,
  active,
  allowed_roles,
  configuration
)
select
  v.id,
  'PDF / Browser A4',
  'BROWSER',
  null,
  true,
  array['ADMIN','CASHIER','WAITER']::public.user_role[],
  '{"output":"PDF","paper":"A4","system_managed":true}'::jsonb
from public.venues v
where not exists(
  select 1
  from public.print_devices d
  where d.venue_id=v.id
    and d.configuration->>'output'='PDF'
);

create or replace function private.ensure_pdf_print_device()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if not exists(
    select 1
    from public.print_devices d
    where d.venue_id=new.id
      and d.configuration->>'output'='PDF'
  ) then
    insert into public.print_devices(
      venue_id,
      name,
      driver,
      endpoint,
      active,
      allowed_roles,
      configuration
    )
    values(
      new.id,
      'PDF / Browser A4',
      'BROWSER',
      null,
      true,
      array['ADMIN','CASHIER','WAITER']::public.user_role[],
      '{"output":"PDF","paper":"A4","system_managed":true}'::jsonb
    );
  end if;
  return new;
end
$function$;

drop trigger if exists ensure_pdf_print_device on public.venues;
create trigger ensure_pdf_print_device
after insert on public.venues
for each row execute function private.ensure_pdf_print_device();

commit;