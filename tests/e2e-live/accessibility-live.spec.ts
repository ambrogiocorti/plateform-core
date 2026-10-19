import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ids, password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// WCAG 2.2 A/AA automated audit (axe-core, real Chromium) of the public site and of the main
// staff screens, on the disposable local stack with real data. Automated rules catch roughly
// a third of WCAG issues: keyboard paths and screen reader checks stay manual (see the report).

const publicBase = 'http://localhost:5173';
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Member = (typeof staff)[keyof typeof staff];

async function audit(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(tags).analyze();
  // Guard against an audit that silently checked nothing (blank page, wrong frame).
  expect(result.passes.length, label).toBeGreaterThan(10);
  return result.violations.map(
    (violation) =>
      `${label} · ${violation.id} (${violation.impact}): ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join(' | ')}`,
  );
}

async function signIn(page: Page, member: Member) {
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(member.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(
    page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`),
  ).toBeVisible();
}

test.beforeEach(async () => {
  await reset();
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`WCAG sito pubblico ${viewport.name}`, async ({ browser }) => {
    // Prenotazioni attive con un servizio, come in step11-booking-live, per verificare il modulo.
    sql(`update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}'`);
    sql(`update public.restaurant_profile
      set public_content=coalesce(public_content,'{}'::jsonb)||'{"privacy_url":"https://trattoria-e2e.example/privacy"}'::jsonb`);
    sql(`with s as (insert into public.services(venue_id,name,starts_at,ends_at)
        values('${ids.venue}','Cena','19:00','22:00') returning id,venue_id)
      insert into public.service_booking_rules(venue_id,service_id,max_covers_service,max_arrivals_per_slot,max_covers_per_slot)
      select venue_id,id,40,4,12 from s`);
    const page = await (
      await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    ).newPage();
    const violations: string[] = [];
    for (const path of [
      '/',
      '/menu',
      '/ristorante',
      '/gallery',
      '/contatti',
      '/sedi',
      '/prenota',
      '/pagina-inesistente',
    ]) {
      await page.goto(publicBase + path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      violations.push(...(await audit(page, path)));
    }
    expect(violations).toEqual([]);
  });
}

test('WCAG app staff: accesso e schermate principali per ruolo', async ({ browser }) => {
  const violations: string[] = [];
  const login = await (await browser.newContext()).newPage();
  await login.goto('/login');
  await expect(login.getByLabel('Identificativo staff')).toBeVisible();
  violations.push(...(await audit(login, 'login')));

  const screens: [Member, string[]][] = [
    [staff.waiter, ['/servizio', '/conti', '/consegne']],
    [staff.kitchen, ['/cucina']],
    [staff.pass, ['/pass']],
    [staff.cashier, ['/cassa', '/statistiche']],
    [
      staff.admin,
      [
        '/operazioni',
        '/sala',
        '/accoglienza',
        '/conflitti',
        '/gestione',
        '/menu-sede',
        '/sito',
        '/staff',
        '/dispositivi',
        '/stampe',
        '/privacy',
      ],
    ],
  ];
  for (const [member, paths] of screens) {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await signIn(page, member);
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      violations.push(...(await audit(page, `${member.role} ${path}`)));
    }
    await page.context().close();
  }
  expect(violations).toEqual([]);
});

test('tastiera: link per saltare al contenuto e focus visibile sul sito pubblico', async ({
  page,
}) => {
  await page.goto(`${publicBase}/menu`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Vai al contenuto' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
  // Il primo link successivo ha un indicatore di focus visibile.
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    const style = getComputedStyle(active);
    return {
      tag: active.tagName,
      outline: style.outlineStyle,
      width: style.outlineWidth,
      shadow: style.boxShadow,
    };
  });
  expect(outline.tag).not.toBe('BODY');
  expect(outline.outline !== 'none' || outline.shadow !== 'none').toBe(true);
});

test('tastiera: il link per saltare al contenuto porta il focus nell’app staff', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByLabel('Identificativo staff')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Vai al contenuto' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
  // Dal contenuto, il tasto Tab prosegue nell'ordine della pagina: marchio, poi il modulo.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Plateform' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Identificativo staff')).toBeFocused();
});
