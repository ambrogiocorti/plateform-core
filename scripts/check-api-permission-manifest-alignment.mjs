import { readFile } from 'node:fs/promises';

const alignment = await readFile(
  new URL('../supabase/migrations/20261005222521_api_permission_manifest_alignment.sql', import.meta.url),
  'utf8',
);
const cleanup = await readFile(
  new URL('../supabase/migrations/20261005223814_api_permission_manifest_legacy_cleanup.sql', import.meta.url),
  'utf8',
);
const heartbeat = await readFile(
  new URL('../supabase/migrations/20261005221652_step12_continuity_worker_heartbeat.sql', import.meta.url),
  'utf8',
);

const required = [
  'public.abort_restore_cutover(uuid,uuid,text,uuid)',
  'public.configure_continuity_targets(bigint,integer,integer,integer,integer,uuid)',
  'public.confirm_restore_cutover(uuid,uuid,text,text,uuid)',
  'public.get_admin_operational_overview(uuid)',
  'public.get_kitchen_admin_overview(uuid)',
  'private.abort_restore_cutover_impl(uuid,uuid,text,uuid)',
  'private.configure_continuity_targets_impl(bigint,integer,integer,integer,integer,uuid)',
  'private.confirm_restore_cutover_impl(uuid,uuid,text,text,uuid)',
];
const legacy = [
  'public.create_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb)',
  'public.create_refund(uuid,bigint,bigint,text,uuid,uuid)',
  'public.force_close_account(uuid,text,uuid)',
  'public.reopen_account(uuid,text,uuid)',
];

const checks = [
  ...required.map((signature) => [alignment.includes(signature), `required:${signature}`]),
  ...legacy.map((signature) => [cleanup.includes(signature), `legacy-cleanup:${signature}`]),
  [heartbeat.includes("('public.record_continuity_worker_heartbeat(text,text,jsonb)','service_role')"), 'heartbeat manifest service-role entry'],
  [cleanup.includes("where api_role='authenticated'"), 'legacy cleanup scoped to authenticated'],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`STEP12_API_PERMISSION_MANIFEST_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log(`STEP12_API_PERMISSION_MANIFEST_GATE=PASSED_${checks.length}_OF_${checks.length}`);
