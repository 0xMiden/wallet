/**
 * Poison-note isolation for batched auto-consume.
 *
 * Auto-consume claims a backlog of native notes in ONE transaction, because every
 * consume pays its own fee. But a Miden transaction is atomic, so a single
 * un-consumable note fails the whole batch — and the #215 backoff gate counts that
 * one shared Failed row once for EVERY note id it carries. So one poison note dragged
 * its healthy batch-mates into the same doubling backoff, up to the 24h cap, which is
 * exactly the regression the earlier per-note-always design existed to avoid.
 *
 * The call sites' own `try/catch` around the initiate call cannot fix this: that call
 * is a queue WRITE, so it throws only on a DB error, while an un-consumable note fails
 * much later at generation time. Isolation therefore happens on the next enqueue, which
 * is what these tests pin.
 *
 * Real Dexie via the global `fake-indexeddb` setup — the behaviour lives in a Dexie `rw`
 * transaction and in index reads over `noteId` / `noteIds`, so stubbing the DB would
 * test nothing.
 */
import Dexie from 'dexie';

import * as Repo from 'lib/miden/repo';

import { ConsumeTransaction, ITransaction, ITransactionStatus } from '../db/types';
import * as SdkHelpers from '../sdk/helpers';
import * as WasmClient from '../sdk/miden-client';
import { ConsumableNote, NoteTypeEnum } from '../types';

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: () => false
}));

jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: () => false,
  getOrCreateMultisigService: jest.fn()
}));

jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getActiveOverride: () => null,
  isNoteTransportConfigured: () => false,
  getEffectiveNetworkName: () => 'testnet'
}));
const mockProxyGetAccount = jest.fn();
const mockNativeAssetId = jest.fn();
const mockVerificationBaseFee = jest.fn();
const mockMarkPoisoned = jest.fn();
const mockFreeClient = jest.fn();
// Writable exports let the spies wrap the real lock without depending on SWC's export descriptors.
jest.mock('../sdk/miden-client', () => ({
  __esModule: true,
  ...jest.requireActual('../sdk/miden-client')
}));
jest.mock('../sdk/helpers', () => ({ __esModule: true, ...jest.requireActual('../sdk/helpers') }));
jest.mock('../sdk/miden-client-interface', () => ({
  MidenClientInterface: {
    create: async () => ({ markPoisoned: mockMarkPoisoned, free: mockFreeClient })
  }
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: () => mockNativeAssetId(),
  getVerificationBaseFee: () => mockVerificationBaseFee()
}));
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getAccount: (...args: unknown[]) => mockProxyGetAccount(...args),
    tryGetAccount: async (...args: unknown[]) => ({ ran: true, account: await mockProxyGetAccount(...args) })
  }
}));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ClaimInsertRefusedError,
  initiateConsumeNotesTransaction,
  initiateConsumeTransaction,
  initiatePswapReclaimTransaction,
  MAX_RETRY_BACKOFF_SEC,
  noteClaimCoverage,
  queueConsumeNotes,
  RETRY_COOLDOWN_SEC
} = require('./initiate');

const ACCOUNT = 'mtst1account';

/** A claimable native note. `amount` is base units, as the chain reports it. */
const note = (id: string, amount = '1000000'): ConsumableNote => ({
  id,
  faucetId: 'native-faucet',
  amount,
  senderAddress: 'mtst1sender',
  isBeingClaimed: false,
  type: NoteTypeEnum.Public
});

const consumeRows = async (): Promise<ITransaction[]> =>
  (await Repo.transactions.toArray()).filter(tx => tx.type === 'consume');

beforeEach(async () => {
  await Repo.transactions.clear();
  mockProxyGetAccount.mockReset().mockResolvedValue(null);
  mockNativeAssetId.mockReset().mockResolvedValue('native-faucet');
  mockVerificationBaseFee.mockReset().mockResolvedValue(null);
  mockMarkPoisoned.mockClear();
  WasmClient.__resetRecoveryCooldownForTests();
});

describe('initiateConsumeNotesTransaction — batching', () => {
  it('queues ONE row for many notes, so the backlog pays one fee', async () => {
    await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b'), note('c')], false, false, true);

    const rows = await consumeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.noteIds).toEqual(['a', 'b', 'c']);
  });
});

describe('initiatePswapReclaimTransaction', () => {
  it('inserts the prepared request and settlement link atomically on the consume row', async () => {
    const requestBytes = new Uint8Array([7, 4, 7, 6]);

    const id = await initiatePswapReclaimTransaction(
      ACCOUNT,
      note('zero-fill-tip'),
      requestBytes,
      'swap-order-row',
      true
    );

    const row = await Repo.transactions.get(id);
    expect(row).toMatchObject({
      id,
      type: 'consume',
      noteId: 'zero-fill-tip',
      delegateTransaction: true,
      requestBytes,
      extraInputs: { swapOrderTxId: 'swap-order-row', swapSettleKind: 'reclaim' }
    });
  });
});

describe('noteClaimCoverage', () => {
  const NOW = 10_000_000;
  const claimRow = async (status: ITransactionStatus, completedAt?: number, accountId = ACCOUNT) => {
    const row = new ConsumeTransaction(accountId, [note('tip')], false);
    row.status = status;
    row.initiatedAt = (completedAt ?? NOW) - 1;
    row.completedAt = completedAt;
    await Repo.transactions.add(row);
    return row;
  };

  it.each([
    ['queued', ITransactionStatus.Queued, undefined],
    ['in flight', ITransactionStatus.GeneratingTransaction, undefined],
    ['completed', ITransactionStatus.Completed, NOW - MAX_RETRY_BACKOFF_SEC]
  ])('names a %s claim as the one that keeps a new claim out', async (_label, status, completedAt) => {
    const row = await claimRow(status, completedAt);

    await expect(noteClaimCoverage(ACCOUNT, 'tip', NOW)).resolves.toMatchObject({
      liveOrCompleted: { id: row.id },
      backingOff: undefined
    });
  });

  it('names a failed claim only while its backoff runs', async () => {
    const failed = await claimRow(ITransactionStatus.Failed, NOW - 1);

    await expect(noteClaimCoverage(ACCOUNT, 'tip', NOW)).resolves.toMatchObject({
      liveOrCompleted: undefined,
      backingOff: { id: failed.id }
    });
    await expect(noteClaimCoverage(ACCOUNT, 'tip', NOW - 1 + RETRY_COOLDOWN_SEC)).resolves.toMatchObject({
      backingOff: undefined
    });
  });

  it("ignores another account's claims and rows restored from a backup", async () => {
    await claimRow(ITransactionStatus.Queued, undefined, 'mtst1other');
    const restored = new ConsumeTransaction(ACCOUNT, [note('tip')], false);
    await Repo.transactions.add({ ...restored, restoredFromBackup: true });

    await expect(noteClaimCoverage(ACCOUNT, 'tip', NOW)).resolves.toEqual({
      rows: [],
      liveOrCompleted: undefined,
      backingOff: undefined
    });
  });
});

describe('initiateConsumeNotesTransaction — poison-note isolation', () => {
  /** A Failed BATCH row, aged past the #215 backoff so the notes are eligible again. */
  const failedBatch = async (noteIds: string[]) => {
    const row = new ConsumeTransaction(
      ACCOUNT,
      noteIds.map(id => note(id)),
      false
    );
    row.status = ITransactionStatus.Failed;
    // Far enough in the past to clear the first-failure cooldown.
    row.initiatedAt = 0;
    row.completedAt = 0;
    await Repo.transactions.add(row);
    return row;
  };

  it('gives every note its own row after a shared batch row failed', async () => {
    await failedBatch(['a', 'b', 'c']);

    await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b'), note('c')], false, false, true);

    const queued = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued);
    // Three single-note rows, not one batch of three: each note's next outcome is now
    // its own, so the poison note cannot fail the other two into its backoff again.
    expect(queued).toHaveLength(3);
    expect(queued.every(row => row.noteIds?.length === 1)).toBe(true);
    expect(queued.flatMap(row => row.noteIds ?? []).sort()).toEqual(['a', 'b', 'c']);
  });

  it('isolates ONLY the notes that lost a batch, leaving newcomers batched together', async () => {
    await failedBatch(['a', 'b']);

    // `c` and `d` are new arrivals with no history of their own.
    await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b'), note('c'), note('d')], false, false, true);

    const queued = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued);
    const single = queued.filter(row => row.noteIds?.length === 1);
    const batched = queued.filter(row => (row.noteIds?.length ?? 0) > 1);
    expect(single.flatMap(row => row.noteIds ?? []).sort()).toEqual(['a', 'b']);
    expect(batched).toHaveLength(1);
    // Notes with no failure of their own keep the one-fee batch.
    expect(batched[0]!.noteIds!.sort()).toEqual(['c', 'd']);
  });

  it('does NOT isolate a note whose only failure was its own single-note row', async () => {
    // A single-note row's failure IS evidence about that note, and it already retries
    // alone. Only a SHARED row's failure is ambiguous.
    const row = new ConsumeTransaction(ACCOUNT, [note('a')], false);
    row.status = ITransactionStatus.Failed;
    row.initiatedAt = 0;
    row.completedAt = 0;
    await Repo.transactions.add(row);

    await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b')], false, false, true);

    const queued = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.noteIds!.sort()).toEqual(['a', 'b']);
  });

  it('stays batched when the caller does not opt in', async () => {
    // The swap-settlement path links its returned row id to a swap order and manual
    // Claim All navigates to it, so neither can have one call fan out into many rows.
    await failedBatch(['a', 'b']);

    await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b')], false);

    const queued = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.noteIds).toEqual(['a', 'b']);
  });

  it('does not isolate when doing so would strand a remainder below the floor', async () => {
    // `rich` can fund a transaction alone, `poor` cannot. Isolating `rich` would leave
    // `poor` as a one-note "batch" -- i.e. claimed alone at a loss, the very thing
    // excluding it from isolation was meant to avoid. So neither is isolated: the pair
    // goes out as ONE batch for one fee, which is what the caller measured.
    const BASE_FEE = 10000;
    await failedBatch(['poor', 'rich']);

    await initiateConsumeNotesTransaction(
      ACCOUNT,
      [note('poor', String(BASE_FEE * 5)), note('rich', String(BASE_FEE * 500))],
      false,
      false,
      true,
      BASE_FEE
    );

    const queued = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.noteIds!.sort()).toEqual(['poor', 'rich']);
  });

  it('isolates the worthy notes when the remainder can still stand alone', async () => {
    // Both `a` and `b` can fund a transaction of their own, and so can the remainder
    // `c`+`d` (new arrivals, no failure history). Isolation is safe and happens.
    const BASE_FEE = 10000;
    const rich = String(BASE_FEE * 500);
    await failedBatch(['a', 'b']);

    await initiateConsumeNotesTransaction(
      ACCOUNT,
      [note('a', rich), note('b', rich), note('c', rich), note('d', rich)],
      false,
      false,
      true,
      BASE_FEE
    );

    const queued = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued);
    const single = queued.filter(row => row.noteIds?.length === 1);
    const batched = queued.filter(row => (row.noteIds?.length ?? 0) > 1);
    expect(single.flatMap(row => row.noteIds ?? []).sort()).toEqual(['a', 'b']);
    expect(batched).toHaveLength(1);
    expect(batched[0]!.noteIds!.sort()).toEqual(['c', 'd']);
  });

  it('never strands a below-floor note, however many batches it has lost', async () => {
    // The regression this rule exists to prevent. The failed-batch row that makes a note
    // an isolation candidate is NEVER pruned, so a rule that removed below-floor notes
    // from batches removed them from every future enqueue, for the wallet's lifetime.
    // Twenty notes at 20x the base fee are each below the 30x floor and together worth
    // 400x -- real money, claimable for one fee, and previously dropped forever.
    const BASE_FEE = 10000;
    const ids = Array.from({ length: 20 }, (_unused, index) => `n${index}`);
    await failedBatch(ids);

    await initiateConsumeNotesTransaction(
      ACCOUNT,
      ids.map(id => note(id, String(BASE_FEE * 20))),
      false,
      false,
      true,
      BASE_FEE
    );

    const queued = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.noteIds).toHaveLength(20);
  });

  it('isolates every candidate when no fee is supplied', async () => {
    // A manual retry passes no fee: the user asked, so nothing is second-guessed. Same
    // fail-open contract `isWorthClaiming` has on an unknown fee everywhere else.
    await failedBatch(['poor', 'rich']);

    await initiateConsumeNotesTransaction(ACCOUNT, [note('poor', '1'), note('rich', '5000000')], false, false, true);

    const queued = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued);
    expect(queued).toHaveLength(2);
    expect(queued.flatMap(row => row.noteIds ?? []).sort()).toEqual(['poor', 'rich']);
  });

  it('returns an id that names a row it actually created', async () => {
    // Callers treat the return as "the row covering this claim"; with the notes split
    // across several rows it must still resolve to one of them.
    await failedBatch(['a', 'b']);

    const id = await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b')], false, false, true);

    const queuedIds = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued).map(tx => tx.id);
    expect(queuedIds).toContain(id);
  });

  it('reports each isolated note under the row it was given', async () => {
    await failedBatch(['a', 'b']);

    const { coveringTxIdByNoteId } = await queueConsumeNotes(
      ACCOUNT,
      [note('a'), note('b'), note('c')],
      false,
      false,
      true
    );

    const rows = new Map((await consumeRows()).map(row => [row.id, row]));
    for (const id of ['a', 'b', 'c']) {
      expect(rows.get(coveringTxIdByNoteId.get(id)!)?.noteIds).toContain(id);
    }
  });
});

describe('queueConsumeNotes - the row covering each note', () => {
  it('names the row that kept a deduplicated note out, and the committed row for a queued one', async () => {
    // A caller following each note's outcome needs the row covering THAT note: in a partly deduplicated batch the
    // committed id is only the row the other notes joined.
    const live = new ConsumeTransaction(ACCOUNT, [note('a')], false);
    await Repo.transactions.add(live);

    const { committedId, coveringTxIdByNoteId } = await queueConsumeNotes(ACCOUNT, [note('a'), note('b')], false, true);

    expect(committedId).not.toBe(live.id);
    expect(coveringTxIdByNoteId.get('a')).toBe(live.id);
    expect(coveringTxIdByNoteId.get('b')).toBe(committedId);
  });

  it('names the Failed row that backed a note off', async () => {
    const failed = new ConsumeTransaction(ACCOUNT, [note('a')], false);
    failed.status = ITransactionStatus.Failed;
    failed.completedAt = Math.floor(Date.now() / 1000);
    await Repo.transactions.add(failed);

    const { committedId, coveringTxIdByNoteId } = await queueConsumeNotes(ACCOUNT, [note('a')], false, false);

    expect(coveringTxIdByNoteId.get('a')).toBe(failed.id);
    expect(committedId).toBe(failed.id);
  });
});

describe('a worker claim its caller can no longer sign', () => {
  type CanSign = () => boolean;

  it.each([
    [
      'initiateConsumeNotesTransaction',
      (canSign: CanSign) =>
        initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b')], false, false, true, null, undefined, canSign)
    ],
    [
      'initiateConsumeTransaction',
      (canSign: CanSign) => initiateConsumeTransaction(ACCOUNT, note('a'), false, undefined, undefined, canSign)
    ],
    [
      'initiatePswapReclaimTransaction',
      (canSign: CanSign) =>
        initiatePswapReclaimTransaction(ACCOUNT, note('a'), new Uint8Array([7]), 'swap-order-row', false, canSign)
    ]
  ])('%s writes no row when the lock lands during its reads, and writes it once unlocked', async (_name, enqueue) => {
    let unlocked = true;
    const pending = enqueue(() => unlocked);
    // The call is now awaiting its dedup and backoff reads, ahead of any row it writes.
    unlocked = false;

    await expect(pending).rejects.toBeInstanceOf(ClaimInsertRefusedError);
    expect(await consumeRows()).toEqual([]);

    unlocked = true;
    await enqueue(() => unlocked);
    expect(await consumeRows()).toHaveLength(1);
  });

  it.each([
    ['between two isolated rows', ['a', 'b', 'c'], ['a', 'b', 'c'], 1, 3],
    ["after the isolated rows, before the remainder's batch row", ['a', 'b'], ['a', 'b', 'c', 'd'], 2, 3]
  ])(
    'rolls back the rows it wrote when the lock lands %s',
    async (_when, failedTogether, claimed, rowsBeforeLock, rowsUnlocked) => {
      const failed = new ConsumeTransaction(
        ACCOUNT,
        failedTogether.map(id => note(id)),
        false
      );
      failed.status = ITransactionStatus.Failed;
      failed.initiatedAt = 0;
      failed.completedAt = 0;
      await Repo.transactions.add(failed);
      let checks = 0;
      const lockAfterRows: CanSign = () => checks++ < rowsBeforeLock;
      const enqueue = (canSign: CanSign) =>
        initiateConsumeNotesTransaction(
          ACCOUNT,
          claimed.map(id => note(id)),
          false,
          false,
          true,
          null,
          undefined,
          canSign
        );

      await expect(enqueue(lockAfterRows)).rejects.toBeInstanceOf(ClaimInsertRefusedError);
      expect((await consumeRows()).map(row => row.id)).toEqual([failed.id]);

      await enqueue(() => true);
      expect((await consumeRows()).filter(row => row.status === ITransactionStatus.Queued)).toHaveLength(rowsUnlocked);
    }
  );
});

describe('the consume writer fee gate', () => {
  const knownNative = (id: string, amount = '10000'): ConsumableNote => ({
    ...note(id, amount),
    carriesMoreAssets: false
  });
  const knownToken = (id = 'token'): ConsumableNote => ({ ...knownNative(id), faucetId: 'token-faucet' });
  const enqueue = (notes: ConsumableNote[], isolate = false, canSign = () => true) =>
    queueConsumeNotes(ACCOUNT, notes, false, true, isolate, 10000, undefined, canSign);
  const failedTogether = async (notes: ConsumableNote[]) => {
    const failed = new ConsumeTransaction(ACCOUNT, notes, false);
    failed.status = ITransactionStatus.Failed;
    failed.initiatedAt = 0;
    failed.completedAt = 0;
    await Repo.transactions.add(failed);
    return failed;
  };
  const queuedRows = async () => (await consumeRows()).filter(row => row.status === ITransactionStatus.Queued);
  const emptyAccount = () => ({ vault: jest.fn(() => ({ fungibleAssets: () => [] })) });
  const dispatchTrap = () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
  };

  const mockFeeContextReads = (assertOutsideTransaction: () => void) => {
    mockNativeAssetId.mockImplementation(async () => {
      assertOutsideTransaction();
      return 'native-faucet';
    });
    mockVerificationBaseFee.mockImplementation(async () => {
      assertOutsideTransaction();
      return 10000;
    });
    mockProxyGetAccount.mockImplementation(async () => {
      assertOutsideTransaction();
      return emptyAccount();
    });
  };

  it('writer refuses a known shortage and admits self funding and same-call funding', async () => {
    mockFeeContextReads(() => {
      expect(Dexie.currentTransaction).toBeNull();
    });
    await expect(enqueue([knownToken()])).rejects.toMatchObject({ name: 'ClaimFeeRefusedError' });
    expect(await consumeRows()).toEqual([]);

    const selfFunding = await enqueue([knownNative('native')]);
    expect(selfFunding).toMatchObject({ feeRefusedNoteIds: [] });
    expect(await Repo.transactions.get(selfFunding.committedId)).toMatchObject({
      feeAdmission: 'known_sufficient',
      consumedNotes: [expect.objectContaining({ id: 'native', carriesMoreAssets: false })]
    });

    await Repo.transactions.clear();
    const native = knownNative('isolated-native', '1000000');
    const token = { ...knownToken('remainder-token'), amount: '1000000' };
    await failedTogether([native, knownNative('old-batch-mate')]);
    const funded = await enqueue([native, token], true);
    const rows = await queuedRows();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.noteId === native.id)).toMatchObject({ feeAdmission: 'known_sufficient' });
    expect(rows.find(row => row.noteId === token.id)).toMatchObject({ feeAdmission: 'ahead_native' });
    expect(funded).toMatchObject({
      committedId: rows.find(row => row.noteId === native.id)?.id,
      feeRefusedNoteIds: []
    });
    expect(rows.map(row => row.consumedNotes)).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ id: native.id, carriesMoreAssets: false })],
        [expect.objectContaining({ id: token.id, carriesMoreAssets: false })]
      ])
    );
  });

  it('writer admits on a busy or reentrant vault lock', async () => {
    mockFeeContextReads(() => {
      expect(Dexie.currentTransaction).toBeNull();
    });
    const tryLock = jest.spyOn(WasmClient, 'tryWithWasmClientLock');
    try {
      tryLock.mockResolvedValueOnce({ ran: false });
      await enqueue([knownToken()]);
      expect(tryLock).toHaveBeenCalled();
      expect(mockProxyGetAccount).not.toHaveBeenCalled();
      expect(await queuedRows()).toEqual([expect.objectContaining({ feeAdmission: 'balance_unknown' })]);

      await Repo.transactions.clear();
      tryLock.mockClear();
      await WasmClient.withWasmClientLock(async () => {
        await enqueue([knownToken()]);
        expect(tryLock).toHaveBeenCalled();
        expect(mockProxyGetAccount).not.toHaveBeenCalled();
        expect(await queuedRows()).toEqual([expect.objectContaining({ feeAdmission: 'balance_unknown' })]);
        expect(WasmClient.isWasmClientBusy()).toBe(true);
      });
    } finally {
      tryLock.mockRestore();
    }
  });

  it('writer ignores an evicted vault read and retires a trap before continuing', async () => {
    mockFeeContextReads(() => {
      expect(Dexie.currentTransaction).toBeNull();
    });
    const staleAccount = emptyAccount();
    let returnAccount!: (account: ReturnType<typeof emptyAccount>) => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => {
      readStarted = resolve;
    });
    mockProxyGetAccount.mockImplementationOnce(() => {
      expect(Dexie.currentTransaction).toBeNull();
      readStarted();
      return new Promise<ReturnType<typeof emptyAccount>>(resolve => {
        returnAccount = resolve;
      });
    });
    const pending = enqueue([knownToken()]);
    // On the old writer the read never starts; the completed queue still reaches the assertion.
    await Promise.race([started, pending]);
    expect(mockProxyGetAccount).toHaveBeenCalled();
    dispatchTrap();
    returnAccount(staleAccount);
    await pending;
    expect(staleAccount.vault).not.toHaveBeenCalled();
    expect(await queuedRows()).toHaveLength(1);

    await Repo.transactions.clear();
    WasmClient.__resetRecoveryCooldownForTests();
    await WasmClient.getMidenClient();
    mockMarkPoisoned.mockClear();
    const trap = new WebAssembly.RuntimeError('unreachable');
    const trappedClientNextCall = jest.fn();
    let trapSeenByLock: unknown;
    const realTryLock = WasmClient.tryWithWasmClientLock;
    const observeTryLock: typeof realTryLock = (operation, options) =>
      realTryLock(async hold => {
        try {
          return await operation(hold);
        } catch (error) {
          trapSeenByLock = error;
          throw error;
        }
      }, options);
    const tryLock = jest.spyOn(WasmClient, 'tryWithWasmClientLock').mockImplementation(observeTryLock);
    mockProxyGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => [
          {
            faucetId: () => {
              throw trap;
            }
          },
          { faucetId: trappedClientNextCall }
        ]
      })
    });
    try {
      const result = await enqueue([knownToken()]);
      expect(trapSeenByLock).toBe(trap);
      expect(mockMarkPoisoned).toHaveBeenCalledTimes(1);
      expect(trappedClientNextCall).not.toHaveBeenCalled();
      expect(mockProxyGetAccount).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ feeRefusedNoteIds: [] });
      expect(await queuedRows()).toHaveLength(1);
    } finally {
      tryLock.mockRestore();
    }
  });

  it('writer distinguishes unknown ahead assets from known token-only assets', async () => {
    mockFeeContextReads(() => {
      expect(Dexie.currentTransaction).toBeNull();
    });
    const ahead = new ConsumeTransaction(ACCOUNT, [knownToken('ahead')], false);
    // Seed the record explicitly so this control also exercises pre-task persistence.
    const knownRecord = { id: 'ahead', senderAddress: 'sender', faucetId: 'token-faucet', amount: 10000n };
    const knownPersistedRecord = { ...knownRecord, carriesMoreAssets: false };
    await Repo.transactions.add({ ...ahead, consumedNotes: [knownPersistedRecord] });
    await expect(enqueue([knownToken()])).rejects.toMatchObject({ name: 'ClaimFeeRefusedError' });

    const unknownRecords = [undefined, [], [knownRecord]];
    for (const consumedNotes of unknownRecords) {
      await Repo.transactions.clear();
      await Repo.transactions.add({ ...ahead, consumedNotes });
      expect(await enqueue([knownToken()])).toMatchObject({ feeRefusedNoteIds: [] });
    }
    for (const consumedNotes of [
      [{ ...knownPersistedRecord, amount: undefined }],
      [{ ...knownPersistedRecord, faucetId: '' }]
    ]) {
      await Repo.transactions.clear();
      await Repo.transactions.add({ ...ahead, consumedNotes });
      expect(await enqueue([knownToken()])).toMatchObject({ feeRefusedNoteIds: [] });
    }
    await Repo.transactions.clear();
    await Repo.transactions.add({ ...ahead, noteIds: undefined, consumedNotes: [knownPersistedRecord] });
    await expect(enqueue([knownToken()])).rejects.toMatchObject({ name: 'ClaimFeeRefusedError' });
    for (const consumedNotes of [
      [{ ...knownRecord, faucetId: 'native-faucet', carriesMoreAssets: false }],
      [{ ...knownRecord, carriesMoreAssets: true }]
    ]) {
      await Repo.transactions.clear();
      await Repo.transactions.add({ ...ahead, consumedNotes });
      expect(await enqueue([knownToken()])).toMatchObject({ feeRefusedNoteIds: [] });
    }
    await Repo.transactions.clear();
    await Repo.transactions.add({
      ...ahead,
      noteIds: ['ahead', 'missing'],
      consumedNotes: [knownPersistedRecord]
    });
    expect(await enqueue([knownToken()])).toMatchObject({ feeRefusedNoteIds: [] });

    for (const status of [ITransactionStatus.Failed, ITransactionStatus.Unconfirmed, ITransactionStatus.Completed]) {
      await Repo.transactions.clear();
      await Repo.transactions.add({ ...ahead, status, consumedNotes: undefined });
      await expect(enqueue([knownToken()])).rejects.toMatchObject({ name: 'ClaimFeeRefusedError' });
    }
    await Repo.transactions.clear();
    await Repo.transactions.add({ ...ahead, accountId: 'mtst1other', consumedNotes: undefined });
    await expect(enqueue([knownToken()])).rejects.toMatchObject({ name: 'ClaimFeeRefusedError' });

    for (const status of [ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction]) {
      await Repo.transactions.clear();
      await Repo.transactions.add({
        ...ahead,
        accountId: `${ACCOUNT}_suffix`,
        status,
        restoredFromBackup: true,
        consumedNotes: undefined
      });
      expect(await enqueue([knownToken()])).toMatchObject({ feeRefusedNoteIds: [] });
    }
  });

  it('writer reports partial fee refusal without covering refused notes', async () => {
    mockFeeContextReads(() => {
      expect(Dexie.currentTransaction).toBeNull();
    });
    const token = { ...knownToken(), amount: '1000000' };
    const native = knownNative('native', '1000000');
    await failedTogether([token, knownToken('old-batch-mate')]);
    const partial = await enqueue([token, native], true);
    const [nativeRow] = await queuedRows();
    expect(nativeRow).toBeDefined();
    expect(partial).toMatchObject({ committedId: nativeRow?.id, feeRefusedNoteIds: ['token'] });
    expect(partial.coveringTxIdByNoteId.has('token')).toBe(false);
    expect(partial.coveringTxIdByNoteId.get('native')).toBe(nativeRow?.id);
    expect(await Repo.transactions.get(nativeRow!.id)).toMatchObject({
      consumedNotes: [expect.objectContaining({ id: 'native', carriesMoreAssets: false })]
    });

    await Repo.transactions.clear();
    const existing = new ConsumeTransaction(ACCOUNT, [knownToken('covered')], false);
    existing.status = ITransactionStatus.Completed;
    await Repo.transactions.add(existing);
    const dedupAndRefusal = await enqueue([knownToken('covered'), knownToken()]);
    expect(dedupAndRefusal).toMatchObject({ committedId: existing.id, feeRefusedNoteIds: ['token'] });
    expect(dedupAndRefusal.coveringTxIdByNoteId.has('token')).toBe(false);
    expect(dedupAndRefusal.coveringTxIdByNoteId.get('covered')).toBe(existing.id);
    expect(await consumeRows()).toHaveLength(1);
    expect(await enqueue([knownToken('covered')])).toMatchObject({ committedId: existing.id, feeRefusedNoteIds: [] });
  });

  it('writer fee refusal preserves dedup and signing rollback', async () => {
    mockFeeContextReads(() => {
      expect(Dexie.currentTransaction).toBeNull();
    });
    await expect(enqueue([knownToken()])).rejects.toMatchObject({ name: 'ClaimFeeRefusedError' });
    expect(await consumeRows()).toEqual([]);
    mockVerificationBaseFee.mockResolvedValueOnce(null);
    expect(await enqueue([knownToken('unknown-fee')])).toMatchObject({ feeRefusedNoteIds: [] });
    await Repo.transactions.clear();
    mockNativeAssetId.mockRejectedValueOnce(new Error('discovery failed'));
    expect(await enqueue([knownToken('unknown-native')])).toMatchObject({ feeRefusedNoteIds: [] });
    await Repo.transactions.clear();
    mockProxyGetAccount.mockResolvedValueOnce(null);
    expect(await enqueue([knownToken('missing-account')])).toMatchObject({ feeRefusedNoteIds: [] });
    await Repo.transactions.clear();
    mockProxyGetAccount.mockRejectedValueOnce(new Error('read failed'));
    expect(await enqueue([knownToken('failed-read')])).toMatchObject({ feeRefusedNoteIds: [] });

    await Repo.transactions.clear();
    expect(await enqueue([{ ...knownToken('unknown-assets'), carriesMoreAssets: undefined }])).toMatchObject({
      feeRefusedNoteIds: []
    });
    await Repo.transactions.clear();
    const canonicalFaucet = jest.spyOn(SdkHelpers, 'getBech32AddressFromAccountId');
    try {
      const mockVaultAmounts = (lastAmount: bigint) => {
        canonicalFaucet
          .mockReturnValueOnce('native-faucet')
          .mockReturnValueOnce('token-faucet')
          .mockReturnValueOnce('native-faucet');
        mockProxyGetAccount.mockResolvedValueOnce({
          vault: () => ({
            fungibleAssets: () => [
              { faucetId: () => 'native-id', amount: () => 6000n },
              { faucetId: () => 'foreign-id', amount: () => 1000000n },
              { faucetId: () => 'native-id', amount: () => lastAmount }
            ]
          })
        });
      };
      mockVaultAmounts(3999n);
      await expect(enqueue([knownToken()])).rejects.toMatchObject({ name: 'ClaimFeeRefusedError' });
      expect(await consumeRows()).toEqual([]);
      mockVaultAmounts(4000n);
      expect(await enqueue([knownToken()])).toMatchObject({ feeRefusedNoteIds: [] });
      expect(canonicalFaucet).toHaveBeenCalledTimes(6);
    } finally {
      canonicalFaucet.mockRestore();
    }

    await Repo.transactions.clear();
    const native = knownNative('native', '1000000');
    const remainder = { ...knownToken(), amount: '1000000' };
    const failed = await failedTogether([native, knownNative('old-batch-mate')]);
    let checks = 0;
    await expect(enqueue([native, remainder], true, () => checks++ === 0)).rejects.toMatchObject({
      name: 'ClaimInsertRefusedError'
    });
    expect(await queuedRows()).toEqual([]);
    expect((await consumeRows()).map(row => row.id)).toEqual([failed.id]);

    await Repo.transactions.clear();
    const requestBytes = new Uint8Array([7, 4, 7, 6]);
    const id = await initiatePswapReclaimTransaction(ACCOUNT, knownNative('reclaim'), requestBytes, 'swap-row', true);
    expect(await Repo.transactions.get(id)).toMatchObject({
      requestBytes,
      extraInputs: { swapOrderTxId: 'swap-row', swapSettleKind: 'reclaim' },
      consumedNotes: [expect.objectContaining({ carriesMoreAssets: false })]
    });
  });
});
