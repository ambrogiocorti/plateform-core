import { expect, test } from '@playwright/test';
import { anonKey, password, serviceKey, stack, staff } from './stack/seed.mjs';

// A recovery e-mail (the first technical account on a fresh install gets one) must land on a page
// that sets the password, and the person must then sign in through the normal login.
const member = staff.cashier;
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${stack.gateway}/auth/v1/admin/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  });

test('a recovery link sets a new password, then the normal login works', async ({ page }) => {
  const response = await admin('generate_link', {
    method: 'POST',
    body: JSON.stringify({
      type: 'recovery',
      email: member.email,
      redirect_to: 'http://localhost:5174/',
    }),
  });
  expect(response.ok).toBe(true);
  const link = (await response.json()) as {
    hashed_token: string;
    id?: string;
    user?: { id: string };
  };
  const userId = link.user?.id ?? link.id;
  // The local gateway does not serve GoTrue's browser /verify redirect, so verify the token as
  // that redirect would and land on the staff app with the same fragment GoTrue appends.
  const verified = await fetch(`${stack.gateway}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'recovery', token_hash: link.hashed_token }),
  });
  expect(verified.ok).toBe(true);
  const session = (await verified.json()) as { access_token: string; refresh_token: string };
  const fragment = new URLSearchParams({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: '3600',
    token_type: 'bearer',
    type: 'recovery',
  });
  const next = `Nuova-Password-${Date.now()}`;
  try {
    await page.goto(`http://localhost:5174/#${fragment}`);
    await expect(page.getByRole('heading', { name: 'Scegli la tua password' })).toBeVisible();
    expect(page.url()).not.toContain('access_token');
    await page.getByLabel('Nuova password').fill(next);
    await page.getByLabel('Ripeti la password').fill('diversa-dalla-prima');
    await page.getByRole('button', { name: 'Salva la password' }).click();
    await expect(page.getByRole('heading', { name: 'Scegli la tua password' })).toBeVisible();
    await page.getByLabel('Ripeti la password').fill(next);
    await page.getByRole('button', { name: 'Salva la password' }).click();
    await expect(page.getByText('Password salvata.')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Identificativo staff').fill(member.email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Accedi al servizio' }).click();
    await expect(page.getByText('Credenziali non valide.')).toBeVisible();
    await page.getByLabel('Password').fill(next);
    await page.getByRole('button', { name: 'Accedi al servizio' }).click();
    await expect(page).toHaveURL(new RegExp(`${member.landing}$`));
  } finally {
    // Leave the seeded credential as the rest of the suite expects it.
    if (userId)
      await admin(`users/${userId}`, { method: 'PUT', body: JSON.stringify({ password }) });
  }
});

test('an expired e-mail link says so instead of showing the login', async ({ page }) => {
  await page.goto('http://localhost:5174/#error=access_denied&error_code=otp_expired');
  await expect(page.getByRole('heading', { name: 'Link scaduto' })).toBeVisible();
  expect(page.url()).not.toContain('error_code');
});

test('a token link survives a mail scanner and is redeemed only by the button', async ({
  browser,
  page,
}) => {
  const response = await admin('generate_link', {
    method: 'POST',
    body: JSON.stringify({ type: 'recovery', email: member.email }),
  });
  expect(response.ok).toBe(true);
  const link = (await response.json()) as {
    hashed_token: string;
    id?: string;
    user?: { id: string };
  };
  const userId = link.user?.id ?? link.id;
  const url = `http://localhost:5174/?token_hash=${link.hashed_token}&type=recovery`;
  const next = `Nuova-Password-${Date.now()}`;
  try {
    // A scanner opens the link without pressing anything.
    const scanner = await browser.newContext();
    const scan = await scanner.newPage();
    await scan.goto(url);
    await expect(scan.getByRole('button', { name: 'Continua' })).toBeVisible();
    await scanner.close();

    await page.goto(url);
    expect(page.url()).not.toContain('token_hash');
    await page.getByRole('button', { name: 'Continua' }).click();
    await page.getByLabel('Nuova password').fill(next);
    await page.getByLabel('Ripeti la password').fill(next);
    await page.getByRole('button', { name: 'Salva la password' }).click();
    await expect(page.getByText('Password salvata.')).toBeVisible();
    await page.getByLabel('Identificativo staff').fill(member.email);
    await page.getByLabel('Password').fill(next);
    await page.getByRole('button', { name: 'Accedi al servizio' }).click();
    await expect(page).toHaveURL(new RegExp(`${member.landing}$`));
  } finally {
    if (userId)
      await admin(`users/${userId}`, { method: 'PUT', body: JSON.stringify({ password }) });
  }
});
