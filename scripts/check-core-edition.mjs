import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { printLines } from '../shared/print-document.ts';
import {
  externalPaymentProvidersIncluded,
  epsonPrintingIncluded,
  permittedPaymentMethod,
  permittedPaymentMethods,
  permittedPrintDriver,
  permittedPrintDrivers,
  permittedBookingSlots,
  requiresExcludedDeposit,
} from '../src/services/commercial-scope.ts';

let count = 0;
function check(test) {
  test();
  count++;
}

check(() => assert.equal(externalPaymentProvidersIncluded, false));
check(() => assert.equal(epsonPrintingIncluded, false));
check(() =>
  assert.deepEqual(
    permittedPaymentMethods(['CASH', 'CARD_POS', 'STRIPE', 'SATISPAY_POS', 'SATISPAY_API']),
    ['CASH', 'CARD_POS'],
  ),
);
for (const valid of ['CASH', 'CARD_POS'])
  check(() => assert.equal(permittedPaymentMethod(valid), true));
for (const invalid of ['STRIPE', 'SATISPAY_POS', 'SATISPAY_API', '', 'BOGUS'])
  check(() => assert.equal(permittedPaymentMethod(invalid), false));
check(() => assert.deepEqual(permittedPrintDrivers(), ['BROWSER']));
check(() => assert.equal(permittedPrintDriver('BROWSER'), true));
for (const invalid of ['EPOS', 'BRIDGE', '', 'BOGUS'])
  check(() => assert.equal(permittedPrintDriver(invalid), false));
const bookingSlots = [
  { time: '19:00', status_if_booked: 'RESERVED' },
  { time: '19:30', status_if_booked: 'REQUESTED' },
  { time: '20:00', status_if_booked: 'PENDING_DEPOSIT' },
];
check(() =>
  assert.deepEqual(
    permittedBookingSlots(bookingSlots).map((entry) => entry.time),
    ['19:00', '19:30'],
  ),
);
check(() => assert.equal(bookingSlots.length, 3, 'caller input must not be mutated'));
check(() =>
  assert.deepEqual(
    permittedBookingSlots([{ time: '20:00', status_if_booked: 'PENDING_DEPOSIT' }]),
    [],
  ),
);
check(() =>
  assert.deepEqual(
    permittedBookingSlots([
      { time: '20:30', status_if_booked: 'RESERVED', deposit: { amount_cents: 1000 } },
    ]),
    [],
  ),
);
check(() =>
  assert.deepEqual(
    permittedBookingSlots([
      { time: '20:45', status_if_booked: 'REQUESTED', deposit: { amount_cents: 1000 } },
    ]),
    [],
  ),
);
check(() =>
  assert.deepEqual(permittedBookingSlots([{ time: '21:00', status_if_booked: 'UNKNOWN' }]), []),
);
check(() => assert.deepEqual(permittedBookingSlots([{ time: '21:15' }]), []));
check(() =>
  assert.equal(
    requiresExcludedDeposit({ status_if_booked: 'RESERVED', deposit: { amount_cents: 1000 } }),
    true,
  ),
);
check(() => assert.equal(requiresExcludedDeposit({ status_if_booked: 'RESERVED' }), false));

const accountPayments = readFileSync('src/pages/account-payments.ts', 'utf8');
const operationalSettings = readFileSync('src/pages/operational-settings.ts', 'utf8');
const publicBooking = readFileSync('src/pages/public-booking.ts', 'utf8');
const printing = readFileSync('src/pages/printing.ts', 'utf8');
const accountFinance = readFileSync('src/pages/account-finance.ts', 'utf8');
const cashPage = readFileSync('src/pages/cash.ts', 'utf8');
const providerPayments = readFileSync('src/pages/provider-payments.ts', 'utf8');
const technicalPage = readFileSync('src/pages/technical.ts', 'utf8');
check(() => assert.match(accountPayments, /const allowed = permittedPaymentMethods\(/));
check(() => assert.match(accountPayments, /method\.disabled = allowed\.length === 0/));
check(() => assert.match(accountPayments, /if \(!permittedPaymentMethod\(method\.value\)\)/));
check(() => assert.match(operationalSettings, /const methods = permittedPaymentMethods\(/));
check(() => assert.match(operationalSettings, /permittedPrintDrivers\(\)/));
check(() => assert.match(operationalSettings, /permittedPrintDriver\(device\.driver\)/));
check(() => assert.match(publicBooking, /permittedBookingSlots\(confirmedSlots\)/));
check(() => assert.match(publicBooking, /confirmedSlots\.some\(requiresExcludedDeposit\)/));
check(() => assert.match(publicBooking, /if \(!externalPaymentProvidersIncluded\)/));
check(() => assert.match(publicBooking, /Non inviare un’altra richiesta/));
check(() =>
  assert.match(printing, /\.filter\(\(device\) => permittedPrintDriver\(device\.driver\)\)/),
);
check(() =>
  assert.match(
    printing,
    /if \(!permittedPrintDriver\(device\.driver\)\) \{\s*await finish\(false\);/,
  ),
);
check(() =>
  assert.match(printing, /La stampa su questo dispositivo non è inclusa in Plateform CORE/),
);
check(() => assert.match(accountFinance, /if \(!permittedPaymentMethod\(payment\.method\)\)/));
check(() =>
  assert.match(
    accountFinance,
    /manual\(payment\.method\) &&\s*permittedPaymentMethod\(payment\.method\)/,
  ),
);
check(() => assert.match(accountFinance, /Operazione storica con metodo escluso dalla CORE/));
check(() =>
  assert.match(
    accountFinance,
    /refund\.status === 'PENDING' &&\s*!manual\(payment\.method\) &&\s*permittedPaymentMethod\(payment\.method\)/,
  ),
);
check(() => assert.match(cashPage, /if \(permittedPaymentMethod\(payment\.method\)\)/));
check(() => assert.match(providerPayments, /if \(!externalPaymentProvidersIncluded\) \{/));
check(() => assert.match(technicalPage, /FUORI PERIMETRO CORE/));
check(() => assert.match(technicalPage, /excludedFromCore/));
const receiptLines = printLines({
  restaurant: 'Plateform QA',
  at: '2026-10-08T17:00:00Z',
  account: 'A-01',
  table: '7',
  document: 'Conto di cortesia',
  lines: [{ name: 'Piatto prova', quantity: 1, total_cents: 1290 }],
  balance: { total_cents: 1290, discount_cents: 0 },
  payments: [{ method: 'CARD_POS', amount_cents: 1290, tip_cents: 0 }],
  refunds: [{ method: 'CASH', amount_cents: 300 }],
});
check(() => assert.ok(receiptLines.some((line) => line.includes('DOCUMENTO NON FISCALE'))));
check(() => assert.ok(receiptLines.some((line) => line.includes('documento commerciale fiscale'))));
check(() => assert.ok(receiptLines.some((line) => line.includes('CARD_POS'))));
check(() => assert.ok(receiptLines.some((line) => line.includes('Rimborso CASH'))));

console.log(
  `CORE_EDITION_SOURCE_CONTRACT=PASS (${count}/${count} checks; server configuration verified separately)`,
);
