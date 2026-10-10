import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/pwa-browser',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: {
    browserName: 'chromium',
    headless: true,
    serviceWorkers: 'allow',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx vite preview --config vite.public.config.ts --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite preview --config vite.staff.config.ts --host 127.0.0.1 --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
