-- Security verification 2026-10-18 (local PostgreSQL 16 replay, see
-- docs/SECURITY_VERIFICATION_RLS_2026-10-18.md). Additive and non-destructive:
-- grants, revokes and BEFORE triggers only; no existing row is read for
-- rewriting, deleted or modified.
begin;

-- 1. RLS predicates referenced by policies must be executable by the role the
-- policy applies to. The menu policies (menus, menu_venues, menu_categories,
-- menu_dishes call can_read_menu; menu_promotions calls
-- can_manage_shared_catalog) referenced revoked functions, so every direct
-- SELECT by authenticated failed with 42501 instead of being filtered.
-- can_read_menu is a row predicate like can_read_account/can_read_order and
-- becomes executable. can_manage_shared_catalog stays a non-executable
-- internal helper (tests/database/foundation.test.ts); the promotion policy
-- reaches it through a dedicated row predicate instead.
grant execute on function private.can_read_menu(uuid) to authenticated;

create or replace function private.can_read_menu_promotion(p_venue uuid)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select private.installation_active()
    and private.is_role(array['ADMIN']::public.user_role[])
    and (
      (p_venue is null and private.can_manage_shared_catalog())
      or (p_venue is not null and private.has_venue(p_venue))
    )
$$;
revoke all on function private.can_read_menu_promotion(uuid) from public,anon,service_role;
grant execute on function private.can_read_menu_promotion(uuid) to authenticated;

alter policy menu_promotions_admin_read on public.menu_promotions
  using (private.can_read_menu_promotion(venue_id));

-- 2. Internal helpers must not be callable by API roles unless a policy or a
-- SECURITY INVOKER routine needs them. responsible_waiter(table) returned the
-- assigned waiter's user id for a table of any venue to any authenticated
-- user, including customers (cross-venue staff identifier oracle).
revoke all on function private.responsible_waiter(uuid) from public,anon,authenticated;

-- 3. Venue consistency of single-column references between venue-scoped
-- tables. Other venue-scoped references already use composite
-- (venue_id, id) foreign keys; these 18 did not, so a row of venue A could
-- point at a parent of venue B. Enforced for new and changed rows only:
-- existing rows are not touched (the report lists a read-only check query).
create or replace function private.enforce_reference_venue()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_new jsonb:=to_jsonb(new);
  v_old jsonb;
  v_ref uuid;
  v_parent_venue uuid;
begin
  v_ref:=(v_new->>tg_argv[0])::uuid;
  if v_ref is null then return new; end if;
  if tg_op='UPDATE' then
    v_old:=to_jsonb(old);
    if v_old->tg_argv[0] is not distinct from v_new->tg_argv[0]
       and v_old->'venue_id' is not distinct from v_new->'venue_id' then
      return new;
    end if;
  end if;
  execute format('select venue_id from public.%I where id=$1',tg_argv[1])
    into v_parent_venue using v_ref;
  if v_parent_venue is not null
     and (v_new->>'venue_id')::uuid is distinct from v_parent_venue then
    raise exception 'CROSS_VENUE_REFERENCE'
      using errcode='23514',detail=format('%s.%s',tg_table_name,tg_argv[0]);
  end if;
  return new;
end
$$;
revoke all on function private.enforce_reference_venue() from public,anon,authenticated,service_role;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('discount_requests','discount_id','discounts'),
      ('discount_unit_allocations','discount_id','discounts'),
      ('equal_split_plans','id','account_splits'),
      ('message_jobs','reminder_rule_id','reservation_reminder_rules'),
      ('message_jobs','reservation_id','reservations'),
      ('offline_sync_events','device_id','registered_devices'),
      ('provider_operations','payment_id','payments'),
      ('provider_operations','refund_id','refunds'),
      ('reservation_deposits','reservation_id','reservations'),
      ('step_deliveries','step_id','order_steps'),
      ('step_delivery_history','step_id','order_steps'),
      ('takeaway_orders','account_id','accounts'),
      ('takeaway_orders','order_id','orders'),
      ('takeaway_orders','pickup_slot_id','takeaway_pickup_slots'),
      ('takeaway_requests','order_id','orders'),
      ('takeaway_requests','pickup_slot_id','takeaway_pickup_slots'),
      ('waitlist_entries','converted_reservation_id','reservations'),
      ('waitlist_entries','service_id','services')
    ) x(child,col,parent)
  loop
    -- Fail closed if the reference no longer matches the reviewed schema.
    if not exists(
      select 1 from pg_constraint c
      where c.contype='f'
        and c.conrelid=format('public.%I',r.child)::regclass
        and c.confrelid=format('public.%I',r.parent)::regclass
        and c.conkey=array[(select attnum from pg_attribute
          where attrelid=format('public.%I',r.child)::regclass and attname=r.col)]
        and c.confkey=array[(select attnum from pg_attribute
          where attrelid=format('public.%I',r.parent)::regclass and attname='id')]
    ) then
      raise exception 'VENUE_REFERENCE_SCHEMA_CHANGED: %.%',r.child,r.col;
    end if;
    execute format(
      'create trigger %I before insert or update of %I,venue_id on public.%I '
      'for each row execute function private.enforce_reference_venue(%L,%L)',
      left('venue_reference_'||r.col,63),r.col,r.child,r.col,r.parent);
  end loop;
end
$$;

commit;
