import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Live browser suite against a real local backend started by `npm run test:e2e:live`
// (native: PostgreSQL + GoTrue + PostgREST) or `npm run test:e2e:supabase` (Supabase CLI stack
// with Realtime, Storage and Edge Functions). Nothing here is mocked.
const stateFile = 'tests/e2e-live/.stack/env.json';
const state = existsSync(stateFile)
  ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, string>)
  : {};
// Seed helpers and specs read the same stack (database URL, keys) through these variables.
for (const [key, value] of Object.entries({
  E2E_SUPABASE_URL: state.kongUrl ?? state.supabaseUrl,
  E2E_DB_URL: state.dbUrl,
  E2E_ANON_KEY: state.anonKey,
  E2E_SERVICE_KEY: state.serviceKey,
}))
  if (value && !process.env[key]) process.env[key] = value;
const anonKey =
  process.env.E2E_ANON_KEY ?? readFileSync('tests/e2e-live/.stack/anon.key', 'utf8').trim();
const environment = {
  VITE_ENVIRONMENT: 'development',
  VITE_PUBLIC_BASE_URL: 'http://localhost:5173',
  VITE_STAFF_BASE_URL: 'http://localhost:5174',
  VITE_SUPABASE_URL: state.supabaseUrl ?? 'http://127.0.0.1:54321',
  VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
};

export default defineConfig({
  testDir: './tests/e2e-live',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: 'http://localhost:5174',
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev:staff',
      url: 'http://localhost:5174',
      env: environment,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
