// Headless-browser checks of index.html: `npm run test:browser` (after `npm ci` and `npx playwright install chromium`).
// The tests live in e2e/, outside the paths `node --test` picks up, so `npm test` still needs no install.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.mjs',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { browserName: 'chromium', headless: true, actionTimeout: 10_000, trace: 'retain-on-failure' },
  projects: [
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
});
