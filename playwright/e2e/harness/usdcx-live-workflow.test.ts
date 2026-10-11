/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-usdcx-live.yml'), 'utf8');

describe('E2E USDCx Bridge-IN (live) workflow', () => {
  // The spec skips itself without the key, and a skipped spec passes the job, so a run that tested nothing read green.
  it('fails before anything else when the live Arc Testnet key is not set', () => {
    const steps = workflow.slice(workflow.indexOf('    steps:\n'));
    const guard = steps.indexOf('- name: Require the live Arc Testnet key');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(steps.indexOf('- uses: actions/checkout@v4'));
    const body = steps.slice(guard, steps.indexOf('\n      - ', guard + 1));
    expect(body).toMatch(/if \[ -z "\$USDCX_LIVE_EVM_PRIVATE_KEY" \]; then[\s\S]*::error[\s\S]*exit 1/);
  });
});
