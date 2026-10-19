import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { admin, password, sql } from './stack.mjs';

// Real GoTrue TOTP on hosted staging: a venue admin must enroll and verify MFA before the
// staff session is completed, and a wrong code is refused.

function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}

function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

test('amministratore: password, iscrizione TOTP, codice errato rifiutato, accesso aal2', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(admin.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();

  await expect(page.getByRole('heading', { name: 'Verifica la tua identità.' })).toBeVisible();
  await expect(page.getByAltText('QR per configurare l’app di autenticazione')).toBeVisible();
  await page.getByText('Inserimento manuale').click();
  const secret = (await page.locator('details code').textContent())!.trim();

  const code = page.getByLabel('Codice di autenticazione');
  const wrong = String((Number(totp(secret)) + 500_000) % 1_000_000).padStart(6, '0');
  await code.fill(wrong);
  await page.getByRole('button', { name: 'Verifica e accedi' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Codice non valido o scaduto. Inserisci il codice attuale dell’app.',
  );
  expect(
    sql(`select count(*) from auth.mfa_factors f join auth.users u on u.id=f.user_id
      where u.email='${admin.email}' and f.status='verified'`),
  ).toBe('0');

  await code.fill(totp(secret));
  await page.getByRole('button', { name: 'Verifica e accedi' }).click();
  await expect(page.getByText(`${admin.name} · ADMIN`)).toBeVisible();
  expect(
    sql(`select count(*) from auth.mfa_factors f join auth.users u on u.id=f.user_id
      where u.email='${admin.email}' and f.status='verified'`),
  ).toBe('1');
  expect(
    sql(`select s.aal from auth.sessions s join auth.users u on u.id=s.user_id
      where u.email='${admin.email}' order by s.updated_at desc nulls last limit 1`),
  ).toBe('aal2');
});
