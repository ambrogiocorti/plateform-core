import { expect, test } from '@playwright/test';
import { ids, sql, staff } from './stack.mjs';
import { licenseProvider, mfaDevice } from './flow';

// Reservation messaging worker on hosted staging: the SUPER_ADMIN licenses RESERVATION_MESSAGING
// with step-up, the venue sends EMAIL through the simulated MOCK adapter, and the scheduled
// dispatcher (public.invoke_reservation_message_worker) makes the Edge Function claim and settle
// the job. Staging runs MESSAGE_DELIVERY_MODE=dry_run, so a real provider is never contacted.
test.setTimeout(300_000);

async function workerResponse(): Promise<Record<string, unknown>> {
  const request = sql(`select (public.invoke_reservation_message_worker(5)->>'request_id')`);
  let body = '';
  await expect
    .poll(
      () =>
        (body = sql(
          `select status_code||'|'||content from net._http_response where id=${request}`,
        )),
      { timeout: 60_000 },
    )
    .toMatch(/^\d+\|/);
  const [status, ...content] = body.split('|');
  expect(status).toBe('200');
  return JSON.parse(content.join('|'));
}

test('messaggi prenotazioni: coda vuota IDLE, job MOCK inviato dal worker', async ({ browser }) => {
  sql(`update public.message_jobs set state='CANCELLED', cancelled_at=now(),
    last_error_code='E2E_RESET' where venue_id='${ids.venue}' and state in ('QUEUED','FAILED')`);
  expect(await workerResponse()).toMatchObject({ mode: 'dry_run', idle: true, claimed: 0 });

  const superAdmin = await mfaDevice(browser, staff.superAdmin);
  await licenseProvider(superAdmin, 'RESERVATION_MESSAGING');

  const reservation = sql(`select id from public.reservations where venue_id='${ids.venue}'
    and status='RESERVED' and not walk_in and anonymized_at is null order by created_at desc limit 1`);
  expect(reservation).not.toBe('');
  const job = sql(`
    insert into public.venue_features(venue_id,name,enabled) values('${ids.venue}','RESERVATION_MESSAGING',true)
      on conflict (venue_id,name) do update set enabled=true;
    insert into public.message_templates(venue_id,channel,template_key,body_template)
      values('${ids.venue}','EMAIL','e2e-conferma','Ciao {{customer_name}}, prenotazione confermata.')
      on conflict (venue_id,channel,template_key) do update set active=true;
    insert into public.message_provider_settings(venue_id,channel,adapter,enabled,confirmation_template)
      values('${ids.venue}','EMAIL','MOCK',true,'e2e-conferma')
      on conflict (venue_id,channel) do update set adapter='MOCK', enabled=true, confirmation_template='e2e-conferma';
    insert into private.reservation_message_contacts(reservation_id,channel,destination,verified_at,verification_source)
      values('${reservation}','EMAIL','cliente@e2e.test',now(),'CUSTOMER_PROVIDED')
      on conflict (reservation_id,channel) do update set verified_at=now(), preference_status='ALLOWED';
    select private.enqueue_reservation_message('${reservation}','RESERVATION_CONFIRMATION','EMAIL',
      now(),'e2e-msg-'||gen_random_uuid(),null);`);

  expect(await workerResponse()).toMatchObject({ mode: 'dry_run', claimed: 1, sent: 1, failed: 0 });
  expect(
    sql(
      `select state||'|'||adapter||'|'||provider_message_id||'|'||attempts from public.message_jobs where id='${job}'`,
    ),
  ).toBe(`SENT|MOCK|mock:${job}|1`);
});
