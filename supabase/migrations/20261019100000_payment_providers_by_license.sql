-- Stripe and Satispay enter the first commercial release (owner decision, 2026-10-19).
-- The CORE triggers of 20261008181605 denied them unconditionally; they now follow the
-- installation licences STRIPE and SATISPAY_API, which only a SUPER_ADMIN with step-up can grant
-- (save_feature_license / configure_feature). Without the licence every path still fails closed.
-- Online booking deposits stay denied (no deposit Edge Function exists yet) and the Epson/print
-- guards of 20261008181605 are unchanged.

create or replace function private.payment_method_licensed(p_method text)
returns boolean language sql stable security definer set search_path='' as $$
  select case
    when p_method in ('CASH','CARD_POS') then true
    when p_method='STRIPE' then private.feature_licensed('STRIPE')
    -- Satispay at the counter is offered with the Satispay licence.
    when p_method in ('SATISPAY_API','SATISPAY_POS') then private.feature_licensed('SATISPAY_API')
    else false
  end
$$;
revoke all on function private.payment_method_licensed(text) from public,anon,authenticated;

-- The guards run as their owner: they are fired by service_role and by RPCs alike, and
-- payment_method_licensed stays private to the owner.

-- Licensing: providers may be licensed again; deposits may not.
create or replace function private.core_edition_license_guard()
returns trigger language plpgsql security definer set search_path='' as $core$
begin
  if new.name='BOOKING_DEPOSITS' and new.licensed then
    raise exception 'CORE_PROVIDER_LICENSE_FORBIDDEN';
  end if;
  return new;
end $core$;

create or replace function private.core_edition_payment_guard()
returns trigger language plpgsql security definer set search_path='' as $core$
begin
  if not private.payment_method_licensed(new.method::text) then
    raise exception 'PAYMENT_METHOD_UNLICENSED';
  end if;
  return new;
end $core$;

create or replace function private.core_edition_register_methods_guard()
returns trigger language plpgsql security definer set search_path='' as $core$
begin
  if new.payment_methods is null or exists (
    select 1 from pg_catalog.unnest(new.payment_methods) as m(method)
    where m.method is null or not private.payment_method_licensed(m.method::text)
  ) then
    raise exception 'CORE_REGISTER_PAYMENT_METHODS_FORBIDDEN';
  end if;
  return new;
end $core$;

-- Provider commands only for a licensed provider.
create or replace function private.core_edition_new_provider_operation_guard()
returns trigger language plpgsql security definer set search_path='' as $core$
begin
  if not private.payment_method_licensed(new.method::text) then
    raise exception 'PAYMENT_METHOD_UNLICENSED';
  end if;
  return new;
end $core$;

-- Revoking a licence must not leave registers offering a method that can no longer be used.
create or replace function private.provider_licence_revocation_guard()
returns trigger language plpgsql security definer set search_path='' as $core$
declare methods text[];
begin
  if not (old.licensed and not new.licensed and new.name in ('STRIPE','SATISPAY_API')) then
    return new;
  end if;
  methods := case new.name
    when 'STRIPE' then array['STRIPE']
    else array['SATISPAY_API','SATISPAY_POS'] end;
  if exists (select 1 from public.venue_settings where payment_methods::text[] && methods)
     or exists (select 1 from public.cash_registers where payment_methods::text[] && methods) then
    raise exception 'PROVIDER_STILL_CONFIGURED';
  end if;
  if exists (select 1 from public.provider_operations
             where method::text = any(methods) and state in ('NEW','IN_FLIGHT','WAITING')) then
    raise exception 'PROVIDER_OPERATIONS_PENDING';
  end if;
  return new;
end $core$;
revoke all on function private.provider_licence_revocation_guard() from public,anon,authenticated;
revoke all on function private.core_edition_license_guard() from public,anon,authenticated;
revoke all on function private.core_edition_payment_guard() from public,anon,authenticated;
revoke all on function private.core_edition_register_methods_guard() from public,anon,authenticated;
revoke all on function private.core_edition_new_provider_operation_guard() from public,anon,authenticated;
create trigger provider_licence_revocation before update of licensed on public.feature_flags
for each row execute function private.provider_licence_revocation_guard();
