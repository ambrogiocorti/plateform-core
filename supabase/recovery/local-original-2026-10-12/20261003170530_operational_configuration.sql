begin;
create function public.save_financial_settings(p_venue uuid,p_version bigint,p_methods public.payment_method[],p_discount text,p_complimentary text,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;settings public.venue_settings;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('financial_settings',p_key,jsonb_build_object('venue',p_venue,'version',p_version,'methods',p_methods,'discount',p_discount,'complimentary',p_complimentary));
  if result is not null then return result;end if;
  select * into settings from public.venue_settings where venue_id=p_venue for update;
  if settings.venue_id is null then raise exception 'NOT_FOUND';end if;
  if settings.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if p_methods is null or cardinality(p_methods) not between 1 and 5 or array_position(p_methods,null) is not null
    or p_discount is null or p_discount not in ('DISABLED','ADMIN_APPROVAL_REQUIRED','CASHIER_AUTONOMOUS')
    or p_complimentary is null or p_complimentary not in ('DISABLED','ADMIN_APPROVAL_REQUIRED','CASHIER_AUTONOMOUS') then raise exception 'INVALID_SETTINGS';end if;
  if ('STRIPE'=any(p_methods) and not exists(select 1 from public.feature_flags where name='STRIPE' and licensed))
    or ('SATISPAY_API'=any(p_methods) and not exists(select 1 from public.feature_flags where name='SATISPAY_API' and licensed)) then raise exception 'FEATURE_NOT_LICENSED';end if;
  update public.venue_settings set payment_methods=p_methods,discount_policy=p_discount,complimentary_policy=p_complimentary where venue_id=p_venue;
  return private.idempotency_finish('financial_settings',p_key,jsonb_build_object('id',p_venue));
end $$;
grant execute on function public.save_financial_settings(uuid,bigint,public.payment_method[],text,text,uuid) to authenticated;

create function public.save_register_finance(p_register uuid,p_version bigint,p_methods public.payment_method[],p_printer uuid,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare register public.cash_registers;result jsonb;enabled public.payment_method[];
begin
  select * into register from public.cash_registers where id=p_register for update;
  if register.id is null then raise exception 'NOT_FOUND';end if;
  perform private.authorize(register.venue_id,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('register_finance',p_key,jsonb_build_object('register',p_register,'version',p_version,'methods',p_methods,'printer',p_printer));
  if result is not null then return result;end if;
  if register.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  select payment_methods into enabled from public.venue_settings where venue_id=register.venue_id;
  if p_methods is null or cardinality(p_methods) not between 1 and 5 or array_position(p_methods,null) is not null or not p_methods<@enabled then raise exception 'PAYMENT_METHOD_UNAVAILABLE';end if;
  if p_printer is not null and not exists(select 1 from public.print_devices where id=p_printer and venue_id=register.venue_id and active) then raise exception 'INVALID_PRINT_DEVICE';end if;
  update public.cash_registers set payment_methods=p_methods,printer_id=p_printer where id=register.id;
  return private.idempotency_finish('register_finance',p_key,jsonb_build_object('id',register.id));
end $$;
grant execute on function public.save_register_finance(uuid,bigint,public.payment_method[],uuid,uuid) to authenticated;

create function public.configure_table_label(p_venue uuid,p_status public.table_status,p_label text,p_color text,p_icon text,p_order integer,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ref uuid;result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('table_label',p_key,jsonb_build_object('venue',p_venue,'status',p_status,'label',p_label,'color',p_color,'icon',p_icon,'order',p_order));
  if result is not null then return result;end if;
  if p_status is null or p_label is null or length(trim(p_label)) not between 1 and 80 or p_color is null or p_color !~ '^#[0-9a-fA-F]{6}$'
    or p_order is null or p_order not between 0 and 100 or length(coalesce(p_icon,''))>30 then raise exception 'INVALID_SETTINGS';end if;
  insert into public.table_status_definitions(venue_id,technical_status,label,color,icon,sort_order) values(p_venue,p_status,trim(p_label),p_color,p_icon,p_order)
    on conflict(venue_id,technical_status) do update set label=excluded.label,color=excluded.color,icon=excluded.icon,sort_order=excluded.sort_order returning id into ref;
  return private.idempotency_finish('table_label',p_key,jsonb_build_object('id',ref));
end $$;
grant execute on function public.configure_table_label(uuid,public.table_status,text,text,text,integer,uuid) to authenticated;
commit;
