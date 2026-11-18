import { waitFor } from '@testing-library/react';
import {
  concatHex,
  createPublicClient,
  decodeFunctionData,
  erc20Abi,
  parseUnits,
  slice,
  toHex,
  type Hash,
  type Hex,
  type EIP1193Provider
} from 'viem';

import { bindTransferQuote, quoteAmounts } from 'lib/bridge/core/quote';
import { assertReviewedBridge, type ReviewedTransfer } from 'lib/bridge/core/review';
import type { SourceRpcTransaction } from 'lib/bridge/evm/source-transaction';
import { bridgeOperationOf, type BridgeOperationSnapshot } from 'lib/bridge/operation';
import type { XReserveClient } from 'lib/bridge/providers/xreserve/deposit';
import { runXReserveReceive } from 'lib/bridge/providers/xreserve/flows';
import {
  cctpSourceMessage,
  cctpSourceReceipt,
  cctpArcReceipt,
  cctpDepositAttestation,
  FORWARD_HASH
} from 'lib/bridge/testing/cctp-fixtures';
import { reviewedOwnedCircleTransfer, TEST_CCTP_TRANSMITTER } from 'lib/bridge/testing/circle-fixtures';
import { accounts, now, referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { createBridgeReceiveReconciler } from 'lib/miden/activity/bridge-receive';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { usdcxExpectedRemoteTokenFor } from 'lib/usdcx/deposit-target';

import { getUsdcxSourceChain } from './constant';
import { runUsdcxDeposit } from './deposit';
import { runUsdcxExecutorDeposit } from './executor';
import { midenAccountHexToXReserveRecipient } from './recipient';

jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: jest.fn() }));
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
    jest
      .requireActual<typeof import('lib/bridge/testing/circle-fixtures')>('lib/bridge/testing/circle-fixtures')
      .circleSnapshot()
}));

const sourceHash: Hash = `0x${'c'.repeat(64)}`;
const approvalHash: Hash = `0x${'a'.repeat(64)}`;
const adapterRpc = {
  readContract: jest.fn(),
  call: jest.fn(),
  estimateGas: jest.fn(),
  waitForTransactionReceipt: jest.fn(),
  getBalance: jest.fn(),
  getGasPrice: jest.fn(),
  getTransaction: jest.fn(),
  getBlockNumber: jest.fn(),
  getTransactionCount: jest.fn(),
  getBlock: jest.fn()
} satisfies XReserveClient;
const receiptReader = jest.fn();
const targetReadContract = jest.fn();
let useDistinctTargetClient = false;
const adapterWallet = jest.fn();
const adapterTransactions = new Map<Hash, SourceRpcTransaction>();
let adapterAllowance: bigint;
let afterAdapterApproval: () => void;
let adapterFee: bigint;
let targetRegistered: boolean;
let signed: { from: string; to: Hex; data: Hex; chainId: Hex; value: Hex }[];
jest.mock('lib/bridge/providers/xreserve/provider', () => ({
  xreserveReadClient: (chainId: number) =>
    useDistinctTargetClient && chainId === 5042002 ? { readContract: targetReadContract } : adapterRpc
}));
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
    signedQuote: '0x1234',
    feeToken: token,
    feeTotalAmount: '1',
    nonce: '0',
    claimable: true,
    expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000 + 60, expired: false, secondsRemaining: 60 },
    failedChecks: [],
    items: [
      { type: 'FORWARD', argsMatch: true },
      { type: 'PRE_FINALITY', argsMatch: true }
    ],
    ...validationPatch
  };
}

function reviewFor(executor: boolean): ReviewedTransfer {
  const review = reviewedOwnedCircleTransfer();
  if (!executor) {
    const chain = referenceSnapshot('testnet').config?.supportedEvmChains['arc-testnet'];
    const token = chain?.bridges.usdcx?.tokens.USDC?.contractAddress;
    if (!token || !review.quote) throw new Error('Missing accepted Arc fixture');
    review.route.source = { kind: 'erc20', network: 'arc-testnet', symbol: 'USDC', decimals: 6, address: token };
    review.quote = bindTransferQuote(
      { route: review.route, amount: review.amount, ...accounts },
      {
        kind: 'arc-deposit',
        received: review.amount,
        validity: { kind: 'time', expiresAt: now + 60000 }
      }
    );
  }
  assertReviewedBridge(review, review, now);
  return review;
}

async function drive(
  executor: boolean,
  afterClaim?: (claimed: BridgeOperationSnapshot) => Promise<void>,
  changed: {
    amount?: string;
    recipient?: `0x${string}`;
    rowId?: string;
    fee?: bigint;
    contract?: boolean;
    depositor?: `0x${string}`;
    signature?: `0x${string}`;
  } = {}
) {
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
  const finished = new Promise<unknown>(resolve => {
    finish = resolve;
  });
  let winner: BridgeOperationSnapshot | undefined;
  const wrapper = createBridgeReceiveReconciler({ getLocks: () => undefined });
  const id = await wrapper.startSubmission(
    () =>
      initiateBridgedReceiveTransaction({
        accountId: accounts.midenAccount,
        amount: parseUnits(review.amount, 6),
        faucetId: review.route.destination.kind === 'miden' ? review.route.destination.faucetId : '',
        provider: 'usdcx',
        sourceAddress: accounts.evmAddress,
        sourceChainId: chainId,
        sourceAmount: quoteAmounts(review.route, review.quote!).sourceTotal,
        sourceSymbol: 'USDC',
        usdcxSource: source,
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
          readAllowance: async () => {
            await duringAllowance();
            return 10000000n;
          },
          waitForReceipt: async () => undefined,
          updatePhase: updateBridgedReceivePhase,
          owned: { rowId, operation: claimed, checks: { readCurrent: async () => live, now: () => now } }
        };
        const recipient = changed.recipient ?? midenAccountHexToXReserveRecipient(accounts.midenAccount);
        if (source.route === 'xreserve')
          await runUsdcxDeposit(changed.rowId ?? rowId, changed.amount ?? review.amount, recipient, {
            ...deps,
            source
          });
        else
          await runUsdcxExecutorDeposit(changed.rowId ?? rowId, changed.amount ?? review.amount, recipient, {
            ...deps,
            source,
            depositor: changed.depositor ?? `0x${accounts.evmAddress.slice(2)}`,
            readBalance: async () => 10000000n,
            fetchQuote: async () => ({
              signedQuote: changed.signature ?? '0x1234',
              feeTotalAmount: changed.fee ?? 1n,
              expiresAt: now / 1000 + 60
            })
          });
        finish(undefined);
      } catch (error) {
        finish(error);
      }
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
  useDistinctTargetClient = false;
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest
    .mocked(createPublicClient)
    .mockReturnValue(
      Object.assign(
        jest
          .requireActual('viem')
          .createPublicClient({ transport: jest.requireActual('viem').http('https://rpc.example') }),
        { getTransactionReceipt: receiptReader }
      )
    );
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

async function driveAdapter(executor: boolean, configure?: () => void, received?: string) {
  const review = reviewFor(executor);
  if (received !== undefined && review.quote)
    review.quote = bindTransferQuote(
      { route: review.route, amount: review.amount, ...accounts },
      { ...review.quote, received }
    );
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
    if (functionName === 'getRemoteToken')
      return usdcxExpectedRemoteTokenFor(review.route.recovery.nativeAsset!.faucetId);
    if (functionName === 'paused') return false;
    if (functionName === 'localMessageTransmitter') return TEST_CCTP_TRANSMITTER;
    if (functionName === 'getFee')
      return [adapterFee, review.route.source.kind === 'erc20' ? review.route.source.address : ''];
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
    const source = getUsdcxSourceChain(11155111);
    if (executor && hash === sourceHash && source.route === 'cctp-executor')
      return cctpSourceReceipt(hash, cctpSourceMessage(source));
    return { transactionHash: hash, status: 'success', logs: [] };
  });
  adapterWallet.mockImplementation(async ({ method, params }) => {
    if (method === 'eth_accounts') return [accounts.evmAddress];
    if (method === 'eth_chainId') return executor ? '0xaa36a7' : '0x4cef52';
    if (method !== 'eth_sendTransaction') throw new Error('Unexpected wallet method');
    const tx = params[0];
    signed.push(tx);
    const approval = tx.data.startsWith('0x095ea7b3');
    const hash: Hash = approval ? `0x${signed.length.toString(16).padStart(64, '0')}` : sourceHash;
    adapterTransactions.set(hash, {
      hash,
      from: `0x${accounts.evmAddress.slice(2)}`,
      to: tx.to,
      input: tx.data,
      value: BigInt(tx.value),
      nonce: signed.length,
      blockNumber: 1n
    });
    return hash;
  });
  configure?.();
  const provider: EIP1193Provider = { request: adapterWallet, on: jest.fn(), removeListener: jest.fn() };
  return runXReserveReceive(
    { operationId: 'circle-provider', review },
    {
      provider,
      client: adapterRpc,
      checks: { readCurrent: async () => live, verifyBalanceCap: async () => undefined, now: () => now }
    }
  );
}
it('reads the executor target registration on its own chain, not the different source client', async () => {
  const id = await driveAdapter(true, () => {
    useDistinctTargetClient = true;
    targetRegistered = false;
    targetReadContract.mockImplementation(async args =>
      args.functionName === 'isRemoteDomainRegistered' ? true : adapterRpc.readContract(args)
    );
  });
  await waitFor(async () => expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('delivering'));
  expect(targetReadContract.mock.calls.some(([args]) => args.functionName === 'isRemoteDomainRegistered')).toBe(true);
  expect(adapterRpc.readContract.mock.calls.some(([args]) => args.functionName === 'isRemoteDomainRegistered')).toBe(
    false
  );
  expect(signed).toHaveLength(1);
});

it('refuses an unregistered executor target before source approval or burn even if the source says registered', async () => {
  const id = await driveAdapter(true, () => {
    useDistinctTargetClient = true;
    targetRegistered = true;
    adapterAllowance = 0n;
    targetReadContract.mockImplementation(async args =>
      args.functionName === 'isRemoteDomainRegistered' ? false : adapterRpc.readContract(args)
    );
  });
  await waitFor(async () =>
    expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).toBe('uncertain')
  );
  expect(targetReadContract.mock.calls.some(([args]) => args.functionName === 'isRemoteDomainRegistered')).toBe(true);
  expect(adapterRpc.readContract.mock.calls.some(([args]) => args.functionName === 'isRemoteDomainRegistered')).toBe(
    false
  );
  expect(signed).toHaveLength(0);
  expect((await Repo.transactions.get(id))?.extraInputs.evmTxHash).toBeUndefined();
});

it.each([false, true])(
  'adapts the reviewed provider into the actual receive wrapper and source leaf (executor=%s)',
  async executor => {
    const id = await driveAdapter(executor);
    await waitFor(async () => expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('delivering'));
    const row = await Repo.transactions.get(id);
    expect(bridgeOperationOf(row!)?.sourceAttempt).toMatchObject({ phase: 'known', hash: sourceHash });
    expect(bridgeOperationOf(row!)?.operationId).toBe('circle-provider');
    expect(signed).toHaveLength(1);
    expect(row?.amount).toBe(1000001n);
    expect(row?.extraInputs.sourceAmount).toBe(executor ? '1.000002' : '1.000001');
    expect(await Repo.transactions.count()).toBe(1);
  }
);

it.each([
  { executor: false, received: '2.000002' },
  { executor: true, received: '2.000002' },
  { executor: false, received: '0.500000' },
  { executor: true, received: '0.500000' }
])(
  'refuses inconsistent native received $received before approval/source prompts (executor=$executor)',
  async ({ executor, received }) => {
    const id = await driveAdapter(
      executor,
      () => {
        adapterAllowance = 0n;
      },
      received
    );
    await waitFor(() => expect(console.error).toHaveBeenCalledWith('[bridge-receive] deposit submission failed'));
    const row = await Repo.transactions.get(id);
    expect(bridgeOperationOf(row!)?.sourceAttempt).toEqual({ phase: 'running' });
    expect(signed).toHaveLength(0);
    expect(row?.extraInputs.evmTxHash).toBeUndefined();
  }
);

it.each([false, true])('retains existing unrepresentable received refusal (executor=%s)', async executor => {
  await expect(driveAdapter(executor, undefined, '1.0000011')).rejects.toThrow('Bridge minimum is not representable');
  expect(signed).toHaveLength(0);
});

it.each([false, true])(
  'resets a short nonzero allowance and records exact original approval facts (executor=%s)',
  async executor => {
    const id = await driveAdapter(executor, () => {
      adapterAllowance = 1n;
    });
    await waitFor(async () => expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('delivering'));
    const row = await Repo.transactions.get(id);
    expect(bridgeOperationOf(row!)?.approvals?.map(item => item.amount)).toEqual([
      '0',
      executor ? '1000002' : '1000001'
    ]);
    expect(bridgeOperationOf(row!)?.approvals?.every(item => item.transaction?.nonce !== undefined)).toBe(true);
    expect(signed).toHaveLength(3);
  }
);
it.each([false, true])(
  'checks the current remote token before paying for an approval (executor=%s)',
  async executor => {
    const id = await driveAdapter(executor, () => {
      adapterAllowance = 0n;
      const read = adapterRpc.readContract.getMockImplementation()!;
      adapterRpc.readContract.mockImplementation(async args =>
        args.functionName === 'getRemoteToken' ? `0x${'0'.repeat(64)}` : read(args)
      );
    });
    await waitFor(async () =>
      expect(['known', 'uncertain']).toContain(
        bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase
      )
    );
    expect(signed).toHaveLength(0);
  }
);
it('refuses a signed-quote on-chain fee increase after a paid approval', async () => {
  const id = await driveAdapter(true, () => {
    adapterAllowance = 0n;
    afterAdapterApproval = () => {
      adapterFee = 2n;
    };
  });
  await waitFor(async () =>
    expect(['known', 'uncertain']).toContain(
      bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase
    )
  );
  const row = await Repo.transactions.get(id);
  expect(signed).toHaveLength(1);
  expect(row?.extraInputs.evmTxHash).toBeUndefined();
  expect(bridgeOperationOf(row!)?.approvals).toHaveLength(1);
});
it('keeps the original paid approval but refuses a quote that expires before burn preparation', async () => {
  const id = await driveAdapter(true, () => {
    adapterAllowance = 0n;
    afterAdapterApproval = () => {
      validationPatch = {
        claimable: false,
        failedChecks: ['QUOTE_EXPIRED'],
        expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000, expired: true, secondsRemaining: 0 }
      };
    };
  });
  await waitFor(async () =>
    expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).toBe('uncertain')
  );
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
  await waitFor(async () =>
    expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).toBe('uncertain')
  );
  const row = await Repo.transactions.get(id);
  const owner = row && bridgeOperationOf(row);
  if (!owner) throw new Error('Missing original owner');
  expect(owner.approvals).toHaveLength(1);
  const original = structuredClone(row);
  const provider: EIP1193Provider = { request: adapterWallet, on: jest.fn(), removeListener: jest.fn() };
  expect(
    await runXReserveReceive(owner, {
      provider,
      client: adapterRpc,
      checks: { readCurrent: async () => live, verifyBalanceCap: async () => undefined, now: () => now }
    })
  ).toBe(id);
  expect(await Repo.transactions.get(id)).toEqual(original);
  expect(signed).toHaveLength(1);
});
it.each(['repriced', 'cancelled', 'replaced'])(
  'persists %s approval replacement facts without rearming funding',
  async reason => {
    const id = await driveAdapter(true, () => {
      adapterAllowance = 0n;
      adapterRpc.waitForTransactionReceipt.mockImplementationOnce(async ({ hash, onReplaced }) => {
        const original = adapterTransactions.get(hash);
        if (!original) throw new Error('Missing original approval');
        const replacement: SourceRpcTransaction = {
          ...original,
          hash: `0x${'e'.repeat(64)}`,
          ...(reason === 'cancelled' && {
            to: `0x${accounts.evmAddress.slice(2)}` satisfies Hex,
            input: '0x',
            value: 0n
          }),
          ...(reason === 'replaced' && { input: '0x1234' })
        };
        onReplaced({ reason, transaction: replacement });
        if (reason === 'repriced') adapterAllowance = 1000002n;
        return { status: 'success', transactionHash: replacement.hash };
      });
    });
    await waitFor(async () =>
      expect(['known', 'uncertain']).toContain(
        bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase
      )
    );
    const row = await Repo.transactions.get(id);
    expect(bridgeOperationOf(row!)?.approvals?.[1]?.replacementReason).toBe(reason);
    expect(bridgeOperationOf(row!)?.approvals?.[1]?.originalTransaction?.nonce).toBe(1);
    expect(signed).toHaveLength(reason === 'repriced' ? 2 : 1);
    expect(row?.extraInputs.evmTxHash).toBe(reason === 'repriced' ? sourceHash : undefined);
  }
);

it('captures verified source MessageSent from the already-awaited burn receipt on the original row', async () => {
  const id = await driveAdapter(true);
  await waitFor(async () => expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('delivering'));
  const source = getUsdcxSourceChain(11155111);
  if (source.route !== 'cctp-executor') throw new Error('Missing CCTP source');
  expect((await Repo.transactions.get(id))?.extraInputs.cctp).toMatchObject({
    sourceMessage: cctpSourceMessage(source).toLowerCase(),
    messageTransmitter: TEST_CCTP_TRANSMITTER
  });
  expect(
    adapterRpc.readContract.mock.calls.filter(([args]) => args.functionName === 'localMessageTransmitter')
  ).toHaveLength(1);
});
it.each(['failed', 'zero'])('refuses a %s transmitter getter before any new source prompt', async outcome => {
  const id = await driveAdapter(true, () => {
    adapterAllowance = 0n;
    const read = adapterRpc.readContract.getMockImplementation()!;
    adapterRpc.readContract.mockImplementation(async args => {
      if (args.functionName === 'localMessageTransmitter') {
        if (outcome === 'zero') return '0x0000000000000000000000000000000000000000';
        throw new Error('Getter unavailable');
      }
      return read(args);
    });
  });
  await waitFor(async () =>
    expect(['known', 'uncertain']).toContain(
      bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase
    )
  );
  expect(signed).toHaveLength(0);
});
it.each([
  'hash',
  'transmitter',
  'duplicate log',
  'source sender',
  'source amount',
  'source domain',
  'source token',
  'mint recipient',
  'source hook'
])('retains the source hash but refuses unverified %s receipt evidence', async change => {
  const id = await driveAdapter(true, () => {
    adapterRpc.waitForTransactionReceipt.mockImplementationOnce(async ({ hash }) => {
      const source = getUsdcxSourceChain(11155111);
      if (source.route !== 'cctp-executor') throw new Error('Missing source');
      let message = cctpSourceMessage(
        source,
        change === 'source amount'
          ? { amount: 1000002n }
          : change === 'source sender'
            ? { sender: TEST_CCTP_TRANSMITTER }
            : {}
      );
      if (change === 'source domain')
        message = concatHex([slice(message, 0, 4), toHex(3, { size: 4 }), slice(message, 8)]);
      if (change === 'source token')
        message = concatHex([slice(message, 0, 152), toHex(0, { size: 32 }), slice(message, 184)]);
      if (change === 'mint recipient')
        message = concatHex([slice(message, 0, 184), toHex(0, { size: 32 }), slice(message, 216)]);
      if (change === 'source hook') message = `0x${message.slice(2, -2)}05`;
      const receipt = cctpSourceReceipt(hash, message);
      const first = receipt.logs[0];
      if (!first) throw new Error('Missing source log fixture');
      if (change === 'hash') receipt.transactionHash = FORWARD_HASH;
      if (change === 'transmitter') first.address = source.usdc;
      if (change === 'duplicate log') receipt.logs.push(first);
      return receipt;
    });
  });
  await waitFor(async () => {
    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs.phase === 'delivering' || jest.mocked(console.error).mock.calls.length > 0).toBe(true);
  });
  const row = await Repo.transactions.get(id);
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
  expect(row?.extraInputs.phase).toBe('submitting');
  expect(signed).toHaveLength(1);
});
async function prepareOwnedStatus(
  change:
    | 'immutable amount'
    | 'ambiguous'
    | 'proof'
    | 'proof and route'
    | 'arc nonce'
    | 'arc deposit'
    | 'arc handler'
    | 'none',
  beforeStatus?: (id: string) => void | Promise<void>
) {
  const id = await driveAdapter(true);
  await waitFor(async () => expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('delivering'));
  const source = getUsdcxSourceChain(11155111);
  if (source.route !== 'cctp-executor') throw new Error('Missing CCTP source');
  if (change === 'proof' || change === 'proof and route')
    await Repo.transactions.update(id, { 'extraInputs.cctp.sourceMessage': undefined });
  if (change === 'proof and route') await Repo.transactions.update(id, { 'extraInputs.usdcxSource': undefined });
  const attested = cctpSourceMessage(source, { executed: 1000 });
  const entry = { message: attested, attestation: '0xabcd', status: 'complete', forwardTxHash: FORWARD_HASH };
  const entries = [entry];
  if (change === 'ambiguous')
    entries.push({ ...entry, message: cctpSourceMessage(source, { executed: 1000, nonce: `0x${'9'.repeat(64)}` }) });
  if (change === 'immutable amount') entry.message = cctpSourceMessage(source, { executed: 1000, amount: 1000002n });
  fetchMock.mockImplementation(async (url: string) => {
    const body = url.includes('/v2/messages/') ? { messages: entries } : cctpDepositAttestation(source);
    return { ok: true, status: 200, json: async () => body };
  });
  receiptReader.mockResolvedValue(
    cctpArcReceipt(
      source,
      change === 'arc nonce'
        ? { nonce: `0x${'9'.repeat(64)}` }
        : change === 'arc deposit'
          ? { depositAmount: 1000002n }
          : change === 'arc handler'
            ? { handler: TEST_CCTP_TRANSMITTER }
            : {}
    )
  );
  await beforeStatus?.(id);
  const reconciler = createBridgeReceiveReconciler({ getLocks: () => undefined });
  await reconciler.reconcile();
  await reconciler.reconcile();
  return { id, row: await Repo.transactions.get(id), source };
}
it('accepts source placeholder nonce -> unique attested nonce -> same Arc Executed nonce with immutable transfer and exact deposit', async () => {
  const { row } = await prepareOwnedStatus('none');
  expect(row?.extraInputs.phase).toBe('ready');
  expect(row?.extraInputs.cctp?.executeTxHash).toBe(FORWARD_HASH);
  expect(slice(`0x${row?.extraInputs.cctp?.sourceMessage?.slice(2)}`, 12, 44)).toBe(toHex(0, { size: 32 }));
  expect(receiptReader).toHaveBeenCalledTimes(1);
});
it('continues passive funded status after UI RPC departure and quote expiry without fresh source permission', async () => {
  const { row } = await prepareOwnedStatus('none', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now + 120000);
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other.example/private');
  });
  expect(row?.extraInputs.phase).toBe('ready');
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
  expect(signed).toHaveLength(1);
});
it('recovers only the original owned CCTP source proof from its saved hash and receipt after a restart', async () => {
  const source = getUsdcxSourceChain(11155111);
  if (source.route !== 'cctp-executor') throw new Error('Missing CCTP source');
  const { id } = await prepareOwnedStatus('proof', () => {
    receiptReader.mockImplementation(async ({ hash }) =>
      hash === sourceHash ? cctpSourceReceipt(sourceHash, cctpSourceMessage(source)) : cctpArcReceipt(source)
    );
  });
  const reconciler = createBridgeReceiveReconciler({ getLocks: () => undefined });
  await reconciler.reconcile();
  const row = await Repo.transactions.get(id);
  expect(receiptReader.mock.calls.some(([args]) => args.hash === sourceHash)).toBe(true);
  expect(row?.extraInputs.cctp?.sourceMessage).toBe(cctpSourceMessage(source).toLowerCase());
  expect(row?.extraInputs.phase).toBe('ready');
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
  expect(signed).toHaveLength(1);
});

it.each([
  'wrong chain',
  'wrong source hash',
  'missing transmitter',
  'wrong account',
  'wrong amount',
  'wrong faucet',
  'wrong sender',
  'contradictory proof',
  'restored',
  'recovered'
])('never reads a source receipt or re-arms an owned %s row with unverified original facts', async change => {
  const { row } = await prepareOwnedStatus('proof', async id => {
    if (change === 'wrong chain') await Repo.transactions.update(id, { 'extraInputs.sourceChainId': 5042002 });
    if (change === 'wrong source hash')
      await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.sourceAttempt.hash': FORWARD_HASH });
    if (change === 'missing transmitter')
      await Repo.transactions.update(id, {
        'extraInputs.cctp.messageTransmitter': '0x0000000000000000000000000000000000000000'
      });
    if (change === 'wrong account') await Repo.transactions.update(id, { accountId: 'mtst1wrongaccount' });
    if (change === 'wrong amount') await Repo.transactions.update(id, { amount: 1000002n });
    if (change === 'wrong faucet') await Repo.transactions.update(id, { faucetId: 'mtst1wrongfaucet' });
    if (change === 'wrong sender')
      await Repo.transactions.update(id, { 'extraInputs.sourceAddress': '0x0000000000000000000000000000000000000001' });
    if (change === 'contradictory proof')
      await Repo.transactions.update(id, { 'extraInputs.cctp.sourceMessage': '0x01' });
    if (change === 'restored') await Repo.transactions.update(id, { restoredFromBackup: true });
    if (change === 'recovered') await Repo.transactions.update(id, { recovered: true });
  });
  expect(receiptReader).not.toHaveBeenCalled();
  expect(row?.extraInputs.cctp?.sourceMessage).toBe(change === 'contradictory proof' ? '0x01' : undefined);
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
  expect(signed).toHaveLength(1);
});
it.each(['wrong hash', 'wrong transmitter log', 'wrong amount', 'duplicate message'])(
  'refuses a recovered source receipt with %s without persisting Circle proof',
  async change => {
    const source = getUsdcxSourceChain(11155111);
    if (source.route !== 'cctp-executor') throw new Error('Missing CCTP source');
    const { row } = await prepareOwnedStatus('proof', () => {
      receiptReader.mockImplementation(async ({ hash }) => {
        if (hash !== sourceHash) return cctpArcReceipt(source);
        const receipt = cctpSourceReceipt(
          sourceHash,
          cctpSourceMessage(source, change === 'wrong amount' ? { amount: 1000002n } : {})
        );
        if (change === 'wrong hash') receipt.transactionHash = FORWARD_HASH;
        if (change === 'wrong transmitter log' && receipt.logs[0]) receipt.logs[0].address = source.usdc;
        if (change === 'duplicate message' && receipt.logs[0]) receipt.logs.push(receipt.logs[0]);
        return receipt;
      });
    });
    expect(receiptReader.mock.calls.some(([args]) => args.hash === sourceHash)).toBe(true);
    expect(row?.extraInputs.cctp?.sourceMessage).toBeUndefined();
    expect(row?.extraInputs.phase).toBe('delivering');
    expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
    expect(signed).toHaveLength(1);
  }
);
it.each(['revision', 'transmitter', 'restored'])(
  'rejects recovered Circle proof when its original %s changes before the CAS',
  async change => {
    const source = getUsdcxSourceChain(11155111);
    if (source.route !== 'cctp-executor') throw new Error('Missing CCTP source');
    const { row } = await prepareOwnedStatus('proof', id => {
      receiptReader.mockImplementation(async ({ hash }) => {
        if (hash !== sourceHash) return cctpArcReceipt(source);
        if (change === 'revision') await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.revision': 999 });
        if (change === 'transmitter')
          await Repo.transactions.update(id, {
            'extraInputs.cctp.messageTransmitter': '0x1111111111111111111111111111111111111111'
          });
        if (change === 'restored') await Repo.transactions.update(id, { restoredFromBackup: true });
        return cctpSourceReceipt(sourceHash, cctpSourceMessage(source));
      });
    });
    expect(receiptReader.mock.calls.some(([args]) => args.hash === sourceHash)).toBe(true);
    expect(row?.extraInputs.cctp?.sourceMessage).toBeUndefined();
    expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
    expect(signed).toHaveLength(1);
  }
);

it('does not fail or rearm known funded ownership merely because source proof metadata is missing after restart', async () => {
  const { row } = await prepareOwnedStatus('proof', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
  });
  expect(row?.extraInputs.phase).toBe('delivering');
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
  expect(signed).toHaveLength(1);
});
it('keeps known funded ownership proof-pending when both source proof and saved route metadata are missing', async () => {
  const { row } = await prepareOwnedStatus('proof and route', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
  });
  expect(row?.extraInputs.phase).toBe('delivering');
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
  expect(signed).toHaveLength(1);
});
it.each(['ambiguous', 'proof', 'immutable amount', 'arc nonce', 'arc deposit', 'arc handler'])(
  'keeps an owned CCTP %s mismatch proof-pending, not ready or a fresh source',
  async change => {
    const { row } = await prepareOwnedStatus(
      change === 'ambiguous'
        ? 'ambiguous'
        : change === 'proof'
          ? 'proof'
          : change === 'immutable amount'
            ? 'immutable amount'
            : change === 'arc nonce'
              ? 'arc nonce'
              : change === 'arc deposit'
                ? 'arc deposit'
                : 'arc handler'
    );
    expect(row?.extraInputs.phase).toBe('delivering');
    expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
    expect(signed).toHaveLength(1);
  }
);

it('keeps private Arc RPC diagnostics out of the owned status observer while preserving funded facts', async () => {
  const privateData = 'https://private-rpc.example/?key=secret Arc-receipt-request';
  const { row } = await prepareOwnedStatus('none', () => {
    receiptReader.mockRejectedValue(new Error(privateData));
  });
  expect(row?.extraInputs.phase).toBe('delivering');
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
  expect(
    jest
      .mocked(console.warn)
      .mock.calls.flatMap(call => call.map(String))
      .join(' ')
  ).not.toContain(privateData);
  expect(signed).toHaveLength(1);
});

it('enriches pending Circle approval facts in the existing passive reconciler without signing again', async () => {
  const id = await driveAdapter(true, () => {
    adapterAllowance = 0n;
    adapterRpc.getTransaction.mockRejectedValueOnce(new Error('Metadata unavailable'));
    adapterRpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Receipt unavailable'));
  });
  await waitFor(async () =>
    expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).toBe('uncertain')
  );
  const before = await Repo.transactions.get(id);
  const approval = before && bridgeOperationOf(before)?.approvals?.[0];
  expect(approval?.hash).toBeDefined();
  expect(approval?.transaction).toBeUndefined();
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).reconcile();
  const after = await Repo.transactions.get(id);
  expect(bridgeOperationOf(after!)?.approvals?.[0]?.transaction?.hash).toBe(approval?.hash);
  expect(bridgeOperationOf(after!)?.sourceAttempt?.phase).toBe('uncertain');
  expect(after?.extraInputs.evmTxHash).toBeUndefined();
  expect(signed).toHaveLength(1);
});

it('keeps provider RPC and request-byte errors out of the submission observer', async () => {
  const privateData = 'https://private-rpc.example/?key=secret 0xprivate-request-bytes';
  const id = await driveAdapter(true, () => {
    adapterRpc.estimateGas.mockRejectedValueOnce(new Error(privateData));
  });
  await waitFor(async () =>
    expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).toBe('uncertain')
  );
  const visible = jest
    .mocked(console.error)
    .mock.calls.flatMap(call => call.map(String))
    .join(' ');
  expect(visible).not.toContain(privateData);
  expect(signed).toHaveLength(0);
});

it.each([false, true])('first drives a real claimed Circle row (executor=%s)', async executor => {
  const { row, error } = await drive(executor);
  expect(error).toBeUndefined();
  expect(deposit).toHaveBeenCalledTimes(1);
  expect(approve).not.toHaveBeenCalled();
  expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
});

it.each([false, true])('refuses RPC departure after allowance read before signing (executor=%s)', async executor => {
  duringAllowance = async () => {
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other.example/private');
  };
  const { error } = await drive(executor);
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
});

it('refuses the Circle source prompt when live consent changes during the final owner read', async () => {
  const changeDuringOwnerRead = (row: ITransaction) => {
    if (adapterRpc.estimateGas.mock.calls.length > 0 && signed.length === 0) live = { ...live, amount: '2' };
    return row;
  };
  Repo.transactions.hook('reading', changeDuringOwnerRead);
  try {
    const id = await driveAdapter(true);
    await waitFor(async () =>
      expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.phase).toBe('uncertain')
    );
    expect(adapterRpc.estimateGas).toHaveBeenCalled();
    expect(signed).toHaveLength(0);
    expect((await Repo.transactions.get(id))?.extraInputs.evmTxHash).toBeUndefined();
  } finally {
    Repo.transactions.hook('reading').unsubscribe(changeDuringOwnerRead);
  }
});

it.each([false, true])('refuses live reviewed amount change after allowance read (executor=%s)', async executor => {
  duringAllowance = async () => {
    live.amount = '2';
  };
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
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/v2/quote/validate/usdc/0'),
    expect.objectContaining({ method: 'POST' })
  );
});

it.each([
  ['rejected', { claimable: false, failedChecks: ['INVALID_AMOUNT'] }],
  ['signature', { signedQuote: '0xabcd' }],
  ['token', { feeToken: '0x2222222222222222222222222222222222222222' }],
  ['fee', { feeTotalAmount: '2' }],
  ['nonce', { nonce: '1' }],
  [
    'wrong hook',
    {
      items: [
        { type: 'FORWARD', argsMatch: false },
        { type: 'PRE_FINALITY', argsMatch: true }
      ]
    }
  ],
  [
    'missing service',
    {
      items: [
        { type: 'FORWARD', argsMatch: true },
        { type: 'FORWARD', argsMatch: true }
      ]
    }
  ],
  ['inconsistent', { failedChecks: ['QUOTE_EXPIRED'] }],
  [
    'expired',
    {
      claimable: false,
      failedChecks: ['QUOTE_EXPIRED'],
      expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000, expired: true, secondsRemaining: 0 }
    }
  ],
  ['no headroom', { expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000 + 29, expired: false, secondsRemaining: 29 } }]
])('refuses %s validation before the actual owned burn', async (_, patch) => {
  validationPatch = patch;
  const { error } = await drive(true);
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});

it('refuses live review departure during Circle validation', async () => {
  afterValidation = () => {
    live.amount = '9';
  };
  const { error } = await drive(true);
  expect(error).toBeInstanceOf(Error);
  expect(deposit).not.toHaveBeenCalled();
});

it.each([false, true])(
  'persists the original winning source hash after RPC departure in the signing await (executor=%s)',
  async executor => {
    deposit.mockImplementationOnce(async () => {
      jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other.example/private');
      return sourceHash;
    });
    const { row, winner } = await drive(executor);
    expect(bridgeOperationOf(row!)?.revision).toBe(winner?.revision);
    expect(bridgeOperationOf(row!)?.sourceAttempt).toMatchObject({ phase: 'known', hash: sourceHash });
    expect(row?.extraInputs.evmTxHash).toBe(sourceHash);
  }
);
