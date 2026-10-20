import * as Repo from 'lib/miden/repo';

import { ConsumeTransaction, type ISubmitEvidence, type ITransaction, ITransactionStatus } from '../db/types';
import { type SwapOrder } from '../swap/classification';
import { reconcileSwapOrderNotes } from '../swap/settlement';
import { type ConsumableNote, NoteTypeEnum, type SwapOrderNoteMetadata } from '../types';
import { ClaimInsertRefusedError } from './initiate';

jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isExtension: () => false }));
jest.mock('lib/miden/back/store', () => ({ store: { getState: () => ({ accounts: [] }) } }));
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: () => true,
  getOrCreateMultisigService: jest.fn()
}));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getActiveOverride: () => null,
  isNoteTransportConfigured: () => false,
  getEffectiveNetworkName: () => 'testnet'
}));

const mockNativeAssetId = jest.fn();
const mockVerificationBaseFee = jest.fn();
const mockGetAccount = jest.fn();
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: () => mockNativeAssetId(),
  getVerificationBaseFee: () => mockVerificationBaseFee()
}));
// Keep fee admission and the WASM lock real while replacing only the remote account read.
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getAccount: (...args: unknown[]) => mockGetAccount(...args),
    tryGetAccount: async (...args: unknown[]) => ({ ran: true, account: await mockGetAccount(...args) })
  }
}));
jest.mock('../sdk/miden-client-interface', () => ({
  MidenClientInterface: { create: async () => ({ markPoisoned: jest.fn(), free: jest.fn() }) }
}));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));

const ACCOUNT = 'mtst1account';
const NOW = 2_000_000;
type SettlementNote = ConsumableNote & { swapOrder: SwapOrderNoteMetadata };
type InsertedConsume = Pick<ITransaction, 'id' | 'noteIds' | 'extraInputs' | 'consumeEntryPoint'>;

const order = (expired = false): SwapOrder => ({
  id: 'swap-order',
  type: 'swap',
  accountId: ACCOUNT,
  amount: 50n,
  faucetId: 'offered-faucet',
  status: ITransactionStatus.Completed,
  initiatedAt: NOW - 100,
  completedAt: NOW - 90,
  displayIcon: 'SWAP',
  delegateTransaction: true,
  extraInputs: {
    requestedFaucetId: 'requested-faucet',
    requestedAmount: 50n,
    orderId: '77',
    autoConsume: true,
    expiresAt: expired ? NOW - 1 : NOW + 100
  }
});

const note = (id: string, role: 'payback' | 'tip' = 'payback'): SettlementNote => ({
  id,
  faucetId: role === 'payback' ? 'requested-faucet' : 'offered-faucet',
  amount: '10000',
  carriesMoreAssets: false,
  senderAddress: 'mtst1sender',
  isBeingClaimed: false,
  type: NoteTypeEnum.Public,
  swapOrder: {
    orderId: '77',
    depth: role === 'payback' ? 1 : 2,
    role,
    lineageState: role === 'payback' ? 'filled' : 'active',
    expiresAt: role === 'payback' ? NOW + 100 : NOW - 1,
    autoConsume: true
  }
});

const consumes = async () => (await Repo.transactions.toArray()).filter(row => row.type === 'consume');
const reconcile = (notes: SettlementNote[], parent: SwapOrder, canSign?: () => boolean) =>
  reconcileSwapOrderNotes(ACCOUNT, notes, true, NOW, [parent], new Map(), canSign);

// Snapshot the actual insert arguments; a later modify must not repair what this observer saw.
async function observeInserts(operation: () => ReturnType<typeof reconcile>) {
  const inserted: InsertedConsume[] = [];
  const observe = (_key: unknown, row: ITransaction) => {
    if (row.type !== 'consume') return;
    inserted.push({
      id: row.id,
      noteIds: row.noteIds?.slice(),
      extraInputs: row.extraInputs ? { ...row.extraInputs } : undefined,
      consumeEntryPoint: row.consumeEntryPoint
    });
  };
  Repo.transactions.hook('creating', observe);
  try {
    return { result: await operation(), inserted };
  } finally {
    Repo.transactions.hook('creating').unsubscribe(observe);
  }
}

const linked = (notes: SettlementNote[], status: ITransactionStatus): ITransaction => {
  const row: ITransaction = new ConsumeTransaction(ACCOUNT, notes, true);
  row.status = status;
  row.extraInputs = { swapOrderTxId: 'swap-order', swapSettleKind: 'settle' };
  return row;
};

beforeEach(async () => {
  await Repo.transactions.clear();
  mockNativeAssetId.mockReset().mockResolvedValue('native-faucet');
  mockVerificationBaseFee.mockReset().mockResolvedValue(null);
  mockGetAccount.mockReset().mockResolvedValue(null);
});

it('links a payback to its parent and settle role at the first consume insert', async () => {
  const parent = order();
  await Repo.transactions.add(parent);

  const { result, inserted } = await observeInserts(() => reconcile([note('payback')], parent));

  expect(await consumes()).toHaveLength(1);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.extraInputs).toEqual({ swapOrderTxId: 'swap-order', swapSettleKind: 'settle' });
  expect(inserted[0]).toMatchObject({
    id: result.queuedTransactionIds[0],
    noteIds: ['payback'],
    consumeEntryPoint: 'swap_settlement',
    extraInputs: { swapOrderTxId: 'swap-order', swapSettleKind: 'settle' }
  });
  expect(await Repo.transactions.get(result.queuedTransactionIds[0]!)).toMatchObject({
    noteIds: ['payback'],
    delegateTransaction: true,
    extraInputs: { swapOrderTxId: 'swap-order', swapSettleKind: 'settle' }
  });
});

it('links an expired tip to its parent and reclaim role at the first consume insert', async () => {
  const parent = order(true);
  await Repo.transactions.add(parent);

  const { result, inserted } = await observeInserts(() => reconcile([note('tip', 'tip')], parent));

  expect(await consumes()).toHaveLength(1);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.extraInputs).toEqual({ swapOrderTxId: 'swap-order', swapSettleKind: 'reclaim' });
  expect(inserted[0]).toMatchObject({
    id: result.queuedTransactionIds[0],
    noteIds: ['tip'],
    consumeEntryPoint: 'swap_settlement',
    extraInputs: { swapOrderTxId: 'swap-order', swapSettleKind: 'reclaim' }
  });
  expect(await Repo.transactions.get(result.queuedTransactionIds[0]!)).toMatchObject({
    noteIds: ['tip'],
    delegateTransaction: true,
    extraInputs: { swapOrderTxId: 'swap-order', swapSettleKind: 'reclaim' }
  });
});

it('retains the covering child when only part of the requested note set is new', async () => {
  const parent = order();
  const covered = linked([note('covered')], ITransactionStatus.Queued);
  await Repo.transactions.bulkAdd([parent, covered]);

  await reconcile([note('covered'), note('fresh')], parent);

  const rows = await consumes();
  expect(rows).toHaveLength(2);
  expect(rows.flatMap(row => row.noteIds ?? []).sort()).toEqual(['covered', 'fresh']);
  expect(await Repo.transactions.get(covered.id)).toMatchObject(covered);
  expect(rows.find(row => row.noteId === 'fresh')).toMatchObject({
    status: ITransactionStatus.Queued,
    noteIds: ['fresh'],
    extraInputs: { swapOrderTxId: 'swap-order', swapSettleKind: 'settle' }
  });
});

it('does not compete with an unconfirmed shared claim whose submit evidence still holds its notes', async () => {
  const parent = order();
  const held = linked([note('held-a'), note('held-b')], ITransactionStatus.Unconfirmed);
  const hex = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
  // Evidence-less rows have a different policy; this undecided submission still holds its inputs.
  const evidence: ISubmitEvidence = {
    attemptId: 'held-attempt',
    capturedAt: Math.floor(Date.now() / 1000),
    source: 'stage',
    transactionId: hex(1),
    initialCommitment: hex(2),
    finalCommitment: hex(3),
    initialNonce: '1',
    outputNoteIds: [],
    nullifiers: [hex(4)],
    refBlock: 10,
    refBlockCommitment: hex(5)
  };
  held.submitEvidence = [evidence];
  await Repo.transactions.bulkAdd([parent, held]);

  await reconcile([note('held-a'), note('held-b')], parent);

  expect(await consumes()).toHaveLength(1);
  expect(await Repo.transactions.get(held.id)).toMatchObject(held);
  expect((await Repo.transactions.get(held.id))?.neverCommittedAt).toBeUndefined();
});

it('leaves a failed shared claim inside its lifetime cooldown without a fresh child', async () => {
  const parent = order();
  const cooling = linked([note('cool-a'), note('cool-b')], ITransactionStatus.Failed);
  cooling.completedAt = Math.floor(Date.now() / 1000);
  await Repo.transactions.bulkAdd([parent, cooling]);

  await reconcile([note('cool-a'), note('cool-b')], parent);

  expect(await consumes()).toHaveLength(1);
  expect(await Repo.transactions.get(cooling.id)).toMatchObject(cooling);
  expect((await Repo.transactions.get(parent.id))?.extraInputs?.settledAt).toBeUndefined();
});

it('admits no settlement child when known native fee funding is insufficient', async () => {
  const parent = order();
  await Repo.transactions.add(parent);
  mockVerificationBaseFee.mockResolvedValue(10000);
  mockGetAccount.mockResolvedValue({ vault: () => ({ fungibleAssets: () => [] }) });

  const result = await reconcile([note('unfunded')], parent);

  expect(result.queuedTransactionIds).toEqual([]);
  expect(await consumes()).toEqual([]);
  expect((await Repo.transactions.get(parent.id))?.extraInputs?.settledAt).toBeUndefined();
});

it('writes no settlement child when the vault locks during the awaited fee-context read', async () => {
  const parent = order();
  await Repo.transactions.add(parent);
  let entered!: () => void;
  let release!: (value: string) => void;
  const reading = new Promise<void>(resolve => {
    entered = resolve;
  });
  mockNativeAssetId.mockImplementation(() => {
    entered();
    return new Promise<string>(resolve => {
      release = resolve;
    });
  });
  let unlocked = true;
  const pending = reconcile([note('locking')], parent, () => unlocked);
  pending.catch(() => {});
  try {
    await reading;
    unlocked = false;
    release('native-faucet');

    await expect(pending).rejects.toBeInstanceOf(ClaimInsertRefusedError);
    expect(await consumes()).toEqual([]);
    expect(await Repo.transactions.get(parent.id)).toMatchObject(parent);
  } finally {
    release('native-faucet');
    await pending.catch(() => {});
  }
});
