import { defineConfig } from '@playwright/test';

const environment = {
  VITE_ENVIRONMENT: 'development',
  VITE_PUBLIC_BASE_URL: 'http://localhost:5173',
  VITE_STAFF_BASE_URL: 'http://localhost:5174',
  VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'local-browser-contract-test-key',
};

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    browserName: 'chromium',
    headless: true,
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
