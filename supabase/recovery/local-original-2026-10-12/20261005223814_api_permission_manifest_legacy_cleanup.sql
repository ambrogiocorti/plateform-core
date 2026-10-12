begin;
delete from private.api_permission_manifest
where api_role='authenticated'
  and function_identity in (
    'public.create_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb)',
    'public.create_refund(uuid,bigint,bigint,text,uuid,uuid)',
    'public.force_close_account(uuid,text,uuid)',
    'public.reopen_account(uuid,text,uuid)'
  );
commit;
