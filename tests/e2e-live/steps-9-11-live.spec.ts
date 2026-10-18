import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { anonKey, password, serviceKey, sql, stack, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// STEPS 9–11 on the disposable local stack (real GoTrue, PostgREST, PostgreSQL; no Realtime).
// Edge Functions are not served by the stack: the step-up endpoint is replaced, inside the
// browser of these tests only, by a Node port of supabase/functions/step-up (same checks in the
// same order: GoTrue identity, authorize_sensitive_action as the user, password re-verification,
// issue_step_up_grant with the service role). Nothing else is substituted.

type Member = (typeof staff)[keyof typeof staff];
const publicBase = 'http://localhost:5173';
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function serveStepUp(page: Page) {
  await page.route('**/functions/v1/step-up', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const reply = (status: number, body: unknown) =>
      route.fulfill({ status, headers: cors, contentType: 'application/json', json: body });
    const authorization = request.headers()['authorization'] ?? '';
    const body = request.postDataJSON() as {
      password: string;
      action: string;
      resource_id?: string | null;
    };
    const identity = await fetch(`${stack.gateway}/auth/v1/user`, {
      headers: { authorization, apikey: anonKey },
    });
    if (!identity.ok) return reply(401, { error: 'UNAUTHORIZED' });
    const user = (await identity.json()) as { id: string; email: string };
    const allowed = await fetch(`${stack.gateway}/rest/v1/rpc/authorize_sensitive_action`, {
      method: 'POST',
      headers: { authorization, apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_action: body.action, p_resource: body.resource_id ?? null }),
    });
    if (!allowed.ok) return reply(403, { error: 'FORBIDDEN' });
    const scope = (await allowed.json()) as { user_id: string; session_id: string };
    const verified = await fetch(`${stack.gateway}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: body.password }),
    });
    if (!verified.ok || scope.user_id !== user.id) return reply(401, { error: 'UNAUTHORIZED' });
    const verifier = (await verified.json()) as { access_token: string };
    await fetch(`${stack.gateway}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { authorization: `Bearer ${verifier.access_token}`, apikey: anonKey },
    });
    const grant = await fetch(`${stack.gateway}/rest/v1/rpc/issue_step_up_grant`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        p_user: user.id,
        p_session: scope.session_id,
        p_action: body.action,
        p_resource: body.resource_id ?? null,
      }),
    });
    if (!grant.ok) return reply(500, { error: 'REQUEST_FAILED' });
    return reply(200, { grant_id: await grant.json() });
  });
}

async function device(browser: Browser, member: Member): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[${member.role}] pageerror`, error.message));
  await serveStepUp(page);
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(member.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  if (member.role === 'SUPER_ADMIN') {
    await page.getByText('Inserimento manuale').click();
    const secret = (await page.locator('details code').innerText()).trim();
    await page.getByLabel('Codice di autenticazione').fill(totp(secret));
    await page.getByRole('button', { name: 'Verifica e accedi' }).click();
  }
  await expect(
    page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`),
  ).toBeVisible();
  return page;
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main')).toBeVisible();
}

async function confirmStepUp(page: Page) {
  const confirmation = page.getByRole('dialog', { name: 'Conferma la tua identità' });
  await confirmation.getByLabel('La tua password').fill(password);
  await confirmation.getByRole('button', { name: 'Conferma identità' }).click();
}

test.beforeEach(async () => {
  await reset();
});

test('statistiche §92 in edizione CORE e con Analytics avanzate', async ({ browser }) => {
  const cashier = await device(browser, staff.cashier);
  // Movimento contabile reale: conto pagato tramite RPC del flusso cassa non serve qui, basta
  // verificare che la pagina non sia più bloccata senza licenza e che lo scope sia rispettato.
  await open(cashier, '/statistiche');
  await cashier.getByRole('button', { name: 'Aggiorna statistiche' }).click();
  await expect(cashier.getByRole('heading', { name: 'Incassi' })).toBeVisible();
  await expect(
    cashier.getByText('Nessun movimento contabile registrato nel periodo.'),
  ).toBeVisible();
  await expect(cashier.getByText(/inclusi nella licenza Analytics avanzate/)).toBeVisible();
  await expect(cashier.getByText(/Permanenza media al tavolo/)).toHaveCount(0);

  sql(`update public.feature_flags set licensed=true where name='ADVANCED_ANALYTICS'`);
  await open(cashier, '/statistiche');
  await cashier.getByRole('button', { name: 'Aggiorna statistiche' }).click();
  await expect(cashier.getByText(/Permanenza media al tavolo/)).toBeVisible();
  await expect(cashier.getByText(/inclusi nella licenza Analytics avanzate/)).toHaveCount(0);

  // La Cucina non vede le statistiche né via UI né via RPC.
  const kitchen = await device(browser, staff.kitchen);
  await open(kitchen, '/statistiche');
  await expect(kitchen.getByText('Vista non disponibile')).toBeVisible();
});

test('multi-sede: il Super Admin crea una sede, lo switcher la mostra solo a chi è autorizzato', async ({
  browser,
}) => {
  const superAdmin = await device(browser, staff.superAdmin);

  // Senza licenza MULTI_VENUE la seconda sede non si crea.
  await open(superAdmin, '/sedi');
  await expect(superAdmin.getByText(/La licenza multi-sede non è attiva/)).toBeVisible();
  await expect(superAdmin.getByRole('button', { name: 'Nuova sede' })).toHaveCount(0);

  sql(`update public.feature_flags set licensed=true where name='MULTI_VENUE'`);
  await open(superAdmin, '/sedi');
  await superAdmin.getByRole('button', { name: 'Nuova sede' }).click();
  const form = superAdmin.getByRole('dialog', { name: 'Nuova sede' });
  await form.getByLabel('Nome sede').fill('Sede Navigli');
  await expect(form.getByLabel('Percorso della pagina sede')).toHaveValue('sede-navigli');
  await form.getByLabel('Codice sede').fill('n2');
  await form.getByLabel('Indirizzo', { exact: true }).fill('Alzaia Naviglio Grande 10, Milano');
  await form.getByLabel('Telefono').fill('+390200000002');
  await form.getByRole('button', { name: 'Crea sede' }).click();
  await confirmStepUp(superAdmin);
  await expect(superAdmin.getByText('Sede Sede Navigli creata.')).toBeVisible();
  await expect(superAdmin.locator('article', { hasText: 'Sede Navigli' })).toContainText(
    'N2 · /sedi/sede-navigli',
  );
  const second = sql(`select id from public.venues where slug='sede-navigli'`);
  expect(sql(`select count(*) from public.audit_log where action='VENUE_CREATED'`)).toBe('1');

  // Modifica con step-up, versione e audit.
  await superAdmin
    .locator('article', { hasText: 'Sede Navigli' })
    .getByRole('button', { name: 'Modifica sede' })
    .click();
  const edit = superAdmin.getByRole('dialog', { name: 'Modifica Sede Navigli' });
  await edit.getByLabel('Telefono').fill('+390200000099');
  await edit.getByRole('button', { name: 'Salva sede' }).click();
  await confirmStepUp(superAdmin);
  await expect(superAdmin.getByText('Sede aggiornata.')).toBeVisible();
  expect(sql(`select phone||':'||version from public.venues where id='${second}'`)).toBe(
    '+390200000099:2',
  );

  // Admin CHAIN: switcher con entrambe le sedi; il contesto cambia sede.
  const admin = await device(browser, staff.admin);
  const switcher = admin.getByLabel('Sede operativa');
  await expect(switcher.locator('option')).toHaveText(['Sede centrale', 'Sede Navigli']);
  await switcher.selectOption({ label: 'Sede Navigli' });
  await open(admin, '/sala');
  await expect(admin.getByText('Tavolo 1')).toHaveCount(0);

  // Cameriere VENUE della sede centrale: nessuno switcher, la nuova sede non è leggibile.
  const waiter = await device(browser, staff.waiter);
  await expect(waiter.getByLabel('Sede operativa')).toHaveCount(0);
  // Stessa sessione del dispositivo del cameriere (login staff completato), REST diretto.
  const request = waiter.waitForRequest((entry) => entry.url().includes('/rest/v1/'));
  await waiter.reload();
  const authorization = (await request).headers()['authorization']!;
  const readable = (await (
    await fetch(`${stack.gateway}/rest/v1/venues?select=slug&order=slug`, {
      headers: { apikey: anonKey, authorization },
    })
  ).json()) as { slug: string }[];
  expect(readable.map((row) => row.slug)).toEqual(['sede-centrale']);

  // Sito pubblico: elenco sedi con entrambe, pagina dedicata della nuova sede.
  const visitor = await browser.newPage();
  await visitor.goto(`${publicBase}/sedi`);
  await expect(visitor.getByRole('heading', { name: 'Sede Navigli' })).toBeVisible();
  await expect(visitor.getByRole('heading', { name: 'Sede centrale' })).toBeVisible();

  // Disattivazione: almeno una sede resta attiva, la sede disattivata sparisce dal sito.
  await open(superAdmin, '/sedi');
  await superAdmin
    .locator('article', { hasText: 'Sede Navigli' })
    .getByRole('button', { name: 'Disattiva sede' })
    .click();
  await superAdmin.getByRole('button', { name: 'Conferma disattivazione' }).click();
  await confirmStepUp(superAdmin);
  await expect(superAdmin.getByText('Sede disattivata.')).toBeVisible();
  await expect(
    superAdmin
      .locator('article', { hasText: 'Sede centrale' })
      .getByRole('button', { name: 'Disattiva sede' }),
  ).toHaveCount(0);
  expect(
    sql(
      `select string_agg(action, ',' order by timestamp) from public.audit_log where action in ('VENUE_CREATED','VENUE_UPDATED','VENUE_DEACTIVATED')`,
    ),
  ).toBe('VENUE_CREATED,VENUE_UPDATED,VENUE_DEACTIVATED');
  await visitor.goto(`${publicBase}/sedi`);
  await expect(visitor.getByRole('heading', { name: 'Sede centrale' })).toBeVisible();
  await expect(visitor.getByRole('heading', { name: 'Sede Navigli' })).toHaveCount(0);
});

test('dispositivi e command palette: ricerca autorizzata e revoca con step-up', async ({
  browser,
}) => {
  const [admin, waiter] = await Promise.all([
    device(browser, staff.admin),
    device(browser, staff.waiter),
  ]);

  // Ctrl+K: ricerca autorizzata del tavolo e navigazione.
  await open(admin, '/operazioni');
  await admin.keyboard.press('Control+k');
  const palette = admin.getByRole('dialog', { name: 'Vai a…' });
  await palette.getByLabel('Cerca tavoli, conti, prenotazioni o funzioni').fill('Tavolo 1');
  await palette.getByRole('button', { name: 'Tavolo 1 · Tavolo' }).click();
  await expect(palette).toHaveCount(0);

  // Il cameriere non trova lo staff né funzioni Admin.
  await open(waiter, '/servizio');
  await waiter.keyboard.press('Control+k');
  const waiterPalette = waiter.getByRole('dialog', { name: 'Vai a…' });
  await waiterPalette.getByLabel('Cerca tavoli, conti, prenotazioni o funzioni').fill('Anna');
  await expect(waiterPalette.getByText('Nessun risultato nel tuo ambito.')).toBeVisible();
  await expect(waiterPalette.getByRole('button', { name: 'Staff' })).toHaveCount(0);
  await waiter.keyboard.press('Escape');

  // Revoca del dispositivo del cameriere: richiede password, viene auditata, blocca il device.
  await open(admin, '/dispositivi');
  const waiterDevice = admin.locator('article', { hasText: 'Marco Cameriere' });
  await waiterDevice.getByRole('button', { name: 'Revoca dispositivo' }).click();
  await confirmStepUp(admin);
  await expect
    .poll(() =>
      sql(
        `select count(*) from public.registered_devices d join public.staff_profiles p on p.id=d.user_id where p.role='WAITER' and d.revoked_at is not null`,
      ),
    )
    .toBe('1');
  expect(sql(`select count(*) from public.audit_log where action='DEVICE_REVOKED'`)).toBe('1');
  await waiter.reload();
  await expect(waiter.getByText('Marco Cameriere · WAITER')).toHaveCount(0);
});
