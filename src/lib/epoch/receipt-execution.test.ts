import { CollateralType, EpochIntentSDK, type EpochIntentSDKConfig } from '@epoch-protocol/epoch-intents-sdk';
import { COMPACT_ABI } from '@epoch-protocol/epoch-intents-sdk/dist/constants';
import { createWalletClient, custom, decodeFunctionData, isHex } from 'viem';
import { sepolia } from 'viem/chains';

import {
  buildCrossChainIntent,
  buildEVMToMidenIntent,
  type EpochPreparedIntent,
  type EpochReceiptHooks
} from './bridge';
import { PREPARED_FAUCET, PREPARED_OWNER, PREPARED_RECIPIENT, PREPARED_TOKEN } from './testing/earn-prepared';

const mockPublicClient = jest.fn();
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: (...args: unknown[]) => mockPublicClient(...args)
}));
jest.mock('@miden-sdk/miden-sdk', () => ({ AccountId: { fromHex: (value: string) => ({ toString: () => value }) } }));
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
function fixture(resourceLockRequired = true, batch = false, forced = false, failBatchStatus = false) {
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
    if (method === 'wallet_getCallsStatus' && failBatchStatus)
      return { atomic: true, chainId: '0xaa36a7', status: 200, version: '2.0.0', receipts: [] };
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
    } else if (url.pathname === '/compact') {
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

it.each([
  { lock: true, batch: false },
  { lock: true, batch: true },
  { lock: false, batch: false }
])(
  'Task4C2 finalseams freezes one Epoch nonce before resourceLock=$lock batch=$batch execution',
  async ({ lock, batch }) => {
    const setup = fixture(lock, batch);
    const entered = deferred();
    const ack = deferred();
    let prepared: EpochPreparedIntent | undefined;
    const recovery: EpochReceiptHooks = {
      config: setup.config,
      assertCurrent: () => {},
      beforeExecute: async value => {
        prepared = value;
        entered.release();
        await ack.promise;
      },
      onSubmitted: async () => {},
      beforeAllocation: async () => {}
    };
    const operation = buildEVMToMidenIntent(setup.sdk, { ...setup.params, preFetchedQuote: setup.quote, recovery });
    try {
      await Promise.race([entered.promise, setup.submitted.promise, operation]);
      expect(setup.requests).toHaveLength(0);
      expect(prepared?.resourceLockRequired).toBe(lock);
      ack.release();
      const result = await operation;
      expect(result.error).toBeUndefined();
      expect(setup.nonces()).toBe(1);
      expect(setup.allocations).toHaveLength(lock ? 1 : 0);
      expect(setup.allocations).toEqual(lock ? [prepared?.requestJson] : []);
      const request: unknown = JSON.parse(prepared?.requestJson ?? '{}');
      expect(request).toMatchObject({
        compact: { arbiter: PREPARED_OWNER, nonce: '22', amount: '1000000', mandate: { tokenInAmount: '1000000' } }
      });
      const encoded = setup.requests.at(-1);
      const item: unknown = Array.isArray(encoded) ? encoded[0] : undefined;
      const data: unknown = typeof item === 'object' && item !== null ? Reflect.get(item, 'data') : undefined;
      const decoded = lock && !batch && isHex(data) ? decodeFunctionData({ abi: COMPACT_ABI, data }) : undefined;
      expect(decoded?.functionName).toBe(lock && !batch ? 'depositERC20AndRegister' : undefined);
      expect(decoded?.args?.map(value => String(value)).includes(prepared?.claimHash ?? '')).toBe(
        lock && !batch ? true : undefined
      );
    } finally {
      ack.release();
      await operation;
    }
  }
);

it('Task4C2 finalseams keeps a forced withdrawal refusal before Epoch preparation or funding', async () => {
  const setup = fixture(true, false, true);
  const beforeExecute = jest.fn();
  const result = await buildEVMToMidenIntent(setup.sdk, {
    ...setup.params,
    preFetchedQuote: setup.quote,
    recovery: {
      config: setup.config,
      beforeExecute,
      onSubmitted: async () => {},
      beforeAllocation: async () => {},
      assertCurrent: () => {}
    }
  });
  expect(result.error).toContain('forced withdrawal');
  expect(beforeExecute).not.toHaveBeenCalled();
  expect(setup.requests).toHaveLength(0);
  expect(setup.allocations).toHaveLength(0);
});

it('Task4C2 finalseams preserves an Epoch accepted batch identity when receipt retention refuses', async () => {
  const setup = fixture(true, true);
  const submitted: string[] = [];
  const result = await buildEVMToMidenIntent(setup.sdk, {
    ...setup.params,
    preFetchedQuote: setup.quote,
    recovery: {
      config: setup.config,
      beforeExecute: async () => {},
      beforeAllocation: async () => {},
      assertCurrent: () => {},
      onSubmitted: async (_kind, id) => {
        submitted.push(id);
        throw new Error('Receipt retention refused');
      }
    }
  });
  expect(result.error).toBeDefined();
  expect(submitted).toEqual(['bundle-1']);
  expect(setup.requests).toHaveLength(1);
  expect(setup.allocations).toHaveLength(0);
  expect(setup.nonces()).toBe(1);
});

it('does not retry individual transactions after an accepted batch lacks status receipts', async () => {
  const setup = fixture(false, true, false, true);
  setup.quote.quoteResult.transactions = [
    { target: PREPARED_OWNER, callData: '0x1234', value: '0', chainId: sepolia.id },
    { target: PREPARED_OWNER, callData: '0xabcd', value: '0', chainId: sepolia.id }
  ];
  const submitted: string[] = [];
  const result = await buildEVMToMidenIntent(setup.sdk, {
    ...setup.params,
    preFetchedQuote: setup.quote,
    recovery: {
      config: setup.config,
      beforeExecute: async () => {},
      beforeAllocation: async () => {},
      assertCurrent: () => {},
      onSubmitted: async (_kind, id) => {
        submitted.push(id);
      }
    }
  });
  expect(setup.events.filter(method => method === 'eth_sendTransaction')).toHaveLength(0);
  expect(submitted).toEqual(['bundle-1']);
  expect(setup.requests).toHaveLength(1);
  expect(result.error).toBeDefined();
});

it('does not retry a compact deposit after an accepted batch lacks status receipts', async () => {
  const setup = fixture(true, true, false, true);
  const submitted: string[] = [];
  const result = await buildEVMToMidenIntent(setup.sdk, {
    ...setup.params,
    preFetchedQuote: setup.quote,
    recovery: {
      config: setup.config,
      beforeExecute: async () => {},
      beforeAllocation: async () => {},
      assertCurrent: () => {},
      onSubmitted: async (_kind, id) => {
        submitted.push(id);
      }
    }
  });
  expect(setup.events.filter(method => method === 'eth_sendTransaction')).toHaveLength(0);
  expect(submitted).toEqual(['bundle-1']);
  expect(setup.requests).toHaveLength(1);
  expect(result.error).toContain('Epoch submission requires reconciliation');
});

it.each([true, false])(
  'Task4C2 finalseams preserves Miden collateral callback and nonce for resourceLock=%s',
  async lock => {
    if (lock) jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    const setup = fixture(lock, false);
    const walletClient = createWalletClient({
      account: PREPARED_OWNER,
      chain: { ...sepolia, id: 999999999 },
      transport: custom({ request: setup.config.walletClient.request })
    });
    const config = { ...setup.config, walletClient };
    const entered = deferred();
    const ack = deferred();
    const noteCalled = deferred();
    const notes: unknown[][] = [];
    let prepared: EpochPreparedIntent | undefined;
    let allocationRequest: string | undefined;
    const params = {
      midenAccountId: PREPARED_RECIPIENT,
      midenFaucetId: PREPARED_FAUCET,
      midenAmount: '1000000',
      midenReclaimHeight: 10000,
      evmRecipient: PREPARED_OWNER,
      destinationChainId: sepolia.id,
      outputTokenAddress: PREPARED_TOKEN,
      minTokenOut: '980000'
    };
    const operation = buildCrossChainIntent(new EpochIntentSDK(config), {
      ...params,
      preFetchedQuote: { ...setup.quote, params },
      collateralType: CollateralType.Miden,
      midenSourceAccount: PREPARED_RECIPIENT,
      createMidenP2IDENote: async (...args) => {
        notes.push(args);
        noteCalled.release();
        return { success: true, noteId: 'miden-note-22' };
      },
      recovery: {
        config,
        assertCurrent: () => {},
        beforeExecute: async value => {
          prepared = value;
          entered.release();
          await ack.promise;
        },
        onSubmitted: async () => {},
        beforeAllocation: async request => {
          allocationRequest = request;
        }
      }
    });
    try {
      await Promise.race([entered.promise, noteCalled.promise, setup.submitted.promise, operation]);
      expect(notes.length).toBe(0);
      expect(setup.requests).toHaveLength(0);
      expect(prepared?.collateralType).toBe('miden');
      ack.release();
      if (lock) {
        await noteCalled.promise;
        await jest.advanceTimersByTimeAsync(12000);
      }
      const result = await operation;
      expect(result.error).toBeUndefined();
      expect(setup.nonces()).toBe(1);
      expect(notes).toHaveLength(lock ? 1 : 0);
      expect(setup.allocations).toHaveLength(lock ? 1 : 0);
      expect(setup.allocations).toEqual(lock ? [allocationRequest] : []);
      const expectedAllocation = expect.objectContaining({
        isRegisteredOnchain: false,
        compact: expect.objectContaining({
          nonce: '22',
          mandate: expect.objectContaining({
            midenNoteId: 'miden-note-22',
            midenSourceAccount: PREPARED_RECIPIENT,
            midenFaucetId: PREPARED_FAUCET
          })
        })
      });
      expect(allocationRequest ? JSON.parse(allocationRequest) : undefined).toEqual(
        lock ? expectedAllocation : undefined
      );
      expect(notes[0]?.[0]).toBe(lock ? PREPARED_FAUCET : undefined);
      expect(notes[0]?.[1]).toBe(lock ? '1000000' : undefined);
      expect(notes[0]?.[3]).toBe(lock ? 1250 : undefined);
      expect(Array.isArray(notes[0]?.[4])).toBe(lock);
    } finally {
      ack.release();
      if (lock) await jest.advanceTimersByTimeAsync(12000);
      await operation;
      jest.useRealTimers();
    }
  }
);
