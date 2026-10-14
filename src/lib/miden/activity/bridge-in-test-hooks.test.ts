/**
 * @jest-environment node
 */

// The hooks run in the service worker, which has no document and so no bridge config scheduler; a node environment
// keeps the real remote-config runtime on that path.
import * as Repo from 'lib/miden/repo';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import { type BridgeConfig, parseBridgeConfig } from 'lib/remote-config/schema';
import type { StoredBridgeConfig } from 'lib/remote-config/source';
import testnet from 'lib/remote-config/testing/testnet.json';

import { installBridgeInTestHooks } from './bridge-in-test-hooks';
import type { IBridgedReceiveExtraInputs } from '../db/types';

const ARC_TESTNET_CHAIN_ID = 5_042_002;

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: () => 'https://rpc.testnet.example'
}));

const mockStorage = new Map<string, unknown>();
const mockRereads: Array<() => Promise<void>> = [];
jest.mock('lib/miden/front/storage', () => ({
  ...jest.requireActual('lib/miden/front/storage'),
  fetchFromStorage: async (key: string) => mockStorage.get(key) ?? null,
  putToStorage: async (key: string, value: unknown) => {
    mockStorage.set(key, value);
  },
  registerStorageReread: (reread: () => Promise<void>) => mockRereads.push(reread),
  onStorageChanged: () => () => undefined
}));

const mockFetch = jest.fn<Promise<StoredBridgeConfig>, [string]>();
jest.mock('lib/remote-config/source', () => ({
  ...jest.requireActual('lib/remote-config/source'),
  readStoredBridgeConfig: async (network: string) => mockStorage.get(`bridge_config_v1:${network}`) ?? null,
  fetchAndStoreBridgeConfig: (network: string) => mockFetch(network)
}));

jest.mock('lib/remote-config/derive', () => ({
  ...jest.requireActual('lib/remote-config/derive'),
  deriveBridgeConfig: async (config: BridgeConfig) => ({
    network: config.network,
    version: config.version,
    derivedAt: Date.now(),
    chains: {},
    agglayer: { indexer: { state: 'skipped' } },
    epoch: { allocator: { state: 'skipped' }, market: { state: 'skipped' }, midenUsdcFaucet: { state: 'skipped' } }
  })
}));

const storeDocument = (): StoredBridgeConfig => {
  const config = parseBridgeConfig(testnet, 'testnet');
  if (!config) throw new Error('the testnet fixture does not validate');
  const entry = { config, fetchedAt: Date.now() };
  mockStorage.set('bridge_config_v1:testnet', entry);
  return entry;
};

beforeEach(async () => {
  mockStorage.clear();
  mockFetch.mockReset().mockImplementation(async () => storeDocument());
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await Repo.transactions.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('creates a USDCx tracking row with the document domain right after a wallet-creation wipe', async () => {
  // Service-worker startup hydrates the stored document; creating a wallet then wipes storage, and the realm with it.
  storeDocument();
  await initBridgeConfig();
  mockStorage.clear();
  await Promise.all(mockRereads.map(reread => reread()));
  installBridgeInTestHooks();

  const txId = await globalThis.__TEST_CREATE_BRIDGE_RECEIVE__({
    accountId: 'mtst1account',
    amount: '20000',
    faucetId: 'mtst1usdcx',
    provider: 'usdcx',
    sourceChainId: ARC_TESTNET_CHAIN_ID,
    sourceAddress: '0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81',
    sourceAmount: '0.02',
    sourceSymbol: 'USDC',
    evmTxHash: '0x1111111111111111111111111111111111111111111111111111111111111111'
  });

  const inputs: IBridgedReceiveExtraInputs | undefined = (await Repo.transactions.where({ id: txId }).first())
    ?.extraInputs;
  expect(inputs).toMatchObject({
    phase: 'delivering',
    usdcxMidenDomain: 10007,
    usdcxSource: { route: 'xreserve', chain: { id: ARC_TESTNET_CHAIN_ID } }
  });
});
