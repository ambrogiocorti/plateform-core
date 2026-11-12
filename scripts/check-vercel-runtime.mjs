import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVercelConfiguration } from './vercel-configuration.mjs';

// Vercel reads routing and headers before the build. Changing an environment
// variable alone must not publish a bundle whose API is blocked by its CSP.
if (process.env.VERCEL === '1') {
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  const expected = createVercelConfiguration({
    supabaseUrl: process.env.VITE_SUPABASE_URL,
  });
  const csp = (value) =>
    value.headers
      .find((rule) => rule.source === '/(.*)')
      ?.headers.find((header) => header.key === 'Content-Security-Policy')?.value;
  assert.equal(csp(config), csp(expected), 'VERCEL_BACKEND_CSP_MISMATCH');
  console.log('VERCEL_BACKEND_CSP=PASS');
}
