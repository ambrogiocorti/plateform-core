import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { anonKey, ids, password, sql, stack, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// STEP 8 / §112 Conflict Center on the disposable local stack (real GoTrue, PostgREST,
// PostgreSQL). The offline rejection itself needs the offline-authorization Edge Function, which
// the stack does not serve, so the rejected CREATE_ORDER event and its conflict are written as
// the server would record them. Everything after that goes through the real UI and RPCs.

type Member = (typeof staff)[keyof typeof staff];

async function device(browser: Browser, member: Member): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[${member.role}] pageerror`, error.message));
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(member.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(
    page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`),
  ).toBeVisible();
  return page;
}

async function openAccount(waiter: Page, table: string, name: string) {
  await waiter.goto('/servizio');
  const card = waiter.locator('article.waiter-table-card', { hasText: table });
  await card.getByRole('button', { name: 'Nuovo conto' }).click();
  const account = waiter.getByRole('dialog', { name: `Nuovo conto · ${table}` });
  await account.getByLabel('Nome conto').fill(name);
  await account.getByLabel('Coperti').fill('2');
  await account.getByRole('button', { name: 'Crea conto' }).click();
  await expect(waiter.getByRole('dialog', { name: 'Conto aperto' })).toBeVisible();
  return sql(`select id from public.accounts where account_name='${name}'`);
}

const line = (dish: string, quantity: number, step: number) => ({
  dish_id: dish,
  quantity,
  step,
  removed_ingredients: [],
  variant_options: [],
});

// The rejected event and conflict exactly as the offline sync path stores them.
function rejectedOrder(account: string, items: ReturnType<typeof line>[], reason: string) {
  return sql(`with e as (
      insert into public.offline_sync_events(client_event_id,idempotency_key,user_id,device_id,venue_id,
        resource_type,resource_id,operation,base_version,payload,sync_status,created_at_local)
      select gen_random_uuid(),gen_random_uuid(),d.user_id,d.id,'${ids.venue}','accounts','${account}',
        'CREATE_ORDER',1,'${JSON.stringify({ items })}'::jsonb,'CONFLICT',now()-interval '5 minutes'
      from public.registered_devices d where d.user_id=(select id from auth.users where email='${staff.waiter.email}') order by d.last_seen_at desc nulls last limit 1
      returning id,venue_id)
    insert into public.sync_conflicts(venue_id,sync_event_id,reason_code,server_snapshot)
    select venue_id,id,'${reason}',jsonb_build_object('resource_type','accounts','resource_id','${account}','status','OPEN','version',1) from e
    returning id`);
}

const orderLines = (account: string) =>
  sql(`select coalesce(string_agg(i.quantity||'x'||i.dish_name||'@'||s.step_number||':'||o.origin,',' order by i.dish_name),'')
    from public.order_items i join public.orders o on o.id=i.order_id join public.order_steps s on s.id=i.step_id
    where o.account_id='${account}'`);

test.beforeEach(async () => {
  await reset();
});

test('Conflict Center: Annulla item e Modifica ordine reinviano l’ordine corretto, con audit', async ({
  browser,
}) => {
  const waiter = await device(browser, staff.waiter);
  const first = await openAccount(waiter, 'Tavolo 1', 'Famiglia Rossi');
  const second = await openAccount(waiter, 'Tavolo 2', 'Famiglia Bianchi');
  const removeItem = rejectedOrder(
    first,
    [line(ids.carbonara, 1, 1), line(ids.tiramisu, 1, 2)],
    'OUT_OF_STOCK',
  );
  const editOrder = rejectedOrder(second, [line(ids.carbonara, 1, 1)], 'VERSION_CONFLICT');

  const admin = await device(browser, staff.admin);
  await admin.goto('/conflitti');
  const outOfStock = admin.locator('section.card', {
    hasText: 'Disponibilità esaurita durante la sincronizzazione',
  });
  const rejected = outOfStock.getByRole('list', { name: 'Righe dell’ordine rifiutato' });
  await expect(rejected).toContainText('1 × Carbonara · step 1');
  await expect(rejected).toContainText('1 × Tiramisù · step 2');

  // Annulla item: l'ordine parte senza il Tiramisù e il conflitto si chiude nella stessa transazione.
  await rejected
    .getByRole('listitem')
    .filter({ hasText: 'Tiramisù' })
    .getByRole('button', { name: 'Annulla item' })
    .click();
  const confirm = admin.getByRole('dialog', { name: 'Annulla Tiramisù' });
  await expect(confirm).toContainText('senza Tiramisù');
  await confirm.getByRole('button', { name: 'Conferma' }).click();
  await expect(
    admin.getByText('Ordine corretto inviato alla cucina. Conflitto risolto.'),
  ).toBeVisible();
  expect(orderLines(first)).toBe('1xCarbonara@1:OFFLINE');
  expect(
    sql(
      `select status||':'||(resolution->>'action')||':'||(resolution->>'sent_lines') from public.sync_conflicts where id='${removeItem}'`,
    ),
  ).toBe('RESOLVED:CORRECTED:1');
  // The original offline event was never executed as sent.
  expect(
    sql(
      `select e.sync_status from public.offline_sync_events e join public.sync_conflicts c on c.sync_event_id=e.id where c.id='${removeItem}'`,
    ),
  ).toBe('CONFLICT');

  // Modifica ordine: dialogo precompilato con le righe inviate, l'Admin porta la Carbonara a 2.
  const versionConflict = admin.locator('section.card', {
    hasText: 'La risorsa è stata modificata da un altro dispositivo',
  });
  await versionConflict.getByRole('button', { name: 'Modifica ordine' }).click();
  const editor = admin.getByRole('dialog', { name: 'Modifica ordine' });
  const carbonara = editor.locator('article.menu-choice', { hasText: 'Carbonara' });
  await expect(carbonara.getByLabel('Quantità')).toHaveValue('1');
  await expect(
    editor.locator('article.menu-choice', { hasText: 'Tiramisù' }).getByLabel('Quantità'),
  ).toHaveValue('0');
  await carbonara.getByLabel('Quantità').fill('2');
  await editor.getByRole('button', { name: 'Invia ordine' }).click();
  // The earlier correction may still have its own toast; assert the latest
  // notification and independently verify the new order's server state below.
  await expect(
    admin.getByText('Ordine corretto inviato alla cucina. Conflitto risolto.').last(),
  ).toBeVisible();
  await expect.poll(() => orderLines(second)).toBe('2xCarbonara@1:OFFLINE');
  expect(sql(`select status from public.sync_conflicts where id='${editOrder}'`)).toBe('RESOLVED');
  await expect(admin.getByText('Nessun conflitto da risolvere.')).toBeVisible();

  expect(
    sql(
      `select count(*) from public.audit_log where action='OFFLINE_CONFLICT_CORRECTED' and resource_id in ('${removeItem}','${editOrder}')`,
    ),
  ).toBe('2');
  // Il cameriere vede l'ordine corretto sul conto.
  await waiter.goto(`/conti/${second}`);
  await expect(waiter.locator('main')).toContainText('Carbonara');
});

test('Conflict Center: annullare l’unica riga chiude il conflitto senza ordine; il server rifiuta altri ruoli', async ({
  browser,
}) => {
  const waiter = await device(browser, staff.waiter);
  const account = await openAccount(waiter, 'Tavolo 1', 'Tavolo solo');
  const conflict = rejectedOrder(account, [line(ids.tiramisu, 1, 1)], 'ACCOUNT_NOT_ORDERABLE');

  // A waiter session cannot correct the conflict, whatever the UI shows: same REST session.
  const request = waiter.waitForRequest((entry) => entry.url().includes('/rest/v1/'));
  await waiter.reload();
  const authorization = (await request).headers()['authorization']!;
  const denied = (
    await fetch(`${stack.gateway}/rest/v1/rpc/resolve_order_conflict`, {
      method: 'POST',
      headers: { apikey: anonKey, authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        p_conflict: conflict,
        p_items: [line(ids.tiramisu, 1, 1)],
        p_reason: 'tentativo',
        p_key: crypto.randomUUID(),
      }),
    })
  ).status;
  expect(denied).toBeGreaterThanOrEqual(400);
  expect(sql(`select status from public.sync_conflicts where id='${conflict}'`)).toBe('OPEN');

  const admin = await device(browser, staff.admin);
  await admin.goto('/conflitti');
  await admin.getByRole('button', { name: 'Annulla item' }).click();
  const confirm = admin.getByRole('dialog', { name: 'Annulla Tiramisù' });
  await expect(confirm).toContainText('È l’unica riga');
  await confirm.getByRole('button', { name: 'Conferma' }).click();
  await expect(admin.getByText('Ordine annullato. Conflitto chiuso.')).toBeVisible();
  expect(sql(`select status from public.sync_conflicts where id='${conflict}'`)).toBe('DISCARDED');
  expect(orderLines(account)).toBe('');
});
