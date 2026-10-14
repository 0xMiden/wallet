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

  // Every push to main runs it as well as the nightly and a dispatch, and runs queue: a cancelled run can leave a
  // deposit that no relayer mints.
  it('runs after every push to main, nightly and by dispatch, one run at a time', () => {
    expect(workflow).toMatch(
      /\non:\n {2}push:\n {4}branches:\n {6}- main\n {2}schedule:\n {4}- cron: '17 3 \* \* \*'\n {2}workflow_dispatch:\n/
    );
    expect(workflow).toMatch(
      /\nconcurrency:\n {2}group: \$\{\{ github\.workflow \}\}\n(?: {2}#.*\n)* {2}cancel-in-progress: false\n/
    );
  });

  // Every step sees a job variable, the dependency install and the app build among them.
  it('sets the live Arc key only on the key check and the test step', () => {
    const code = workflow
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    const reading = code.split(/\n(?= {6}- )/).filter(chunk => chunk.includes('secrets.USDCX_LIVE_EVM_PRIVATE_KEY'));
    expect(reading.map(chunk => /^ {6}- name: (.+)$/m.exec(chunk)?.[1])).toEqual([
      'Require the live Arc Testnet key',
      'Run USDCx bridge-IN E2E (mobile, live testnets)'
    ]);
    for (const chunk of reading)
      expect(chunk).toContain(
        `\n        env:\n          USDCX_LIVE_EVM_PRIVATE_KEY: \${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}\n`
      );
  });
});
