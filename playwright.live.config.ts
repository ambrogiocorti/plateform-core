import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Live browser suite: real GoTrue + PostgREST + PostgreSQL started by tests/e2e-live/stack.
// Unlike tests/e2e (HTTP fixtures), nothing here is mocked; Realtime and Edge Functions are not served.
const anonKey =
  process.env.E2E_ANON_KEY ?? readFileSync('tests/e2e-live/.stack/anon.key', 'utf8').trim();
const environment = {
  VITE_ENVIRONMENT: 'development',
  VITE_PUBLIC_BASE_URL: 'http://localhost:5173',
  VITE_STAFF_BASE_URL: 'http://localhost:5174',
  VITE_SUPABASE_URL: process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321',
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
