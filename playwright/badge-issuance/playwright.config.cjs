const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.cjs',
  workers: 1,
  outputDir: '../../test-results/badge-issuance',
  use: {
    baseURL: 'http://127.0.0.1:5187',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2
  },
  webServer: {
    command: 'yarn vite --config playwright/badge-issuance/vite.config.mjs',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: !process.env.CI
  }
});
