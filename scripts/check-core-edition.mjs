import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  externalPaymentProvidersIncluded,
  epsonPrintingIncluded,
  permittedPaymentMethod,
  permittedPaymentMethods,
  permittedPrintDriver,
  permittedPrintDrivers,
} from '../src/services/commercial-scope.ts';

let count = 0;
function check(test) { test(); count++; }

check(() => assert.equal(externalPaymentProvidersIncluded, false));
check(() => assert.equal(epsonPrintingIncluded, false));
check(() => assert.deepEqual(permittedPaymentMethods([
  'CASH','CARD_POS','STRIPE','SATISPAY_POS','SATISPAY_API',
]), ['CASH','CARD_POS']));
for (const valid of ['CASH','CARD_POS'])
  check(() => assert.equal(permittedPaymentMethod(valid), true));
for (const invalid of ['STRIPE','SATISPAY_POS','SATISPAY_API','','BOGUS'])
  check(() => assert.equal(permittedPaymentMethod(invalid), false));
check(() => assert.deepEqual(permittedPrintDrivers(), ['BROWSER']));
check(() => assert.equal(permittedPrintDriver('BROWSER'), true));
for (const invalid of ['EPOS','BRIDGE','','BOGUS'])
  check(() => assert.equal(permittedPrintDriver(invalid), false));

const accountPayments = readFileSync('src/pages/account-payments.ts', 'utf8');
const operationalSettings = readFileSync('src/pages/operational-settings.ts', 'utf8');
const publicBooking = readFileSync('src/pages/public-booking.ts', 'utf8');
check(() => assert.match(accountPayments, /const allowed = permittedPaymentMethods\(/));
check(() => assert.match(accountPayments, /method\.disabled = allowed\.length === 0/));
check(() => assert.match(accountPayments, /if \(!permittedPaymentMethod\(method\.value\)\)/));
check(() => assert.match(operationalSettings, /const methods = permittedPaymentMethods\(/));
check(() => assert.match(operationalSettings, /permittedPrintDrivers\(\)/));
check(() => assert.match(operationalSettings, /permittedPrintDriver\(device\.driver\)/));
check(() => assert.match(publicBooking, /slot\.status_if_booked !== 'PENDING_DEPOSIT'/));
check(() => assert.match(publicBooking, /if \(!externalPaymentProvidersIncluded\)/));
check(() => assert.match(publicBooking, /Non inviare un’altra richiesta/));

console.log(`CORE_EDITION_SOURCE_CONTRACT=PASS (${count}/${count} checks; server configuration verified separately)`);