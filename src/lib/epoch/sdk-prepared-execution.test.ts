import {
  ActionType,
  EpochIntentSDK,
  MIDEN_VIRTUAL_CHAIN_ID,
  STATELESS_7702_IMPLEMENTATION,
  mockEip7702DelegatedCode,
  type BeforeExecute,
  type ExecuteActionOptions,
  type ExecuteActionParams,
  type PreparedExecution
} from '@epoch-protocol/epoch-intents-sdk';
import { createWalletClient, custom } from 'viem';
import { toAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { deferred } from './testing/earn-locks';

const mockCreatePublicClient = jest.fn();
const mockSignDepositDelegation = jest.fn();
const mockEncodeRedeemExecutionData = jest.fn();
const mockSign7702AuthorizationIfNeeded = jest.fn();

jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: (...args: unknown[]) => mockCreatePublicClient(...args)
}));

jest.mock('@epoch-protocol/epoch-intents-sdk/dist/gasless/relay', () => ({
  ...jest.requireActual<typeof import('@epoch-protocol/epoch-intents-sdk/dist/gasless/relay')>(
    '@epoch-protocol/epoch-intents-sdk/dist/gasless/relay'
  ),
  signDepositDelegation: () => mockSignDepositDelegation(),
  encodeRedeemExecutionData: () => mockEncodeRedeemExecutionData(),
  sign7702AuthorizationIfNeeded: () => mockSign7702AuthorizationIfNeeded()
}));

const OWNER = '0x1111111111111111111111111111111111111111';
const UNDERLYING = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
const MIDEN_RECIPIENT = '0x0123456789abcdef0123456789abcd';
const MIDEN_FAUCET = '0x123456789abcdef0123456789abcde';
const API_BASE = 'https://allocator.invalid';
const TEST_CHAIN = {
  ...sepolia,
  rpcUrls: { ...sepolia.rpcUrls, default: { http: ['https://rpc.invalid'] } }
};

interface AllocatorOptions {
  readonly resourceLocks?: readonly boolean[];
  readonly suggestedNonces?: readonly string[];
  readonly allowRelayExecute?: boolean;
}

function hash(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function jsonResponse(body: object, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERROR',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function actionParams(options: ExecuteActionOptions): ExecuteActionParams {
  return {
    action: ActionType.Withdraw,
    underlying: UNDERLYING,
    amount: '1000000',
    protocol: 'dummy-lending',
    chainId: sepolia.id,
    swapAndBridge: {
      toToken: MIDEN_FAUCET,
      toChainId: MIDEN_VIRTUAL_CHAIN_ID,
      recipient: MIDEN_RECIPIENT
    },
    ...options
  };
}

function installAllocator(events: string[], options: AllocatorOptions = {}) {
  const compactBodies: string[] = [];
  const suggestedNonces = [...(options.suggestedNonces ?? ['101', '102', '11', '103', '22'])];
  const resourceLocks = [...(options.resourceLocks ?? [true, true, true])];
  let quoteCount = 0;
  let suggestedNonceRequestCount = 0;
  let relayExecuteCount = 0;
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (!url.startsWith(API_BASE)) throw new Error(`Unhandled fetch URL: ${url}`);
    const path = new URL(url).pathname;
    events.push(`fetch:${path}`);
    if (path === '/checkIfDepositNeeded' && init?.method === 'POST') {
      quoteCount += 1;
      const resourceLockRequired = resourceLocks.shift();
      if (resourceLockRequired === undefined) throw new Error('Unexpected extra quote request');
      return jsonResponse({
        success: true,
        resourceLockRequired,
        transactions: resourceLockRequired
          ? []
          : [{ target: OWNER, callData: '0x1234', value: '0', chainId: sepolia.id }],
        path: [],
        tokenIn: UNDERLYING,
        tokenOut: '1000000',
        tokenInDecimals: 6,
        tokenInSymbol: 'USDC'
      });
    }
    if (path.startsWith('/suggested-nonce/') && init?.method === 'GET') {
      suggestedNonceRequestCount += 1;
      const nonce = suggestedNonces.shift();
      if (!nonce) throw new Error('Unexpected extra suggested-nonce request');
      return jsonResponse({ success: true, nonce });
    }
    if (path === '/relay-execute' && init?.method === 'POST' && options.allowRelayExecute) {
      relayExecuteCount += 1;
      return jsonResponse({ success: true, txHash: hash(3), nonce: 'relay-999' });
    }
    if (path === '/compact' && init?.method === 'POST') {
      const body = String(init.body);
      compactBodies.push(body);
      const request = JSON.parse(body);
      return jsonResponse({
        hash: hash(90 + compactBodies.length),
        signature: '0x00',
        digest: hash(80),
        nonce: request.compact.nonce
      });
    }
    throw new Error(`Unhandled allocator request: ${init?.method ?? 'GET'} ${path}`);
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    writable: true,
    configurable: true
  });
  return {
    compactBodies,
    counts: () => ({ quoteCount, suggestedNonceRequestCount, relayExecuteCount })
  };
}

function installPublicClient(events: string[], getCodeResult: `0x${string}` = '0x') {
  const readContract = jest.fn(async () => 1n << 255n);
  const waitForTransactionReceipt = jest.fn(async ({ hash: transactionHash }) => {
    events.push(`receipt:${transactionHash}`);
    return { status: 'success', transactionHash };
  });
  const getCode = jest.fn(async () => getCodeResult);
  const client = { readContract, waitForTransactionReceipt, getCode };
  mockCreatePublicClient.mockReturnValue(client);
  return client;
}

function sequentialWallet(events: string[]) {
  const sentHashes = [hash(1), hash(2), hash(5), hash(6)];
  const request = jest.fn(async ({ method }: { method: string }) => {
    events.push(`wallet:${method}`);
    if (method === 'wallet_getCapabilities') return { '0xaa36a7': {} };
    if (method === 'eth_chainId') return `0x${sepolia.id.toString(16)}`;
    if (method === 'eth_sendTransaction') {
      const transactionHash = sentHashes.shift();
      if (!transactionHash) throw new Error('Unexpected extra eth_sendTransaction');
      return transactionHash;
    }
    throw new Error(`Unhandled wallet RPC method: ${method}`);
  });
  return {
    request,
    client: createWalletClient({ account: OWNER, chain: TEST_CHAIN, transport: custom({ request }) })
  };
}

function batchWallet(events: string[]) {
  const request = jest.fn(async ({ method }: { method: string }) => {
    events.push(`wallet:${method}`);
    if (method === 'wallet_getCapabilities') {
      return { '0xaa36a7': { atomic: { status: 'supported' } } };
    }
    if (method === 'wallet_sendCalls') return 'bundle-1';
    if (method === 'wallet_getCallsStatus') {
      return {
        atomic: true,
        chainId: '0xaa36a7',
        status: 200,
        version: '2.0.0',
        receipts: [{ transactionHash: hash(4), status: '0x1', blockNumber: '0x1', gasUsed: '0x1' }]
      };
    }
    throw new Error(`Unhandled wallet RPC method: ${method}`);
  });
  return {
    request,
    client: createWalletClient({ account: OWNER, chain: TEST_CHAIN, transport: custom({ request }) })
  };
}

function gaslessWallet(events: string[]) {
  const signature: `0x${string}` = `0x${'01'.repeat(65)}`;
  const account = toAccount({
    address: OWNER,
    async signMessage() {
      return signature;
    },
    async signTransaction() {
      return '0x02';
    },
    async signTypedData() {
      return signature;
    }
  });
  const request = jest.fn(async ({ method }: { method: string }) => {
    events.push(`wallet:${method}`);
    throw new Error(`Unhandled wallet RPC method: ${method}`);
  });
  return {
    request,
    client: createWalletClient({ account, chain: TEST_CHAIN, transport: custom({ request }) })
  };
}

function parkedCallback(events: string[]) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const captures: PreparedExecution[] = [];
  const callback: BeforeExecute = async prepared => {
    events.push('callback:entered');
    captures.push(prepared);
    entered.resolve();
    await release.promise;
    events.push('callback:released');
  };
  return { callback, captures, entered, release };
}

function callbackForRejection(events: string[]) {
  const rejection = new Error('persistence rejected');
  const callback = jest.fn<ReturnType<BeforeExecute>, Parameters<BeforeExecute>>(async () => {
    events.push('callback:rejected');
    throw rejection;
  });
  return { callback, rejection };
}

function preparedNonces(prepared: PreparedExecution): string[] {
  return prepared.allocations.map(allocation => allocation.nonce);
}

function submittedNonces(bodies: readonly string[]): string[] {
  return bodies.map(body => JSON.parse(body).compact.nonce);
}

function isCompactRequest(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'compact' in value && 'witnessTypeString' in value;
}

async function settleAsyncWork(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('parks paid sequential execution on immutable exact allocation descriptors', async () => {
  const events: string[] = [];
  const allocator = installAllocator(events);
  const publicClient = installPublicClient(events);
  const wallet = sequentialWallet(events);
  const parked = parkedCallback(events);
  const sdk = new EpochIntentSDK({ apiBaseUrl: API_BASE, walletClient: wallet.client });

  const execution = sdk.helpers.executeActions(actionParams({ gasless: false, onBeforeExecute: parked.callback }));
  await parked.entered.promise;
  await settleAsyncWork();

  expect(wallet.request.mock.calls.map(([request]) => request.method)).not.toContain('eth_sendTransaction');
  expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  expect(allocator.compactBodies).toEqual([]);
  expect(parked.captures).toHaveLength(1);
  const prepared = parked.captures[0];
  expect(prepared).toBeDefined();
  if (!prepared) throw new Error('Missing prepared execution');
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.allocations)).toBe(true);
  expect(prepared.allocations.every(Object.isFrozen)).toBe(true);
  expect(prepared.chainId).toBe(sepolia.id);
  expect(preparedNonces(prepared)).toEqual(['11', '22']);
  expect(prepared.allocations.map(allocation => allocation.sponsor)).toEqual([OWNER, OWNER]);
  expect(prepared.allocations.every(allocation => /^\d+$/.test(allocation.expires))).toBe(true);
  for (const allocation of prepared.allocations) {
    const request = JSON.parse(allocation.requestJson);
    expect({ sponsor: allocation.sponsor, nonce: allocation.nonce, expires: allocation.expires }).toEqual({
      sponsor: request.compact.sponsor,
      nonce: request.compact.nonce,
      expires: request.compact.expires
    });
  }

  parked.release.resolve();
  const result = await execution;

  expect(wallet.request.mock.calls.map(([request]) => request.method)).toEqual([
    'wallet_getCapabilities',
    'eth_chainId',
    'eth_sendTransaction',
    'eth_chainId',
    'eth_sendTransaction'
  ]);
  expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  expect(allocator.compactBodies).toEqual(prepared.allocations.map(allocation => allocation.requestJson));
  expect(submittedNonces(allocator.compactBodies)).toEqual(['11', '22']);
  expect(result.allocations.map(allocation => allocation.nonce)).toEqual(['11', '22']);
});

test('rejecting the callback prevents paid sequential execution and allocation submission', async () => {
  const events: string[] = [];
  const allocator = installAllocator(events);
  const publicClient = installPublicClient(events);
  const wallet = sequentialWallet(events);
  const denied = callbackForRejection(events);
  const sdk = new EpochIntentSDK({ apiBaseUrl: API_BASE, walletClient: wallet.client });

  await expect(
    sdk.helpers.executeActions(actionParams({ gasless: false, onBeforeExecute: denied.callback }))
  ).rejects.toBe(denied.rejection);

  expect(denied.callback).toHaveBeenCalledTimes(1);
  expect(wallet.request.mock.calls.map(([request]) => request.method)).not.toContain('eth_sendTransaction');
  expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  expect(allocator.compactBodies).toEqual([]);
});

test('parks paid batch execution before wallet_sendCalls and then continues', async () => {
  const events: string[] = [];
  const allocator = installAllocator(events);
  installPublicClient(events);
  const wallet = batchWallet(events);
  const parked = parkedCallback(events);
  const sdk = new EpochIntentSDK({ apiBaseUrl: API_BASE, walletClient: wallet.client });

  const execution = sdk.helpers.executeActions(
    actionParams({ gasless: false, forceAtomic: true, onBeforeExecute: parked.callback })
  );
  await parked.entered.promise;
  await settleAsyncWork();
  expect(wallet.request).not.toHaveBeenCalled();
  expect(allocator.compactBodies).toEqual([]);

  parked.release.resolve();
  const result = await execution;

  expect(wallet.request.mock.calls.map(([request]) => request.method)).toEqual([
    'wallet_getCapabilities',
    'wallet_sendCalls',
    'wallet_getCallsStatus'
  ]);
  expect(submittedNonces(allocator.compactBodies)).toEqual(['11', '22']);
  expect(result.allocations.map(allocation => allocation.nonce)).toEqual(['11', '22']);
  expect(events.indexOf('wallet:wallet_sendCalls')).toBeLessThan(events.indexOf('fetch:/compact'));
});

test('rejecting the callback prevents paid batch execution and allocation submission', async () => {
  const events: string[] = [];
  const allocator = installAllocator(events);
  installPublicClient(events);
  const wallet = batchWallet(events);
  const denied = callbackForRejection(events);
  const sdk = new EpochIntentSDK({ apiBaseUrl: API_BASE, walletClient: wallet.client });

  await expect(
    sdk.helpers.executeActions(actionParams({ gasless: false, forceAtomic: true, onBeforeExecute: denied.callback }))
  ).rejects.toBe(denied.rejection);

  expect(wallet.request).not.toHaveBeenCalled();
  expect(allocator.compactBodies).toEqual([]);
});

test('parks gasless execution before relay and then continues with a distinct relay nonce', async () => {
  const events: string[] = [];
  const allocator = installAllocator(events, { allowRelayExecute: true });
  const delegate = STATELESS_7702_IMPLEMENTATION[sepolia.id];
  if (!delegate) throw new Error('Missing test-chain 7702 implementation');
  const publicClient = installPublicClient(events, mockEip7702DelegatedCode(delegate));
  mockSignDepositDelegation.mockImplementation(async () => {
    events.push('sign:delegation');
    return { delegate: OWNER, delegator: OWNER, authority: hash(0), caveats: [], salt: '0x00' };
  });
  mockEncodeRedeemExecutionData.mockImplementation(() => {
    events.push('encode:redeem');
    return '0x1234';
  });
  mockSign7702AuthorizationIfNeeded.mockImplementation(async () => {
    events.push('sign:authorization');
    return undefined;
  });
  const wallet = gaslessWallet(events);
  const parked = parkedCallback(events);
  const sdk = new EpochIntentSDK({ apiBaseUrl: API_BASE, walletClient: wallet.client });

  const execution = sdk.helpers.executeActions(actionParams({ gasless: true, onBeforeExecute: parked.callback }));
  await parked.entered.promise;
  await settleAsyncWork();
  expect(mockSignDepositDelegation).not.toHaveBeenCalled();
  expect(allocator.counts().relayExecuteCount).toBe(0);
  expect(allocator.compactBodies).toEqual([]);

  parked.release.resolve();
  const result = await execution;

  expect(mockSignDepositDelegation).toHaveBeenCalledTimes(1);
  expect(mockEncodeRedeemExecutionData).toHaveBeenCalledTimes(1);
  expect(mockSign7702AuthorizationIfNeeded).toHaveBeenCalledTimes(1);
  expect(allocator.counts().relayExecuteCount).toBe(1);
  expect(submittedNonces(allocator.compactBodies)).toEqual(['11', '22']);
  expect(result.allocations.map(allocation => allocation.nonce)).toEqual(['11', '22']);
  expect(events.indexOf('fetch:/relay-execute')).toBeLessThan(events.indexOf('fetch:/compact'));
  expect(publicClient.getCode).toHaveBeenCalledTimes(2);
});

test('rejecting the callback prevents gasless signing, relay, and allocation submission', async () => {
  const events: string[] = [];
  const allocator = installAllocator(events, { allowRelayExecute: true });
  const delegate = STATELESS_7702_IMPLEMENTATION[sepolia.id];
  if (!delegate) throw new Error('Missing test-chain 7702 implementation');
  installPublicClient(events, mockEip7702DelegatedCode(delegate));
  const wallet = gaslessWallet(events);
  const denied = callbackForRejection(events);
  const sdk = new EpochIntentSDK({ apiBaseUrl: API_BASE, walletClient: wallet.client });

  await expect(
    sdk.helpers.executeActions(actionParams({ gasless: true, onBeforeExecute: denied.callback }))
  ).rejects.toBe(denied.rejection);

  expect(mockSignDepositDelegation).not.toHaveBeenCalled();
  expect(mockEncodeRedeemExecutionData).not.toHaveBeenCalled();
  expect(mockSign7702AuthorizationIfNeeded).not.toHaveBeenCalled();
  expect(allocator.counts().relayExecuteCount).toBe(0);
  expect(allocator.compactBodies).toEqual([]);
});

test.each([
  {
    name: 'zero',
    resourceLocks: [false, false, false],
    suggestedNonces: ['101', '102', '103'],
    expected: []
  },
  {
    name: 'one',
    resourceLocks: [true, true, false],
    suggestedNonces: ['101', '102', '11', '103'],
    expected: ['11']
  }
])('invokes the callback once for $name prepared allocations', async fixture => {
  const events: string[] = [];
  const allocator = installAllocator(events, fixture);
  installPublicClient(events);
  const wallet = sequentialWallet(events);
  const captures: PreparedExecution[] = [];
  const callback: BeforeExecute = async prepared => {
    captures.push(prepared);
  };
  const sdk = new EpochIntentSDK({ apiBaseUrl: API_BASE, walletClient: wallet.client });

  await sdk.helpers.executeActions(actionParams({ gasless: false, onBeforeExecute: callback }));

  expect(captures).toHaveLength(1);
  const prepared = captures[0];
  if (!prepared) throw new Error('Missing prepared execution');
  expect(preparedNonces(prepared)).toEqual(fixture.expected);
  expect(submittedNonces(allocator.compactBodies)).toEqual(fixture.expected);
});

test('does not serialize prepared descriptors when the callback is absent', async () => {
  const events: string[] = [];
  installAllocator(events);
  installPublicClient(events);
  const wallet = sequentialWallet(events);
  const stringify = jest.spyOn(JSON, 'stringify');
  const sdk = new EpochIntentSDK({ apiBaseUrl: API_BASE, walletClient: wallet.client });

  await sdk.helpers.executeActions(actionParams({ gasless: false }));

  const compactSerializations = stringify.mock.calls.filter(([value]) => isCompactRequest(value));
  expect(compactSerializations).toHaveLength(5);
});
