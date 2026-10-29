import { EpochIntentSDK, type EpochIntentSDKConfig } from '@epoch-protocol/epoch-intents-sdk';
import { createWalletClient, custom } from 'viem';
import type { WalletClient } from 'viem';
import { sepolia } from 'viem/chains';

import type { ITransaction } from 'lib/miden/db/types';
import { installProviderReceiptBackend } from 'lib/miden/recovery/receipt-backend';
import * as Repo from 'lib/miden/repo';
import { getStorageHealth } from 'lib/miden/storage-health';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';

import { openEarnPosition } from './earn';
import { resetEpochSdk } from './sdk';
import { useEpochStore } from './store';
import { TEST_EARN_MARKET, TEST_MIDEN_USDC } from './testing/bridge-config';
import { PREPARED_FAUCET, PREPARED_OWNER, PREPARED_RECIPIENT, PREPARED_TOKEN } from './testing/earn-prepared';

const mockPublicClient = jest.fn();
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: (...args: unknown[]) => mockPublicClient(...args)
}));
jest.mock('@miden-sdk/miden-sdk', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk'),
  AccountId: { fromHex: (value: string) => ({ toString: () => value }) }
}));
const witness =
  'address tokenIn,uint256 tokenInAmount,address tokenOut,uint256 minTokenOut,uint256 destinationChainId,bytes4 taskType,address recipient,string midenRecipientAccount,string midenFaucetId';
const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
function deferred() {
  let release = () => {};
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(resourceLockRequired = true, batch = false, forced = false) {
  const events: string[] = [];
  const submitted = deferred();
  const requests: unknown[] = [];
  const allocations: string[] = [];
  let nonces = 0;
  const intentData = {
    tokenIn: PREPARED_TOKEN,
    tokenInAmount: '0',
    tokenOut: PREPARED_TOKEN,
    minTokenOut: '980000',
    destinationChainId: '999999999',
    taskType: '0x12345678',
    recipient: PREPARED_OWNER,
    midenRecipientAccount: PREPARED_RECIPIENT,
    midenFaucetId: PREPARED_FAUCET
  };
  mockPublicClient.mockReturnValue({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'getForcedWithdrawalStatus' ? [forced ? 1 : 0, 0n] : 0n,
    getCode: async () => '0x',
    call: async () => ({ data: '0x' }),
    waitForTransactionReceipt: async () => {
      events.push('receipt');
      return { status: 'success', transactionHash: hash };
    }
  });
  const request = jest.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    events.push(method);
    if (method === 'wallet_getCapabilities') return { '0xaa36a7': batch ? { atomic: { status: 'supported' } } : {} };
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_blockNumber') return '0x1';
    if (method === 'eth_getTransactionReceipt')
      return {
        transactionHash: hash,
        transactionIndex: '0x0',
        blockHash: hash,
        blockNumber: '0x1',
        cumulativeGasUsed: '0x1',
        gasUsed: '0x1',
        effectiveGasPrice: '0x1',
        logs: [],
        logsBloom: '0x',
        status: '0x1',
        type: '0x2',
        from: PREPARED_OWNER,
        to: PREPARED_OWNER,
        contractAddress: null
      };
    if (method === 'eth_sendTransaction') {
      requests.push(params);
      submitted.release();
      return hash;
    }
    if (method === 'wallet_sendCalls') {
      requests.push(params);
      submitted.release();
      return 'bundle-1';
    }
    if (method === 'wallet_getCallsStatus')
      return {
        atomic: true,
        chainId: '0xaa36a7',
        status: 200,
        version: '2.0.0',
        receipts: [{ transactionHash: hash, status: '0x1', blockNumber: '0x1', gasUsed: '0x1' }]
      };
    throw new Error(`Unexpected wallet method ${method}`);
  });
  const walletClient = createWalletClient({ account: PREPARED_OWNER, chain: sepolia, transport: custom({ request }) });
  const config: EpochIntentSDKConfig = { apiBaseUrl: 'https://allocator.invalid', walletClient };
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    let body: object;
    if (url.pathname.startsWith('/suggested-nonce/')) {
      nonces++;
      body = { success: true, nonce: '22' };
    } else if (url.pathname === '/checkIfDepositNeeded')
      body = { resourceLockRequired: true, transactions: [], tokenIn: '1000000', tokenOut: '990000' };
    else if (url.pathname === '/compact') {
      allocations.push(String(init?.body));
      body = { hash, signature: '0x00', digest: hash, nonce: '22' };
    } else if (url.pathname === '/reportFill') body = { success: true };
    else if (url.pathname === '/miden-recipient')
      body = { midenP2IDRecipientAccountId: PREPARED_RECIPIENT, midenMinReclaimBlocks: 1000 };
    else if (url.pathname === '/health')
      body = {
        status: 'healthy',
        allocatorAddresses: { [sepolia.id]: PREPARED_OWNER, 999999999: PREPARED_OWNER },
        arbiterAddresses: { [sepolia.id]: PREPARED_OWNER, 999999999: PREPARED_OWNER },
        compactAddresses: { [sepolia.id]: PREPARED_OWNER, 999999999: PREPARED_OWNER },
        compactLockResetPeriod: 0,
        compactLockScope: 0,
        compactExpirySeconds: 3600,
        compactExpiryBufferSeconds: 300,
        midenRecallBufferBlocks: 250,
        midenVirtualChainId: 999999999,
        midenTestnetVirtualChainId: 999999999,
        midenMainnetVirtualChainId: 999999998
      };
    else throw new Error(`Unexpected allocator path ${url.pathname}`);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetchMock });
  const params = {
    sourceChainId: sepolia.id,
    destinationChainId: 999999999,
    evmSourceAddress: PREPARED_OWNER,
    evmTokenAddress: PREPARED_TOKEN,
    midenRecipientId: PREPARED_RECIPIENT,
    midenFaucetId: PREPARED_FAUCET,
    minTokenOut: '980000'
  };
  const quote = {
    taskTypeString: witness,
    intentData,
    params,
    quoteResult: {
      success: true,
      resourceLockRequired,
      tokenIn: '1000000',
      tokenOut: '990000',
      transactions: resourceLockRequired
        ? []
        : [{ target: PREPARED_OWNER, callData: '0x1234', value: '0', chainId: sepolia.id }]
    }
  };
  return {
    config,
    sdk: new EpochIntentSDK(config),
    params,
    quote,
    events,
    requests,
    submitted,
    allocations,
    nonces: () => nonces
  };
}

let mockWallet: WalletClient;
let mockQueue = async (_row: ITransaction) => {};
jest.mock('./client', () => ({
  getEvmConnection: async () => ({ address: PREPARED_OWNER, isNative: true, chainId: 11155111 }),
  buildEpochWalletClient: async () => mockWallet,
  buildEpochReadOnlyWalletClient: () => mockWallet
}));
jest.mock('@reown/appkit/react', () => ({ useAppKitAccount: () => ({}) }));
jest.mock('lib/remote-config/runtime', () => ({
  initBridgeConfig: async () => {},
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));
jest.mock('lib/miden/activity/bridge-in', () => ({
  registerPendingBridgeIn: async () => {},
  resolveBridgeInNoteId: async () => {}
}));
jest.mock('./chain', () => ({
  getCurrentMidenBlock: async () => 1000,
  MIDEN_MIN_RECLAIM_BLOCKS: 1000,
  MIDEN_RECLAIM_BUFFER_BLOCKS: 200
}));
jest.mock('./collateral-note', () => ({
  buildEpochCollateralRequestBytes: async () => ({
    requestBytes: new Uint8Array([1]),
    reclaimHeight: 2000,
    noteId: 'note-stamped'
  })
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (value: string) => ({ toString: () => value }),
  getBech32AddressFromAccountId: (value: { toString: () => string }) => value.toString()
}));
jest.mock('lib/miden/spending-limits/queue', () => ({
  queueOutgoingTransaction: (row: ITransaction) => mockQueue(row),
  spendsOf: (row: ITransaction) => [{ faucetId: row.faucetId, amount: row.amount }]
}));
jest.mock('lib/miden/activity', () => ({
  initiateEarnDepositTransaction: (...args: unknown[]) =>
    Reflect.apply(
      jest.requireActual<typeof import('lib/miden/transaction/initiate')>('lib/miden/transaction/initiate')
        .initiateEarnDepositTransaction,
      undefined,
      args
    ),
  updateEarnDepositStatus: (...args: unknown[]) =>
    Reflect.apply(
      jest.requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
        .updateEarnDepositStatus,
      undefined,
      args
    ),
  requestSWTransactionProcessing: jest.fn(),
  startBackgroundTransactionProcessing: jest.fn(),
  waitForTransactionCompletion: jest.fn()
}));
beforeEach(async () => {
  await Repo.db.open();
  resetEpochSdk();
  useEpochStore.getState().reset();
  installProviderReceiptBackend(async () => {});
});
afterEach(() => {
  installProviderReceiptBackend(undefined);
  resetEpochSdk();
});
async function inbound(setup: ReturnType<typeof fixture>) {
  mockWallet = setup.config.walletClient;
  const id = await initiateBridgedReceiveTransaction({
    accountId: PREPARED_RECIPIENT,
    amount: 980000n,
    faucetId: PREPARED_FAUCET,
    provider: 'epoch',
    sourceAddress: PREPARED_OWNER,
    sourceAmount: '1',
    sourceSymbol: 'USDC',
    sourceChainId: 11155111,
    epochAllocatorUrl: setup.config.apiBaseUrl
  });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: setup.quote });
  return id;
}
it('Task4C2 owners retains the production inbound compact before the first source request', async () => {
  const setup = fixture();
  const id = await inbound(setup);
  const entered = deferred();
  const ack = deferred();
  let retained: unknown;
  installProviderReceiptBackend(async value => {
    retained = value;
    entered.release();
    await ack.promise;
  });
  const operation = useEpochStore.getState().executeEVMToMiden(id);
  try {
    await Promise.race([entered.promise, setup.submitted.promise, operation]);
    expect(setup.requests).toHaveLength(0);
    expect(retained).toMatchObject({
      extraInputs: {
        sourceSubmission: 'attempted',
        intentNonce: '22',
        epochExecution: { claimHash: expect.any(String), requestJson: expect.any(String) }
      }
    });
    ack.release();
    await operation;
    expect(useEpochStore.getState().status).toBe('pending');
    expect(setup.allocations).toHaveLength(1);
    expect(setup.nonces()).toBe(1);
  } finally {
    ack.release();
    await operation;
  }
});
it('Task4C2 owners refuses a fresh inbound solve for a prior attempted source with no hash', async () => {
  const setup = fixture();
  const id = await inbound(setup);
  await Repo.transactions.where({ id }).modify(row => {
    row.extraInputs.sourceSubmission = 'attempted';
  });
  await useEpochStore.getState().executeEVMToMiden(id);
  expect(setup.requests).toHaveLength(0);
  expect(setup.nonces()).toBe(0);
  expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('submitting');
  expect(getStorageHealth().status).toBe('healthy');
});
it('Task4C2 owners carries Earn preparation into the actual collateral queue before execution permission', async () => {
  const setup = fixture();
  mockWallet = createWalletClient({
    account: PREPARED_OWNER,
    chain: { ...sepolia, id: 999999999 },
    transport: custom({ request: setup.config.walletClient.request })
  });
  const entered = deferred();
  const finish = deferred();
  let queued: ITransaction | undefined;
  mockQueue = async row => {
    queued = row;
    entered.release();
    await finish.promise;
    throw new Error('Financial queue refused');
  };
  const operation = openEarnPosition({
    amount: 1000000n,
    collateral: { ...TEST_MIDEN_USDC, faucetId: PREPARED_FAUCET },
    evmAddress: PREPARED_OWNER,
    market: TEST_EARN_MARKET,
    protocol: 'dummy-lending',
    senderPublicKey: PREPARED_RECIPIENT,
    deps: {
      signTransaction: async () => new Uint8Array(),
      guardianProvider: {
        getAccounts: async () => [],
        getPublicKeyForCommitment: async () => '',
        signWord: async () => ''
      }
    }
  }).catch((error: unknown) => error);
  try {
    await Promise.race([entered.promise, operation]);
    expect(queued?.extraInputs.intentNonce).toBe('22');
    expect(queued?.extraInputs.epochExecution?.requestJson).toEqual(expect.any(String));
    expect(setup.allocations).toHaveLength(0);
    finish.release();
    await operation;
    expect(setup.allocations).toHaveLength(0);
  } finally {
    finish.release();
    await operation;
  }
});
it('Task4C2 owners keeps a wallet cancellation distinct from storage failure', async () => {
  const setup = fixture();
  const id = await inbound(setup);
  const original = setup.config.walletClient;
  mockWallet = createWalletClient({
    account: PREPARED_OWNER,
    chain: sepolia,
    transport: custom(
      {
        request: async args => {
          if (args.method === 'eth_sendTransaction')
            throw Object.assign(new Error('User rejected the request'), { code: 4001 });
          return original.request(args);
        }
      },
      { retryCount: 0 }
    )
  });
  await useEpochStore.getState().executeEVMToMiden(id);
  expect(setup.requests).toHaveLength(0);
  expect(setup.allocations).toHaveLength(0);
  expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('failed');
  expect(getStorageHealth().status).toBe('healthy');
});
it('Task4C2 enrichment keeps a production Epoch attempt unresolved after an ambiguous wallet response', async () => {
  const setup = fixture();
  const id = await inbound(setup);
  const original = setup.config.walletClient;
  let sends = 0;
  mockWallet = createWalletClient({
    account: PREPARED_OWNER,
    chain: sepolia,
    transport: custom(
      {
        request: async args => {
          if (args.method === 'eth_sendTransaction') {
            sends++;
            throw new Error('Wallet response lost');
          }
          return original.request(args);
        }
      },
      { retryCount: 0 }
    )
  });
  await useEpochStore.getState().executeEVMToMiden(id);
  expect(sends).toBe(1);
  expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('submitting');
  expect((await Repo.transactions.get(id))?.extraInputs.sourceSubmission).toBe('attempted');
  expect(getStorageHealth().status).toBe('healthy');
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: setup.quote });
  await useEpochStore.getState().executeEVMToMiden(id);
  expect(sends).toBe(1);
});

it('Task4C2 supplemental waits for the production accepted allocation receipt before reporting pending', async () => {
  const setup = fixture();
  const id = await inbound(setup);
  const entered = deferred();
  const ack = deferred();
  let retained: unknown;
  let settled = false;
  installProviderReceiptBackend(async value => {
    if (!JSON.stringify(value).includes('"submission":"accepted"')) return;
    retained = value;
    entered.release();
    await ack.promise;
  });
  const operation = useEpochStore
    .getState()
    .executeEVMToMiden(id)
    .then(() => {
      settled = true;
    });
  try {
    await Promise.race([entered.promise, operation]);
    expect(settled).toBe(false);
    expect(useEpochStore.getState().status).toBe('signing');
    expect(retained).toMatchObject({
      extraInputs: {
        intentNonce: '22',
        epochExecution: {
          submission: 'accepted',
          allocation: { hash, signature: '0x00', digest: hash }
        }
      }
    });
    expect(setup.nonces()).toBe(1);
    expect(setup.allocations).toHaveLength(1);
    ack.release();
    await operation;
    expect(useEpochStore.getState().status).toBe('pending');
    expect(getStorageHealth().status).toBe('healthy');
  } finally {
    ack.release();
    await operation;
  }
});
