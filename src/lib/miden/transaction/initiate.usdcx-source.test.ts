import { serialize } from 'v8';

import type { BridgedReceiveTransaction } from '../db/types';

const mockAdd = jest.fn(async (_row: BridgedReceiveTransaction) => undefined);
jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { add: mockAdd };
  }
}));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: () => 'testnet',
  isNoteTransportConfigured: () => true
}));
jest.mock('../spending-limits/queue', () => ({ queueOutgoingTransaction: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: () => true }));

// jsdom has no structuredClone and fake-indexeddb's fallback copies a Proxy, so v8.serialize stands in for IndexedDB.
it('stores USDCx routes IndexedDB can clone after AppKit state has proxied the shared chains', async () => {
  // A fresh registry, so the proxied viem chains stay inside this test.
  await jest.isolateModulesAsync(async () => {
    const { getVersion, proxy } = await import('valtio/vanilla');
    const { ARC_TESTNET, EVM_CHAIN_DEFINITIONS } = await import('lib/walletconnect/config');
    proxy({ caipNetworks: EVM_CHAIN_DEFINITIONS.map(chain => ({ ...chain })) });
    expect(getVersion(ARC_TESTNET.blockExplorers?.default)).toBeDefined();

    const { usdcxDestinations, usdcxSourceChains } = await import('lib/usdcx/constant');
    const { initiateBridgedReceiveTransaction } = await import('./initiate');
    const sources = [...usdcxSourceChains().values()];
    expect(new Set(sources.map(source => source.route))).toEqual(new Set(['xreserve', 'cctp-executor']));
    for (const source of sources) {
      expect(() => serialize(source)).not.toThrow();
      await initiateBridgedReceiveTransaction({
        accountId: 'mtst1account',
        amount: 1_000_000n,
        faucetId: 'mtst1faucet',
        provider: 'usdcx',
        sourceAddress: '0x0000000000000000000000000000000000000001',
        sourceChainId: source.chain.id,
        usdcxSource: source,
        sourceAmount: '1',
        sourceSymbol: 'USDC'
      });
    }
    for (const destination of usdcxDestinations().values()) expect(() => serialize(destination)).not.toThrow();

    expect(mockAdd).toHaveBeenCalledTimes(sources.length);
    for (const [row] of mockAdd.mock.calls) {
      expect(row.extraInputs.usdcxSource).toBeDefined();
      expect(() => serialize(row.extraInputs)).not.toThrow();
      expect(() => serialize(row)).not.toThrow();
    }
  });
});

jest.mock('lib/miden/recovery/receipt-writer', () => ({
  checkpointProviderReceipt: jest.fn().mockResolvedValue(undefined)
}));
