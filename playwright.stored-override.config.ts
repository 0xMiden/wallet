import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// The blockchain harness for the specs that run a wallet on a stored endpoint override. They need a build that reads
// stored overrides (`yarn test:e2e:stored-override:build`), which every other E2E build ignores, so the base config
// ignores their directory and Local E2E runs them on that second build after its core specs. The output directory is
// their own: Playwright empties its output directory at the start of a run, and the core run's report and artifacts
// sit in test-results/.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/stored-override',
  testIgnore: undefined,
  outputDir: 'test-results/stored-override',
  reporter: [['list'], ['json', { outputFile: 'test-results/stored-override/results.json' }]]
});
