/**
 * @jest-environment node
 */

// The hooks run in the service worker, which has no document and so no bridge config scheduler; a node environment
// keeps the real remote-config runtime on that path.
import { getProviderReceiptBackend, installProviderReceiptBackend } from 'lib/miden/recovery/receipt-backend';
import { fromSerializable } from 'lib/miden/recovery/serialization';
import { projectRecoveryTransaction, validateRecoveryReceipt } from 'lib/miden/recovery/transaction-record';
import * as Repo from 'lib/miden/repo';
import { PRESERVED_STORAGE_KEYS } from 'lib/miden/reset';
import { assertStorageHealthy } from 'lib/miden/storage-health';
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
import { reconcileBridgedReceives } from './bridge-receive';
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
    epoch: {
      allocator: { state: 'skipped' },
      market: { state: 'skipped' },
      midenUsdcFaucet: { state: 'skipped' },
      vaults: { state: 'skipped' }
    },
    swap: { pairs: { state: 'skipped' } }
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

const BASE_SEPOLIA_CHAIN_ID = 84_532;
const BURN_HASH = '0x2222222222222222222222222222222222222222222222222222222222222222';
const FORWARD_HASH = '0x3333333333333333333333333333333333333333333333333333333333333333';
// What runUsdcxExecutorDeposit (usdcx/executor.ts) writes on its `submitting` step.
const SUBMITTED = {
  usdcxRemoteRecipient: '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400',
  cctp: { sourceDomain: 6, forwarded: true, forwardFee: '22404' }
};

const createExecutorReceive = () =>
  globalThis.__TEST_CREATE_BRIDGE_RECEIVE__({
    accountId: 'mtst1account',
    amount: '1000',
    faucetId: 'mtst1usdcx',
    sourceChainId: BASE_SEPOLIA_CHAIN_ID,
    sourceAddress: '0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81',
    sourceAmount: '0.001',
    sourceSymbol: 'USDC',
    evmTxHash: BURN_HASH,
    ...SUBMITTED
  });

it("keeps an executor deposit's submitting write on the row it moves to delivering", async () => {
  installBridgeInTestHooks();

  const id = await createExecutorReceive();

  const inputs: IBridgedReceiveExtraInputs | undefined = (await Repo.transactions.where({ id }).first())?.extraInputs;
  expect(inputs).toMatchObject({
    phase: 'delivering',
    evmTxHash: BURN_HASH,
    usdcxRemoteRecipient: SUBMITTED.usdcxRemoteRecipient,
    cctp: SUBMITTED.cctp,
    usdcxSource: { route: 'cctp-executor', chain: { id: BASE_SEPOLIA_CHAIN_ID } }
  });
});

it('hands the row to the reconciler, which asks Circle about the burn and takes its Arc forward as the execute', async () => {
  installBridgeInTestHooks();
  const id = await createExecutorReceive();
  // Iris, as bridge-receive.usdcx.test.ts stands it in: the only fetch this pass makes.
  const iris = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      messages: [
        {
          message: '0x01',
          attestation: '0x02',
          status: 'complete',
          eventNonce: '0x03',
          forwardState: 'COMPLETE',
          forwardTxHash: FORWARD_HASH
        }
      ]
    })
  }));
  Object.defineProperty(globalThis, 'fetch', { value: iris, writable: true, configurable: true });

  await reconcileBridgedReceives();

  expect(iris).toHaveBeenCalledWith(
    `https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${BURN_HASH}`,
    expect.anything()
  );
  expect(await globalThis.__TEST_BRIDGE_RECEIVE_STATE__(id)).toMatchObject({
    phase: 'delivering',
    usdcxExecuteTxHash: FORWARD_HASH
  });
});

it("reports an executor deposit's forwarded leg and the fee it paid", async () => {
  installBridgeInTestHooks();

  const id = await createExecutorReceive();

  expect(await globalThis.__TEST_BRIDGE_RECEIVE_STATE__(id)).toMatchObject({
    cctpForwarded: true,
    cctpForwardFee: SUBMITTED.cctp.forwardFee
  });
  expect(await globalThis.__TEST_LATEST_BRIDGE_RECEIVE__('usdcx')).toMatchObject({
    id,
    cctpForwarded: true,
    cctpForwardFee: SUBMITTED.cctp.forwardFee
  });
});

let previousReceiptBackend: ReturnType<typeof getProviderReceiptBackend>;
const retainedReceipts = new Map<string, ReturnType<typeof validateRecoveryReceipt>>();

async function acknowledgeSyntheticReceipt(value: unknown, expectedEpoch: number): Promise<void> {
  assertStorageHealthy(expectedEpoch);
  const row = validateRecoveryReceipt(fromSerializable(value));
  const persisted = await Repo.transactions.get(row.id);
  if (!persisted) throw new Error('Synthetic receipt owner requires a persisted row');
  expect(projectRecoveryTransaction(persisted)).toMatchObject(row);
  assertStorageHealthy(expectedEpoch);
  retainedReceipts.set(row.id, row);
}

beforeEach(() => {
  previousReceiptBackend = getProviderReceiptBackend();
  retainedReceipts.clear();
  installProviderReceiptBackend(acknowledgeSyntheticReceipt);
});

afterEach(() => {
  installProviderReceiptBackend(previousReceiptBackend);
});
