-- Retry safety for public waitlist acceptance.
-- The existing atomic function verified the *live* offer token before looking
-- up a matching idempotency key. A successful acceptance revokes that token,
-- so a lost HTTP response could never be recovered by retrying the same key.
--
-- Move the tested transactional implementation into an inaccessible private
-- function and expose a narrow wrapper. Only a matching entry, token digest
-- and unguessable idempotency key can retrieve a previously committed result.
-- New acceptances continue through the original atomic implementation.

alter function public.accept_waitlist_offer(uuid,text,uuid) set schema private;
alter function private.accept_waitlist_offer(uuid,text,uuid)
  rename to accept_waitlist_offer_core;

revoke all on function private.accept_waitlist_offer_core(uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function private.accept_waitlist_offer_core(uuid,text,uuid)
  to service_role,postgres;

create function public.accept_waitlist_offer(
  p_entry uuid,
  p_access_token text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_digest text;
  v_existing private.public_requests;
begin
  if p_entry is null
     or p_access_token is null
     or length(p_access_token) not between 32 and 256
     or p_key is null then
    raise exception 'INVALID_WAITLIST_ACCEPTANCE';
  end if;

  v_digest:=encode(extensions.digest(
    jsonb_build_object(
      'entry',p_entry,
      'token_hash',private.waitlist_token_hash(p_access_token)
    )::text,
    'sha256'
  ),'hex');

  perform pg_advisory_xact_lock(hashtextextended('waitlist_accept:'||p_key::text,0));

  select * into v_existing
  from private.public_requests
  where operation='waitlist_accept' and idempotency_key=p_key;

  if found then
    if v_existing.payload_hash<>v_digest then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode='22023';
    end if;
    return v_existing.response;
  end if;

  return private.accept_waitlist_offer_core(p_entry,p_access_token,p_key);
end
$$;

revoke all on function public.accept_waitlist_offer(uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.accept_waitlist_offer(uuid,text,uuid)
  to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.accept_waitlist_offer(uuid,text,uuid)','service_role')
on conflict do nothing;
