import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getEnvironmentConfig } from './environments';

describe('mainnet environment', () => {
  const previous = process.env.E2E_NETWORK;

  afterEach(() => {
    if (previous === undefined) delete process.env.E2E_NETWORK;
    else process.env.E2E_NETWORK = previous;
  });

  it('points at the cedar mainnet node and the bundled LambdaClass operator', () => {
    process.env.E2E_NETWORK = 'mainnet';
    expect(getEnvironmentConfig()).toMatchObject({
      name: 'mainnet',
      rpcUrl: 'https://rpc.cedar.miden.io',
      provingUrl: 'https://tx-prover.cedar.miden.io',
      transportUrl: 'https://transport.cedar.miden.io',
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
    // A dispatch tests the ref it names; the scheduled run's ref is main.
    expect(text).toContain('ref: ${{ github.ref }}');
    expect(text).toContain('cancel-in-progress: false');
  });
});
