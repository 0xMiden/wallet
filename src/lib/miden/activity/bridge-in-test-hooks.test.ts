/**
 * @jest-environment node
 */

// The hooks run in the service worker, which has no document and so no bridge config scheduler; a node environment
// keeps the real remote-config runtime on that path.
import * as Repo from 'lib/miden/repo';
import { PRESERVED_STORAGE_KEYS } from 'lib/miden/reset';
import {
  _refreshBridgeConfigForTest,
  _resetBridgeConfigRuntimeForTest,
  initBridgeConfig
} from 'lib/remote-config/runtime';
import { type BridgeConfig, parseBridgeConfig } from 'lib/remote-config/schema';
import type { StoredBridgeConfig } from 'lib/remote-config/source';
import testnet from 'lib/remote-config/testing/testnet.json';
import { getUsdcxRemoteDomain } from 'lib/usdcx/constant';

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

// Service-worker startup hydrates the stored document, and its first derivation lands.
const startUp = async () => {
  storeDocument();
  await initBridgeConfig();
  await _refreshBridgeConfigForTest();
  mockFetch.mockClear();
};

// Creating a wallet removes every key but the kept ones, then runs this realm's rereads.
const wipe = async () => {
  for (const key of [...mockStorage.keys()]) if (!PRESERVED_STORAGE_KEYS.includes(key)) mockStorage.delete(key);
  await Promise.all(mockRereads.map(reread => reread()));
};

const createArcReceive = () =>
  globalThis.__TEST_CREATE_BRIDGE_RECEIVE__({
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

const expectArcRow = async (txId: string) => {
  const inputs: IBridgedReceiveExtraInputs | undefined = (await Repo.transactions.where({ id: txId }).first())
    ?.extraInputs;
  expect(inputs).toMatchObject({
    phase: 'delivering',
    usdcxMidenDomain: 10007,
    usdcxSource: { route: 'xreserve', chain: { id: ARC_TESTNET_CHAIN_ID } }
  });
};

beforeEach(async () => {
  _resetBridgeConfigRuntimeForTest();
  mockStorage.clear();
  mockFetch.mockReset().mockImplementation(async () => storeDocument());
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await Repo.transactions.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('creates a USDCx tracking row with the document domain right after a wallet-creation wipe, with no fetch', async () => {
  await startUp();
  await wipe();
  installBridgeInTestHooks();

  await expectArcRow(await createArcReceive());
  expect(mockFetch).not.toHaveBeenCalled();
});

it('fetches the first document for a USDCx tracking row in a profile that never stored one', async () => {
  installBridgeInTestHooks();

  await expectArcRow(await createArcReceive());
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it.each([
  ['in the same realm', () => undefined],
  ['after the service worker restarts', _resetBridgeConfigRuntimeForTest]
])('hydrates the stored document after a wallet-creation wipe %s, with the network down', async (_where, after) => {
  await startUp();
  await wipe();
  after();
  mockFetch.mockRejectedValue(new Error('offline'));

  await initBridgeConfig();

  expect(getUsdcxRemoteDomain()).toBe(10007);
  expect(mockFetch).not.toHaveBeenCalled();
});
