begin;
create function private.responsible_waiter(p_table uuid) returns uuid language sql stable security definer set search_path='' as $$
  select a.waiter_id from public.tables t join public.table_assignments a
    on a.venue_id=t.venue_id and a.active and ((a.mode='TABLE' and a.table_id=t.id) or (a.mode='ZONE' and a.zone_id=t.zone_id))
    join public.staff_profiles p on p.id=a.waiter_id and p.active and p.role='WAITER'
    where t.id=p_table and t.active and (p.scope='CHAIN' or exists(select 1 from public.staff_venue_assignments s where s.user_id=p.id and s.venue_id=t.venue_id and s.active))
    order by case a.mode when 'TABLE' then 0 else 1 end limit 1
$$;
create function private.owns_customer_account(p_account uuid) returns boolean language sql stable security definer set search_path='' as $$
  select private.installation_active() and exists(select 1 from auth.sessions where id=private.jwt_session_id() and user_id=auth.uid()) and exists(
    select 1 from private.customer_sessions s join public.accounts a on a.id=s.account_id
    join public.venues v on v.id=a.venue_id and v.active and v.operational_status='OPEN'
    where s.auth_user_id=auth.uid() and s.account_id=p_account and s.revoked_at is null and s.expires_at>now()
      and a.status<>'CLOSED' and s.access_epoch=a.access_epoch and s.table_id=a.table_id)
$$;
create function private.can_read_account(p_account uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.accounts a where a.id=p_account and private.has_venue(a.venue_id)
    and (private.is_role(array['ADMIN','CASHIER']::public.user_role[])
      or (private.current_role()='WAITER' and private.responsible_waiter(a.table_id)=private.effective_user_id())))
$$;
create function private.can_read_order(p_order uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.orders o where o.id=p_order and private.can_read_account(o.account_id))
$$;
create function private.can_read_item(p_item uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.order_items i where i.id=p_item and private.can_read_order(i.order_id))
$$;
create function private.can_work_station(p_venue uuid,p_station uuid) returns boolean language sql stable security definer set search_path='' as $$
  select private.has_venue(p_venue) and (private.current_role()='KITCHEN_ADMIN' or
    (private.current_role()='KITCHEN_STAFF' and exists(select 1 from public.station_staff_assignments a where a.venue_id=p_venue and a.station_id=p_station and a.user_id=private.effective_user_id() and a.active)))
$$;
create function private.can_use_register(p_register uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.cash_registers r where r.id=p_register and r.active and private.has_venue(r.venue_id)
    and (private.current_role()='ADMIN' or (private.current_role()='CASHIER' and exists(select 1 from public.cashier_assignments a
      where a.cash_register_id=r.id and a.user_id=private.effective_user_id() and a.active))))
$$;
grant execute on function private.responsible_waiter(uuid),private.can_read_account(uuid),private.can_read_order(uuid),private.can_read_item(uuid),private.can_work_station(uuid,uuid),private.can_use_register(uuid) to authenticated;

grant select on public.restaurant_profile,public.restaurant_settings,public.feature_flags,public.system_limits,public.venues,public.venue_settings,public.staff_profiles to authenticated;
create policy profile_read on public.restaurant_profile for select to authenticated using(private.current_role()='SUPER_ADMIN' or (private.installation_active() and private.current_role() is not null));
create policy settings_read on public.restaurant_settings for select to authenticated using(private.current_role()='SUPER_ADMIN' or (private.installation_active() and private.current_role() is not null));
create policy flags_read on public.feature_flags for select to authenticated using(private.current_role()='SUPER_ADMIN' or (private.installation_active() and private.current_role() is not null));
create policy limits_read on public.system_limits for select to authenticated using(private.current_role()='SUPER_ADMIN');
create policy venue_read on public.venues for select to authenticated using(private.current_role()='SUPER_ADMIN' or private.has_venue(id));
create policy venue_settings_read on public.venue_settings for select to authenticated using(private.has_venue(venue_id));
create policy staff_read on public.staff_profiles for select to authenticated using(
  id=private.effective_user_id() or private.current_role()='SUPER_ADMIN' or
  (private.current_role()='ADMIN' and private.installation_active() and
   (scope='VENUE' and exists(select 1 from public.staff_venue_assignments a where a.user_id=id and a.active and private.has_venue(a.venue_id))
    or exists(select 1 from public.staff_profiles me where me.id=private.effective_user_id() and me.scope='CHAIN')))
);
-- Avoid recursive staff_profiles policy lookup using a security-definer scope helper.
create function private.current_scope() returns public.user_scope language sql stable security definer set search_path='' as $$
 select scope from public.staff_profiles where id=private.effective_user_id()
$$;
grant execute on function private.current_scope() to authenticated;
drop policy staff_read on public.staff_profiles;
create policy staff_read on public.staff_profiles for select to authenticated using(
  id=private.effective_user_id() or private.current_role()='SUPER_ADMIN' or
  (private.current_role()='ADMIN' and private.installation_active() and (private.current_scope()='CHAIN' or
    (scope='VENUE' and exists(select 1 from public.staff_venue_assignments a where a.user_id=staff_profiles.id and a.active and private.has_venue(a.venue_id)))))
);
grant select on public.staff_venue_assignments to authenticated;
create policy assignments_read on public.staff_venue_assignments for select to authenticated using(
  private.current_role()='SUPER_ADMIN' or (private.has_venue(venue_id) and (user_id=private.effective_user_id() or private.current_role()='ADMIN'))
);

do $$ declare t text;
begin
  foreach t in array array['rooms','room_layouts','zones','tables','table_status_definitions','table_merges','table_assignments'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy operational_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.is_role(array[''ADMIN'',''HOST'',''WAITER'',''CASHIER'',''PASS'']::public.user_role[]))',t);
  end loop;
  foreach t in array array['services','service_booking_rules','booking_time_slots','reservation_form_definitions','reservation_form_fields','reservations','reservation_answers'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy host_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.is_role(array[''ADMIN'',''HOST'']::public.user_role[]))',t);
  end loop;
  foreach t in array array['categories','dishes','ingredients','allergens','ingredient_allergens','dish_ingredients','dietary_tags','dish_dietary_tags','variant_groups','variant_options'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy catalog_read on public.%I for select to authenticated using(private.installation_active() and private.is_role(array[''ADMIN'',''WAITER'',''CASHIER'',''KITCHEN_ADMIN'',''KITCHEN_STAFF'',''PASS'']::public.user_role[]))',t);
  end loop;
  foreach t in array array['venue_dish_settings','dish_station_assignments','stations','station_staff_assignments'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy scoped_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.is_role(array[''ADMIN'',''WAITER'',''CASHIER'',''KITCHEN_ADMIN'',''KITCHEN_STAFF'',''PASS'']::public.user_role[]))',t);
  end loop;
  foreach t in array array['cash_registers','cashier_assignments','cash_register_sessions','service_sessions','cash_reconciliations','payments','payment_allocations','tips','refunds','discounts','account_splits'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy finance_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.is_role(array[''ADMIN'',''CASHIER'']::public.user_role[]))',t);
  end loop;
  foreach t in array array['shifts','registered_devices'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy staff_admin_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.current_role()=''ADMIN'')',t);
  end loop;
  foreach t in array array['print_devices','print_jobs'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy print_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.is_role(array[''ADMIN'',''CASHIER'']::public.user_role[]))',t);
  end loop;
  foreach t in array array['sync_conflicts','offline_sync_events'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy conflicts_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.current_role()=''ADMIN'')',t);
  end loop;
  foreach t in array array['audit_log','system_errors','system_metrics','telemetry_events','backup_metadata','restore_jobs','application_releases','database_migrations_metadata'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy technical_read on public.%I for select to authenticated using(private.current_role()=''SUPER_ADMIN'')',t);
  end loop;
end $$;
grant select on public.accounts,public.orders,public.order_steps,public.order_items,public.order_item_removed_ingredients,public.order_item_variants,public.order_change_requests,public.customer_order_requests,public.waiter_calls,public.notifications,public.incidents,public.incident_events to authenticated;
create policy account_read on public.accounts for select to authenticated using(private.can_read_account(id));
create policy order_read on public.orders for select to authenticated using(private.can_read_account(account_id));
create policy step_read on public.order_steps for select to authenticated using(private.can_read_order(order_id));
create policy item_read on public.order_items for select to authenticated using(private.can_read_order(order_id));
create policy removals_read on public.order_item_removed_ingredients for select to authenticated using(private.can_read_item(order_item_id));
create policy variants_read on public.order_item_variants for select to authenticated using(private.can_read_item(order_item_id));
create policy changes_read on public.order_change_requests for select to authenticated using(private.can_read_order(order_id));
create policy requests_read on public.customer_order_requests for select to authenticated using(private.can_read_account(account_id));
create policy calls_read on public.waiter_calls for select to authenticated using(private.has_venue(venue_id) and (private.current_role()='ADMIN' or assigned_waiter_id=private.effective_user_id()));
create policy notifications_read on public.notifications for select to authenticated using(private.has_venue(venue_id) and
  (recipient_user_id=private.effective_user_id() or (recipient_user_id is null and recipient_role=private.current_role())));
create policy incidents_read on public.incidents for select to authenticated using(private.current_role()='SUPER_ADMIN' or (venue_id is not null and private.has_venue(venue_id) and private.current_role()='ADMIN'));
create policy incident_events_read on public.incident_events for select to authenticated using(exists(select 1 from public.incidents i where i.id=incident_id));

create function public.get_public_site() returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('name',p.name,'branding',p.branding,'content',p.public_content,'contact',p.contact,
    'multi_venue',coalesce((select licensed from public.feature_flags where name='MULTI_VENUE'),false),
    'venues',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'slug',v.slug,'address',v.address,'phone',v.phone,
      'email',v.email,'opening_hours',v.opening_hours,'timezone',v.timezone,'currency',v.currency,'locale',v.locale,
      'reservations_enabled',s.reservations_enabled and p.status='ACTIVE' and v.operational_status='OPEN') order by v.name)
      from public.venues v join public.venue_settings s on s.venue_id=v.id where v.active),'[]'::jsonb))
    from public.restaurant_profile p where p.id
$$;
create function public.get_public_menu(p_venue uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'description',d.description,'image_path',d.image_path,
    'beverage',d.beverage,'category_id',c.id,'category_name',c.name,'price_cents',coalesce(s.local_price_cents,d.price_cents),
    'availability',case when s.availability is null then null when s.availability_date=(now() at time zone v.timezone)::date then s.availability else 0 end,
    'ingredients',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',i.name,'removable',di.removable) order by i.name)
       from public.dish_ingredients di join public.ingredients i on i.id=di.ingredient_id where di.dish_id=d.id),'[]'::jsonb),
    'allergens',coalesce((select jsonb_agg(jsonb_build_object('code',a.code,'name',a.name) order by a.code) from public.allergens a where a.id in
       (select ia.allergen_id from public.ingredient_allergens ia join public.dish_ingredients di on di.ingredient_id=ia.ingredient_id where di.dish_id=d.id)),'[]'::jsonb),
    'dietary_tags',coalesce((select jsonb_agg(jsonb_build_object('code',dt.code,'label',dt.label)) from public.dietary_tags dt join public.dish_dietary_tags dd on dd.tag_id=dt.id where dd.dish_id=d.id),'[]'::jsonb),
    'variant_groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'required',g.required,'max_selections',g.max_selections,
       'options',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'label',o.label)) from public.variant_options o where o.group_id=g.id and o.active),'[]'::jsonb)))
       from public.variant_groups g where g.dish_id=d.id and g.active),'[]'::jsonb)) order by c.sort_order,d.sort_order,d.name),'[]'::jsonb)
   from public.dishes d join public.categories c on c.id=d.category_id and c.active
   join public.venues v on v.id=p_venue and v.active
   left join public.venue_dish_settings s on s.venue_id=v.id and s.dish_id=d.id
   where d.active and coalesce(s.enabled,true) and
    (d.schedule_mode='ALWAYS' or (d.schedule_mode='DATE' and d.available_from=(now() at time zone v.timezone)::date)
      or (d.schedule_mode='WEEKDAYS' and extract(isodow from now() at time zone v.timezone)::integer=any(d.weekdays))
      or (d.schedule_mode='RANGE' and (now() at time zone v.timezone)::date between d.available_from and d.available_until))
$$;
grant execute on function public.get_public_site(), public.get_public_menu(uuid) to anon,authenticated;
commit;
