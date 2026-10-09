-- Clean-install postlude v1: recover the two missing operational RPCs.
-- Development-only diagnostics with fixed fixture IDs are deliberately excluded.
begin;
do $postlude$
begin
  if to_regprocedure('public.get_account_transfer_targets(uuid)') is not null then
    raise exception 'CLEAN_INSTALL_POSTLUDE_TARGET_ALREADY_EXISTS';
  end if;
  if to_regprocedure('public.get_order_change_center(uuid)') is not null then
    raise exception 'CLEAN_INSTALL_POSTLUDE_TARGET_ALREADY_EXISTS';
  end if;
end
$postlude$;

CREATE OR REPLACE FUNCTION public.get_account_transfer_targets(p_account uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_account public.accounts;
begin
  select * into v_account
  from public.accounts
  where id=p_account;

  if v_account.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(v_account.venue_id,array['ADMIN','CASHIER']::public.user_role[],false);

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',a.id,
        'account_name',a.account_name,
        'table_id',a.table_id,
        'table_name',t.name,
        'status',a.status,
        'version',a.version,
        'covers',a.covers
      )
      order by t.name,a.account_name,a.id
    )
    from public.accounts a
    left join public.tables t on t.id=a.table_id
    where a.venue_id=v_account.venue_id
      and a.id<>v_account.id
      and a.status<>'CLOSED'
      and a.floor_released_at is null
      and a.table_id=any(private.table_group(v_account.table_id))
      and private.can_read_account(a.id)
  ),'[]'::jsonb);
end
$function$;
revoke all on function public.get_account_transfer_targets(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_account_transfer_targets(uuid) to authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_order_change_center(p_venue uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[],false);
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',r.id,
        'order_id',r.order_id,
        'account_id',o.account_id,
        'account_name',a.account_name,
        'table_name',t.name,
        'requested_by',r.requested_by,
        'requested_by_name',sp.display_name,
        'kind',r.kind,
        'payload',r.payload,
        'reason',r.reason,
        'status',r.status,
        'created_at',r.created_at,
        'current_order_version',o.version,
        'items',coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id',i.id,
              'dish_name',i.dish_name,
              'quantity',i.quantity,
              'status',i.status
            )
            order by i.created_at,i.id
          )
          from public.order_items i
          where i.order_id=o.id
            and i.id in (
              select value::uuid
              from jsonb_array_elements_text(coalesce(r.payload->'item_ids','[]'::jsonb))
            )
        ),'[]'::jsonb)
      )
      order by r.created_at,r.id
    )
    from public.order_change_requests r
    join public.orders o on o.id=r.order_id
    join public.accounts a on a.id=o.account_id
    left join public.tables t on t.id=a.table_id
    left join public.staff_profiles sp on sp.id=r.requested_by
    where r.venue_id=p_venue
      and r.status='PENDING'
  ),'[]'::jsonb);
end
$function$;
revoke all on function public.get_order_change_center(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_order_change_center(uuid) to authenticated,service_role;

-- Mandatory release-test definitions created outside the applied SQL ledger.
-- Recover only the catalog contract. Never copy results, execution claims,
-- actors, timestamps or a PASS state from Development.
insert into private.release_test_catalog(key,category,required,description)
values
('MENU_ENGINEERING_CLASSIFICATION','REGRESSION',true,'Menu engineering classification deterministically maps popularity/margin quadrants while retaining numeric metrics.'),
('STEP11_BOOKING_AVAILABILITY_CLIENT_CONTRACT','PUBLIC_SITE',true,'Validate venue/service/date/party association and all bookable slot invariants'),
('STEP11_BOOKING_CHROMIUM_DOM_MOCK','PUBLIC_SITE',true,'Verify real booking DOM with Chromium and isolated mock transport for filter invalidation, out-of-order response and payload submission'),
('STEP11_BOOKING_DST_GAP_CONTRACT','PUBLIC_SITE',true,'PostgreSQL Europe/Rome spring-forward non-existent local slot suppression; adjacent valid slots and ordinary-day availability stay intact'),
('STEP11_BOOKING_FIELDS_CLIENT_CONTRACT','PUBLIC_SITE',true,'Isolated TypeScript client: dynamic booking field UUID IDs, JSONB-compatible select/radio/checkbox payloads, required field and numeric validation'),
('STEP11_BOOKING_VISIBILITY_DATABASE','PUBLIC_SITE',true,'Ensure booking readiness, navigation, public site and SEO booking page agree for every active venue'),
('STEP11_BRANDING_COLOR_CONTRAST','PUBLIC_SITE',true,'Pure TypeScript contrast tests for ten representative administrator-defined accents, fallback background contrast, text and visible focus'),
('STEP11_DARK_THEME_CSS_CHROMIUM','PUBLIC_SITE',true,'Chromium CSS checks for light/dark button contrast, mobile touch target, keyboard focus, reduced motion and form input readability'),
('STEP11_DEPOSIT_CHECKOUT_EXACT_HOST_CLIENT','PUBLIC_SITE',true,'Integrated frontend payment redirects accept only exact provider checkout hosts, never arbitrary brand subdomains'),
('STEP11_DEPOSIT_CLIENT_CONTRACT','PUBLIC_SITE',true,'Isolated TypeScript client: reservation/deposit response validation and constrained Stripe/Satispay HTTPS redirects'),
('STEP11_DEPOSIT_CONTINUATION_CLIENT','PUBLIC_SITE',true,'Pure client contract for deposits: redirect HTTPS provider allowlist, id/provider context, completed/failed/processing states'),
('STEP11_INTEGRATED_BUILD_ASSEMBLY','PUBLIC_SITE',true,'Rebuild deployed public tree from real Vite HTML template with controlled anonymous RPC, stale-route cleanup and noindex mode'),
('STEP11_INTEGRATED_SOURCE_BOOKING_CONTRACT','PUBLIC_SITE',true,'Source recovered from authorized full Plateform checkpoint; public booking uses authoritative server availability, dates, idempotency and deposit Edge Function; offline unit assertions'),
('STEP11_INTEGRATED_SOURCE_MOBILE_DOM','PUBLIC_SITE',true,'Recovered full application public menu mobile navigation tested in actual Chromium DOM without backend'),
('STEP11_INTEGRATED_SOURCE_SEO_PRERENDER','PUBLIC_SITE',true,'Recovered full application static public HTML SEO renderer tested with mocked public RPC data, escaping, origin and key checks'),
('STEP11_INTEGRATED_STATIC_CHROMIUM','PUBLIC_SITE',true,'Actual assembled prerendered HTML in Chromium with JavaScript disabled: home, menu, contacts, keyboard and CSS responsive/contrast'),
('STEP11_MIGRATION_RECOVERY_DRYRUN','PUBLIC_SITE',true,'Read-only PostgreSQL migration inventory recovery with strict SHA-256, dry-run, mismatch and malicious input guards'),
('STEP11_PUBLIC_BOOKING_CTA_SCOPING','PUBLIC_SITE',true,'Client side booking CTA and multi-venue selection respect authoritative selected venue booking readiness'),
('STEP11_PUBLIC_BOOKING_PRIVACY_READY','PUBLIC_SITE',true,'Booking readiness requires HTTPS privacy notice and active configured service; all public booking RPCs obey same backend policy'),
('STEP11_PUBLIC_BOOKING_TRANSACTION_ROLLBACK','PUBLIC_SITE',true,'Real development PostgreSQL booking writes for RESERVED, REQUESTED, PENDING_DEPOSIT, idempotent replay, deposit row and full rollback'),
('STEP11_PUBLIC_KEY_CLIENT_GUARD','SECURITY',true,'Reject browser credentials with service_role or sb_secret while accepting supported publishable and legacy anon keys'),
('STEP11_PUBLIC_METADATA_BACKEND','PUBLIC_SITE',true,'Check public page metadata, anonymous scope, forbidden routes, SEO noindex behavior'),
('STEP11_PUBLIC_MOBILE_NAVIGATION_DOM','PUBLIC_SITE',true,'Chromium DOM test for aria-expanded, Escape focus restoration, outside clicks, link close, responsive desktop transition and handler cleanup'),
('STEP11_PUBLIC_SITEMAP_BACKEND','PUBLIC_SITE',true,'Check sitemap candidate URLs, private route exclusion and indexability consistency'),
('STEP11_REAL_HTML_ENTRY_PRERENDER','PUBLIC_SITE',true,'Local release compiler recognizes the actual index.html Vite entry with its boot paragraph and produces accessible static HTML; rejects multiple or injected app mounts'),
('STEP11_STAGING_FULL_CI_WORKFLOW_STATIC','PUBLIC_SITE',true,'Staging workflow requires Node 24 npm ci, formatting, full app checks, Chromium E2E, migration dry run, real build and hosted HTTPS smoke'),
('STEP11_STAGING_HTTP_SMOKE_FIXTURES','PUBLIC_SITE',true,'Staging HTTPS read-only smoke contract on controlled HTTP fixtures with explicit negative tests'),
('STEP11_STATIC_EDITORIAL_HTML_OFFLINE','PUBLIC_SITE',true,'Public HTML editorial fallback built from authorized read-only RPC payloads: home/story, menu published vs legacy, gallery, contacts, venues, strict escaping and build consistency'),
('STEP11_STATIC_EDITORIAL_NO_JS_CHROMIUM','PUBLIC_SITE',true,'Chromium with JavaScript disabled renders SSR editorial markup, menu/allergens and contact links without running injected HTML'),
('STEP11_STATIC_SEO_GENERATOR_OFFLINE','PUBLIC_SITE',true,'Pre-render indexable public route HTML metadata, sitemap.xml and robots.txt from authoritative read-only Supabase RPCs; fail closed on malformed URLs or mismatched domains'),
('STEP11_VERCEL_STAGING_CONFIG_OFFLINE','PUBLIC_SITE',true,'Vercel staging headers, noindex, staff route segregation, and no-asset-fallback tests on the integrated source')
on conflict(key) do update set category=excluded.category,required=excluded.required,
  description=excluded.description;

commit;
