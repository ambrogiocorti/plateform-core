
alter table public.ingredients
  add column if not exists version bigint not null default 1;

do $$
begin
  if not exists(
    select 1 from pg_trigger
    where tgrelid='public.ingredients'::regclass
      and tgname='touch_version'
      and not tgisinternal
  ) then
    create trigger touch_version
    before update on public.ingredients
    for each row execute function private.touch_version();
  end if;
end
$$;

create table if not exists private.dish_price_history(
  id uuid primary key default gen_random_uuid(),
  dish_id uuid not null references public.dishes(id),
  venue_id uuid references public.venues(id),
  source text not null check(source in ('BASE','VENUE')),
  old_price_cents bigint,
  new_price_cents bigint,
  changed_by uuid not null,
  changed_at timestamptz not null default clock_timestamp(),
  check(old_price_cents is null or old_price_cents between 0 and 100000000),
  check(new_price_cents is null or new_price_cents between 0 and 100000000),
  check(
    (source='BASE' and venue_id is null and new_price_cents is not null)
    or source='VENUE'
  )
);

create index if not exists dish_price_history_dish_time_idx
  on private.dish_price_history(dish_id,changed_at desc);

create index if not exists dish_price_history_venue_time_idx
  on private.dish_price_history(venue_id,changed_at desc)
  where venue_id is not null;

alter table private.dish_price_history enable row level security;
revoke all on private.dish_price_history from public,anon,authenticated,service_role;

do $$
begin
  if not exists(
    select 1 from pg_trigger
    where tgrelid='private.dish_price_history'::regclass
      and tgname='immutable_record'
      and not tgisinternal
  ) then
    create trigger immutable_record
    before update or delete on private.dish_price_history
    for each row execute function private.immutable_record();
  end if;
  if not exists(
    select 1 from pg_trigger
    where tgrelid='private.dish_price_history'::regclass
      and tgname='immutable_no_truncate'
      and not tgisinternal
  ) then
    create trigger immutable_no_truncate
    before truncate on private.dish_price_history
    for each statement execute function private.immutable_record();
  end if;
end
$$;
