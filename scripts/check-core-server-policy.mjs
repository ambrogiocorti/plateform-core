import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// SOURCE-ONLY checks against the exact applied, versioned Development migration.
// Remote negative SQL checks are evidence documented separately; this script
// alone cannot certify API authorization behavior or Production deployment.
const migrationFile = '20261008181605_core_edition_payment_and_print_denial.sql';
const migrationPath = `supabase/migrations/${migrationFile}`;
const migrationBytes = readFileSync(migrationPath);
const sql = migrationBytes.toString('utf8');
const foundation = readFileSync('supabase/migrations/20261003165439_foundation.sql', 'utf8');
const enumValues = (type) => {
  const match = foundation.match(
    new RegExp(`create type public\\.${type} as enum \\(([^)]*)\\)`, 'i'),
  );
  assert.ok(match, `${type} must exist in foundation schema`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
let count = 0;
function check(name, run) {
  try {
    run();
    count++;
  } catch (error) {
    throw new Error(`${name}: ${error.message}`, { cause: error });
  }
}

const paymentMethods = enumValues('payment_method');
const refundStatuses = enumValues('refund_status');
const paymentStatuses = enumValues('payment_status');
check('payment enum contains only documented CORE methods', () => {
  assert.deepEqual(paymentMethods, ['CASH', 'CARD_POS', 'STRIPE', 'SATISPAY_POS', 'SATISPAY_API']);
});
check('payment preflight terminal enum is valid', () => {
  for (const value of ['FAILED', 'CANCELLED', 'REFUNDED'])
    assert.ok(paymentStatuses.includes(value));
});
check('refund preflight terminal enum is valid', () => {
  for (const value of ['FAILED', 'REJECTED', 'COMPLETED'])
    assert.ok(refundStatuses.includes(value));
  assert.ok(!sql.match(/refunds[\s\S]{0,170}CANCELLED/), 'no nonexistent refund enum states');
});
check('historical refunded payments do not block activation', () => {
  assert.match(sql, /payments[\s\S]{0,170}status NOT IN \('FAILED',\s*'CANCELLED',\s*'REFUNDED'\)/);
});
check('historical completed refunds do not block activation', () => {
  assert.match(sql, /refunds[\s\S]{0,170}status NOT IN \('FAILED',\s*'REJECTED',\s*'COMPLETED'\)/);
});
check('applied migration version and digest match the source manifest', () => {
  const manifest = JSON.parse(readFileSync('supabase/migration-manifest.json', 'utf8'));
  const row = manifest.migrations.find((entry) => entry.filename === migrationFile);
  assert.ok(row, 'the CORE migration must be versioned');
  assert.equal(row.version, '20261008181605');
  assert.equal(row.name, 'core_edition_payment_and_print_denial');
  const hash = (source) => createHash('sha256').update(source).digest('hex');
  const rawHash = hash(migrationBytes);
  // Windows Git checkouts predating .gitattributes may contain CRLF. Accept
  // only the byte-identical SQL or an LF-canonicalized equivalent, never a
  // changed migration body. The manifest remains the authority.
  const verifiedHash = rawHash === row.sha256 ? rawHash : hash(sql.replace(/\r\n/g, '\n'));
  assert.equal(row.sha256, verifiedHash);
});
for (const pattern of [
  /CORE_EDITION_PENDING_PROVIDER_OPERATIONS/,
  /CORE_EDITION_EXISTING_PROVIDER_PAYMENTS/,
  /CORE_EDITION_EXISTING_PROVIDER_REFUNDS/,
  /CORE_EDITION_PENDING_RESERVATION_DEPOSITS/,
  /CORE_EDITION_ACTIVE_EXTERNAL_PRINT_DEVICES/,
  /CORE_EDITION_PENDING_EXTERNAL_PRINT_JOBS/,
  /CREATE TRIGGER core_edition_license/,
  /CREATE TRIGGER core_edition_payment_methods[\s\S]*?INSERT OR UPDATE OF method/,
  /CREATE TRIGGER core_edition_refund_methods[\s\S]*?INSERT OR UPDATE OF method/,
  /CREATE TRIGGER core_edition_venue_payment_methods/,
  /CREATE TRIGGER core_edition_cash_register_payment_methods/,
  /CREATE TRIGGER core_edition_new_provider_operation/,
  /CREATE TRIGGER core_edition_print_drivers[\s\S]*?INSERT OR UPDATE OF driver,active/,
  /CREATE TRIGGER core_edition_print_jobs[\s\S]*?INSERT OR UPDATE OF print_device_id/,
  /CORE_PROVIDER_OPERATION_FORBIDDEN/,
  /PRINT_DRIVER_NOT_INCLUDED/,
  /CORE_PRINT_DEVICE_FORBIDDEN/,
  /SET licensed\s*=\s*false/,
  /'BOOKING_DEPOSITS'\) AND licensed\s*=\s*true/,
  /FROM PUBLIC,\s*anon,\s*authenticated/,
])
  check(`required policy: ${pattern}`, () => assert.match(sql, pattern));

// 20261019100000 (owner decision, 2026-10-19) supersedes the unconditional provider denial of
// the migration above: Stripe/Satispay follow the installation licences, deposits stay denied.
const licenceFile = '20261019100000_payment_providers_by_license.sql';
const licenceSql = readFileSync(`supabase/migrations/${licenceFile}`, 'utf8');
check('provider licence migration is versioned in the manifest', () => {
  const manifest = JSON.parse(readFileSync('supabase/migration-manifest.json', 'utf8'));
  const row = manifest.migrations.find((entry) => entry.filename === licenceFile);
  assert.ok(row, 'the provider licence migration must be versioned');
  const hash = createHash('sha256').update(readFileSync(`supabase/migrations/${licenceFile}`));
  assert.equal(row.sha256, hash.digest('hex'));
});
for (const pattern of [
  /when p_method in \('CASH','CARD_POS'\) then true/,
  /when p_method='STRIPE' then private\.feature_licensed\('STRIPE'\)/,
  /when p_method in \('SATISPAY_API','SATISPAY_POS'\) then private\.feature_licensed\('SATISPAY_API'\)/,
  /else false/,
  // Historical: superseded by the licence-based deposit gate of 20261021090000 (checked below).
  /new\.name='BOOKING_DEPOSITS' and new\.licensed then\s*raise exception 'CORE_PROVIDER_LICENSE_FORBIDDEN'/,
  /core_edition_payment_guard\(\)[\s\S]*?not private\.payment_method_licensed\(new\.method::text\)[\s\S]*?PAYMENT_METHOD_UNLICENSED/,
  /core_edition_register_methods_guard\(\)[\s\S]*?m\.method is null or not private\.payment_method_licensed/,
  /core_edition_new_provider_operation_guard\(\)[\s\S]*?not private\.payment_method_licensed\(new\.method::text\)/,
  /PROVIDER_STILL_CONFIGURED/,
  /PROVIDER_OPERATIONS_PENDING/,
  /revoke all on function private\.payment_method_licensed\(text\) from public,anon,authenticated/,
])
  check(`provider licence policy: ${pattern}`, () => assert.match(licenceSql, pattern));
check('provider licence migration leaves print guards and history untouched', () => {
  const code = licenceSql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /print/i);
  assert.doesNotMatch(code, /\b(?:DELETE FROM|TRUNCATE|DROP)\b/i);
});
// 20261021090000 (owner decision, 2026-10-21): the large-group booking deposit may be licensed,
// but only together with a licensed provider, and the server asks it only when the venue can
// collect it. Epson/print guards stay untouched.
const depositFile = '20261021090000_large_group_booking_deposits.sql';
const depositSql = readFileSync(`supabase/migrations/${depositFile}`, 'utf8');
check('deposit licence migration is versioned in the manifest', () => {
  const manifest = JSON.parse(readFileSync('supabase/migration-manifest.json', 'utf8'));
  const row = manifest.migrations.find((entry) => entry.filename === depositFile);
  assert.ok(row, 'the deposit licence migration must be versioned');
  const hash = createHash('sha256').update(readFileSync(`supabase/migrations/${depositFile}`));
  assert.equal(row.sha256, hash.digest('hex'));
});
for (const pattern of [
  /core_edition_license_guard\(\)[\s\S]*?new\.name='BOOKING_DEPOSITS' and new\.licensed\s*and not \(private\.feature_licensed\('STRIPE'\) or private\.feature_licensed\('SATISPAY_API'\)\) then\s*raise exception 'BOOKING_DEPOSITS_PROVIDER_LICENCE_REQUIRED'/,
  /BOOKING_DEPOSITS_STILL_LICENSED/,
  /BOOKING_DEPOSITS_PENDING/,
  /create trigger booking_deposit_licence_revocation before update of licensed on public\.feature_flags/,
  /private\.booking_deposits_ready\(p_venue uuid\)[\s\S]*?venue_feature_enabled\(p_venue,'BOOKING_DEPOSITS'\)\s*and cardinality\(private\.booking_deposit_providers\(p_venue\)\)>0/,
  /where private\.feature_licensed\(p\.method\)/,
  /if not private\.booking_deposits_ready\(v\.id\) then\s*raise exception 'BOOKING_DEPOSITS_DISABLED'/,
  /if not private\.booking_deposits_ready\(p_venue\) then\s*v_available:=false;\s*v_reason:='BOOKING_DEPOSITS_DISABLED'/,
  /if not v_provider=any\(private\.booking_deposit_providers\(v_deposit\.venue_id\)\) then\s*raise exception 'DEPOSIT_PROVIDER_UNAVAILABLE'/,
  /revoke all on function public\.get_reservation_deposit_status\(uuid,text\) from public,anon,authenticated/,
  /deposit_no_show_action='RETAIN'/,
])
  check(`deposit licence policy: ${pattern}`, () => assert.match(depositSql, pattern));
check('deposit licence migration leaves print guards and history untouched', () => {
  const code = depositSql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /print/i);
  assert.doesNotMatch(code, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE|DROP TYPE)\b/i);
});
check('all function scopes have fixed search path', () => {
  const functions = sql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
  const secured = sql.match(/RETURNS trigger LANGUAGE plpgsql SET search_path\s*=\s*''/g) ?? [];
  assert.ok(functions.length >= 6);
  assert.equal(secured.length, functions.length);
});
check('policy does not perform destructive historical deletes', () => {
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE|DROP TYPE)\b/i);
});
console.log(
  `CORE_SERVER_POLICY_SOURCE=PASS (${count}/${count} source checks; real JWT API authorization still required)`,
);
