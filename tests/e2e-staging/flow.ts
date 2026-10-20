import { createHmac } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { password, sql, staff } from './stack.mjs';

// Shared steps of the staging suite: one browser context per staff device, the cash day and
// the table reset (staging is persistent, so every spec leaves the restaurant as it found it).

export type Member = { email: string; name: string; role: string; landing: string };

export async function device(browser: Browser, member: Member): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[${member.role}] pageerror`, error.message));
  // Server refusals are logged with their code, so a failed run says why.
  page.on('response', async (response) => {
    if (response.status() >= 400 && /\/rest\/v1\/rpc\/|\/functions\/v1\//.test(response.url()))
      console.log(
        `[${member.role}] ${response.status()} ${new URL(response.url()).pathname}`,
        (await response.text().catch(() => '')).slice(0, 200),
      );
  });
  await login(page, member);
  await expect(page).toHaveURL(new RegExp(`${member.landing}$`));
  return page;
}

// Hosted GoTrue limits password sign-ins per IP (HTTP 429). A suite logs in many staff members
// from one machine, so a refused login waits for the window and tries again.
async function login(page: Page, member: Member) {
  const signedIn = page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`);
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    const watch = (response: { url(): string; status(): number }) => {
      if (response.url().includes('/auth/v1/token')) status = response.status();
    };
    page.on('response', watch);
    await page.goto('/login');
    await page.getByLabel('Identificativo staff').fill(member.email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Accedi al servizio' }).click();
    const refused = page.getByRole('alert').filter({ hasText: /\S/ });
    await expect(signedIn.or(refused)).toBeVisible({ timeout: 30_000 });
    page.off('response', watch);
    if (await signedIn.isVisible()) return;
    if (attempt === 4 || status !== 429) await expect(signedIn).toBeVisible();
    console.log(`[${member.role}] login rate-limited (429), retrying in 60s`);
    await page.waitForTimeout(60_000);
  }
}

function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}

export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** Login of a member who must pass TOTP (ADMIN, SUPER_ADMIN): a fresh factor is enrolled. */
export async function mfaDevice(browser: Browser, member: Member): Promise<Page> {
  sql(
    `delete from auth.mfa_factors where user_id=(select id from auth.users where email='${member.email}')`,
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[${member.role}] pageerror`, error.message));
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(member.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await page.getByText('Inserimento manuale').click();
  const secret = (await page.locator('details code').textContent())!.trim();
  const signedIn = page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`);
  // GoTrue also rate-limits MFA verifications per IP: a refused attempt waits and retries
  // with a fresh code.
  for (let attempt = 1; ; attempt++) {
    await page.getByLabel('Codice di autenticazione').fill(totp(secret));
    await page.getByRole('button', { name: 'Verifica e accedi' }).click();
    const refused = page.getByRole('alert').filter({ hasText: /\S/ });
    await expect(signedIn.or(refused).first()).toBeVisible({ timeout: 30_000 });
    if ((await signedIn.isVisible()) || attempt === 3) break;
    console.log(`[${member.role}] MFA verification refused, retrying in 60s`);
    await page.waitForTimeout(60_000);
  }
  await expect(signedIn).toBeVisible();
  return page;
}

export async function open(page: Page, path: string) {
  // Over the internet a page load can hit a transient API error; the app then offers
  // "Riprova", and so does the test (at most three loads).
  for (let attempt = 0; ; attempt++) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    const failed = page.getByText('Accesso momentaneamente non disponibile');
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    if (attempt === 2 || !(await failed.isVisible())) return;
  }
}

export async function expandOperations(cashier: Page) {
  const operations = cashier.locator('details.cashier-operations');
  await expect(operations).toBeVisible();
  if ((await operations.getAttribute('open')) === null) await operations.locator('summary').click();
}

// Fine giornata: quadratura del servizio contabile (contante = fondo iniziale) e chiusura della
// postazione. A day left open by a previous failed run is closed first.
export async function closeDay(cashier: Page) {
  await open(cashier, '/cassa');
  await expandOperations(cashier);
  await expect(cashier.locator('article', { hasText: 'Cassa sala' })).toBeVisible();
  const closing = cashier.getByRole('button', { name: 'Quadratura e chiusura' });
  if (await closing.count()) {
    await closing.first().click();
    const dialog = cashier.getByRole('dialog', { name: 'Chiudi servizio contabile' });
    await dialog.getByLabel('Contante reale contato').fill('100,00');
    await dialog.getByRole('button', { name: 'Conferma conteggio e chiudi' }).click();
    await expect(cashier.getByText('Servizio chiuso e quadratura salvata.')).toBeVisible();
    await open(cashier, '/cassa');
    await expandOperations(cashier);
  }
  const registerCard = cashier.locator('article', { hasText: 'Cassa sala' });
  const closeRegister = registerCard.getByRole('button', { name: 'Chiudi postazione' });
  if (await closeRegister.count()) {
    await closeRegister.click();
    await expect(registerCard.getByRole('button', { name: 'Apri postazione' })).toBeVisible();
  }
}

export async function openDay(cashier: Page) {
  await open(cashier, '/cassa');
  await expect(cashier.locator('details.cashier-operations')).toHaveAttribute('open', '');
  const registerCard = cashier.locator('article', { hasText: 'Cassa sala' });
  await registerCard.getByRole('button', { name: 'Apri postazione' }).click();
  await registerCard.getByRole('button', { name: 'Apri servizio contabile' }).click();
  const serviceDialog = cashier.getByRole('dialog', { name: 'Apri servizio · Cassa sala' });
  await serviceDialog.getByLabel('Fondo iniziale').fill('100,00');
  await serviceDialog.getByRole('button', { name: 'Apri servizio' }).click();
  await expect(cashier.getByText('Servizio di cassa aperto.')).toBeVisible();
}

/** An empty account left open by an interrupted run is closed (nothing was ordered on it). */
export async function closeEmptyAccounts(cashier: Page) {
  const leftovers = sql(`select a.id from public.accounts a where a.status='OPEN'
    and not exists(select 1 from public.orders o where o.account_id=a.id)`);
  for (const id of leftovers.split('\n').filter(Boolean)) {
    await open(cashier, `/conti/${id}`);
    await cashier.getByRole('button', { name: 'Chiudi conto' }).click();
    await cashier
      .getByRole('dialog', { name: 'Conferma chiusura conto' })
      .getByRole('button', { name: 'Conferma chiusura' })
      .click();
    await expect(cashier.getByText('Conto chiuso.')).toBeVisible();
  }
}

// A closed table is TO_RESET until the waiter confirms it is set again for new guests.
export async function resetTable(waiter: Page) {
  await open(waiter, '/servizio');
  const card = waiter.locator('article.waiter-table-card', { hasText: 'Tavolo 1' });
  const reset = card.getByRole('button', { name: 'Tavolo riapparecchiato' });
  const ready = card.getByRole('button', { name: 'Nuovo conto' });
  await expect(reset.or(ready)).toBeVisible();
  if (await reset.isVisible()) {
    await reset.click();
    await expect(waiter.getByText('Tavolo 1: pronto per nuovi clienti.')).toBeVisible();
  }
  await expect(ready).toBeVisible();
}

/** Waiter opens Tavolo 1 and orders 2 Carbonara + 1 Tiramisù (34,50 €); returns the account. */
export async function orderAtTable(waiter: Page, name: string): Promise<string> {
  await open(waiter, '/servizio');
  const tableCard = waiter.locator('article.waiter-table-card', { hasText: 'Tavolo 1' });
  await tableCard.getByRole('button', { name: 'Nuovo conto' }).click();
  const accountDialog = waiter.getByRole('dialog', { name: 'Nuovo conto · Tavolo 1' });
  await accountDialog.getByLabel('Nome conto').fill(name);
  await accountDialog.getByLabel('Coperti').fill('3');
  await accountDialog.getByRole('button', { name: 'Crea conto' }).click();
  const created = waiter.getByRole('dialog', { name: 'Conto aperto' });
  await expect(created).toBeVisible();
  await created.getByRole('button', { name: 'Aggiungi piatti' }).click();
  const order = waiter.getByRole('dialog', { name: 'Nuovo ordine' });
  await order
    .locator('article.menu-choice', { hasText: 'Carbonara' })
    .getByLabel('Quantità')
    .fill('2');
  await order
    .locator('article.menu-choice', { hasText: 'Tiramisù' })
    .getByLabel('Quantità')
    .fill('1');
  await expect(order.getByText('3 pietanze selezionate')).toBeVisible();
  await order.getByRole('button', { name: 'Invia ordine' }).click();
  await expect(waiter.getByText('Ordine inviato alla cucina.')).toBeVisible();
  await expect(waiter).toHaveURL(/\/conti\/[0-9a-f-]{36}$/);
  return waiter.url().split('/').at(-1)!;
}

/**
 * Kitchen prepares, Pass releases, waiter delivers the whole order of Tavolo 1. Each stage is
 * skipped when an interrupted run already completed it.
 */
export async function serveOrder(waiter: Page, kitchen: Page, pass: Page) {
  const stage = () =>
    sql(`select string_agg(distinct i.status::text, ',') from public.order_items i
      join public.orders o on o.id=i.order_id join public.accounts a on a.id=o.account_id
      where a.status<>'CLOSED' and a.table_id='40000000-0000-4000-8000-0000000000e4'`);
  if (!/^READY$|SERVED|DELIVER/.test(stage())) {
    await open(kitchen, '/cucina');
    for (const dish of ['2 × Carbonara', '1 × Tiramisù']) {
      const line = kitchen.locator('section.kitchen-line', { hasText: dish });
      const start = line.getByRole('button', { name: 'RICEVUTO → PREPARA' });
      const ready = line.getByRole('button', { name: 'SEGNA PRONTO' });
      await expect(start.or(ready).or(line.getByText('READY'))).toBeVisible();
      if (await start.isVisible()) {
        await start.click();
        await expect(ready).toBeVisible();
      }
      if (await ready.isVisible()) await ready.click();
      await expect(line.getByText('READY')).toBeVisible();
    }
  }
  await open(pass, '/pass');
  const release = pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' });
  await expect(
    release.or(pass.getByText('Pass libero')).or(pass.locator('.kds-ticket-meta')).first(),
  ).toBeVisible();
  if (await release.isVisible()) {
    await expect(pass.getByText('2/2 piatti pronti')).toBeVisible();
    await release.click();
    await expect(release).toHaveCount(0);
  }
  await open(waiter, '/servizio');
  const delivery = waiter.locator('article.waiter-delivery-card', { hasText: 'Tavolo 1' });
  const take = delivery.getByRole('button', { name: 'Prendi in carico' });
  const confirm = delivery.getByRole('button', { name: 'Conferma consegna al tavolo' });
  await expect(take.or(confirm)).toBeVisible();
  if (await take.isVisible()) {
    await take.click();
    await expect(waiter.getByText('Tavolo 1: consegna presa in carico.')).toBeVisible();
  }
  await confirm.click();
  await waiter.getByRole('button', { name: 'Sì, piatti consegnati' }).click();
  await expect(waiter.getByText('Tavolo 1: step servito.')).toBeVisible();
}

/**
 * Re-enters the password in the step-up dialog (sensitive actions). The step-up Edge Function
 * allows 5 confirmations per user and IP every 10 minutes, so back-to-back suite runs must be
 * spaced out.
 */
export async function stepUp(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Conferma la tua identità' });
  await dialog.getByLabel('La tua password').fill(password);
  await dialog.getByRole('button', { name: 'Conferma identità' }).click();
}

export async function licenseProvider(page: Page, name: 'STRIPE' | 'SATISPAY_API') {
  if (sql(`select licensed from public.feature_flags where name='${name}'`) === 'true') return;
  await open(page, '/salute');
  const row = page
    .locator('section', { hasText: 'Licenze dell’installazione' })
    .locator('div.row')
    .filter({ has: page.getByText(name, { exact: true }) });
  await row.getByRole('button', { name: 'Attiva licenza' }).click();
  await page.getByRole('button', { name: 'Conferma con password' }).click();
  await stepUp(page);
  await expect(row.getByRole('button', { name: 'Disattiva licenza' })).toBeVisible();
  expect(sql(`select licensed from public.feature_flags where name='${name}'`)).toBe('true');
}

/**
 * A Tavolo 1 account with the served 34,50 € order, ready to be paid. Staging keeps its state,
 * so an account left unpaid by an interrupted run is reused (and served if still in kitchen).
 */
export async function servedAccount(
  pages: { waiter: Page; kitchen: Page; pass: Page; cashier: Page },
  name: string,
): Promise<string> {
  const { waiter, kitchen, pass, cashier } = pages;
  let account = sql(`select a.id from public.accounts a where a.status<>'CLOSED'
    and exists(select 1 from public.orders o where o.account_id=a.id)
    and not exists(select 1 from public.payments p where p.account_id=a.id) limit 1`);
  if (!account) {
    await closeEmptyAccounts(cashier);
    await closeDay(cashier);
    await resetTable(waiter);
  }
  if (sql(`select status from public.cash_registers where code='R1'`) === 'CLOSED')
    await openDay(cashier);
  if (!account) account = await orderAtTable(waiter, name);
  const unserved = sql(`select count(*) from public.order_items i join public.orders o
    on o.id=i.order_id where o.account_id='${account}' and i.status<>'SERVED'`);
  if (unserved !== '0') await serveOrder(waiter, kitchen, pass);
  await expect(async () => {
    await open(cashier, `/conti/${account}`);
    await expect(cashier.getByText('34,50 €').first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  return account;
}

export { staff };
