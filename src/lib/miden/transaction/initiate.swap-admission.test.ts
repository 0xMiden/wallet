import * as Repo from 'lib/miden/repo';

import {
  ConsumeTransaction,
  type ISubmitEvidence,
  type ITransaction,
  ITransactionStatus,
  isLiveTransaction,
  SendTransaction
} from '../db/types';
import { __resetSyncFuseStateForTests } from '../front/sync-fuse';
import { canonicalWalletAccountId } from '../sdk/helpers';
import { type SwapOrder } from '../swap/classification';
import { reconcileSwapOrderNotes } from '../swap/settlement';
import { type ConsumableNote, NoteTypeEnum, type SwapOrderNoteMetadata } from '../types';
import { readClaimFeeContext } from './claim-fee';
import { getUncompletedTransactions } from './get';
import { noteClaimCoverage } from './initiate';
import { holdsNotes, isCheckable } from './verdict-rules';

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

// The shared SDK mock has no Address.fromAccountId. Adapt only this external conversion;
// a nonempty vault must reach the real fee gate as known, rather than failing open.
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const sdk = jest.requireActual<typeof import('@miden-sdk/miden-sdk/lazy')>('@miden-sdk/miden-sdk/lazy');
  return {
    ...sdk,
    Address: {
      ...sdk.Address,
      fromAccountId: (accountId: { toString(): string }) => ({ toBech32: () => accountId.toString() })
    }
  };
});

interface FeeAccount {
  vault(): {
    fungibleAssets(): Array<{ faucetId(): { toString(): string }; amount(): bigint }>;
  };
}

const mockNativeAssetId = jest.fn<Promise<string>, []>();
const mockVerificationBaseFee = jest.fn<Promise<number>, []>();
const mockGetAccount = jest.fn<Promise<FeeAccount>, [string]>();
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: () => mockNativeAssetId(),
  getVerificationBaseFee: () => mockVerificationBaseFee()
}));
// Account transport is external; the fee decision, real WASM lock and Dexie queue stay intact.
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getAccount: (accountId: string) => mockGetAccount(accountId),
    tryGetAccount: async (accountId: string) => ({ ran: true, account: await mockGetAccount(accountId) })
  }
}));
jest.mock('../sdk/miden-client-interface', () => ({
  MidenClientInterface: { create: async () => ({ markPoisoned: jest.fn(), free: jest.fn() }) }
}));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));

const ACCOUNT = 'mtst1accounta';
const OTHER_ACCOUNT = 'mtst1accountb';
const NOW = 2_000_000;
const NATIVE = 'native-faucet';
type SettlementNote = ConsumableNote & { swapOrder: SwapOrderNoteMetadata };
type InsertedConsume = Pick<
  ITransaction,
  'id' | 'accountId' | 'noteIds' | 'extraInputs' | 'consumeEntryPoint' | 'feeAdmission'
>;
type LiveUnitCase = [string, ITransactionStatus];

const order = (
  id = 'swap-A',
  orderId = '77',
  accountId = ACCOUNT,
  requestedFaucetId = 'requested-faucet'
): SwapOrder => ({
  id,
  type: 'swap',
  accountId,
  amount: 50n,
  faucetId: 'offered-faucet',
  status: ITransactionStatus.Completed,
  initiatedAt: NOW - 100,
  completedAt: NOW - 90,
  displayIcon: 'SWAP',
  delegateTransaction: true,
  extraInputs: {
    requestedFaucetId,
    requestedAmount: 50n,
    orderId,
    autoConsume: true,
    expiresAt: NOW + 100
  }
});

const note = (id: string, orderId = '77', faucetId = 'requested-faucet'): SettlementNote => ({
  id,
  faucetId,
  amount: '10000',
  carriesMoreAssets: false,
  senderAddress: 'mtst1sender',
  isBeingClaimed: false,
  type: NoteTypeEnum.Public,
  swapOrder: {
    orderId,
    depth: 1,
    role: 'payback',
    lineageState: 'filled',
    expiresAt: NOW + 100,
    autoConsume: true
  }
});

const backlog = () => Array.from({ length: 9 }, (_, index) => note(`payback-0${index}`));
const linked = (notes: SettlementNote[], parent: SwapOrder, status: ITransactionStatus): ITransaction => {
  const row: ITransaction = new ConsumeTransaction(parent.accountId, notes, true);
  row.status = status;
  row.consumeEntryPoint = 'swap_settlement';
  row.extraInputs = { swapOrderTxId: parent.id, swapSettleKind: 'settle' };
  return row;
};
const failedShared = (notes: SettlementNote[], parent: SwapOrder, completedAt = NOW - 86_401): ITransaction => ({
  ...linked(notes, parent, ITransactionStatus.Failed),
  initiatedAt: completedAt - 100,
  completedAt
});
const evidence = (verdict?: ISubmitEvidence['verdict']): ISubmitEvidence => {
  const hex = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
  return {
    attemptId: 'admission-attempt',
    capturedAt: NOW - 10,
    source: 'stage',
    transactionId: hex(1),
    initialCommitment: hex(2),
    finalCommitment: hex(3),
    initialNonce: '1',
    outputNoteIds: [],
    nullifiers: [hex(4)],
    refBlock: 10,
    refBlockCommitment: hex(5),
    ...(verdict === undefined ? {} : { verdict })
  };
};
const vault = (balance: bigint): FeeAccount => ({
  vault: () => ({
    fungibleAssets: () => [{ faucetId: () => ({ toString: () => NATIVE }), amount: () => balance }]
  })
});
const reconcile = (notes: SettlementNote[], parents: SwapOrder[], accountId = ACCOUNT) =>
  reconcileSwapOrderNotes(accountId, notes, true, NOW, parents, new Map(), () => true);

// Detached creating-hook values prevent a later row modification from repairing the observation.
async function observeInserts<T>(operation: () => Promise<T>) {
  const inserted: InsertedConsume[] = [];
  const observe = (_key: unknown, row: ITransaction) => {
    if (row.type !== 'consume') return;
    inserted.push({
      id: row.id,
      accountId: row.accountId,
      noteIds: row.noteIds?.slice(),
      extraInputs: row.extraInputs ? { ...row.extraInputs } : undefined,
      consumeEntryPoint: row.consumeEntryPoint,
      feeAdmission: row.feeAdmission
    });
  };
  Repo.transactions.hook('creating', observe);
  try {
    return { result: await operation(), inserted };
  } finally {
    Repo.transactions.hook('creating').unsubscribe(observe);
  }
}

beforeEach(async () => {
  // Pin only the wall clock: fake timers can stop real Dexie progress.
  jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  await Repo.transactions.clear();
  __resetSyncFuseStateForTests();
  mockNativeAssetId.mockReset().mockResolvedValue(NATIVE);
  mockVerificationBaseFee.mockReset().mockResolvedValue(10000);
  mockGetAccount.mockReset().mockResolvedValue(vault(1_000_000n));
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('admits one single-note recovery unit from a failed shared settlement', async () => {
  const parent = order();
  const notes = backlog();
  const failed = failedShared(notes, parent);
  await Repo.transactions.bulkAdd([parent, failed]);
  const coverage = await noteClaimCoverage(ACCOUNT, 'payback-00', NOW);
  expect(coverage.rows).toHaveLength(1);
  expect(coverage.backingOff).toBeUndefined();
  expect(holdsNotes(failed, NOW)).toBe(false);

  const { inserted } = await observeInserts(() => reconcile(notes, [parent]));

  expect(inserted.length).toBeGreaterThan(0);
  expect(inserted.every(row => row.feeAdmission === 'known_sufficient')).toBe(true);
  expect(inserted.map(row => row.noteIds)).toEqual([['payback-00']]);
  expect(inserted[0]).toMatchObject({
    accountId: ACCOUNT,
    consumeEntryPoint: 'swap_settlement',
    extraInputs: { swapOrderTxId: 'swap-A', swapSettleKind: 'settle' }
  });
  expect(await Repo.transactions.get(failed.id)).toEqual(failed);
  expect((await Repo.transactions.get(parent.id))?.extraInputs?.settledAt).toBeUndefined();
});

it.each<LiveUnitCase>([
  ['queued', ITransactionStatus.Queued],
  ['generating', ITransactionStatus.GeneratingTransaction],
  ['holding-unconfirmed', ITransactionStatus.Unconfirmed]
])('admits no second settlement unit while the account has a %s unit', async (_label, status) => {
  const parent = order();
  const other = order('swap-B', '88');
  const aNotes = [note('payback-00'), note('payback-01'), note('payback-02')];
  const bNotes = [note('payback-03', '88'), note('payback-04', '88')];
  await Repo.transactions.bulkAdd([parent, other, failedShared(aNotes, parent), failedShared(bNotes, other)]);
  const seeded = await reconcile([aNotes[0]!], [parent]);
  const unit = await Repo.transactions.get(seeded.queuedTransactionIds[0]!);
  expect(unit?.feeAdmission).toBe('known_sufficient');
  if (!unit) throw new Error('Missing seeded settlement unit');
  unit.status = status;
  unit.submitEvidence = status === ITransactionStatus.Unconfirmed ? [evidence()] : undefined;
  await Repo.transactions.put(unit);
  expect(isLiveTransaction(unit) || holdsNotes(unit, NOW)).toBe(true);
  expect(holdsNotes(unit, NOW)).toBe(status === ITransactionStatus.Unconfirmed);
  expect(await readClaimFeeContext(ACCOUNT)).toEqual({
    nativeAssetId: NATIVE,
    verificationBaseFee: 10000,
    vaultFeeAsset: 1_000_000n
  });

  const { inserted } = await observeInserts(() => reconcile([...aNotes.slice(1), ...bNotes], [parent, other]));

  expect(inserted).toEqual([]);
  expect(await Repo.transactions.get(unit.id)).toEqual(unit);
  expect((await Repo.transactions.get(parent.id))?.extraInputs?.settledAt).toBeUndefined();
  expect((await Repo.transactions.get(other.id))?.extraInputs?.settledAt).toBeUndefined();
});

it('serializes different-order admissions from concurrent callers of one account', async () => {
  const parent = order();
  const other = order('swap-B', '88');
  const aNotes = [note('payback-00'), note('payback-01')];
  const bNotes = [note('payback-02', '88'), note('payback-03', '88')];
  await Repo.transactions.bulkAdd([parent, other, failedShared(aNotes, parent), failedShared(bNotes, other)]);
  expect((await noteClaimCoverage(ACCOUNT, 'payback-00', NOW)).backingOff).toBeUndefined();
  expect((await noteClaimCoverage(ACCOUNT, 'payback-02', NOW)).backingOff).toBeUndefined();
  expect(await readClaimFeeContext(ACCOUNT)).toEqual({
    nativeAssetId: NATIVE,
    verificationBaseFee: 10000,
    vaultFeeAsset: 1_000_000n
  });

  const { inserted } = await observeInserts(() =>
    Promise.all([reconcile(aNotes, [parent]), reconcile(bNotes, [other])])
  );

  // A contended real try-lock may admit balance_unknown first; either caller may win a correct cap.
  console.info('swap-admission A3 fee admissions', JSON.stringify(inserted.map(row => row.feeAdmission)));
  expect(inserted).toHaveLength(1);
  const winner = inserted[0];
  expect([
    { noteIds: ['payback-00'], extraInputs: { swapOrderTxId: 'swap-A', swapSettleKind: 'settle' } },
    { noteIds: ['payback-01'], extraInputs: { swapOrderTxId: 'swap-A', swapSettleKind: 'settle' } },
    { noteIds: ['payback-02'], extraInputs: { swapOrderTxId: 'swap-B', swapSettleKind: 'settle' } },
    { noteIds: ['payback-03'], extraInputs: { swapOrderTxId: 'swap-B', swapSettleKind: 'settle' } }
  ]).toContainEqual({ noteIds: winner?.noteIds, extraInputs: winner?.extraInputs });
  expect(winner).toMatchObject({ accountId: ACCOUNT, consumeEntryPoint: 'swap_settlement' });
});

it('places the fresh recovery successor after an already queued user send', async () => {
  const parent = order();
  const notes = backlog();
  await Repo.transactions.bulkAdd([parent, failedShared(notes, parent)]);
  const firstPass = await observeInserts(() => reconcile(notes, [parent]));
  const first = firstPass.inserted[0];
  expect(first?.feeAdmission).toBe('known_sufficient');
  if (!first) throw new Error('Missing first recovery consume');
  const send = new SendTransaction(ACCOUNT, 1n, 'recipient', 'offered-faucet', NoteTypeEnum.Public);
  await Repo.transactions.add(send);
  // Database disposition only: this does not exercise production completion, stamps or chain commitment.
  await Repo.transactions.update(first.id, { status: ITransactionStatus.Completed, completedAt: NOW });
  const remaining = notes.filter(candidate => !first.noteIds?.includes(candidate.id));
  expect(remaining.length).toBeGreaterThan(0);
  await reconcile(remaining, [parent]);
  const queued = await getUncompletedTransactions(ACCOUNT);
  expect(queued).toHaveLength(2);
  expect(queued.every(row => row.initiatedAt === NOW && row.queuedSeq !== undefined)).toBe(true);

  expect(queued[0]?.id).toBe(send.id);
  expect(queued.map(row => row.type)).toEqual(['send', 'consume']);
  expect(queued[1]).toMatchObject({
    noteIds: ['payback-01'],
    feeAdmission: 'known_sufficient',
    extraInputs: { swapOrderTxId: 'swap-A', swapSettleKind: 'settle' }
  });
  expect(queued[1]!.queuedSeq!).toBeGreaterThan(send.queuedSeq!);
});

it('does not spend the admission budget on a fee-refused candidate', async () => {
  const parent = order();
  const other = order('swap-B', '88', ACCOUNT, NATIVE);
  const refused = note('payback-00');
  const fundable = note('payback-01', '88', NATIVE);
  mockGetAccount.mockResolvedValue({ vault: () => ({ fungibleAssets: () => [] }) });
  await Repo.transactions.bulkAdd([parent, other]);
  expect(await readClaimFeeContext(ACCOUNT)).toEqual({
    nativeAssetId: NATIVE,
    verificationBaseFee: 10000,
    vaultFeeAsset: 0n
  });
  expect(other.extraInputs.requestedFaucetId).toBe(fundable.faucetId);
  expect(fundable.carriesMoreAssets).toBe(false);

  const { result, inserted } = await observeInserts(() => reconcile([refused, fundable], [parent, other]));

  expect(inserted[0]?.feeAdmission).toBe('known_sufficient');
  expect(inserted.map(row => row.noteIds)).toEqual([['payback-01']]);
  expect(inserted[0]?.extraInputs).toEqual({ swapOrderTxId: 'swap-B', swapSettleKind: 'settle' });
  expect([...result.managedNoteIds].sort()).toEqual(['payback-00', 'payback-01']);
  expect((await Repo.transactions.where('noteIds').equals('payback-00').toArray()).length).toBe(0);
  expect((await Repo.transactions.get(parent.id))?.extraInputs?.settledAt).toBeUndefined();
  expect((await Repo.transactions.get(other.id))?.extraInputs?.settledAt).toBeUndefined();
});

it('does not spend the admission budget on a cooling-down note', async () => {
  const parent = order();
  const cooling = note('payback-00');
  const failed = failedShared([cooling, note('payback-01')], parent, NOW - 1);
  await Repo.transactions.bulkAdd([parent, failed]);
  expect((await noteClaimCoverage(ACCOUNT, cooling.id, NOW)).backingOff?.id).toBe(failed.id);
  expect(holdsNotes(failed, NOW)).toBe(false);

  const { inserted } = await observeInserts(() => reconcile([cooling, note('payback-02')], [parent]));

  expect(inserted[0]?.feeAdmission).toBe('known_sufficient');
  expect(inserted.map(row => row.noteIds)).toEqual([['payback-02']]);
  expect(inserted[0]?.extraInputs).toEqual({ swapOrderTxId: 'swap-A', swapSettleKind: 'settle' });
  expect(await Repo.transactions.get(failed.id)).toEqual(failed);
});

it('does not use another account settlement unit as this account budget', async () => {
  const parent = order();
  const other = order('swap-B', '88', OTHER_ACCOUNT);
  await Repo.transactions.bulkAdd([parent, other]);
  const seeded = await reconcile([note('payback-00')], [parent]);
  const unit = await Repo.transactions.get(seeded.queuedTransactionIds[0]!);
  expect(unit?.feeAdmission).toBe('known_sufficient');
  expect(canonicalWalletAccountId(ACCOUNT)).not.toBe(canonicalWalletAccountId(OTHER_ACCOUNT));
  expect(unit?.status).toBe(ITransactionStatus.Queued);

  const { inserted } = await observeInserts(() => reconcile([note('payback-01', '88')], [other], OTHER_ACCOUNT));

  expect(inserted[0]?.feeAdmission).toBe('known_sufficient');
  expect(
    inserted.map(row => ({ accountId: row.accountId, noteIds: row.noteIds, extraInputs: row.extraInputs }))
  ).toEqual([
    {
      accountId: OTHER_ACCOUNT,
      noteIds: ['payback-01'],
      extraInputs: { swapOrderTxId: 'swap-B', swapSettleKind: 'settle' }
    }
  ]);
  expect(await Repo.transactions.get(unit!.id)).toEqual(unit);
});

it('preserves fresh admission when canonical unconfirmed evidence holds nothing', async () => {
  const parent = order();
  const fresh = note('payback-00');
  const old = linked([fresh], parent, ITransactionStatus.Unconfirmed);
  const unresolvable = evidence('unresolvable');
  old.submitEvidence = [unresolvable];
  await Repo.transactions.bulkAdd([parent, old]);
  // Status alone is insufficient: a canonical unresolvable entry is not a note hold.
  expect(isCheckable(unresolvable, NOW)).toBe(false);
  expect(holdsNotes(old, NOW)).toBe(false);
  expect((await noteClaimCoverage(ACCOUNT, fresh.id, NOW)).liveOrCompleted).toBeUndefined();

  const { inserted } = await observeInserts(() => reconcile([fresh], [parent]));

  expect(inserted[0]?.feeAdmission).toBe('known_sufficient');
  expect(inserted.map(row => row.noteIds)).toEqual([['payback-00']]);
  expect(inserted[0]?.extraInputs).toEqual({ swapOrderTxId: 'swap-A', swapSettleKind: 'settle' });
  expect(await Repo.transactions.get(old.id)).toEqual(old);
  expect((await Repo.transactions.get(old.id))?.submitEvidence).toEqual([unresolvable]);
});
