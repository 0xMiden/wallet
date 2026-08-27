import { defineConfig } from '@playwright/test';

/**
 * Telemetry egress suite. Needs its own config because it needs its own BUILD:
 * the Aptabase key and host are baked in by vite's `define`, so the artifact
 * every other suite uses has telemetry inert by construction.
 *
 * The build is the job's responsibility (see `.github/workflows/e2e-telemetry.yml`
 * and `yarn build:chrome:telemetry`), not this file's, so a local run and CI
 * produce the same artifact the same way.
 */
export default defineConfig({
  testDir: './playwright/telemetry',
  // Serial and single-worker: one sink on one fixed port, and two workers would
  // interleave requests into it with no way to tell whose event was whose.
  workers: 1,
  fullyParallel: false,
  // No retries. Every assertion here is either a real leak or a real regression,
  // and a retry would turn "sent something before consent" into a flake.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 180_000,
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});
