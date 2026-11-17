import { waitFor } from '@testing-library/react';
import { decodeFunctionData, erc20Abi, parseUnits, type Hash, type Hex, type EIP1193Provider } from 'viem';

import { runXReserveReceive } from 'lib/bridge/providers/xreserve/flows';
import type { XReserveClient } from 'lib/bridge/providers/xreserve/deposit';
import type { SourceRpcTransaction } from 'lib/bridge/evm/source-transaction';
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
const adapterRpc = { readContract: jest.fn(), call: jest.fn(), estimateGas: jest.fn(),
  waitForTransactionReceipt: jest.fn(), getBalance: jest.fn(), getGasPrice: jest.fn(), getTransaction: jest.fn(),
  getBlockNumber: jest.fn(), getTransactionCount: jest.fn(), getBlock: jest.fn() } satisfies XReserveClient;
const adapterWallet = jest.fn();
const adapterTransactions = new Map<Hash, SourceRpcTransaction>();
let adapterAllowance: bigint;
let afterAdapterApproval: () => void;
let adapterFee: bigint;
let targetRegistered: boolean;
let signed: { from: string; to: Hex; data: Hex; chainId: Hex; value: Hex }[];
jest.mock('lib/bridge/providers/xreserve/provider', () => ({ xreserveReadClient: () => adapterRpc }));
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
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
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

async function driveAdapter(executor: boolean, configure?: () => void) {
  const review = reviewFor(executor);
  live = structuredClone(review);
  adapterAllowance = 10000000n;
  adapterFee = 1n;
  targetRegistered = true;
  afterAdapterApproval = () => undefined;
  signed = [];
  adapterTransactions.clear();
  adapterRpc.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'allowance') return adapterAllowance;
    if (functionName === 'balanceOf') return 1000000000n;
    if (functionName === 'decimals') return 6;
    if (functionName === 'isRemoteDomainRegistered') return targetRegistered;
    if (functionName === 'getRemoteToken') return usdcxExpectedRemoteTokenFor(review.route.recovery.nativeAsset!.faucetId);
    if (functionName === 'paused') return false;
    if (functionName === 'getFee') return [adapterFee, review.route.source.kind === 'erc20' ? review.route.source.address : ''];
    throw new Error('Unexpected read');
  });
  adapterRpc.call.mockResolvedValue({ data: '0x' });
  adapterRpc.estimateGas.mockResolvedValue(100000n);
  adapterRpc.getBalance.mockResolvedValue(1000000000n);
  adapterRpc.getGasPrice.mockResolvedValue(1n);
  adapterRpc.getTransaction.mockImplementation(async ({ hash }) => {
    const tx = adapterTransactions.get(hash);
    if (!tx) throw new Error('Unmodelled transaction');
    return tx;
  });
  adapterRpc.waitForTransactionReceipt.mockImplementation(async ({ hash }) => {
    const tx = adapterTransactions.get(hash);
    if (!tx) throw new Error('Unmodelled receipt');
    if (tx.input.startsWith('0x095ea7b3')) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.input });
      if (decoded.functionName === 'approve') adapterAllowance = decoded.args[1];
      afterAdapterApproval();
    }
    return { transactionHash: hash, status: 'success' };
  });
  adapterWallet.mockImplementation(async ({ method, params }) => {
    if (method === 'eth_accounts') return [accounts.evmAddress];
    if (method === 'eth_chainId') return executor ? '0xaa36a7' : '0x4cef52';
    if (method !== 'eth_sendTransaction') throw new Error('Unexpected wallet method');
    const tx = params[0];
    signed.push(tx);
    const approval = tx.data.startsWith('0x095ea7b3');
    const hash: Hash = approval ? `0x${signed.length.toString(16).padStart(64, '0')}` : sourceHash;
    adapterTransactions.set(hash, { hash, from: `0x${accounts.evmAddress.slice(2)}`, to: tx.to, input: tx.data,
      value: BigInt(tx.value), nonce: signed.length, blockNumber: 1n });
    return hash;
  });
  configure?.();
  const provider: EIP1193Provider = { request: adapterWallet, on: jest.fn(), removeListener: jest.fn() };
  return runXReserveReceive({ operationId: 'circle-provider', review }, { provider, client: adapterRpc,
    checks: { readCurrent: async () => live, verifyBalanceCap: async () => undefined, now: () => now } });
}
it.each([false, true])('adapts the reviewed provider into the actual receive wrapper and source leaf (executor=%s)', async executor => {
  const id = await driveAdapter(executor);
  await waitFor(async () => expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('delivering'));
  const row = await Repo.transactions.get(id);
  expect(bridgeOperationOf(row!)?.sourceAttempt).toMatchObject({ phase: 'known', hash: sourceHash });
  expect(bridgeOperationOf(row!)?.operationId).toBe('circle-provider');
  expect(signed).toHaveLength(1);
  expect(await Repo.transactions.count()).toBe(1);
});

it.each([false, true])('resets a short nonzero allowance and records exact original approval facts (executor=%s)', async executor => {
  const id = await driveAdapter(executor, () => { adapterAllowance = 1n; });
  await waitFor(async () => expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('delivering'));
  const row = await Repo.transactions.get(id);
  expect(bridgeOperationOf(row!)?.approvals?.map(item => item.amount)).toEqual(['0', executor ? '1000002' : '1000001']);
  expect(bridgeOperationOf(row!)?.approvals?.every(item => item.transaction?.nonce !== undefined)).toBe(true);
  expect(signed).toHaveLength(3);
});
it.each([false, true])('checks the current remote token before paying for an approval (executor=%s)', async executor => {
  const id = await driveAdapter(executor, () => {
    adapterAllowance = 0n;
    const read = adapterRpc.readContract.getMockImplementation()!;
    adapterRpc.readContract.mockImplementation(async args => args.functionName === 'getRemoteToken' ? `0x${'0'.repeat(64)}` : read(args));
  });
  await waitFor(async () => expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).not.toBe('running'));
  expect(signed).toHaveLength(0);
});
it('refuses a signed-quote on-chain fee increase after a paid approval', async () => {
  const id = await driveAdapter(true, () => {
    adapterAllowance = 0n;
    afterAdapterApproval = () => { adapterFee = 2n; };
  });
  await waitFor(async () => expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).not.toBe('running'));
  const row = await Repo.transactions.get(id);
  expect(signed).toHaveLength(1);
  expect(row?.extraInputs.evmTxHash).toBeUndefined();
  expect(bridgeOperationOf(row!)?.approvals).toHaveLength(1);
});
it('keeps the original paid approval but refuses a quote that expires before burn preparation', async () => {
  const id = await driveAdapter(true, () => {
    adapterAllowance = 0n;
    afterAdapterApproval = () => { validationPatch = { claimable: false, failedChecks: ['QUOTE_EXPIRED'],
      expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000, expired: true, secondsRemaining: 0 } }; };
  });
  await waitFor(async () => expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).toBe('uncertain'));
  const row = await Repo.transactions.get(id);
  expect(signed).toHaveLength(1);
  expect(row?.extraInputs.evmTxHash).toBeUndefined();
  expect(bridgeOperationOf(row!)?.approvals).toHaveLength(1);
});
it('retains an unconfirmed original approval without prompting or funding on recovery', async () => {
  const id = await driveAdapter(true, () => {
    adapterAllowance = 0n;
    adapterRpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Receipt unavailable'));
  });
  await waitFor(async () => expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).toBe('uncertain'));
  const row = await Repo.transactions.get(id);
  const owner = row && bridgeOperationOf(row);
  if (!owner) throw new Error('Missing original owner');
  expect(owner.approvals).toHaveLength(1);
  const original = structuredClone(row);
  const provider: EIP1193Provider = { request: adapterWallet, on: jest.fn(), removeListener: jest.fn() };
  expect(await runXReserveReceive(owner, { provider, client: adapterRpc,
    checks: { readCurrent: async () => live, verifyBalanceCap: async () => undefined, now: () => now } })).toBe(id);
  expect(await Repo.transactions.get(id)).toEqual(original);
  expect(signed).toHaveLength(1);
});
it.each(['repriced', 'cancelled', 'replaced'])('persists %s approval replacement facts without rearming funding', async reason => {
  const id = await driveAdapter(true, () => {
    adapterAllowance = 0n;
    adapterRpc.waitForTransactionReceipt.mockImplementationOnce(async ({ hash, onReplaced }) => {
      const original = adapterTransactions.get(hash);
      if (!original) throw new Error('Missing original approval');
      const replacement: SourceRpcTransaction = { ...original, hash: `0x${'e'.repeat(64)}`,
        ...(reason === 'cancelled' && { to: `0x${accounts.evmAddress.slice(2)}` satisfies Hex, input: '0x', value: 0n }),
        ...(reason === 'replaced' && { input: '0x1234' }) };
      onReplaced({ reason, transaction: replacement });
      if (reason === 'repriced') adapterAllowance = 1000002n;
      return { status: 'success', transactionHash: replacement.hash };
    });
  });
  await waitFor(async () => expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).not.toBe('running'));
  const row = await Repo.transactions.get(id);
  expect(bridgeOperationOf(row!)?.approvals?.[1]?.replacementReason).toBe(reason);
  expect(bridgeOperationOf(row!)?.approvals?.[1]?.originalTransaction?.nonce).toBe(1);
  expect(signed).toHaveLength(reason === 'repriced' ? 2 : 1);
  if (reason !== 'repriced') expect(row?.extraInputs.evmTxHash).toBeUndefined();
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
