
alter table private.reservation_message_contacts
  add column if not exists preference_status text not null default 'ALLOWED',
  add column if not exists verification_source text,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default clock_timestamp();

alter table private.reservation_message_contacts
  drop constraint if exists reservation_message_contacts_preference_status_check,
  add constraint reservation_message_contacts_preference_status_check
    check(preference_status in ('ALLOWED','OPTED_OUT')),
  drop constraint if exists reservation_message_contacts_verification_source_check,
  add constraint reservation_message_contacts_verification_source_check
    check(
      verification_source is null
      or verification_source in (
        'CUSTOMER_PROVIDED',
        'STAFF_CONFIRMED',
        'PROVIDER_VERIFIED'
      )
    );

drop trigger if exists touch_version on private.reservation_message_contacts;
create trigger touch_version
before update on private.reservation_message_contacts
for each row execute function private.touch_version();

create or replace function private.reservation_message_destination(
  p_reservation uuid,
  p_channel text
)
returns text
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_channel text:=upper(trim(p_channel));
  v_contact private.reservation_message_contacts;
  v_phone text;
begin
  select * into v_contact
  from private.reservation_message_contacts c
  where c.reservation_id=p_reservation
    and c.channel=v_channel;

  if v_contact.reservation_id is not null then
    if v_contact.preference_status='OPTED_OUT' then
      return null;
    end if;

    if v_contact.verified_at is not null then
      return v_contact.destination;
    end if;
  end if;

  if v_channel in ('WHATSAPP','SMS') then
    select r.phone into v_phone
    from public.reservations r
    where r.id=p_reservation
      and r.anonymized_at is null;

    return v_phone;
  end if;

  return null;
end
$$;

revoke all on function private.reservation_message_destination(uuid,text)
from public,anon,authenticated;

create or replace function public.save_reservation_message_contact(
  p_reservation uuid,
  p_channel text,
  p_destination text,
  p_preference text,
  p_verified boolean,
  p_verification_source text,
  p_version bigint,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_res public.reservations;
  v_actor uuid;
  v_channel text:=upper(trim(p_channel));
  v_destination text:=trim(p_destination);
  v_preference text:=upper(trim(p_preference));
  v_source text:=nullif(upper(trim(p_verification_source)),'');
  v_result jsonb;
  v_row private.reservation_message_contacts;
begin
  if p_reservation is null or p_key is null then
    raise exception 'INVALID_MESSAGE_CONTACT';
  end if;

  select * into v_res
  from public.reservations
  where id=p_reservation;

  if v_res.id is null then raise exception 'NOT_FOUND'; end if;

  v_actor:=private.authorize(
    v_res.venue_id,
    array['ADMIN','HOST']::public.user_role[]
  );

  perform private.require_message_channel(v_res.venue_id,v_channel);

  if v_channel not in ('WHATSAPP','SMS','TELEGRAM','EMAIL')
     or v_destination is null
     or length(v_destination) not between 2 and 240
     or v_preference not in ('ALLOWED','OPTED_OUT')
     or p_verified is null
     or (
       p_verified
       and v_source not in (
         'CUSTOMER_PROVIDED',
         'STAFF_CONFIRMED',
         'PROVIDER_VERIFIED'
       )
     )
     or (
       not p_verified
       and v_source is not null
     )
     or (
       v_channel in ('WHATSAPP','SMS')
       and v_preference='OPTED_OUT'
       and v_destination<>v_res.phone
     )
  then
    raise exception 'INVALID_MESSAGE_CONTACT';
  end if;

  v_result:=private.idempotency_begin(
    'reservation_message_contact',
    p_key,
    jsonb_build_object(
      'reservation',p_reservation,
      'channel',v_channel,
      'destination',v_destination,
      'preference',v_preference,
      'verified',p_verified,
      'verification_source',v_source,
      'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  select * into v_row
  from private.reservation_message_contacts
  where reservation_id=p_reservation
    and channel=v_channel
  for update;

  if v_row.reservation_id is null then
    if p_version is not null then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    insert into private.reservation_message_contacts(
      reservation_id,channel,destination,verified_at,source,
      preference_status,verification_source
    ) values(
      p_reservation,v_channel,v_destination,
      case when p_verified then clock_timestamp() end,
      v_source,
      v_preference,
      v_source
    )
    returning * into v_row;
  else
    if p_version is null or v_row.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update private.reservation_message_contacts
    set destination=v_destination,
        verified_at=case
          when p_verified then coalesce(verified_at,clock_timestamp())
          else null
        end,
        source=v_source,
        preference_status=v_preference,
        verification_source=v_source
    where reservation_id=p_reservation
      and channel=v_channel
    returning * into v_row;
  end if;

  perform private.audit(
    'RESERVATION_MESSAGE_CONTACT_UPDATED',
    'reservations',
    p_reservation,
    v_res.venue_id,
    null,
    jsonb_build_object(
      'channel',v_channel,
      'preference_status',v_row.preference_status,
      'verified',v_row.verified_at is not null,
      'verification_source',v_row.verification_source
    )
  );

  v_result:=jsonb_build_object(
    'reservation_id',v_row.reservation_id,
    'channel',v_row.channel,
    'preference_status',v_row.preference_status,
    'verified',v_row.verified_at is not null,
    'version',v_row.version
  );

  return private.idempotency_finish(
    'reservation_message_contact',
    p_key,
    v_result
  );
end
$$;

revoke all on function public.save_reservation_message_contact(
  uuid,text,text,text,boolean,text,bigint,uuid
) from public,anon;

grant execute on function public.save_reservation_message_contact(
  uuid,text,text,text,boolean,text,bigint,uuid
) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.save_reservation_message_contact(uuid,text,text,text,boolean,text,bigint,uuid)',
  'authenticated'
)
on conflict do nothing;
