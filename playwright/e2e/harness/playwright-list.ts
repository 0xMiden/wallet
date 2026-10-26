import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../..');
const playwright = resolve(repoRoot, 'node_modules/.bin/playwright');

/**
 * Lists the tests a Playwright config selects, with the real loader. `--reporter list` replaces the config's
 * reporters, so a listing never rewrites the json report a real run left behind (test-results/results.json, which
 * scripts/report-flaky-e2e.mjs reads, or the stress suite's own). An undefined override deletes that variable.
 */
export function listPlaywrightTests(config: string, envOverrides: Record<string, string | undefined> = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_NETWORK: 'localhost' };
  delete env.JEST_WORKER_ID;
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return execFileSync(playwright, ['test', '--list', '--reporter', 'list', '--config', config], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
}
