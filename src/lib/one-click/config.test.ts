import { getOneClickConfig } from './config';
import { parseBridgeConfig } from 'lib/remote-config/schema';
import testnet from 'lib/remote-config/testing/testnet.json';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

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

function snapshot(network: string, allowOneClickLocalE2E = false): BridgeConfigSnapshot {
  const body = {
    ...configBody,
    network,
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

  it('exposes localnet 1Click only in the explicitly targeted localhost E2E build', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
    process.env.MIDEN_NETWORK = 'localhost';
    expect(getOneClickConfig(snapshot('localnet', true))?.serviceUrl).toBe('http://127.0.0.1:8550');
    expect(getOneClickConfig(snapshot('mainnet', true))).toBeNull();
    expect(getOneClickConfig(snapshot('testnet', true))).toBeNull();
    expect(getOneClickConfig(snapshot('devnet', true))).toBeNull();
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
