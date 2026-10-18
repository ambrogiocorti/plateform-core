import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { password, staff } from '../stack/seed.mjs';
import { totp } from './totp';

export type Member = (typeof staff)[keyof typeof staff];

/**
 * One staff device: its own browser context (storage, GoTrue session, registered device).
 * Roles that require MFA enroll a TOTP factor on first login, exactly as a person would with an
 * authenticator app; the returned secret lets later steps compute fresh codes.
 */
export async function device(
  browser: Browser,
  member: Member,
): Promise<{ page: Page; totpSecret: string | null }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[${member.role}] pageerror`, error.message));
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(member.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  let totpSecret: string | null = null;
  const code = page.getByLabel('Codice di autenticazione');
  const signedIn = page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`);
  await expect(code.or(signedIn)).toBeVisible();
  if (await code.isVisible()) {
    await page.getByText('Inserimento manuale').click();
    totpSecret = (await page.locator('details code').textContent())!.trim();
    await code.fill(totp(totpSecret));
    await page.getByRole('button', { name: 'Verifica e accedi' }).click();
  }
  await expect(signedIn).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${member.landing}$`));
  return { page, totpSecret };
}

export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('main')).toBeVisible();
}
