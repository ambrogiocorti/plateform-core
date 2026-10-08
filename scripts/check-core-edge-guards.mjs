import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  externalPaymentProvidersIncluded,
  epsonPrintingIncluded,
} from '../src/services/commercial-scope.ts';

assert.equal(externalPaymentProvidersIncluded, false, 'CORE must not enable external payment providers');
assert.equal(epsonPrintingIncluded, false, 'CORE must not enable bridge/Epson printing');
const checks = [
  {
    file: 'supabase/functions/payments/index.ts',
    flag: 'externalPaymentProvidersIncluded',
    error: 'PAYMENT_METHOD_UNLICENSED',
    before: "user.rpc(\n        'prepare_provider_operation'",
    external: 'runProviderOperation(prepared.id, request)',
  },
  {
    file: 'supabase/functions/print-authorization/index.ts',
    flag: 'epsonPrintingIncluded',
    error: 'PRINT_DRIVER_NOT_INCLUDED',
    before: "user.rpc('get_print_bridge_authorization'",
    external: 'signPrintAuthorization(',
  },
];
let checked = 2;
for (const {file,flag,error,before,external} of checks) {
  const source = readFileSync(file,'utf8');
  const importLine = `import { ${flag} } from '../../../src/services/commercial-scope.ts';`;
  assert.ok(source.includes(importLine), `${file}: must use common CORE capability`);
  checked++;
  const guard = `if (!${flag}) throw new Error('${error}');`;
  const guardAt = source.indexOf(guard);
  const authenticationAt = source.indexOf("if (error || !identity.user) throw new Error('UNAUTHORIZED');");
  const rpcAt = source.indexOf(before);
  const externalAt = source.indexOf(external);
  assert.ok(authenticationAt >= 0 && guardAt > authenticationAt,
    `${file}: guard must preserve JWT authentication`);
  checked++;
  assert.ok(rpcAt >= 0 && guardAt < rpcAt, `${file}: guard must precede authoritative RPC`);
  checked++;
  assert.ok(externalAt >= 0 && guardAt < externalAt, `${file}: guard must precede external side effects`);
  checked++;
}
console.log(`CORE_EDGE_FUNCTION_GUARDS=PASS (${checked}/${checked} checks; requires remote deploy and JWT HTTP verification)`);
