-- ADR-0001: cloud ingest of the venue hub change log.
-- The venue hub is the single write authority for service operations of its
-- venue. When Internet returns it sends its change log here. Each change was
-- already validated on the hub by the same RPCs and policies, so business
-- triggers are not re-executed: rows are applied as data, in sequence order,
-- exactly once, under these guards:
--   * the hub authenticates with a secret whose SHA-256 is stored here;
--   * only the service tables listed in private.hub_ingest_tables are accepted,
--     and every row (new and replaced) must belong to the hub's venue;
--   * every foreign key of an applied row is re-checked, and a referenced row
--     that has a venue must be in the same venue (replica mode skips FKs);
--   * a hub sending as an older generation is refused (fencing); a newer one
--     needs an explicit promotion by an administrator, which rotates the secret;
--   * anything not accepted is kept in a quarantine table, never dropped.
-- Deletions are quarantined: no LAN operation deletes service rows today.
begin;

create table private.venue_hubs (
  hub_id text primary key check (hub_id ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  venue_id uuid not null references public.venues(id),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  generation integer not null default 1 check (generation >= 1),
  applied_seq bigint not null default 0 check (applied_seq >= 0),
  last_ingest_at timestamptz,
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table private.venue_hub_quarantine (
  id bigint generated always as identity primary key,
  hub_id text not null references private.venue_hubs(hub_id),
  seq bigint not null,
  generation integer not null,
  table_name text not null,
  op text not null,
  reason text not null,
  change jsonb not null,
  received_at timestamptz not null default now(),
  unique (hub_id, seq)
);

revoke all on table private.venue_hubs, private.venue_hub_quarantine
  from public, anon, authenticated;
alter table private.venue_hubs enable row level security;
alter table private.venue_hub_quarantine enable row level security;

create function private.hub_ingest_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'public.accounts', 'public.orders', 'public.order_steps', 'public.order_items',
    'public.step_deliveries', 'public.payments', 'public.payment_unit_allocations',
    'public.billing_units', 'public.cash_journal', 'public.cash_register_sessions',
    'public.service_sessions', 'public.notifications', 'public.venue_dish_settings',
    'public.tables'
  ]::text[]
$$;
revoke all on function private.hub_ingest_tables() from public, anon, authenticated;

-- Checks one applied row: every non-null foreign key resolves, and a referenced
-- row that carries venue_id belongs to p_venue. Returns the failure reason.
create function private.hub_row_reference_error(p_table regclass, p_row jsonb, p_venue uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  fk record;
  conditions text;
  ok boolean;
begin
  for fk in
    select c.conname, c.confrelid::regclass as target,
      array_agg(a.attname order by k.ord) as cols,
      array_agg(r.attname order by k.ord) as ref_cols,
      exists (
        select 1 from pg_attribute v
        where v.attrelid = c.confrelid and v.attname = 'venue_id' and not v.attisdropped
      ) as target_has_venue
    from pg_constraint c
    cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(col, ref, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.col
    join pg_attribute r on r.attrelid = c.confrelid and r.attnum = k.ref
    where c.conrelid = p_table and c.contype = 'f'
    group by c.conname, c.confrelid
  loop
    -- MATCH SIMPLE: a key with a null column is not checked.
    continue when exists (select 1 from unnest(fk.cols) col where p_row ->> col is null);
    select string_agg(format('%I::text = %L', fk.ref_cols[i], p_row ->> fk.cols[i]), ' and ')
      into conditions
    from generate_subscripts(fk.cols, 1) i;
    if fk.target_has_venue then
      conditions := conditions || format(' and venue_id = %L::uuid', p_venue);
    end if;
    execute format('select exists (select 1 from %s where %s)', fk.target, conditions) into ok;
    if not ok then
      return 'REFERENCE_OUTSIDE_VENUE:' || fk.conname;
    end if;
  end loop;
  return null;
end
$$;
revoke all on function private.hub_row_reference_error(regclass, jsonb, uuid)
  from public, anon, authenticated;

create function public.ingest_venue_hub_batch(
  p_hub text,
  p_token_sha256 text,
  p_generation integer,
  p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  hub private.venue_hubs;
  change jsonb;
  v_table text;
  rel regclass;
  v_op text;
  v_seq bigint;
  v_row jsonb;
  pk_cols text[];
  cols text[];
  has_identity boolean;
  existing_venue uuid;
  v_reason text;
  v_applied integer := 0;
  v_quarantined integer := 0;
  v_top bigint;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 500 then
    raise exception 'INVALID_PAYLOAD';
  end if;
  select * into hub from private.venue_hubs where hub_id = p_hub for update;
  if hub.hub_id is null or hub.token_sha256 is distinct from p_token_sha256 then
    raise exception 'UNAUTHORIZED';
  end if;
  if hub.revoked_at is not null then raise exception 'HUB_REVOKED'; end if;
  if p_generation < hub.generation then raise exception 'HUB_GENERATION_FENCED'; end if;
  if p_generation > hub.generation then raise exception 'HUB_GENERATION_NOT_PROMOTED'; end if;

  v_top := hub.applied_seq;
  -- Business triggers already ran on the hub; their resulting rows are data here.
  set local session_replication_role = replica;

  for change in
    select value from jsonb_array_elements(p_changes) order by (value ->> 'seq')::bigint
  loop
    v_seq := (change ->> 'seq')::bigint;
    -- Changes written under an earlier generation of the same data directory are
    -- still delivered by the promoted hub; a change cannot claim a later one.
    if v_seq is null or v_seq < 1 or coalesce((change ->> 'generation')::integer, 0) not between 1 and p_generation then
      raise exception 'INVALID_PAYLOAD';
    end if;
    continue when v_seq <= hub.applied_seq;
    v_top := greatest(v_top, v_seq);
    v_table := change ->> 'table_name';
    v_op := change ->> 'op';
    v_row := change -> 'row_data';
    v_reason := null;

    if v_table is null or not (v_table = any(private.hub_ingest_tables())) then
      v_reason := 'TABLE_NOT_REPLICATED';
    elsif v_op = 'DELETE' then
      v_reason := 'DELETE_NOT_REPLICATED';
    elsif v_op not in ('INSERT', 'UPDATE') or jsonb_typeof(v_row) <> 'object' then
      v_reason := 'INVALID_CHANGE';
    elsif v_row ->> 'venue_id' is distinct from hub.venue_id::text then
      v_reason := 'ROW_OUTSIDE_VENUE';
    end if;

    if v_reason is null then
      rel := v_table::regclass;
      select array_agg(a.attname order by a.attnum) into pk_cols
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = rel and i.indisprimary;
      select array_agg(attname order by attnum), bool_or(attidentity = 'a')
        into cols, has_identity
      from pg_attribute
      where attrelid = rel and attnum > 0 and not attisdropped and attgenerated = '';
      if exists (select 1 from unnest(pk_cols) c where v_row ->> c is null) then
        v_reason := 'INVALID_CHANGE';
      else
        -- The row being replaced must already belong to the same venue.
        execute format(
          'select venue_id from %s where %s',
          rel,
          (select string_agg(format('%I::text = %L', c, v_row ->> c), ' and ') from unnest(pk_cols) c)
        ) into existing_venue;
        if existing_venue is not null and existing_venue <> hub.venue_id then
          v_reason := 'ROW_OUTSIDE_VENUE';
        end if;
      end if;
    end if;

    if v_reason is null then
      begin
      execute format(
        'insert into %1$s (%2$s)%3$s select %2$s from jsonb_populate_record(null::%1$s, $1)
         on conflict (%4$s) do update set %5$s',
        rel,
        (select string_agg(format('%I', c), ',') from unnest(cols) c),
        case when has_identity then ' overriding system value' else '' end,
        (select string_agg(format('%I', c), ',') from unnest(pk_cols) c),
        coalesce(
          (select string_agg(format('%1$I = excluded.%1$I', c), ',')
           from unnest(cols) c where not (c = any(pk_cols))),
          format('%1$I = excluded.%1$I', pk_cols[1])
        )
      ) using v_row;
      v_reason := private.hub_row_reference_error(rel, v_row, hub.venue_id);
      if v_reason is not null then
        raise exception using errcode = 'P0001', message = 'HUB_REFERENCE_REJECTED', detail = v_reason;
      end if;
      exception
        -- Undo only this row (subtransaction) and keep it in quarantine.
        when raise_exception or integrity_constraint_violation or data_exception then
          v_reason := coalesce(v_reason, 'ROW_REJECTED:' || sqlstate);
      end;
    end if;
    if v_reason is null then
      v_applied := v_applied + 1;
    else
      insert into private.venue_hub_quarantine(hub_id, seq, generation, table_name, op, reason, change)
      values (hub.hub_id, v_seq, p_generation, coalesce(v_table, ''), coalesce(v_op, ''), v_reason, change)
      on conflict (hub_id, seq) do nothing;
      v_quarantined := v_quarantined + 1;
    end if;
  end loop;

  set local session_replication_role = origin;
  update private.venue_hubs
  set applied_seq = v_top, last_ingest_at = now()
  where hub_id = hub.hub_id;
  if v_applied + v_quarantined > 0 then
    perform private.audit(
      'VENUE_HUB_BATCH_INGESTED', 'venue_hubs', null, hub.venue_id, null,
      jsonb_build_object('hub_id', hub.hub_id, 'generation', p_generation, 'applied', v_applied,
        'quarantined', v_quarantined, 'applied_seq', v_top)
    );
  end if;
  return jsonb_build_object('applied', v_applied, 'quarantined', v_quarantined, 'applied_seq', v_top);
end
$$;
revoke all on function public.ingest_venue_hub_batch(text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_venue_hub_batch(text, text, integer, jsonb) to service_role;

-- Registration and promotion by a venue administrator. The secret is returned
-- once and stored only as SHA-256; promotion rotates it and fences the old hub.
create function private.issue_venue_hub_secret()
returns text
language sql
volatile
set search_path = ''
as $$
  select translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_')
$$;
revoke all on function private.issue_venue_hub_secret() from public, anon, authenticated;

create function public.register_venue_hub(p_venue uuid, p_hub text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text := private.issue_venue_hub_secret();
begin
  perform private.authorize(p_venue, array['ADMIN']::public.user_role[]);
  if p_hub is null or p_hub !~ '^[a-z0-9][a-z0-9-]{2,62}$' then raise exception 'INVALID_HUB'; end if;
  if exists (select 1 from private.venue_hubs where hub_id = p_hub) then
    raise exception 'HUB_ALREADY_REGISTERED';
  end if;
  insert into private.venue_hubs(hub_id, venue_id, token_sha256, created_by)
  values (p_hub, p_venue, encode(extensions.digest(secret, 'sha256'), 'hex'), auth.uid());
  perform private.audit('VENUE_HUB_REGISTERED', 'venue_hubs', null, p_venue, null,
    jsonb_build_object('hub_id', p_hub, 'generation', 1));
  return jsonb_build_object('hub_id', p_hub, 'generation', 1, 'secret', secret);
end
$$;
revoke all on function public.register_venue_hub(uuid, text) from public, anon;
grant execute on function public.register_venue_hub(uuid, text) to authenticated;

create function public.promote_venue_hub(p_hub text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  hub private.venue_hubs;
  secret text := private.issue_venue_hub_secret();
begin
  select * into hub from private.venue_hubs where hub_id = p_hub for update;
  if hub.hub_id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(hub.venue_id, array['ADMIN']::public.user_role[]);
  update private.venue_hubs
  set generation = generation + 1,
      token_sha256 = encode(extensions.digest(secret, 'sha256'), 'hex'),
      revoked_at = null
  where hub_id = p_hub;
  perform private.audit('VENUE_HUB_PROMOTED', 'venue_hubs', null, hub.venue_id,
    jsonb_build_object('generation', hub.generation),
    jsonb_build_object('hub_id', p_hub, 'generation', hub.generation + 1));
  return jsonb_build_object('hub_id', p_hub, 'generation', hub.generation + 1, 'secret', secret);
end
$$;
revoke all on function public.promote_venue_hub(text) from public, anon;
grant execute on function public.promote_venue_hub(text) to authenticated;

commit;
