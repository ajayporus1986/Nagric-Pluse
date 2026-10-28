/**
 * End-to-end tests: real browser → vite preview (production build) → API → Postgres.
 * global-setup creates a fresh database, per-module roles, bootstraps users and
 * starts the API and worker; global-teardown stops them and drops the database.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
