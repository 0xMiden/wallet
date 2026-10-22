import { isAddress, isHash, isHex, type Address, type Hash, type Hex } from 'viem';

import { assertOneClickQuoteBinding } from '../../../src/lib/one-click/client';
import type { OneClickAsset, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from '../../../src/lib/one-click/types';
import type { CounterpartyTransaction } from '../ios/helpers/wc-counterparty-request';
import {
  assertMainnetEvmFunding,
  createMainnetOneClickEvmSender,
  type MainnetEvmClient,
  type MainnetEvmHolding
} from './mainnet-one-click-evm';

jest.mock('../../../src/lib/one-click/client', () => ({
  assertOneClickQuoteBinding: jest.fn()
}));

function testAddress(value: string): Address {
  if (!isAddress(value)) throw new Error('Invalid test address');
  return value;
}

function testHash(value: string): Hash {
  if (!isHash(value)) throw new Error('Invalid test hash');
  return value;
}

function testHex(value: string): Hex {
  if (!isHex(value)) throw new Error('Invalid test hex');
  return value;
}

const account = testAddress('0x1111111111111111111111111111111111111111');
const deposit = '0x2222222222222222222222222222222222222222';
const token = testAddress('0x3333333333333333333333333333333333333333');
const chain = testAddress('0x4444444444444444444444444444444444444444');
const config: OneClickConfig = { serviceUrl: 'https://one-click.example', midenAssets: [] };
const asset: OneClickAsset = {
  assetId: 'nep141:eth-0x3333333333333333333333333333333333333333.omft.near',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: token,
  chainId: 1
};
const destination: OneClickAsset = {
  assetId: 'miden:usdc',
  blockchain: 'miden',
  symbol: 'USDC',
  decimals: 6,
  faucetId: `0x${'55'.repeat(15)}`
};

function quotePair(originAsset = asset): { request: OneClickQuoteRequest; quote: OneClickQuoteResponse } {
  const request: OneClickQuoteRequest = {
    amount: '1000000',
    originAsset,
    destinationAsset: destination,
    refundTo: account,
    recipient: 'miden-account',
    deadline: '2027-10-22T12:15:00.000Z',
    slippageTolerance: 100
  };
  const quote: OneClickQuoteResponse = {
    correlationId: 'test-correlation',
    timestamp: '2026-10-22T12:00:00.000Z',
    signature: 'test-signature',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: request.slippageTolerance,
      originAsset: originAsset.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: destination.assetId,
      amount: request.amount,
      refundTo: account,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: request.deadline
    },
    quote: {
      depositAddress: deposit,
      amountIn: request.amount,
      amountInFormatted: '1',
      amountInUsd: '1',
      minAmountIn: request.amount,
      amountOut: '999000',
      amountOutFormatted: '0.999',
      amountOutUsd: '0.999',
      minAmountOut: '998000',
      deadline: '2027-10-22T12:00:00.000Z',
      timeEstimate: 60
    }
  };
  return { request, quote };
}

function makeClient(overrides: Partial<MainnetEvmClient> = {}): MainnetEvmClient {
  return {
    estimateGas: jest.fn(async () => 50_000n),
    estimateFeesPerGas: jest.fn(async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n })),
    getBalance: jest.fn(async () => 10n ** 18n),
    readTokenBalance: jest.fn(async () => 2_000_000n),
    waitForTransactionReceipt: jest.fn(async () => testReceipt('success', 1_500_000_000n, 42_000n)),
    ...overrides
  };
}

function testReceipt(status: 'success' | 'reverted', effectiveGasPrice: bigint | undefined, gasUsed: bigint) {
  return { status, ...(effectiveGasPrice === undefined ? {} : { effectiveGasPrice }), gasUsed };
}

function makeHolding(client = makeClient(), overrides: Partial<MainnetEvmHolding> = {}): MainnetEvmHolding {
  return {
    asset,
    balanceBaseUnits: 2_000_000n,
    nativeBalanceWei: 10n ** 18n,
    gasPriceWei: 1_000_000_000n,
    gasReserveWei: 200_000_000_000_000n,
    client,
    ...overrides
  };
}

function makeSender(options: {
  holding?: MainnetEvmHolding;
  account?: Address;
  gasBudgetWei?: bigint;
  broadcast?: (transaction: { to: Address; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint }) => Promise<Hash>;
} = {}) {
  return createMainnetOneClickEvmSender({
    holding: options.holding ?? makeHolding(),
    account: options.account ?? account,
    config,
    gasBudgetWei: options.gasBudgetWei ?? 100_000_000_000_000n,
    broadcast: options.broadcast ?? jest.fn(async () => testHash(`0x${'aa'.repeat(32)}`))
  });
}

function bind(sender: ReturnType<typeof makeSender>): { request: OneClickQuoteRequest; quote: OneClickQuoteResponse } {
  const pair = quotePair();
  sender.bind(pair.request, pair.quote);
  return pair;
}

function transaction(patch: Partial<CounterpartyTransaction> = {}): CounterpartyTransaction {
  return {
    to: token,
    data: testHex(`0xa9059cbb${'0'.repeat(24)}${deposit.slice(2)}${'0'.repeat(48)}0f4240`),
    value: 0n,
    ...patch
  };
}

describe('mainnet 1Click EVM sender', () => {
  beforeEach(() => jest.clearAllMocks());

  it('verifies and binds the wet quote before accepting the exact transfer', () => {
    const sender = makeSender();
    const pair = bind(sender);
    expect(assertOneClickQuoteBinding).toHaveBeenCalledWith(pair.request, pair.quote, false, config);
    expect(sender.broadcastCount).toBe(0);
  });

  it('fails closed for Base where the sender has no proven all-in fee bound', () => {
    const holding = makeHolding(makeClient(), { asset: { ...asset, blockchain: 'base', chainId: 8453 } });
    expect(() => makeSender({ holding })).toThrow(/Ethereum L1 and Arbitrum One/);
  });

  it('requires a bound quote and rejects a second bind', async () => {
    const sender = makeSender();
    await expect(sender.send(transaction(), new AbortController().signal)).rejects.toThrow(/not been bound/);
    bind(sender);
    expect(() => bind(sender)).toThrow(/already bound/);
  });

  it.each([
    ['target', { to: chain }],
    ['calldata', { data: testHex('0x1234') }],
    ['value', { value: 1n }]
  ])('rejects altered %s and refuses every later send attempt', async (_label, change) => {
    const sender = makeSender();
    bind(sender);
    await expect(sender.send(transaction(change), new AbortController().signal)).rejects.toThrow(/does not match/);
    await expect(sender.send(transaction(), new AbortController().signal)).rejects.toThrow(/second send/);
  });

  it('checks gas, max fee, remaining budget, current balance and retained native reserve before broadcast', async () => {
    const cases = [
      { client: makeClient({ estimateGas: jest.fn(async () => 100_001n) }), gasBudgetWei: 100_000_000_000_000n },
      { client: makeClient({ estimateFeesPerGas: jest.fn(async () => ({ maxFeePerGas: 2_000_000_001n })) }), gasBudgetWei: 100_000_000_000_000n },
      { client: makeClient(), gasBudgetWei: 99_999_999_999_999n },
      { client: makeClient({ getBalance: jest.fn(async () => 200_000_000_000_001n) }), gasBudgetWei: 100_000_000_000_000n },
      { client: makeClient({ readTokenBalance: jest.fn(async () => 999_999n) }), gasBudgetWei: 100_000_000_000_000n }
    ];
    for (const item of cases) {
      const broadcast = jest.fn(async () => testHash(`0x${'aa'.repeat(32)}`));
      const sender = makeSender({ holding: makeHolding(item.client), gasBudgetWei: item.gasBudgetWei, broadcast });
      bind(sender);
      await expect(sender.send(transaction(), new AbortController().signal)).rejects.toThrow();
      expect(broadcast).not.toHaveBeenCalled();
      expect(sender.broadcastCount).toBe(0);
    }
  });

  it('honors abort before reads and again before broadcast', async () => {
    const broadcast = jest.fn(async () => testHash(`0x${'aa'.repeat(32)}`));
    const sender = makeSender({ broadcast });
    bind(sender);
    const controller = new AbortController();
    controller.abort();
    await expect(sender.send(transaction(), controller.signal)).rejects.toThrow(/aborted/);
    expect(broadcast).not.toHaveBeenCalled();

    const controllerDuringReads = new AbortController();
    const client = makeClient({ estimateGas: jest.fn(async () => {
      controllerDuringReads.abort();
      return 50_000n;
    }) });
    const lateAbort = makeSender({ holding: makeHolding(client), broadcast });
    bind(lateAbort);
    await expect(lateAbort.send(transaction(), controllerDuringReads.signal)).rejects.toThrow(/aborted/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses a wet quote that expires before the one-time wallet send', async () => {
    const broadcast = jest.fn(async () => testHash(`0x${'aa'.repeat(32)}`));
    const sender = makeSender({ broadcast });
    const pair = quotePair();
    pair.quote.quote.deadline = new Date(Date.now() - 1000).toISOString();
    sender.bind(pair.request, pair.quote);
    await expect(sender.send(transaction(), new AbortController().signal)).rejects.toThrow(/quote has expired/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts the checked transaction once and reports its successful receipt fee', async () => {
    const hash = testHash(`0x${'ab'.repeat(32)}`);
    const broadcast = jest.fn(async () => hash);
    const client = makeClient();
    const sender = makeSender({ holding: makeHolding(client), broadcast });
    bind(sender);
    const tx = transaction();
    expect(await sender.send(tx, new AbortController().signal)).toBe(hash);
    expect(sender.broadcastCount).toBe(1);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      to: tx.to,
      data: tx.data,
      value: 0n,
      gas: 50_000n,
      maxFeePerGas: 2_000_000_000n
    }));
    await expect(sender.send(tx, new AbortController().signal)).rejects.toThrow(/second send/);
    await expect(sender.receiptFee(testHash(`0x${'cd'.repeat(32)}`))).rejects.toThrow(/not the recorded/);
    expect(await sender.receiptFee(hash)).toBe(63_000_000_000_000n);
  });

  it('accepts Arbitrum One estimates above 100k when the all-in gas liability fits the budget', async () => {
    const arbAsset = { ...asset, assetId: 'nep141:arb-0x3333333333333333333333333333333333333333.omft.near', blockchain: 'arb', chainId: 42161 };
    const client = makeClient({
      estimateGas: jest.fn(async () => 900_000n),
      estimateFeesPerGas: jest.fn(async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }))
    });
    const hash = testHash(`0x${'ee'.repeat(32)}`);
    const broadcast = jest.fn(async () => hash);
    const sender = makeSender({
      holding: makeHolding(client, { asset: arbAsset, gasReserveWei: 2_000_000_000_000_000n }),
      gasBudgetWei: 1_000_000_000_000_000n,
      broadcast
    });
    const pair = quotePair(arbAsset);
    sender.bind(pair.request, pair.quote);
    expect(await sender.send(transaction(), new AbortController().signal)).toBe(hash);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ gas: 900_000n, maxFeePerGas: 1_000_000_000n }));
    expect(await sender.receiptFee(hash)).toBe(63_000_000_000_000n);
  });

  it('accounts for reverted receipt gas and requires an explicit effective gas price', async () => {
    const hash = testHash(`0x${'ab'.repeat(32)}`);
    const reverted = makeSender({ holding: makeHolding(makeClient({
      waitForTransactionReceipt: jest.fn(async () => testReceipt('reverted', 1n, 1n))
    })) });
    bind(reverted);
    await reverted.send(transaction(), new AbortController().signal);
    await expect(reverted.receiptFee(hash)).resolves.toBe(1n);

    const missingPrice = makeSender({ holding: makeHolding(makeClient({
      waitForTransactionReceipt: jest.fn(async () => testReceipt('success', undefined, 1n))
    })) });
    bind(missingPrice);
    await missingPrice.send(transaction(), new AbortController().signal);
    await expect(missingPrice.receiptFee(testHash(`0x${'aa'.repeat(32)}`))).rejects.toThrow(/verifiable all-in fee/);
  });

  it('keeps native principal plus the gas reserve available', () => {
    const nativeAsset = { ...asset, assetId: 'nep141:eth.omft.near', contractAddress: 'native' };
    const holding = makeHolding(makeClient(), {
      asset: nativeAsset,
      balanceBaseUnits: 250n,
      nativeBalanceWei: 250n,
      gasReserveWei: 200n
    });
    expect(() => assertMainnetEvmFunding(holding, 51n)).toThrow(/principal and reserved gas/);
    expect(() => assertMainnetEvmFunding(holding, -1n)).toThrow(/cannot be negative/);
  });
});
