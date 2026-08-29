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
import * as Repo from 'lib/miden/repo';

import { ConsumeTransaction, ITransaction, ITransactionStatus } from '../db/types';
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
jest.mock('lib/miden-chain/effective-endpoints', () => ({ isNoteTransportConfigured: () => false }));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initiateConsumeNotesTransaction } = require('./initiate');

const ACCOUNT = 'mtst1account';

/** A claimable native note. `amount` is base units, as the chain reports it. */
const note = (id: string): ConsumableNote => ({
  id,
  faucetId: 'native-faucet',
  amount: '1000000',
  senderAddress: 'mtst1sender',
  isBeingClaimed: false,
  type: NoteTypeEnum.Public
});

const consumeRows = async (): Promise<ITransaction[]> =>
  (await Repo.transactions.toArray()).filter(tx => tx.type === 'consume');

beforeEach(async () => {
  await Repo.transactions.clear();
});

describe('initiateConsumeNotesTransaction — batching', () => {
  it('queues ONE row for many notes, so the backlog pays one fee', async () => {
    await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b'), note('c')], false, false, true);

    const rows = await consumeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.noteIds).toEqual(['a', 'b', 'c']);
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

  it('returns an id that names a row it actually created', async () => {
    // Callers treat the return as "the row covering this claim"; with the notes split
    // across several rows it must still resolve to one of them.
    await failedBatch(['a', 'b']);

    const id = await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b')], false, false, true);

    const queuedIds = (await consumeRows()).filter(tx => tx.status === ITransactionStatus.Queued).map(tx => tx.id);
    expect(queuedIds).toContain(id);
  });
});
