/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { L2_BRIDGE_IN_SOURCES } from '../helpers/usdcx-constants';

const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-usdcx-live.yml'), 'utf8');
const ARC_JOB = 'mobile-usdcx-live';
const EXECUTOR_JOB = 'mobile-usdcx-live-executor';
/** The executor spec's sources, by the slug USDCX_LIVE_SOURCE and the `legs` input name them. */
const SOURCES = L2_BRIDGE_IN_SOURCES.map(l2 => l2.payout.reviewNetwork);

/** A job's lines, from its `  <id>:` line to the next line at that indent (a job or a comment above one). */
function jobBlock(id: string): string {
  const lines = workflow.split('\n');
  const at = lines.indexOf(`  ${id}:`);
  if (at === -1) throw new Error(`no job ${id}`);
  const next = lines.findIndex((line, index) => index > at && /^ {2}\S/.test(line));
  return lines.slice(at, next === -1 ? lines.length : next).join('\n');
}
const stepsOf = (id: string): string => jobBlock(id).split('\n    steps:\n')[1] ?? '';

describe('E2E USDCx Bridge-IN (live) workflow', () => {
  // The specs skip themselves without the key, and a skipped spec passes the job, so a run that tested nothing read green.
  it.each([
    [ARC_JOB, 'Require the live Arc Testnet key'],
    [EXECUTOR_JOB, 'Require the live deposit key']
  ])('fails %s before anything else when the live key is not set', (job, name) => {
    const steps = stepsOf(job);
    const guard = steps.indexOf(`- name: ${name}`);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(steps.indexOf('- uses: actions/checkout@v4'));
    const body = steps.slice(guard, steps.indexOf('\n      - ', guard + 1));
    expect(body).toMatch(/if \[ -z "\$USDCX_LIVE_EVM_PRIVATE_KEY" \]; then[\s\S]*::error[\s\S]*exit 1/);
  });

  // The nightly and a dispatch run it, never a push, and runs queue: a cancelled run can leave a deposit that no
  // relayer mints.
  it('runs nightly and by dispatch, one run at a time', () => {
    expect(workflow).toMatch(/\non:\n {2}schedule:\n {4}- cron: '17 3 \* \* \*'\n {2}workflow_dispatch:\n/);
    expect(workflow).toMatch(
      /\nconcurrency:\n {2}group: \$\{\{ github\.workflow \}\}\n(?: {2}#.*\n)* {2}cancel-in-progress: false\n/
    );
  });

  // Every step sees a job variable, the dependency install and the app build among them.
  it('sets the live key only on the key checks and the test steps', () => {
    const code = workflow
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    const reading = code.split(/\n(?= {6}- )/).filter(chunk => chunk.includes('secrets.USDCX_LIVE_EVM_PRIVATE_KEY'));
    expect(reading.map(chunk => /^ {6}- name: (.+)$/m.exec(chunk)?.[1])).toEqual([
      'Require the live Arc Testnet key',
      'Run USDCx bridge-IN E2E (mobile, live testnets)',
      'Require the live deposit key',
      'Run USDCx bridge-IN E2E from a source chain (mobile, live testnets)'
    ]);
    for (const chunk of reading)
      expect(chunk).toContain(
        `\n        env:\n          USDCX_LIVE_EVM_PRIVATE_KEY: \${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}\n`
      );
  });

  // A forwarded burn names the key as the executor's recovery address on Arc, so no source chain's deposit runs inside
  // the Arc leg's payout window; a dispatch can still run the Arc leg or one source chain alone.
  it('runs the executor legs after the Arc leg, red or green, never in a cancelled run', () => {
    expect(jobBlock(EXECUTOR_JOB)).toMatch(/^ {4}needs: mobile-usdcx-live$/m);
    expect(jobBlock(EXECUTOR_JOB)).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && inputs\.legs != 'arc' \}\}$/m);
    expect(jobBlock(ARC_JOB)).toMatch(
      /^ {4}if: \$\{\{ !inputs\.legs \|\| inputs\.legs == 'all' \|\| inputs\.legs == 'arc' \}\}$/m
    );
  });

  // One job per source chain the spec knows, none cancelled by another's failure mid-deposit; a dispatch that names one
  // chain spends only that chain's funds.
  it('runs one job per executor source, and one alone on a dispatch that names it', () => {
    const one = SOURCES.map(slug => `inputs.legs == '${slug}' && '${JSON.stringify([slug])}'`).join(' || ');
    expect(jobBlock(EXECUTOR_JOB)).toMatch(/^ {6}fail-fast: false$/m);
    expect(jobBlock(EXECUTOR_JOB)).toContain(
      `\n        source: \${{ fromJSON(${one} || '${JSON.stringify(SOURCES)}') }}\n`
    );
    expect(workflow).toContain(
      ['        options:', '          - all', '          - arc', ...SOURCES.map(slug => `          - ${slug}`)].join(
        '\n'
      )
    );
    expect(stepsOf(EXECUTOR_JOB)).toContain(`\n          USDCX_LIVE_SOURCE: \${{ matrix.source }}\n`);
  });

  it.each([ARC_JOB, EXECUTOR_JOB])(
    "adds the return burn's payout fee to the summary of %s, whatever the run did",
    job => {
      expect(stepsOf(job)).toContain(
        '\n      - name: Add the payout fees to the job summary\n' +
          '        if: always()\n' +
          '        continue-on-error: true\n' +
          '        run: |\n' +
          '          if [ -f test-results/usdcx-payout-fees.md ]; then\n' +
          '            cat test-results/usdcx-payout-fees.md >> "$GITHUB_STEP_SUMMARY"\n' +
          '          fi\n'
      );
    }
  );

  // Both specs match the config's usdcx-live-* glob, and a retry sends a second real deposit.
  it("runs each spec in its own jobs, with no retries, and keeps each source chain's artifact", () => {
    expect(stepsOf(ARC_JOB)).toMatch(/\n {8}run: yarn test:e2e:mobile:usdcx-live:run usdcx-live-deposit\.ios\n/);
    expect(stepsOf(EXECUTOR_JOB)).toMatch(
      /\n {8}run: yarn test:e2e:mobile:usdcx-live:run usdcx-live-executor-deposit\.ios\n/
    );
    expect(stepsOf(EXECUTOR_JOB)).toContain(
      `\n          name: usdcx-live-executor-e2e-\${{ matrix.source }}-\${{ github.run_id }}\n`
    );
    expect(workflow).not.toMatch(/--retries/);
  });
});
