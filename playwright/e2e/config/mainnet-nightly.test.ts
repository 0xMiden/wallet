import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getEnvironmentConfig } from './environments';

describe('mainnet environment', () => {
  const previous = process.env.E2E_NETWORK;

  afterEach(() => {
    if (previous === undefined) delete process.env.E2E_NETWORK;
    else process.env.E2E_NETWORK = previous;
  });

  it('points at the mainnet node and the bundled LambdaClass operator', () => {
    process.env.E2E_NETWORK = 'mainnet';
    expect(getEnvironmentConfig()).toMatchObject({
      name: 'mainnet',
      rpcUrl: 'https://rpc.mainnet.miden.io',
      provingUrl: 'https://tx-prover.mainnet.miden.io',
      transportUrl: 'https://transport.mainnet.miden.io',
      networkFlag: 'mainnet',
      guardianUrl: 'https://guardian.cedar.internal.lambdaclass.com',
      chargesFees: true,
      delegateProving: true,
      mintAmount: 1
    });
  });
});

describe('mainnet nightly workflow', () => {
  const text = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-mainnet-nightly.yml'), 'utf8');

  it('runs nightly at 05:30 UTC, after e2e-resilience.yml, and by dispatch on the dispatched ref', () => {
    const live = text.split('\n').filter(line => !line.trim().startsWith('#') && line.includes('cron:'));
    expect(live).toEqual(["    - cron: '30 5 * * *'"]);
    expect(text).toContain('workflow_dispatch:');
    // Each run checks out its dispatched commit, even if its branch moves while queued.
    expect(text).toContain('ref: ${{ github.sha }}');
    expect(text).toContain('cancel-in-progress: false');
  });

  /** The lines of one job, from its id to the next job's. */
  const jobText = (id: string): string => {
    const lines = text.split('\n');
    const at = lines.indexOf(`  ${id}:`);
    if (at === -1) throw new Error(`no job ${id}`);
    const end = lines.findIndex((line, index) => index > at && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
    return lines.slice(at, end === -1 ? undefined : end).join('\n');
  };

  it('runs the main job on the dispatched runner, and on the free one for the schedule', () => {
    expect(text).toMatch(
      /workflow_dispatch:\n {4}inputs:\n {6}runner:\n(?: {8}.*\n)*? {8}default: ubuntu-latest\n {8}options:\n {10}- ubuntu-latest\n {10}- warp-ubuntu-latest-x64-8x\n/
    );
    expect(jobText('mainnet-nightly')).toContain(
      "    runs-on: ${{ github.event_name == 'workflow_dispatch' && inputs.runner || 'ubuntu-latest' }}"
    );
  });

  it('loops the USDCx routes in the main job and AggLayer in a job of its own after it', () => {
    const main = jobText('mainnet-nightly');
    expect(main).toContain('yarn playwright test mainnet-bridge-loop.spec.ts');
    expect(main).not.toContain('mainnet-agglayer-loop.spec.ts');
    // The first step marks the job started, so a failed main job still hands over to the AggLayer job.
    expect(main).toMatch(/ {4}steps:\n(?: {6}#.*\n)* {6}- name: Mark the main job started\n {8}id: started\n/);
    expect(main).toContain('      started: ${{ steps.started.outputs.started }}');

    const agglayer = jobText('mainnet-agglayer');
    expect(agglayer).toContain('    needs: mainnet-nightly');
    expect(agglayer).toContain("    if: ${{ !cancelled() && needs.mainnet-nightly.outputs.started == 'true' }}");
    expect(agglayer).toContain('    runs-on: ubuntu-latest');
    expect(agglayer).toContain("    timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 230 || 185 }}");
    expect(agglayer).toContain(
      'yarn playwright test mainnet-agglayer-loop.spec.ts --config playwright.mainnet.config.ts'
    );
    expect(agglayer).toContain('E2E_MAINNET_EVM_KEY: ${{ secrets.E2E_MAINNET_EVM_KEY }}');
    expect(agglayer).toContain('E2E_MAINNET_PLAIN_SEED: ${{ secrets.E2E_MAINNET_PLAIN_SEED }}');
    expect(agglayer).toMatch(/- name: Publish the AggLayer summary\n {8}if: always\(\)\n/);
    expect(agglayer).toContain('agglayer-night.md >> "$GITHUB_STEP_SUMMARY"');
  });

  it('publishes the USDCx payout summary', () => {
    const main = jobText('mainnet-nightly');
    const loops = main.indexOf('yarn playwright test mainnet-bridge-loop.spec.ts');
    const step = main.indexOf('      - name: Publish the USDCx payout summary\n');
    expect(loops).toBeGreaterThanOrEqual(0);
    expect(step).toBeGreaterThan(loops);
    const body = main.slice(step, main.indexOf('\n      - name:', step + 1));
    // always(): a night whose payout wait fails still reports the fees of the burns Circle paid.
    expect(body).toMatch(/\n {8}if: always\(\)\n/);
    expect(body).toContain('if [ -f test-results/mainnet-usdcx-payouts.md ]; then');
    expect(body).toContain('cat test-results/mainnet-usdcx-payouts.md >> "$GITHUB_STEP_SUMMARY"');
  });

  it('fails the AggLayer job when the Ethereum key is empty', () => {
    const agglayer = jobText('mainnet-agglayer');
    const guard = agglayer.indexOf('E2E_MAINNET_EVM_KEY is empty');
    const playwright = agglayer.indexOf('yarn playwright test mainnet-agglayer-loop.spec.ts');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(playwright);
    expect(guard).toBeLessThan(agglayer.indexOf('uses: actions/checkout@v4'));
    expect(agglayer.slice(guard, playwright)).toContain('exit 1');
    expect(jobText('mainnet-nightly')).not.toContain('E2E_MAINNET_EVM_KEY is empty');
  });

  it('keeps the run one verdict: a failure in either job fails the run', () => {
    // A job runs after a failed one only by its own if:, and a failed job fails the run; continue-on-error would hide it.
    expect(jobText('mainnet-agglayer')).not.toContain('continue-on-error');
    expect(jobText('mainnet-nightly')).not.toContain('continue-on-error');
  });
});
