import { AgglayerDeposit } from 'lib/agglayer/status';
import { BuyTransaction, ConsumeTransaction, IBuyExtraInputs, IBuyPhase, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { BuyApiError, BuyOrder, BuyOrderPrepare, getBuyOrder } from 'lib/onramp/buy-api';
import { BuySignRefusedError, signBuyOrder } from 'lib/onramp/buy-signer';
import { WalletStatus } from 'lib/shared/types';

import { __resetBuyOrderMemoryForTests, BUY_INDEXER_POLL_INTERVAL_MS, reconcileBuyOrders } from './buy-order';
import { initiateConsumeTransaction } from '../transaction/initiate';
import { ConsumableNote, NoteTypeEnum } from '../types';

const mockStoreState = {
  status: WalletStatus.Ready,
  accounts: [{ publicKey: 'mtst1account', evmAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' }]
};

jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => mockStoreState }
}));
jest.mock('lib/onramp/buy-api', () => ({
  ...jest.requireActual('lib/onramp/buy-api'),
  getBuyOrder: jest.fn()
}));
jest.mock('lib/onramp/buy-signer', () => ({
  ...jest.requireActual('lib/onramp/buy-signer'),
  signBuyOrder: jest.fn()
}));
jest.mock('lib/onramp/buy-batch', () => ({
  midenAccountIdToHex: () => '0x' + '0a'.repeat(15),
  midenAccountHexToEvmAddress: () => '0x000000000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a00'
}));

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });
jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => false
}));
jest.mock('../transaction/initiate', () => ({
  initiateConsumeTransaction: jest.fn()
}));

const mockGetOrder = jest.mocked(getBuyOrder);
const mockSign = jest.mocked(signBuyOrder);
const mockInitiateConsume = jest.mocked(initiateConsumeTransaction);

const ACCOUNT = 'mtst1account';
const AMOUNT = (50n * 10n ** 18n).toString();
const RELAY_HASH: `0x${string}` = `0x${'ab'.repeat(32)}`;

function prepare(overrides: Partial<BuyOrderPrepare> = {}): BuyOrderPrepare {
  return {
    chainId: 11155111,
    calibur: '0x00000cAbFc76478C1537dd418aB00967cBbE4AE6',
    evmAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    midenAccountHex: '0x' + '0a'.repeat(15),
    executor: '0x2222222222222222222222222222222222222222',
    batchNonce: '100',
    salt: `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`,
    deadline: 1,
    needsAuthorization: false,
    authorizationNonce: 0,
    tokenAmount: AMOUNT,
    ...overrides
  };
}

function order(state: BuyOrder['state'], overrides: Partial<BuyOrder> = {}): BuyOrder {
  return {
    id: 'order-1',
    state,
    transakStatus: null,
    tokenAddress: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
    tokenDecimals: 18,
    tokenAmount: null,
    relayTxHash: null,
    error: null,
    prepare: null,
    ...overrides
  };
}

const CLAIM_HASH = `0x${'cd'.repeat(32)}`;

function deposit(overrides: Partial<AgglayerDeposit> = {}): AgglayerDeposit {
  return {
    leaf_type: 0,
    orig_net: 0,
    orig_addr: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
    amount: AMOUNT,
    dest_net: 1,
    dest_addr: '0x000000000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a00',
    block_num: '1',
    deposit_cnt: 7,
    network_id: 0,
    // The indexer can send the hash in other casing than the relay hash.
    tx_hash: RELAY_HASH.toUpperCase().replace('0X', '0x'),
    metadata: '0x',
    ready_for_claim: false,
    global_index: '7',
    ...overrides
  };
}

/** Make the indexer answer with these deposits. */
function indexerReturns(deposits: AgglayerDeposit[]): void {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ deposits, total_cnt: '0' }) });
}

function note(overrides: Partial<ConsumableNote> = {}): ConsumableNote {
  return {
    id: 'note-1',
    faucetId: 'mtst1trnsk',
    amount: AMOUNT,
    senderAddress: 'mtst1bridge',
    isBeingClaimed: false,
    type: NoteTypeEnum.Public,
    ...overrides
  };
}

async function seed(phase: IBuyPhase = 'payment', extra: Partial<IBuyExtraInputs> = {}): Promise<string> {
  const row = new BuyTransaction(ACCOUNT, { orderId: 'order-1', fiatAmount: '50', tokenSymbol: 'TRNSK' });
  row.extraInputs = { ...row.extraInputs, phase, ...extra };
  await Repo.transactions.add(row);
  return row.id;
}

async function inputsOf(id: string): Promise<IBuyExtraInputs | undefined> {
  return (await Repo.transactions.get(id))?.extraInputs;
}

beforeEach(async () => {
  await Repo.transactions.clear();
  jest.clearAllMocks();
  __resetBuyOrderMemoryForTests();
  mockStoreState.status = WalletStatus.Ready;
  mockSign.mockResolvedValue('signed');
  indexerReturns([]);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reconcileBuyOrders state mapping', () => {
  const cases: ReadonlyArray<[BuyOrder['state'], IBuyPhase]> = [
    ['checkout', 'payment'],
    ['awaiting_signature', 'funds-arriving'],
    ['signed', 'funds-arriving'],
    ['relay_sent', 'bridge-sent'],
    ['deposited', 'bridging'],
    ['failed', 'failed'],
    ['expired', 'failed'],
    ['cancelled', 'failed']
  ];

  it.each(cases)('maps %s to %s', async (state, phase) => {
    const id = await seed();
    mockGetOrder.mockResolvedValue(order(state));

    await reconcileBuyOrders();

    expect((await inputsOf(id))?.phase).toBe(phase);
  });

  it('copies the relay hash and the token amount on relay_sent', async () => {
    const id = await seed('funds-arriving');
    mockGetOrder.mockResolvedValue(order('relay_sent', { relayTxHash: RELAY_HASH, tokenAmount: AMOUNT }));

    await reconcileBuyOrders();

    expect(await inputsOf(id)).toMatchObject({
      phase: 'bridge-sent',
      relayTxHash: RELAY_HASH,
      tokenAmount: AMOUNT,
      tokenDecimals: 18
    });
  });

  it('keeps the backend error on a failed order', async () => {
    const id = await seed('funds-arriving');
    mockGetOrder.mockResolvedValue(order('failed', { error: 'Transak refunded the order' }));

    await reconcileBuyOrders();

    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs.phase).toBe('failed');
    expect(row?.error).toBe('Transak refunded the order');
  });

  it('skips terminal rows', async () => {
    await seed('completed');
    await seed('failed');

    await reconcileBuyOrders();

    expect(mockGetOrder).not.toHaveBeenCalled();
  });

  it('fails a row older than 7 days without asking the backend', async () => {
    const id = await seed('bridging');
    await Repo.transactions.update(id, { initiatedAt: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60 });

    await reconcileBuyOrders();

    expect(mockGetOrder).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await inputsOf(id))?.phase).toBe('failed');
  });

  it('leaves the row open when the backend is not reachable', async () => {
    const id = await seed('bridge-sent');
    mockGetOrder.mockRejectedValue(new BuyApiError('Buy backend is not reachable'));

    await reconcileBuyOrders();

    expect((await inputsOf(id))?.phase).toBe('bridge-sent');
  });
});

describe('reconcileBuyOrders Agglayer tracking', () => {
  it('copies the relay hash and token fields on deposited, then reads the indexer', async () => {
    const id = await seed('bridge-sent');
    mockGetOrder.mockResolvedValue(order('deposited', { relayTxHash: RELAY_HASH, tokenAmount: AMOUNT }));

    await reconcileBuyOrders();

    expect(await inputsOf(id)).toMatchObject({
      phase: 'bridging',
      relayTxHash: RELAY_HASH,
      tokenAmount: AMOUNT,
      tokenDecimals: 18
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('0x000000000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a00');
  });

  it('does not ask the backend again after deposited', async () => {
    await seed('bridging', { relayTxHash: RELAY_HASH, tokenAmount: AMOUNT });

    await reconcileBuyOrders();

    expect(mockGetOrder).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays bridging while the indexer does not show the deposit', async () => {
    const id = await seed('bridging', { relayTxHash: RELAY_HASH, tokenAmount: AMOUNT });
    indexerReturns([deposit({ tx_hash: `0x${'ef'.repeat(32)}`, ready_for_claim: true, claim_tx_hash: CLAIM_HASH })]);

    await reconcileBuyOrders();

    expect((await inputsOf(id))?.phase).toBe('bridging');
  });

  it('stays bridging while the deposit is not claimed, and logs the first sighting one time', async () => {
    const id = await seed('bridging', { relayTxHash: RELAY_HASH, tokenAmount: AMOUNT });
    indexerReturns([deposit({ ready_for_claim: true, claim_tx_hash: `0x${'0'.repeat(64)}` })]);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    await reconcileBuyOrders();
    clock.mockReturnValue(now + BUY_INDEXER_POLL_INTERVAL_MS);
    await reconcileBuyOrders();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await inputsOf(id))?.phase).toBe('bridging');
    const sightings = jest
      .mocked(console.info)
      .mock.calls.filter(call => call[0] === '[buy]' && call[1] === 'indexer shows deposit');
    expect(sightings).toEqual([['[buy]', 'indexer shows deposit', { id, depositCnt: 7, ready: true }]]);
  });

  it('reads the indexer at most one time in each poll interval for each row', async () => {
    await seed('bridging', { relayTxHash: RELAY_HASH, tokenAmount: AMOUNT });
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    await reconcileBuyOrders();
    clock.mockReturnValue(now + 8_000);
    await reconcileBuyOrders();
    clock.mockReturnValue(now + BUY_INDEXER_POLL_INTERVAL_MS - 1);
    await reconcileBuyOrders();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + BUY_INDEXER_POLL_INTERVAL_MS);
    await reconcileBuyOrders();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves the row bridging when the indexer is not reachable', async () => {
    const id = await seed('bridging', { relayTxHash: RELAY_HASH, tokenAmount: AMOUNT });
    fetchMock.mockRejectedValue(new Error('network down'));

    await reconcileBuyOrders();

    expect((await inputsOf(id))?.phase).toBe('bridging');
  });

  it('moves to consuming with the claim hash when the indexer shows the claim', async () => {
    const id = await seed('bridging', { relayTxHash: RELAY_HASH, tokenAmount: AMOUNT });
    indexerReturns([deposit({ ready_for_claim: true, claim_tx_hash: CLAIM_HASH })]);

    await reconcileBuyOrders({ claimableAccountId: ACCOUNT, claimableNotes: [] });

    expect(await inputsOf(id)).toMatchObject({ phase: 'consuming', claimTxHash: CLAIM_HASH });
    expect(mockGetOrder).not.toHaveBeenCalled();
  });
});

describe('reconcileBuyOrders signing', () => {
  it('signs each set of values once', async () => {
    await seed();
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));

    await reconcileBuyOrders();
    await reconcileBuyOrders();

    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({
        account: {
          publicKey: ACCOUNT,
          evmAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
          midenAccountHex: '0x' + '0a'.repeat(15)
        },
        fiatAmount: '50'
      })
    );
  });

  it('signs again for a new amount at the same nonce', async () => {
    await seed();
    mockGetOrder.mockResolvedValueOnce(order('awaiting_signature', { prepare: prepare() }));
    mockGetOrder.mockResolvedValueOnce(order('awaiting_signature', { prepare: prepare({ tokenAmount: '5' }) }));

    await reconcileBuyOrders();
    await reconcileBuyOrders();

    expect(mockSign).toHaveBeenCalledTimes(2);
  });

  it('signs again after the relay reverted, though the row is past funds-arriving', async () => {
    const id = await seed('bridge-sent');
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare({ batchNonce: '101' }) }));

    await reconcileBuyOrders();

    expect(mockSign).toHaveBeenCalledTimes(1);
    expect((await inputsOf(id))?.phase).toBe('bridge-sent');
  });

  it('does not sign while the wallet is locked', async () => {
    await seed();
    mockStoreState.status = WalletStatus.Locked;
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));

    await reconcileBuyOrders();

    expect(mockSign).not.toHaveBeenCalled();
  });

  it('retries the same values after a network failure, not after a refusal', async () => {
    await seed();
    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare() }));
    mockSign.mockRejectedValueOnce(new BuyApiError('Buy backend is not reachable'));

    await reconcileBuyOrders();
    await reconcileBuyOrders();
    expect(mockSign).toHaveBeenCalledTimes(2);

    mockGetOrder.mockResolvedValue(order('awaiting_signature', { prepare: prepare({ batchNonce: '102' }) }));
    mockSign.mockRejectedValueOnce(new BuySignRefusedError('amount', 'Order token amount is out of range'));
    await reconcileBuyOrders();
    await reconcileBuyOrders();
    expect(mockSign).toHaveBeenCalledTimes(3);
  });
});

describe('reconcileBuyOrders consume', () => {
  it('queues a consume of the bridged note and links it to the buy row', async () => {
    const id = await seed('bridging', { tokenAmount: AMOUNT, relayTxHash: RELAY_HASH });
    const consume = new ConsumeTransaction(ACCOUNT, [note()]);
    await Repo.transactions.add(consume);
    mockInitiateConsume.mockResolvedValue(consume.id);
    indexerReturns([deposit({ ready_for_claim: true, claim_tx_hash: CLAIM_HASH })]);
    const kickTransactions = jest.fn();

    await reconcileBuyOrders({ claimableAccountId: ACCOUNT, claimableNotes: [note()], kickTransactions });

    expect(mockInitiateConsume).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ id: 'note-1' }), false);
    expect(await inputsOf(id)).toMatchObject({
      phase: 'consuming',
      midenNoteId: 'note-1',
      consumeTxId: consume.id,
      claimTxHash: CLAIM_HASH
    });
    expect((await Repo.transactions.get(consume.id))?.extraInputs.bridgeIn).toMatchObject({ buyTxId: id });
    expect(kickTransactions).toHaveBeenCalled();
  });

  it('ignores a note of another amount, a cached note and the notes of another account', async () => {
    const id = await seed('consuming', { tokenAmount: AMOUNT });

    await reconcileBuyOrders({
      claimableAccountId: ACCOUNT,
      claimableNotes: [note({ amount: '1' }), note({ id: 'note-2', fromCache: true })]
    });
    await reconcileBuyOrders({ claimableAccountId: 'mtst1other', claimableNotes: [note()] });

    expect(mockInitiateConsume).not.toHaveBeenCalled();
    expect(await inputsOf(id)).toMatchObject({ phase: 'consuming' });
    expect((await inputsOf(id))?.consumeTxId).toBeUndefined();
  });

  it('completes the row when its consume completed', async () => {
    const consume = new ConsumeTransaction(ACCOUNT, [note()]);
    consume.status = ITransactionStatus.Completed;
    await Repo.transactions.add(consume);
    const id = await seed('consuming', { tokenAmount: AMOUNT, consumeTxId: consume.id });

    await reconcileBuyOrders({ claimableAccountId: ACCOUNT, claimableNotes: [] });

    expect((await inputsOf(id))?.phase).toBe('completed');
    expect(mockGetOrder).not.toHaveBeenCalled();
  });
});
