import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { anonKey, sql, supabaseUrl } from './stack.mjs';
import {
  action,
  bookGroup,
  configureRule,
  groups,
  groupsService,
  runReleaseWorker,
} from './deposits';

// Large-group deposit paid with Satispay SANDBOX on hosted staging. Paying needs a person with the
// Satispay sandbox phone app inside the 45-minute deposit window, so the spec runs twice: the first
// run books a group of 8, starts the Satispay payment and writes the guest's page to
// test-results/satispay-deposit-link.txt; once the QR is paid, the second run checks the server
// outcome (callback, or the guest's status re-read), seats the group and expects the full refund
// confirmed by Satispay through reservation-deposit-no-show-worker.
test.setTimeout(600_000);
test.beforeAll(groupsService);

const tokenFile = 'test-results/satispay-deposit-token.txt';

test('caparra Satispay sandbox: pagamento con l’app, conferma dal server, rimborso dopo l’arrivo', async ({
  browser,
  request,
}) => {
  const pending = sql(`select d.id from public.reservation_deposits d join public.reservations r
    on r.id=d.reservation_id where r.service_id='${groups}' and d.provider='SATISPAY'
    and r.status in ('PENDING_DEPOSIT','RESERVED') and d.status in ('PENDING','COMPLETED')
    and d.expires_at>now() - interval '1 day' order by d.created_at desc limit 1`);

  if (!pending) {
    if (
      sql(
        `select deposit_policy from public.service_booking_rules where service_id='${groups}'`,
      ) !== 'CONDITIONAL'
    )
      await configureRule(browser);
    const { visitor, deposit, token } = await bookGroup(browser, '22:00');
    await visitor.getByRole('button', { name: 'Paga la caparra con Satispay' }).click();
    await visitor.waitForURL(/satispay\.com/, { timeout: 60_000 });
    expect(
      sql(`select provider||'|'||status from public.reservation_deposits where id='${deposit}'`),
    ).toBe('SATISPAY|PENDING');
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/satispay-deposit-link.txt', `${visitor.url()}\n`);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    test.info().annotations.push({ type: 'next', description: 'pay the QR, then run again' });
    return;
  }

  // Satispay's callback normally settles it; the guest's status read re-reads Satispay otherwise.
  const token = readFileSync(tokenFile, 'utf8').trim();
  const key = anonKey();
  await expect
    .poll(
      async () => {
        await request.post(`${supabaseUrl}/functions/v1/reservation-deposit`, {
          headers: {
            apikey: key,
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          data: { action: 'status', deposit_id: pending, access_token: token },
        });
        return sql(`select r.status||'|'||d.status||'|'||d.amount_cents from public.reservation_deposits d
          join public.reservations r on r.id=d.reservation_id where d.id='${pending}'`);
      },
      { timeout: 120_000, intervals: [5000] },
    )
    .toBe('RESERVED|COMPLETED|2500');

  const reservation = sql(
    `select reservation_id from public.reservation_deposits where id='${pending}'`,
  );
  sql(`update public.reservations set status='ARRIVED' where id='${reservation}'`);
  sql(`update public.reservations set status='SEATED' where id='${reservation}'`);
  expect(action(pending)).toMatch(
    /^HONOURED\|REFUND_FULL\|(QUEUED|IN_FLIGHT|WAITING|COMPLETED)\|2500$/,
  );
  await expect
    .poll(
      async () => {
        await runReleaseWorker();
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return sql(`select d.status||'|'||d.refunded_amount_cents||'|'||a.state
          from public.reservation_deposits d join private.reservation_deposit_no_show_actions a
          on a.deposit_id=d.id where d.id='${pending}'`);
      },
      { timeout: 180_000, intervals: [1000] },
    )
    .toBe('REFUNDED|2500|COMPLETED');
});
