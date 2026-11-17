import { waitFor } from '@testing-library/react';
import { parseUnits, type Hash, type EIP1193Provider } from 'viem';

import { runXReserveReceive } from 'lib/bridge/providers/xreserve/flows';
import type { XReserveClient } from 'lib/bridge/providers/xreserve/deposit';
import { usdcxExpectedRemoteTokenFor } from 'lib/usdcx/deposit-target';

import { bindTransferQuote, quoteAmounts } from 'lib/bridge/core/quote';
import { assertReviewedBridge, type ReviewedTransfer } from 'lib/bridge/core/review';
import { bridgeOperationOf, type BridgeOperationSnapshot } from 'lib/bridge/operation';
import { accounts, now, referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { reviewedCircleTransfer } from 'lib/bridge/testing/operation-fixtures';
import { createBridgeReceiveReconciler } from 'lib/miden/activity/bridge-receive';
import * as Repo from 'lib/miden/repo';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

import { getUsdcxSourceChain } from './constant';
import { runUsdcxDeposit } from './deposit';
import { runUsdcxExecutorDeposit } from './executor';
import { midenAccountHexToXReserveRecipient } from './recipient';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) }
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: jest.fn(() => 'https://wallet-rpc.example/private')
}));
jest.mock('lib/remote-config/runtime', () => ({
  initBridgeConfig: async () => undefined,
  getBridgeConfigSnapshot: () =>
    jest.requireActual<typeof import('lib/bridge/testing/fixtures')>('lib/bridge/testing/fixtures').referenceSnapshot('testnet')
}));

const sourceHash: Hash = `0x${'c'.repeat(64)}`;
const approvalHash: Hash = `0x${'a'.repeat(64)}`;
const fetchMock = jest.fn();
const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
beforeAll(() => Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock }));
afterAll(() => {
  if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
  else Reflect.deleteProperty(globalThis, 'fetch');
});
const approve = jest.fn(async () => approvalHash);
const deposit = jest.fn(async () => sourceHash);
let duringAllowance: () => Promise<void>;
let live: ReviewedTransfer;
let validationPatch: Record<string, unknown>;
let afterValidation: () => void;
function validationResponse() {
  const token = live.route.source.kind === 'erc20' ? live.route.source.address : '';
  return {
    signedQuote: '0x1234', feeToken: token, feeTotalAmount: '1', nonce: '0', claimable: true,
    expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000 + 60, expired: false, secondsRemaining: 60 },
    failedChecks: [], items: [{ type: 'FORWARD', argsMatch: true }, { type: 'PRE_FINALITY', argsMatch: true }],
    ...validationPatch
  };
}

function reviewFor(executor: boolean): ReviewedTransfer {
  const review = reviewedCircleTransfer();
  if (!executor) {
    const chain = referenceSnapshot('testnet').config?.supportedEvmChains['arc-testnet'];
    const token = chain?.bridges.usdcx?.tokens.USDC?.contractAddress;
    if (!token || !review.quote) throw new Error('Missing accepted Arc fixture');
    review.route.source = { kind: 'erc20', network: 'arc-testnet', symbol: 'USDC', decimals: 6, address: token };
    review.quote = bindTransferQuote({ route: review.route, amount: review.amount, ...accounts }, {
      kind: 'arc-deposit', received: review.amount, validity: { kind: 'time', expiresAt: now + 60000 }
    });
  }
  assertReviewedBridge(review, review, now);
  return review;
}

async function drive(executor: boolean, afterClaim?: (claimed: BridgeOperationSnapshot) => Promise<void>,
  changed: { amount?: string; recipient?: `0x${string}`; rowId?: string; fee?: bigint; contract?: boolean; depositor?: `0x${string}`; signature?: `0x${string}` } = {}) {
  const review = reviewFor(executor);
  live = structuredClone(review);
  const chainId = executor ? 11155111 : 5042002;
  const source = getUsdcxSourceChain(chainId);
  if (!source) throw new Error('Missing configured Circle source');
  if (changed.contract) {
    if (source.route === 'xreserve') source.xReserve = '0x2222222222222222222222222222222222222222';
    else source.target.handler = '0x2222222222222222222222222222222222222222';
  }
  let finish: (error: unknown) => void = () => undefined;
  const finished = new Promise<unknown>(resolve => { finish = resolve; });
  let winner: BridgeOperationSnapshot | undefined;
  const wrapper = createBridgeReceiveReconciler({ getLocks: () => undefined });
  const id = await wrapper.startSubmission(
    () => initiateBridgedReceiveTransaction({
      accountId: accounts.midenAccount, amount: parseUnits(review.amount, 6),
      faucetId: review.route.destination.kind === 'miden' ? review.route.destination.faucetId : '',
      provider: 'usdcx', sourceAddress: accounts.evmAddress, sourceChainId: chainId,
      sourceAmount: quoteAmounts(review.route, review.quote!).sourceTotal, sourceSymbol: 'USDC', usdcxSource: source,
      operation: { operationId: 'circle-owned', review }
    }),
    async (rowId, claimed) => {
      try {
        if (!claimed) throw new Error('Missing real CAS winner');
        winner = claimed;
        await afterClaim?.(claimed);
        const deps = {
          sourceChainId: chainId,
          signer: { approve, depositToRemote: deposit, depositForBurnWithHookAndFees: deposit },
          isRemoteDomainRegistered: async () => true,
          readAllowance: async () => { await duringAllowance(); return 10000000n; },
          waitForReceipt: async () => undefined,
          updatePhase: updateBridgedReceivePhase,
          owned: { rowId, operation: claimed, checks: { readCurrent: async () => live, now: () => now } }
        };
        const recipient = changed.recipient ?? midenAccountHexToXReserveRecipient(accounts.midenAccount);
        if (source.route === 'xreserve')
          await runUsdcxDeposit(changed.rowId ?? rowId, changed.amount ?? review.amount, recipient, { ...deps, source });
        else
          await runUsdcxExecutorDeposit(changed.rowId ?? rowId, changed.amount ?? review.amount, recipient, {
            ...deps, source, depositor: changed.depositor ?? `0x${accounts.evmAddress.slice(2)}`,
            readBalance: async () => 10000000n,
            fetchQuote: async () => ({ signedQuote: changed.signature ?? '0x1234', feeTotalAmount: changed.fee ?? 1n, expiresAt: now / 1000 + 60 })
          });
        finish(undefined);
      } catch (error) { finish(error); }
    }
  );
  const error = await finished;
  const row = await Repo.transactions.get(id);
  expect(winner?.sourceAttempt?.phase).toBe('running');
  expect(row).toBeDefined();
  return { id, row, winner, error };
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  duringAllowance = async () => undefined;
  validationPatch = {};
  afterValidation = () => undefined;
  fetchMock.mockImplementation(async () => {
    const body = validationResponse();
    afterValidation();
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  });
  await Repo.transactions.clear();
});
afterEach(() => jest.restoreAllMocks());

it.each([false, true])('adapts the reviewed provider into the actual receive wrapper and source leaf (executor=%s)', async executor => {
  const review = reviewFor(executor);
  live = structuredClone(review);
  const client = {
    readContract: jest.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'allowance') return 10000000n;
      if (functionName === 'balanceOf') return 1000000000n;
      if (functionName === 'decimals') return 6;
      if (functionName === 'isRemoteDomainRegistered') return true;
      if (functionName === 'getRemoteToken') return usdcxExpectedRemoteTokenFor(review.route.recovery.nativeAsset!.faucetId);
      if (functionName === 'paused') return false;
      if (functionName === 'getFee') return [1n, review.route.source.kind === 'erc20' ? review.route.source.address : ''];
      throw new Error('Unexpected read');
    }), call: jest.fn(async () => ({ data: '0x' })), estimateGas: jest.fn(async () => 100000n),
    waitForTransactionReceipt: jest.fn(), getBalance: jest.fn(async () => 1000000000n), getGasPrice: jest.fn(async () => 1n),
    getTransaction: jest.fn(), getBlockNumber: jest.fn(), getTransactionCount: jest.fn(), getBlock: jest.fn()
  } satisfies XReserveClient;
  const send = jest.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return [accounts.evmAddress];
    if (method === 'eth_chainId') return executor ? '0xaa36a7' : '0x4cef52';
    if (method === 'eth_sendTransaction') return sourceHash;
    throw new Error('Unexpected wallet method');
  });
  const provider: EIP1193Provider = { request: send, on: jest.fn(), removeListener: jest.fn() };
  const id = await runXReserveReceive({ operationId: 'circle-provider', review }, { provider, client,
    checks: { readCurrent: async () => live, verifyBalanceCap: async () => undefined, now: () => now } });
  await waitFor(async () => expect((await Repo.transactions.get(id))?.extraInputs.evmTxHash).toBe(sourceHash));
  const row = await Repo.transactions.get(id);
  expect(bridgeOperationOf(row!)?.sourceAttempt).toMatchObject({ phase: 'known', hash: sourceHash });
  expect(bridgeOperationOf(row!)?.operationId).toBe('circle-provider');
  expect(send.mock.calls.filter(([args]) => args.method === 'eth_sendTransaction')).toHaveLength(1);
  expect(await Repo.transactions.count()).toBe(1);
});

it.each([false, true])('first drives a real claimed Circle row (executor=%s)', async executor => {
  const { row, error } = await drive(executor);
  expect(error).toBeUndefined();
  expect(deposit).toHaveBeenCalledTimes(1);
  expect(approve).not.toHaveBeenCalled();
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
});

it.each([false, true])('refuses RPC departure after allowance read before signing (executor=%s)', async executor => {
  duringAllowance = async () => { jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other.example/private'); };
  const { error } = await drive(executor);
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
});

it.each([false, true])('refuses live reviewed amount change after allowance read (executor=%s)', async executor => {
  duringAllowance = async () => { live.amount = '2'; };
  const { error } = await drive(executor);
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});

it.each([false, true])('refuses a retired original source revision (executor=%s)', async executor => {
  const { error } = await drive(executor, async () => {
    const row = await Repo.transactions.where('type').equals('bridged-receive').first();
    if (!row) throw new Error('Missing admitted row');
    await Repo.transactions.update(row.id, { 'extraInputs.bridgeOperation.revision': 'other-revision' });
  });
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});

it.each([false, true])('refuses a different actual source amount (executor=%s)', async executor => {
  const { error } = await drive(executor, undefined, { amount: '2' });
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});
it.each([false, true])('refuses a different actual recipient (executor=%s)', async executor => {
  const { error } = await drive(executor, undefined, { recipient: `0x${'0'.repeat(64)}` });
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});
it.each([false, true])('refuses a different tracking row (executor=%s)', async executor => {
  const { error } = await drive(executor, undefined, { rowId: 'not-original-row' });
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});
it.each([false, true])('refuses changed configured contract or script (executor=%s)', async executor => {
  const { error } = await drive(executor, undefined, { contract: true });
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});
it('refuses a different actual executor depositor', async () => {
  const { error } = await drive(true, undefined, { depositor: '0x2222222222222222222222222222222222222222' });
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});
it('refuses a substituted signed executor authorization', async () => {
  const { error } = await drive(true, undefined, { signature: '0xabcd' });
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});
it('refuses an unreviewed executor fee even when existing allowance covers it', async () => {
  const { error } = await drive(true, undefined, { fee: 2n });
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});

it('verifies the exact canonical burn against Circle before an owned executor source prompt', async () => {
  const { error } = await drive(true);
  expect(error).toBeUndefined();
  expect(deposit).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v2/quote/validate/usdc/0'), expect.objectContaining({ method: 'POST' }));
});

it.each([
  ['rejected', { claimable: false, failedChecks: ['INVALID_AMOUNT'] }],
  ['signature', { signedQuote: '0xabcd' }],
  ['token', { feeToken: '0x2222222222222222222222222222222222222222' }],
  ['fee', { feeTotalAmount: '2' }],
  ['nonce', { nonce: '1' }],
  ['wrong hook', { items: [{ type: 'FORWARD', argsMatch: false }, { type: 'PRE_FINALITY', argsMatch: true }] }],
  ['missing service', { items: [{ type: 'FORWARD', argsMatch: true }, { type: 'FORWARD', argsMatch: true }] }],
  ['inconsistent', { failedChecks: ['QUOTE_EXPIRED'] }],
  ['expired', { claimable: false, failedChecks: ['QUOTE_EXPIRED'], expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000, expired: true, secondsRemaining: 0 } }],
  ['no headroom', { expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000 + 29, expired: false, secondsRemaining: 29 } }]
])('refuses %s validation before the actual owned burn', async (_, patch) => {
  validationPatch = patch;
  const { error } = await drive(true);
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});

it('refuses live review departure during Circle validation', async () => {
  afterValidation = () => { live.amount = '9'; };
  const { error } = await drive(true);
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});

it.each([false, true])('persists the original winning source hash after RPC departure in the signing await (executor=%s)', async executor => {
  deposit.mockImplementationOnce(async () => {
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other.example/private');
    return sourceHash;
  });
  const { row, winner } = await drive(executor);
  expect(bridgeOperationOf(row!)?.revision).toBe(winner?.revision);
  expect(bridgeOperationOf(row!)?.sourceAttempt).toMatchObject({ phase: 'known', hash: sourceHash });
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
});
