import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { active, reset } from './stack/active.mjs';
import { staff } from './stack/seed.mjs';
import { device, open } from './support/devices';

// Live propagation between devices through Supabase Realtime (postgres_changes on
// realtime_signals, filtered by RLS per subscriber). No device reloads after the first render,
// and every wait is shorter than the app's 30 s safety polling, so only Realtime can explain it.
test.skip(active.mode !== 'supabase', 'Realtime is served only by the Supabase CLI stack');

const live = { timeout: 10_000 };

function countNavigations(page: Page) {
  const counter = { value: 0 };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) counter.value += 1;
  });
  return counter;
}

test.beforeEach(async () => {
  await reset();
});

test('ordine, cucina, Pass e consegna si aggiornano in tempo reale sugli altri dispositivi', async ({
  browser,
}) => {
  const [{ page: waiter }, { page: kitchen }, { page: pass }] = await Promise.all([
    device(browser, staff.waiter),
    device(browser, staff.kitchen),
    device(browser, staff.pass),
  ]);
  await open(kitchen, '/cucina');
  await open(pass, '/pass');
  await open(waiter, '/servizio');
  for (const page of [waiter, kitchen, pass])
    await expect(page.locator('#connection-state')).toHaveText('Aggiornamenti connessi', live);
  await expect(kitchen.getByText('Nessuna comanda in attesa')).toBeVisible();
  const kitchenNavigations = countNavigations(kitchen);
  const passNavigations = countNavigations(pass);

  // Il cameriere apre il conto e ordina: la cucina riceve la comanda senza ricaricare.
  const tableCard = waiter.locator('article.waiter-table-card', { hasText: 'Tavolo 2' });
  await tableCard.getByRole('button', { name: 'Nuovo conto' }).click();
  const accountDialog = waiter.getByRole('dialog', { name: 'Nuovo conto · Tavolo 2' });
  await accountDialog.getByLabel('Nome conto').fill('Verdi');
  await accountDialog.getByLabel('Coperti').fill('2');
  await accountDialog.getByRole('button', { name: 'Crea conto' }).click();
  await waiter
    .getByRole('dialog', { name: 'Conto aperto' })
    .getByRole('button', { name: 'Aggiungi piatti' })
    .click();
  const order = waiter.getByRole('dialog', { name: 'Nuovo ordine' });
  await order
    .locator('article.menu-choice', { hasText: 'Carbonara' })
    .getByLabel('Quantità')
    .fill('1');
  await order.getByRole('button', { name: 'Invia ordine' }).click();
  await expect(waiter.getByText('Ordine inviato alla cucina.')).toBeVisible();

  const line = kitchen.locator('section.kitchen-line', { hasText: '1 × Carbonara' });
  await expect(line).toBeVisible(live);
  await expect(pass.getByText('0/1 piatti pronti')).toBeVisible(live);

  // La cucina prepara: il Pass vede il piatto pronto e lo step completo.
  await line.getByRole('button', { name: 'RICEVUTO → PREPARA' }).click();
  await line.getByRole('button', { name: 'SEGNA PRONTO' }).click();
  await expect(pass.getByText('1/1 piatti pronti')).toBeVisible(live);

  // Il Pass libera lo step: il cameriere vede la consegna da fare.
  await open(waiter, '/servizio');
  const waiterNavigations = countNavigations(waiter);
  await pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' }).click();
  await expect(waiter.locator('article.waiter-delivery-card', { hasText: 'Tavolo 2' })).toBeVisible(
    live,
  );

  expect(kitchenNavigations.value).toBe(0);
  expect(passNavigations.value).toBe(0);
  expect(waiterNavigations.value).toBe(0);
});

test('Realtime rispetta RLS: ogni ruolo riceve solo i segnali che può leggere', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { session } = await import('./support/api');
  const { ids } = await import('./stack/seed.mjs');
  const listen = async (member: (typeof staff)[keyof typeof staff]) => {
    const { token } = await session(member);
    const client = createClient(active.supabaseUrl, active.anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.realtime.setAuth(token);
    const topics: string[] = [];
    await new Promise<void>((resolve, reject) => {
      client
        .channel(`rls-${member.role}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'realtime_signals',
            filter: `venue_id=eq.${ids.venue}`,
          },
          (payload) => topics.push(String((payload.new as { topic: string }).topic)),
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') resolve();
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status));
        });
    });
    return { topics, client };
  };
  const kitchen = await listen(staff.kitchen);
  const cashier = await listen(staff.cashier);
  // Realtime authorizes a subscription a moment after SUBSCRIBED; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const waiter = await session(staff.waiter);
  const account = (
    await waiter.call('create_account', {
      p_table: ids.table1,
      p_name: 'Bassi',
      p_covers: 2,
      p_note: null,
      p_key: crypto.randomUUID(),
    })
  ).body as { id: string };
  const { sql } = await import('./stack/seed.mjs');
  const version = Number(sql(`select version from public.accounts where id='${account.id}'`));
  await waiter.call('create_order', {
    p_account: account.id,
    p_items: [
      {
        dish_id: ids.carbonara,
        quantity: 1,
        step: 1,
        removed_ingredients: [],
        variant_options: [],
      },
    ],
    p_key: crypto.randomUUID(),
    p_version: version,
  });

  await expect.poll(() => kitchen.topics, live).toContain('KITCHEN');
  await expect.poll(() => cashier.topics, live).toContain('ACCOUNT');
  // Eventi dello stesso ordine che la cucina non può leggere non le vengono mai consegnati.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(kitchen.topics).not.toContain('ACCOUNT');
  expect(kitchen.topics).not.toContain('FINANCE');
  expect(sql(`select count(*) from public.realtime_signals where topic='ACCOUNT'`)).not.toBe('0');
  await kitchen.client.removeAllChannels();
  await cashier.client.removeAllChannels();
});
