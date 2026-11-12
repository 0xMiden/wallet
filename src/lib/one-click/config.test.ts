import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { parseBridgeConfig } from 'lib/remote-config/schema';
import testnet from 'lib/remote-config/testing/testnet.json';

import { getNearIntentsConfig } from './config';

const nearIntents = {
  serviceUrl: 'https://one-click.example',
  midenAssets: {
    usdcx: { assetId: 'nep141:miden-usdc.omft.near', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 }
  },
  chains: {
    eth: {
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: { USDC: { assetId: 'nep141:eth-usdc.omft.near', decimals: 6, miden: ['usdcx'] } }
    }
  }
};

function snapshot(
  network: string,
  allowOneClickLocalE2E = false,
  nearIntentsEnabled = false,
  status: BridgeConfigSnapshot['status'] = 'ready'
): BridgeConfigSnapshot {
  const body = {
    ...testnet,
    network,
    features: { ...testnet.features, nearIntents: nearIntentsEnabled },
    nearIntents: {
      ...nearIntents,
      serviceUrl: network === 'localnet' ? 'http://127.0.0.1:8550' : 'https://one-click.example'
    }
  };
  const config = parseBridgeConfig(body, network, { allowLocalHttp: allowOneClickLocalE2E, allowOneClickLocalE2E });
  if (!config) throw new Error('Test config is invalid');
  return { network, status, config, derived: null, lastFetch: null };
}

describe('getNearIntentsConfig', () => {
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
    expect(getNearIntentsConfig(snapshot('localnet', true, true))).toBeNull();
    expect(getNearIntentsConfig(snapshot('testnet', true, true))).toBeNull();
  });

  it('keeps configured mainnet and hermetic E2E sections hidden while the switch is false', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
    process.env.MIDEN_NETWORK = 'localhost';
    expect(getNearIntentsConfig(snapshot('mainnet', false, false))).toBeNull();
    expect(getNearIntentsConfig(snapshot('localnet', true, false))).toBeNull();
  });

  it('returns the parsed section on mainnet with the explicit feature switch', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'false';
    process.env.MIDEN_NETWORK = 'mainnet';
    expect(getNearIntentsConfig(snapshot('mainnet', false, true))).toStrictEqual({
      serviceUrl: 'https://one-click.example',
      midenAssets: [
        {
          id: 'usdcx',
          assetId: 'nep141:miden-usdc.omft.near',
          faucetId: '0x537c15a622074e91188aa894456c52',
          decimals: 6
        }
      ],
      chains: [
        {
          id: 'eth',
          name: 'Ethereum',
          addressKind: 'evm',
          tokens: [{ symbol: 'USDC', assetId: 'nep141:eth-usdc.omft.near', decimals: 6, miden: ['usdcx'] }]
        }
      ]
    });
  });

  it('returns null while the snapshot is not ready', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'false';
    process.env.MIDEN_NETWORK = 'mainnet';
    expect(getNearIntentsConfig(snapshot('mainnet', false, true, 'loading'))).toBeNull();
  });

  it('exposes localnet NEAR Intents only in the explicitly targeted localhost E2E build', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET = 'true';
    process.env.MIDEN_NETWORK = 'localhost';
    expect(getNearIntentsConfig(snapshot('localnet', true, true))?.serviceUrl).toBe('http://127.0.0.1:8550');
    expect(getNearIntentsConfig(snapshot('mainnet', true, true))).toBeNull();
    expect(getNearIntentsConfig(snapshot('testnet', true, true))).toBeNull();
    expect(getNearIntentsConfig(snapshot('devnet', true, true))).toBeNull();
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
