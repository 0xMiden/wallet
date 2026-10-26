import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { findAgglayerExitDeposit } from 'lib/agglayer/status';
import {
  BridgedSendTransaction,
  ISellExtraInputs,
  ISellOrderLink,
  ISellPhase,
  ITransaction,
  ITransactionStatus
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { BackendOrder, BuyOrderPrepare, getOrder } from 'lib/onramp/buy-api';
import { SellSignRefusedError, signSellOrder } from 'lib/onramp/sell-signer';
import type { SellToken } from 'lib/onramp/sell-token';
import { WalletStatus } from 'lib/shared/types';

import {
  __resetSellOrderMemoryForTests,
  deriveSellProgress,
  reconcileSellOrders,
  SELL_BACKEND_POLL_INTERVAL_MS,
  SELL_INDEXER_POLL_INTERVAL_MS,
  SELL_ORDER_MAX_AGE_MS,
  SellEvidence,
  SellStartError,
  SellStartFailure,
  setSellPaidClick,
  startSellOrder,
  StartSellOrderInput
} from './sell-order';

const ACCOUNT = 'mtst1account';
const EVM_ADDRESS: `0x${string}` = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const DEPOSIT_ADDRESS = '0x57359A5071a83D3b5640BDcb7Ad17c70F40088A4';
const FAUCET = 'mtst1trnsk';
const EXIT_HASH = `0x${'ee'.repeat(32)}`;
const RELAY_HASH: `0x${string}` = `0x${'ab'.repeat(32)}`;
const CLAIM_HASH = `0x${'cd'.repeat(32)}`;
const ORDER_ID = 'order-1';

const mockStoreState = {
  status: WalletStatus.Ready,
  accounts: [{ publicKey: ACCOUNT, evmAddress: EVM_ADDRESS }]
};

jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => mockStoreState }
}));
jest.mock('lib/onramp/buy-api', () => ({
  ...jest.requireActual('lib/onramp/buy-api'),
  getOrder: jest.fn()
}));
jest.mock('lib/epoch/evm-account', () => ({ buildVaultEvmWalletClient: jest.fn() }));
jest.mock('lib/onramp/sell-signer', () => ({
  ...jest.requireActual('lib/onramp/sell-signer'),
  signSellOrder: jest.fn()
}));
jest.mock('lib/onramp/buy-batch', () => ({
  midenAccountIdToHex: () => '0x' + '0a'.repeat(15)
}));
jest.mock('lib/agglayer/b2agg', () => ({ initiateB2AggBridge: jest.fn() }));
// The indexer helpers read the remote config, which no test loads.
jest.mock('lib/agglayer/status', () => ({
  findAgglayerExitDeposit: jest.fn(),
  isAgglayerDepositClaimed: (deposit: { claim_tx_hash?: string }) => Boolean(deposit.claim_tx_hash),
  sameTxHash: (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
}));
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: jest.fn(async () => undefined) }));

const mockGetOrder = jest.mocked(getOrder);
const mockSign = jest.mocked(signSellOrder);
const mockBridge = jest.mocked(initiateB2AggBridge);
const mockFindExit = jest.mocked(findAgglayerExitDeposit);

const TOKEN: SellToken = {
  faucetId: FAUCET,
  symbol: 'TRNSK',
  decimals: 8,
  amount: 10_000_000_000n,
  evmAmount: 100n * 10n ** 18n
};

function prepare(overrides: Partial<BuyOrderPrepare> = {}): BuyOrderPrepare {
  return {
    chainId: 11155111,
    calibur: '0x00000cAbFc76478C1537dd418aB00967cBbE4AE6',
    evmAddress: EVM_ADDRESS,
    midenAccountHex: '0x' + '0a'.repeat(15),
    executor: '0x2222222222222222222222222222222222222222',
    batchNonce: '100',
    salt: `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`,
    deadline: 1,
    needsAuthorization: false,
    authorizationNonce: 0,
    tokenAmount: TOKEN.evmAmount.toString(),
    depositAddress: DEPOSIT_ADDRESS,
    ...overrides
  };
}

function order(state: BackendOrder['state'], overrides: Partial<BackendOrder> = {}): BackendOrder {
  return {
    id: ORDER_ID,
    side: 'sell',
    state,
    transakStatus: 'AWAITING_PAYMENT_FROM_USER',
    tokenAddress: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
    tokenDecimals: 18,
    tokenAmount: TOKEN.evmAmount.toString(),
    relayTxHash: null,
    error: null,
    depositAddress: DEPOSIT_ADDRESS,
    depositAmount: 100,
    autoExpiresAt: 1_900_000_000,
    prepare: null,
    ...overrides
  };
}

const kickTransactions = jest.fn();

function startInput(overrides: Partial<StartSellOrderInput> = {}): StartSellOrderInput {
  return {
    account: { publicKey: ACCOUNT, evmAddress: EVM_ADDRESS },
    orderId: ORDER_ID,
    deposit: { address: DEPOSIT_ADDRESS, amount: '100' },
    depositSource: 'event',
    token: TOKEN,
    guardianProvider: {
      getAccounts: async () => [],
      signWord: async () => '',
      getPublicKeyForCommitment: async () => ''
    },
    kickTransactions,
    ...overrides
  };
}

/** What `initiateB2AggBridge` does to the store: one queued row that carries the sale. */
async function queueBridgeOut(sellOrder: ISellOrderLink | undefined): Promise<string> {
  const row = new BridgedSendTransaction(
    ACCOUNT,
    TOKEN.amount,
    EVM_ADDRESS,
    0,
    'agglayer',
    FAUCET,
    new Uint8Array([1]),
    true,
    undefined,
    EXIT_HASH
  );
  if (sellOrder !== undefined) row.extraInputs.sellOrder = sellOrder;
  await Repo.transactions.add(row);
  return row.id;
}

const sellRows = () => Repo.transactions.filter(tx => tx.type === 'sell').toArray();
const bridgeRows = () => Repo.transactions.filter(tx => tx.type === 'bridged-send').toArray();

async function onlySellRow(): Promise<ITransaction> {
  const rows = await sellRows();
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('no sell row');
  return row;
}

const inputsOf = async (): Promise<ISellExtraInputs> => (await onlySellRow()).extraInputs;

async function failureOf(start: Promise<string>): Promise<SellStartFailure | undefined> {
  try {
    await start;
    return undefined;
  } catch (error) {
    return error instanceof SellStartError ? error.failure : undefined;
  }
}

/** Start a sale to its tracking row. */
async function startedSale(overrides: Partial<StartSellOrderInput> = {}): Promise<string> {
  mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));
  const id = await startSellOrder(startInput(overrides));
  jest.clearAllMocks();
  return id;
}

async function setBridge(patch: Partial<ITransaction>, extra: Record<string, unknown> = {}): Promise<void> {
  const [bridge] = await bridgeRows();
  if (bridge === undefined) throw new Error('no bridge row');
  await Repo.transactions.where({ id: bridge.id }).modify(tx => {
    Object.assign(tx, patch);
    tx.extraInputs = { ...tx.extraInputs, ...extra };
  });
}

let now = 1_800_000_000_000;
let dateNow: jest.SpyInstance<number, []>;

/** One watcher pass, after enough time for every throttled read. */
async function pass(): Promise<void> {
  now += Math.max(SELL_BACKEND_POLL_INTERVAL_MS, SELL_INDEXER_POLL_INTERVAL_MS);
  await reconcileSellOrders({ kickTransactions });
}

beforeEach(async () => {
  jest.clearAllMocks();
  __resetSellOrderMemoryForTests();
  await Repo.transactions.clear();
  now = 1_800_000_000_000;
  dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockSign.mockResolvedValue('signed');
  mockBridge.mockImplementation(async args => queueBridgeOut(args.sellOrder));
  mockFindExit.mockResolvedValue(null);
});

afterEach(() => {
  dateNow.mockRestore();
});

describe('deriveSellProgress', () => {
  const evidence = (overrides: Partial<SellEvidence> = {}): SellEvidence => ({
    current: 'submitting',
    bridge: 'pending',
    exitClaimed: false,
    ...overrides
  });
  const backend = (state: BackendOrder['state'], transakStatus: string | null = null, error: string | null = null) => ({
    state,
    transakStatus,
    error
  });

  const forward: ReadonlyArray<[string, SellEvidence, ISellPhase]> = [
    ['the bridge-out is in the queue', evidence(), 'submitting'],
    ['the bridge-out is on Miden', evidence({ bridge: 'completed' }), 'bridging'],
    ['the exit is claimed on Ethereum', evidence({ bridge: 'completed', exitClaimed: true }), 'on-ethereum'],
    [
      'the backend waits for the token',
      evidence({ bridge: 'completed', exitClaimed: true, order: backend('signed') }),
      'on-ethereum'
    ],
    ['the relay is sent', evidence({ bridge: 'completed', order: backend('relay_sent') }), 'sent'],
    ['the relay is mined', evidence({ bridge: 'completed', order: backend('deposited') }), 'sent'],
    [
      'Transak has the payment',
      evidence({ bridge: 'completed', order: backend('deposited', 'PENDING_DELIVERY_FROM_TRANSAK') }),
      'received'
    ],
    ['Transak paid out', evidence({ bridge: 'completed', order: backend('deposited', 'COMPLETED') }), 'completed'],
    // A tick with no backend read does not move the row back.
    ['a later phase is kept', evidence({ current: 'sent', bridge: 'completed' }), 'sent']
  ];

  it.each(forward)('reads %s', (_label, input, phase) => {
    expect(deriveSellProgress(input)).toEqual({ phase });
  });

  it('fails the sale when the bridge-out failed on Miden, with its reason', () => {
    expect(deriveSellProgress(evidence({ bridge: 'failed', bridgeError: 'Insufficient balance' }))).toEqual({
      phase: 'failed',
      failure: 'bridge-failed',
      error: 'Insufficient balance'
    });
    expect(deriveSellProgress(evidence({ bridge: 'missing' }))).toEqual({ phase: 'failed', failure: 'bridge-missing' });
  });

  it('does not fail a sale for its bridge-out after later evidence', () => {
    expect(deriveSellProgress(evidence({ current: 'bridging', bridge: 'failed' }))).toEqual({ phase: 'bridging' });
    expect(deriveSellProgress(evidence({ bridge: 'failed', order: backend('relay_sent') }))).toEqual({ phase: 'sent' });
  });

  const ended: ReadonlyArray<[BackendOrder['state'], string]> = [
    ['failed', 'order-failed'],
    ['expired', 'order-expired'],
    ['cancelled', 'order-cancelled']
  ];
  it.each(ended)('fails the sale when the backend order is %s', (state, failure) => {
    expect(deriveSellProgress(evidence({ bridge: 'completed', order: backend(state, null, 'why') }))).toEqual({
      phase: 'failed',
      failure,
      error: 'why'
    });
  });

  const transakEnded: ReadonlyArray<[string, string]> = [
    ['FAILED', 'transak-failed'],
    ['CANCELLED', 'transak-cancelled'],
    ['EXPIRED', 'transak-expired'],
    ['REFUNDED', 'transak-refunded']
  ];
  // After the deposit the backend state stays `deposited`: only the Transak status shows the failure.
  it.each(transakEnded)('fails a deposited sale when Transak reports %s', (transakStatus, failure) => {
    expect(
      deriveSellProgress(evidence({ current: 'sent', bridge: 'completed', order: backend('deposited', transakStatus) }))
    ).toEqual({ phase: 'failed', failure });
  });
});

describe('startSellOrder', () => {
  it('signs the relay first, then queues the bridge-out to the own EVM address and makes the tracking row', async () => {
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));
    const id = await startSellOrder(startInput());

    expect(mockSign).toHaveBeenCalledWith({
      account: { publicKey: ACCOUNT, evmAddress: EVM_ADDRESS, midenAccountHex: '0x' + '0a'.repeat(15) },
      depositAddress: DEPOSIT_ADDRESS,
      cryptoAmount: '100',
      order: expect.objectContaining({ id: ORDER_ID, state: 'awaiting_signature' })
    });
    const link: ISellOrderLink = {
      orderId: ORDER_ID,
      cryptoAmount: '100',
      tokenSymbol: 'TRNSK',
      tokenDecimals: 8,
      depositAddress: DEPOSIT_ADDRESS,
      depositSource: 'event',
      autoExpiresAt: 1_900_000_000
    };
    expect(mockBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: TOKEN.amount,
        faucetId: FAUCET,
        destinationAddress: EVM_ADDRESS,
        senderPublicKey: ACCOUNT,
        sellOrder: link
      })
    );
    const [signOrder = Infinity] = mockSign.mock.invocationCallOrder;
    const [bridgeOrder = -Infinity] = mockBridge.mock.invocationCallOrder;
    expect(signOrder).toBeLessThan(bridgeOrder);

    const row = await onlySellRow();
    const [bridge] = await bridgeRows();
    expect(row.id).toBe(id);
    expect(row.status).toBe(ITransactionStatus.Completed);
    // The value moves in the bridge-out row only.
    expect(row.amount).toBeUndefined();
    expect(row.faucetId).toBeUndefined();
    expect(row.extraInputs).toMatchObject({
      ...link,
      provider: 'transak',
      faucetId: FAUCET,
      tokenAmount: TOKEN.amount.toString(),
      evmAddress: EVM_ADDRESS,
      bridgeTxId: bridge?.id,
      bridgeExitTxHash: EXIT_HASH,
      phase: 'submitting',
      phaseTimestamps: { submitting: now }
    });
    expect(kickTransactions).toHaveBeenCalledTimes(1);
  });

  it('queues one bridge-out for two starts of one order at the same time', async () => {
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));
    const [first, second] = await Promise.all([startSellOrder(startInput()), startSellOrder(startInput())]);
    expect(second).toBe(first);
    expect(mockBridge).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(await bridgeRows()).toHaveLength(1);
    expect(await sellRows()).toHaveLength(1);
  });

  it('gives the same row to a later start of the same order, with no second bridge-out', async () => {
    const id = await startedSale();
    await expect(startSellOrder(startInput())).resolves.toBe(id);
    expect(mockBridge).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockGetOrder).not.toHaveBeenCalled();
    expect(await bridgeRows()).toHaveLength(1);
    expect(await sellRows()).toHaveLength(1);
  });

  it('finds the bridge-out of the order after a restart that lost the tracking row', async () => {
    const id = await startedSale();
    // The app stopped after the bridge-out was queued and before the tracking row was written.
    await Repo.transactions.delete(id);
    __resetSellOrderMemoryForTests();

    const again = await startSellOrder(startInput());
    expect(mockBridge).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    const [bridge] = await bridgeRows();
    expect(await bridgeRows()).toHaveLength(1);
    expect((await onlySellRow()).id).toBe(again);
    expect(await inputsOf()).toMatchObject({ orderId: ORDER_ID, bridgeTxId: bridge?.id, cryptoAmount: '100' });
    expect(kickTransactions).toHaveBeenCalledTimes(1);
  });

  it('queues no bridge-out when the signer refuses', async () => {
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));
    mockSign.mockRejectedValue(new SellSignRefusedError('amount', 'no'));
    expect(await failureOf(startSellOrder(startInput()))).toEqual({ kind: 'refused', reason: 'amount' });
    expect(mockBridge).not.toHaveBeenCalled();
    expect(await sellRows()).toHaveLength(0);
    expect(kickTransactions).not.toHaveBeenCalled();
  });

  it('stops with the backend reason when the order ended', async () => {
    mockGetOrder.mockResolvedValue(order('expired', { error: 'Transak expired the order' }));
    expect(await failureOf(startSellOrder(startInput()))).toEqual({
      kind: 'order',
      state: 'expired',
      message: 'Transak expired the order'
    });
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockBridge).not.toHaveBeenCalled();
  });

  it('queues no bridge-out when the backend relays another amount than the exit releases', async () => {
    // The order has its signature already, so the signer makes no check. The start makes it.
    mockGetOrder.mockResolvedValue(order('signed', { tokenAmount: (TOKEN.evmAmount / 100n).toString() }));
    expect(await failureOf(startSellOrder(startInput()))).toEqual({ kind: 'refused', reason: 'amount' });
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockBridge).not.toHaveBeenCalled();
    expect(await sellRows()).toHaveLength(0);
  });

  it('signs nothing and queues nothing after the page closed', async () => {
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));
    expect(await failureOf(startSellOrder(startInput({ isLive: () => false })))).toEqual({ kind: 'stopped' });
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockBridge).not.toHaveBeenCalled();
  });

  it('does not sign again when the backend already has the signature', async () => {
    mockGetOrder.mockResolvedValue(order('signed'));
    await startSellOrder(startInput());
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockBridge).toHaveBeenCalledTimes(1);
    expect(await sellRows()).toHaveLength(1);
  });

  it('reports a bridge-out that could not be queued and makes no tracking row', async () => {
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));
    mockBridge.mockRejectedValue(new Error('Spending limit reached'));
    expect(await failureOf(startSellOrder(startInput()))).toEqual({
      kind: 'bridge',
      message: 'Spending limit reached'
    });
    expect(await sellRows()).toHaveLength(0);
    // A new try for the same order can queue the bridge-out: nothing is in the store for it.
    mockBridge.mockImplementation(async args => queueBridgeOut(args.sellOrder));
    await startSellOrder(startInput());
    expect(await bridgeRows()).toHaveLength(1);
  });
});

describe('reconcileSellOrders', () => {
  it('starts the queue while the bridge-out waits, and does nothing more', async () => {
    await startedSale();
    mockGetOrder.mockResolvedValue(order('signed'));
    await pass();
    expect(kickTransactions).toHaveBeenCalledTimes(1);
    expect(await inputsOf()).toMatchObject({ phase: 'submitting' });
    expect(mockFindExit).not.toHaveBeenCalled();
  });

  it('follows the sale to the end: Miden, the exit, the relay, the payment and the payout', async () => {
    await startedSale();
    mockGetOrder.mockResolvedValue(order('signed'));

    await setBridge({ status: ITransactionStatus.Completed, transactionId: '0xmiden' });
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'bridging', bridgeTransactionId: '0xmiden' });
    expect(mockFindExit).toHaveBeenCalledWith(EVM_ADDRESS, EXIT_HASH, undefined);

    mockFindExit.mockResolvedValue({
      leaf_type: 0,
      orig_net: 0,
      orig_addr: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
      amount: TOKEN.evmAmount.toString(),
      dest_net: 0,
      dest_addr: EVM_ADDRESS,
      block_num: '1',
      deposit_cnt: 7,
      network_id: 73,
      tx_hash: EXIT_HASH,
      claim_tx_hash: CLAIM_HASH,
      metadata: '0x',
      ready_for_claim: true,
      global_index: '7'
    });
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'on-ethereum', claimTxHash: CLAIM_HASH });

    mockFindExit.mockClear();
    mockGetOrder.mockResolvedValue(order('relay_sent', { relayTxHash: RELAY_HASH }));
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'sent', relayTxHash: RELAY_HASH });
    // The exit is not read again after it is claimed.
    expect(mockFindExit).not.toHaveBeenCalled();

    mockGetOrder.mockResolvedValue(
      order('deposited', { relayTxHash: RELAY_HASH, transakStatus: 'PENDING_DELIVERY_FROM_TRANSAK' })
    );
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'received', transakStatus: 'PENDING_DELIVERY_FROM_TRANSAK' });

    mockGetOrder.mockResolvedValue(order('deposited', { relayTxHash: RELAY_HASH, transakStatus: 'COMPLETED' }));
    await pass();
    const done = await inputsOf();
    expect(done).toMatchObject({ phase: 'completed', transakStatus: 'COMPLETED' });
    expect(Object.keys(done.phaseTimestamps).sort()).toEqual(
      ['bridging', 'completed', 'on-ethereum', 'received', 'sent', 'submitting'].sort()
    );
    expect((await onlySellRow()).displayMessage).toBe('Sold');

    // A terminal row is not polled again.
    mockGetOrder.mockClear();
    await pass();
    expect(mockGetOrder).not.toHaveBeenCalled();
  });

  it('takes the claim that the bridge poll wrote on the bridge-out row, with no indexer read', async () => {
    await startedSale();
    mockGetOrder.mockResolvedValue(order('signed'));
    await setBridge({ status: ITransactionStatus.Completed }, { claimStatus: 'claimed', claimTxHash: CLAIM_HASH });
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'on-ethereum', claimTxHash: CLAIM_HASH });
    expect(mockFindExit).not.toHaveBeenCalled();
  });

  it('reads the backend and the indexer no more often than their intervals', async () => {
    await startedSale();
    mockGetOrder.mockResolvedValue(order('signed'));
    await setBridge({ status: ITransactionStatus.Completed });
    await pass();
    expect(mockGetOrder).toHaveBeenCalledTimes(1);
    expect(mockFindExit).toHaveBeenCalledTimes(1);

    // The watcher ticks again before the intervals passed.
    now += 10_000;
    await reconcileSellOrders({ kickTransactions });
    expect(mockGetOrder).toHaveBeenCalledTimes(1);
    expect(mockFindExit).toHaveBeenCalledTimes(1);

    now += SELL_BACKEND_POLL_INTERVAL_MS;
    await reconcileSellOrders({ kickTransactions });
    expect(mockGetOrder).toHaveBeenCalledTimes(2);
    expect(mockFindExit).toHaveBeenCalledTimes(1);
  });

  it('fails the sale with the reason when the bridge-out transaction failed', async () => {
    await startedSale();
    mockGetOrder.mockResolvedValue(order('signed'));
    await setBridge({ status: ITransactionStatus.Failed, error: 'Transaction execution failed' });
    await pass();
    expect(await inputsOf()).toMatchObject({
      phase: 'failed',
      failure: 'bridge-failed',
      error: 'Transaction execution failed'
    });
    expect((await onlySellRow()).displayMessage).toBe('Sale failed');
  });

  it('fails the sale when the backend order expired while the token was on the bridge', async () => {
    await startedSale();
    await setBridge({ status: ITransactionStatus.Completed });
    mockGetOrder.mockResolvedValue(order('expired', { transakStatus: 'EXPIRED' }));
    await pass();
    // The backend cause wins over the Transak status of the same expiry.
    expect(await inputsOf()).toMatchObject({ phase: 'failed', failure: 'order-expired' });

    await Repo.transactions.clear();
    __resetSellOrderMemoryForTests();
    await startedSale();
    await setBridge({ status: ITransactionStatus.Completed });
    mockGetOrder.mockResolvedValue(order('expired', { transakStatus: 'AWAITING_PAYMENT_FROM_USER' }));
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'failed', failure: 'order-expired' });
  });

  it('reads a failure after the deposit from the Transak status alone', async () => {
    await startedSale();
    await setBridge({ status: ITransactionStatus.Completed });
    mockGetOrder.mockResolvedValue(order('deposited', { relayTxHash: RELAY_HASH }));
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'sent' });

    mockGetOrder.mockResolvedValue(order('deposited', { relayTxHash: RELAY_HASH, transakStatus: 'REFUNDED' }));
    await pass();
    expect(await inputsOf()).toMatchObject({
      phase: 'failed',
      failure: 'transak-refunded',
      transakStatus: 'REFUNDED',
      relayTxHash: RELAY_HASH
    });
  });

  it('keeps the row when the backend is not reachable', async () => {
    await startedSale();
    await setBridge({ status: ITransactionStatus.Completed });
    mockGetOrder.mockRejectedValue(new Error('offline'));
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'bridging' });
  });

  it('signs again when the backend asks for a new signature, one time for each set of values', async () => {
    await startedSale({ deposit: { address: DEPOSIT_ADDRESS, amount: '100' } });
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare({ batchNonce: '101' }) }));
    await pass();
    await pass();
    expect(mockSign).toHaveBeenCalledTimes(1);
    // The row gives the deposit that the widget named: the signer checks the backend against it.
    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({ depositAddress: DEPOSIT_ADDRESS, cryptoAmount: '100' })
    );

    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare({ batchNonce: '102' }) }));
    await pass();
    expect(mockSign).toHaveBeenCalledTimes(2);
  });

  it('makes the tracking row of a bridge-out that has none, and queues no second bridge-out', async () => {
    const id = await startedSale();
    await Repo.transactions.delete(id);
    __resetSellOrderMemoryForTests();
    mockGetOrder.mockResolvedValue(order('signed'));

    await pass();
    const [bridge] = await bridgeRows();
    expect(await inputsOf()).toMatchObject({
      orderId: ORDER_ID,
      bridgeTxId: bridge?.id,
      depositAddress: DEPOSIT_ADDRESS
    });
    expect(mockBridge).not.toHaveBeenCalled();
    await pass();
    expect(await sellRows()).toHaveLength(1);
  });

  it('fails a restored row and a row that is too old, with no backend read', async () => {
    const id = await startedSale();
    await Repo.transactions.where({ id }).modify({ restoredFromBackup: true });
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'failed', failure: 'restored' });

    await Repo.transactions.clear();
    __resetSellOrderMemoryForTests();
    await startedSale();
    now += SELL_ORDER_MAX_AGE_MS;
    await pass();
    expect(await inputsOf()).toMatchObject({ phase: 'failed', failure: 'timeout' });
    expect(mockGetOrder).not.toHaveBeenCalled();
  });

  it('clicks "Yes, I have paid" one time after the relay of a page deposit, and keeps the result', async () => {
    const paidClick = jest.fn(async () => false);
    await startedSale({ depositSource: 'page' });
    setSellPaidClick(paidClick);
    await setBridge({ status: ITransactionStatus.Completed });

    mockGetOrder.mockResolvedValue(order('signed'));
    await pass();
    expect(paidClick).not.toHaveBeenCalled();

    mockGetOrder.mockResolvedValue(order('deposited', { relayTxHash: RELAY_HASH }));
    await pass();
    await pass();
    expect(paidClick).toHaveBeenCalledTimes(1);
    expect(paidClick).toHaveBeenCalledWith(ORDER_ID);
    expect(await inputsOf()).toMatchObject({ phase: 'sent', paidClicked: false });
  });

  it('clicks nothing for a deposit that the widget event named', async () => {
    const paidClick = jest.fn(async () => true);
    await startedSale();
    setSellPaidClick(paidClick);
    await setBridge({ status: ITransactionStatus.Completed });
    mockGetOrder.mockResolvedValue(order('deposited', { relayTxHash: RELAY_HASH }));
    await pass();
    expect(paidClick).not.toHaveBeenCalled();
    expect((await inputsOf()).paidClicked).toBeUndefined();
  });
});
