import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { epsonPrintingIncluded } from '../src/services/commercial-scope.ts';

assert.equal(epsonPrintingIncluded, false, 'CORE must not enable bridge/Epson printing');
let checked = 1;

// Stripe/Satispay are in the edition (2026-10-19) behind the installation licences: the payments
// function authenticates, then prepare_provider_operation inserts the provider command, whose
// licence trigger refuses unlicensed methods, before any call to the provider.
{
  const file = 'supabase/functions/payments/index.ts';
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const authenticationAt = source.indexOf(
    "if (error || !identity.user) throw new Error('UNAUTHORIZED');",
  );
  const rpcAt = source.indexOf("user.rpc(\n        'prepare_provider_operation'");
  const externalAt = source.indexOf('runProviderOperation(prepared.id, request)');
  assert.ok(authenticationAt >= 0 && rpcAt > authenticationAt, `${file}: JWT before the RPC`);
  assert.ok(externalAt > rpcAt, `${file}: licensed RPC before external side effects`);
  const licence = readFileSync(
    'supabase/migrations/20261019100000_payment_providers_by_license.sql',
    'utf8',
  );
  assert.match(
    licence,
    /core_edition_new_provider_operation_guard\(\)[\s\S]*?if not private\.payment_method_licensed\(new\.method::text\) then\s*raise exception 'PAYMENT_METHOD_UNLICENSED'/,
    'provider commands must require the provider licence',
  );
  checked += 3;
}
// Large-group booking deposits (2026-10-21): the guest function runs begin_reservation_deposit,
// whose licence + provider gate (BOOKING_DEPOSITS, a licensed provider offered by the venue)
// raises before the provider is contacted; confirmation only follows a provider read.
{
  const file = 'supabase/functions/_shared/deposits.ts';
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const body = source.slice(source.indexOf('export async function startCheckout('));
  const gateAt = body.indexOf("deps.rpc('begin_reservation_deposit'");
  const createAt = body.indexOf('deps.gateway.create(');
  const readAt = body.indexOf('deps.gateway.read(');
  assert.ok(gateAt >= 0 && createAt > gateAt && readAt > gateAt, `${file}: gate before provider`);
  assert.match(
    body,
    /if \(error\) \{\s*if \(message\(error\) !== 'DEPOSIT_NOT_PENDING'\) throw databaseError\(error\);/,
    `${file}: a refused gate stops the checkout`,
  );
  const entry = readFileSync('supabase/functions/reservation-deposit/index.ts', 'utf8');
  assert.match(
    entry,
    /await rateLimit\(`reservation-deposit-ip:/,
    'deposit function is rate limited',
  );
  const migration = readFileSync(
    'supabase/migrations/20261021090000_large_group_booking_deposits.sql',
    'utf8',
  );
  assert.match(
    migration,
    /if not private\.booking_deposits_ready\(v_deposit\.venue_id\) then\s*raise exception 'BOOKING_DEPOSITS_DISABLED'/,
    'checkout start must require licence, venue feature and provider',
  );
  checked += 4;
}
const checks = [
  {
    file: 'supabase/functions/print-authorization/index.ts',
    flag: 'epsonPrintingIncluded',
    error: 'PRINT_DRIVER_NOT_INCLUDED',
    before: "user.rpc('get_print_bridge_authorization'",
    external: 'signPrintAuthorization(',
  },
];
for (const { file, flag, error, before, external } of checks) {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const importLine = `import { ${flag} } from '../../../src/services/commercial-scope.ts';`;
  assert.ok(source.includes(importLine), `${file}: must use common CORE capability`);
  checked++;
  const guard = `if (!${flag}) throw new Error('${error}');`;
  const guardAt = source.indexOf(guard);
  const authenticationAt = source.indexOf(
    "if (error || !identity.user) throw new Error('UNAUTHORIZED');",
  );
  const rpcAt = source.indexOf(before);
  const externalAt = source.indexOf(external);
  assert.ok(
    authenticationAt >= 0 && guardAt > authenticationAt,
    `${file}: guard must preserve JWT authentication`,
  );
  checked++;
  assert.ok(rpcAt >= 0 && guardAt < rpcAt, `${file}: guard must precede authoritative RPC`);
  checked++;
  assert.ok(
    externalAt >= 0 && guardAt < externalAt,
    `${file}: guard must precede external side effects`,
  );
  checked++;
}
// Edge tests use Deno's isolated npm/JSR cache rather than npm's Node tree.
const edgeDenoConfig = JSON.parse(readFileSync('supabase/functions/deno.json', 'utf8'));
assert.equal(
  edgeDenoConfig.nodeModulesDir,
  'none',
  'Edge dependency resolution must use the Deno cache',
);
checked++;
const edgeRunner = readFileSync('scripts/run-edge.mjs', 'utf8');
assert.doesNotMatch(
  edgeRunner,
  /--node-modules-dir=(?:auto|manual)/,
  'Edge runner must honor the Deno config rather than override its cache mode',
);
checked++;
console.log(
  `CORE_EDGE_FUNCTION_GUARDS=PASS (${checked}/${checked} checks; requires remote deploy and JWT HTTP verification)`,
);
