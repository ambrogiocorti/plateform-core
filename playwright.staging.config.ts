import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';

// Live browser suite against a hosted Supabase STAGING project (PLATEFORM_STAGING_REF).
// The staff and public apps run locally on Vite and talks to the real staging Auth/REST/Realtime.
// The anon key comes from E2E_STAGING_ANON_KEY; one random staff password per run is shared
// with workers through the environment (tests/e2e-staging/stack.mjs).
process.env.E2E_STAGING_PASSWORD ??= `St-${randomBytes(18).toString('base64url')}`;
const ref = process.env.PLATEFORM_STAGING_REF ?? '';
const proxy = process.env.HTTPS_PROXY;
const environment = {
  // The local http frontend must run as development (staging/production demand HTTPS URLs).
  VITE_ENVIRONMENT: 'development',
  VITE_PUBLIC_BASE_URL: 'http://localhost:5173',
  VITE_STAFF_BASE_URL: 'http://localhost:5174',
  VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
  VITE_SUPABASE_PUBLISHABLE_KEY: process.env.E2E_STAGING_ANON_KEY ?? '',
};

export default defineConfig({
  testDir: './tests/e2e-staging',
  globalSetup: './tests/e2e-staging/global-setup.mjs',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: 'http://localhost:5174',
    ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}),
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
      command: 'npm run dev:public',
      url: 'http://localhost:5173',
      env: environment,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev:staff',
      url: 'http://localhost:5174',
      env: environment,
      reuseExistingServer: false,
    },
  ],
});
