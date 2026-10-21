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

  it('keeps the cron commented until the accounts are funded', () => {
    expect(text).toContain("cron: '30 5 * * *'");
    const live = text.split('\n').filter(line => !line.trim().startsWith('#') && line.includes('cron:'));
    expect(live).toEqual([]);
    expect(text).toContain('workflow_dispatch:');
    expect(text).toContain('ref: main');
    expect(text).toContain('cancel-in-progress: false');
  });
});
