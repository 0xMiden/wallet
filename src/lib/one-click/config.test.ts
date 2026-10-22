import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { parseBridgeConfig } from 'lib/remote-config/schema';
import testnet from 'lib/remote-config/testing/testnet.json';

import { getOneClickConfig } from './config';

const configBody = {
  ...testnet,
  swap: {
    ...testnet.swap,
    oneClick: {
      serviceUrl: 'https://one-click.example',
      midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 }]
    }
  }
};

function snapshot(network: string, allowOneClickLocalE2E = false, nearIntentsEnabled = false): BridgeConfigSnapshot {
  const body = {
    ...configBody,
    network,
    features: { ...configBody.features, nearIntents: nearIntentsEnabled },
    swap: {
      ...configBody.swap,
      oneClick: {
        ...configBody.swap.oneClick,
        serviceUrl: network === 'localnet' ? 'http://127.0.0.1:8550' : 'https://one-click.example'
      }
    }
  };
  const config = parseBridgeConfig(body, network, { allowLocalHttp: allowOneClickLocalE2E, allowOneClickLocalE2E });
  if (!config) throw new Error('Test config is invalid');
  return { network, status: 'ready', config, derived: null, lastFetch: null };
}

describe('getOneClickConfig', () => {
  const saved = {
    e2e: process.env.MIDEN_E2E_TEST,
    oneClickE2e: process.env.MIDEN_E2E_ONE_CLICK_TESTNET,
    network: process.env.MIDEN_NETWORK
  };
  afterAll(() => {
    restore('MIDEN_E2E_TEST', saved.e2e);
    restore('MIDEN_E2E_ONE_CLICK_TESTNET', saved.oneClickE2e);
    restore('MIDEN_NETWORK', saved.network);
  });

  it('keeps non-mainnet routes hidden without the exact local E2E gates', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'false';
    process.env.MIDEN_NETWORK = 'localhost';
    expect(getOneClickConfig(snapshot('localnet', true))).toBeNull();
    expect(getOneClickConfig(snapshot('testnet', true))).toBeNull();
  });

  it('keeps configured mainnet and hermetic E2E service/assets hidden while the switch is false', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
    process.env.MIDEN_NETWORK = 'localhost';
    expect(getOneClickConfig(snapshot('mainnet', false, false))).toBeNull();
    expect(getOneClickConfig(snapshot('localnet', true, false))).toBeNull();
  });

  it('requires the explicit feature switch on mainnet as well as local E2E', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'false';
    process.env.MIDEN_NETWORK = 'mainnet';
    expect(getOneClickConfig(snapshot('mainnet', false, true))?.serviceUrl).toBe('https://one-click.example');
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
    process.env.MIDEN_NETWORK = 'localhost';
    expect(getOneClickConfig(snapshot('localnet', true, true))?.serviceUrl).toBe('http://127.0.0.1:8550');
  });

  it('exposes localnet 1Click only in the explicitly targeted localhost E2E build', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
    process.env.MIDEN_NETWORK = 'localhost';
    expect(getOneClickConfig(snapshot('localnet', true, true))?.serviceUrl).toBe('http://127.0.0.1:8550');
    expect(getOneClickConfig(snapshot('mainnet', true))).toBeNull();
    expect(getOneClickConfig(snapshot('testnet', true))).toBeNull();
    expect(getOneClickConfig(snapshot('devnet', true))).toBeNull();
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
