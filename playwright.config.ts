import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataRoot = mkdtempSync(join(tmpdir(), 'coruscant-e2e-'));
export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1,
  timeout: 45_000, expect: { timeout: 8_000 },
  reporter: [['list']], outputDir: 'test-results',
  metadata: { dataRoot }, globalTeardown: './tests/e2e/teardown.ts',
  use: { baseURL: 'http://127.0.0.1:3100', actionTimeout: 8_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: 'node tests/e2e/start.mjs', url: 'http://127.0.0.1:3100/api/public/catalog',
    reuseExistingServer: false, timeout: 30_000,
    env: { CORUSCANT_MODE: 'test', CORUSCANT_TEST_DATA_ROOT: dataRoot, CORUSCANT_PORT: '3100' },
  },
});
