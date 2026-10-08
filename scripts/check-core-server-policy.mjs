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
  const match = foundation.match(new RegExp(`create type public\\.${type} as enum \\(([^)]*)\\)`, 'i'));
  assert.ok(match, `${type} must exist in foundation schema`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
let count = 0;
function check(name, run) {
  try { run(); count++; } catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

const paymentMethods = enumValues('payment_method');
const refundStatuses = enumValues('refund_status');
const paymentStatuses = enumValues('payment_status');
check('payment enum contains only documented CORE methods', () => {
  assert.deepEqual(paymentMethods, ['CASH','CARD_POS','STRIPE','SATISPAY_POS','SATISPAY_API']);
});
check('payment preflight terminal enum is valid', () => {
  for (const value of ['FAILED','CANCELLED','REFUNDED']) assert.ok(paymentStatuses.includes(value));
});
check('refund preflight terminal enum is valid', () => {
  for (const value of ['FAILED','REJECTED','COMPLETED']) assert.ok(refundStatuses.includes(value));
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
  const verifiedHash = rawHash === row.sha256
    ? rawHash
    : hash(sql.replace(/\r\n/g, '\n'));
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
]) check(`required policy: ${pattern}`, () => assert.match(sql, pattern));

check('all function scopes have fixed search path', () => {
  const functions = sql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
  const secured = sql.match(/RETURNS trigger LANGUAGE plpgsql SET search_path\s*=\s*''/g) ?? [];
  assert.ok(functions.length >= 6);
  assert.equal(secured.length, functions.length);
});
check('policy does not perform destructive historical deletes', () => {
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE|DROP TYPE)\b/i);
});
console.log(`CORE_SERVER_POLICY_SOURCE=PASS (${count}/${count} source checks; real JWT API authorization still required)`);
