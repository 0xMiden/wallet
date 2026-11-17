import { parseUnits, type Hash } from 'viem';

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
const approve = jest.fn(async () => approvalHash);
const deposit = jest.fn(async () => sourceHash);
let duringAllowance: () => Promise<void>;
let live: ReviewedTransfer;

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

async function drive(executor: boolean, afterClaim?: (claimed: BridgeOperationSnapshot) => Promise<void>) {
  const review = reviewFor(executor);
  live = structuredClone(review);
  const chainId = executor ? 11155111 : 5042002;
  const source = getUsdcxSourceChain(chainId);
  if (!source) throw new Error('Missing configured Circle source');
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
        const recipient = midenAccountHexToXReserveRecipient(accounts.midenAccount);
        if (source.route === 'xreserve')
          await runUsdcxDeposit(rowId, review.amount, recipient, { ...deps, source });
        else
          await runUsdcxExecutorDeposit(rowId, review.amount, recipient, {
            ...deps, source, depositor: `0x${accounts.evmAddress.slice(2)}`,
            readBalance: async () => 10000000n,
            fetchQuote: async () => ({ signedQuote: '0x1234', feeTotalAmount: 1n, expiresAt: now / 1000 + 60 })
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
  await Repo.transactions.clear();
});
afterEach(() => jest.restoreAllMocks());

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
