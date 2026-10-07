/**
 * The rotation gate's claim entry (#805) over the shared consume queue, on real Dexie
 * (the global `fake-indexeddb` setup): the dedup and backoff it differs on live in index
 * reads inside a Dexie `rw` transaction, so a stubbed table would test nothing.
 */
import * as Repo from 'lib/miden/repo';

import { initiateConsumeNotesTransaction, initiateRotationFundingClaim } from './initiate';
import { ConsumeTransaction, ITransaction, ITransactionStatus } from '../db/types';
import { ConsumableNote } from '../types';

let mockNativeFaucetId: string | null = 'native-faucet';
let mockLegacyFeeIdentity: string | undefined;
let mockNativeIdentityError: Error | undefined;
jest.mock('lib/miden/assets/faucet-id-setting', () => ({
  getFaucetIdSetting: async () => mockLegacyFeeIdentity ?? (mockNativeIdentityError ? null : mockNativeFaucetId)
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: async () => {
    if (mockNativeIdentityError) throw mockNativeIdentityError;
    return mockNativeFaucetId;
  }
}));

jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: () => false,
  getOrCreateMultisigService: jest.fn()
}));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ isNoteTransportConfigured: () => false }));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));

const ACCOUNT = 'mtst1account';
const BASE_FEE = 10000;

const note = (id: string, faucetId = 'native-faucet'): ConsumableNote => ({
  id,
  faucetId,
  amount: '1000000',
  senderAddress: 'mtst1sender',
  isBeingClaimed: false,
  type: 'unknown'
});

const consumeRows = async (): Promise<ITransaction[]> =>
  (await Repo.transactions.toArray()).filter(tx => tx.type === 'consume');

/** A Failed row for these notes that finished `secondsAgo` ago. */
const failedRow = async (noteIds: string[], secondsAgo: number, flagged: boolean) => {
  const row = new ConsumeTransaction(
    ACCOUNT,
    noteIds.map(id => note(id)),
    false
  );
  row.status = ITransactionStatus.Failed;
  row.completedAt = Math.floor(Date.now() / 1000) - secondsAgo;
  if (flagged) row.rotationFunding = true;
  await Repo.transactions.add(row);
  return row;
};

beforeEach(async () => {
  mockNativeFaucetId = 'native-faucet';
  mockNativeIdentityError = undefined;
  await Repo.transactions.clear();
});

describe('initiateRotationFundingClaim', () => {
  it('fee identity: queues actual native rotation funding with a different legacy display override', async () => {
    mockLegacyFeeIdentity = 'legacy-B';
    const id = await initiateRotationFundingClaim(ACCOUNT, [note('actual-note')]);
    expect(await consumeRows()).toEqual([
      expect.objectContaining({ id, noteIds: ['actual-note'], rotationFunding: true })
    ]);
  });

  it('fee identity: refuses a legacy display note before entering the rotation queue', async () => {
    mockLegacyFeeIdentity = 'legacy-B';
    await expect(initiateRotationFundingClaim(ACCOUNT, [note('legacy-note', 'legacy-B')])).rejects.toThrow(
      'not the native asset'
    );
    expect(await consumeRows()).toEqual([]);
  });

  it('fee identity: ordinary discovery rejection retains the typed unknown-asset refusal before queueing', async () => {
    mockNativeIdentityError = new Error('discovery failed');
    await expect(initiateRotationFundingClaim(ACCOUNT, [note('a')])).rejects.toThrow('native asset is not known');
    expect(await consumeRows()).toEqual([]);
  });

  it('fee identity: a fatal native lookup escapes with its original error before queueing', async () => {
    const fatal = new WebAssembly.RuntimeError('native identity trap');
    mockNativeIdentityError = fatal;
    await expect(initiateRotationFundingClaim(ACCOUNT, [note('a')])).rejects.toBe(fatal);
    expect(await consumeRows()).toEqual([]);
  });

  it('stamps rotationFunding on the one batch row it creates', async () => {
    const id = await initiateRotationFundingClaim(ACCOUNT, [note('a'), note('b')], { verificationBaseFee: BASE_FEE });

    const rows = await consumeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.noteIds).toEqual(['a', 'b']);
    expect(rows[0]!.rotationFunding).toBe(true);
  });

  it('stamps every row when a failed flagged batch splits the notes into rows of their own', async () => {
    const failed = await failedRow(['a', 'b'], 60 * 60, true);

    await initiateRotationFundingClaim(ACCOUNT, [note('a'), note('b')], { verificationBaseFee: BASE_FEE });

    const queued = (await consumeRows()).filter(row => row.id !== failed.id);
    expect(queued).toHaveLength(2);
    expect(queued.every(row => row.rotationFunding === true)).toBe(true);
  });

  it('does not isolate a funding claim on an unflagged failed batch row', async () => {
    await failedRow(['a', 'b'], 60 * 60, false);

    const id = await initiateRotationFundingClaim(ACCOUNT, [note('a'), note('b')], { verificationBaseFee: BASE_FEE });

    const queued = (await consumeRows()).filter(row => row.status === ITransactionStatus.Queued);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(id);
    expect(queued[0]!.noteIds).toEqual(['a', 'b']);
  });

  it('queues one row when two wallet surfaces claim the same note at once', async () => {
    const [first, second] = await Promise.all([
      initiateRotationFundingClaim(ACCOUNT, [note('a')]),
      initiateRotationFundingClaim(ACCOUNT, [note('a')])
    ]);

    expect(first).toBe(second);
    expect(await consumeRows()).toHaveLength(1);
  });

  it('names its own entry, not the ordinary one, when called with no notes', async () => {
    await expect(initiateRotationFundingClaim(ACCOUNT, [])).rejects.toThrow(
      'initiateRotationFundingClaim requires at least one note'
    );
  });

  it('refuses a note that is not the native asset before writing anything', async () => {
    await expect(initiateRotationFundingClaim(ACCOUNT, [note('a'), note('b', 'other-faucet')])).rejects.toThrow(
      'note b is not the native asset'
    );
    expect(await consumeRows()).toEqual([]);
  });

  it('refuses everything while the native asset is unknown', async () => {
    mockNativeFaucetId = null;

    await expect(initiateRotationFundingClaim(ACCOUNT, [note('a')])).rejects.toThrow('native asset is not known');
    expect(await consumeRows()).toEqual([]);
  });

  it.each([
    ['an unflagged', false],
    ['a flagged', true]
  ])('dedups against %s live consume row for the note', async (_label, flagged) => {
    const live = new ConsumeTransaction(ACCOUNT, [note('a')], false);
    if (flagged) live.rotationFunding = true;
    await Repo.transactions.add(live);

    const id = await initiateRotationFundingClaim(ACCOUNT, [note('a')]);

    expect(id).toBe(live.id);
    expect(await consumeRows()).toHaveLength(1);
  });

  it('is not held back by an unflagged failure inside the cooldown', async () => {
    await failedRow(['a'], 10, false);

    await initiateRotationFundingClaim(ACCOUNT, [note('a')]);

    const queued = (await consumeRows()).filter(row => row.status === ITransactionStatus.Queued);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.rotationFunding).toBe(true);
  });

  it('waits out a flagged failure inside the cooldown', async () => {
    const failed = await failedRow(['a'], 10, true);

    const id = await initiateRotationFundingClaim(ACCOUNT, [note('a')]);

    expect(id).toBe(failed.id);
    expect((await consumeRows()).filter(row => row.status === ITransactionStatus.Queued)).toEqual([]);
  });

  it('claims again on a manual retry inside that cooldown', async () => {
    await failedRow(['a'], 10, true);

    await initiateRotationFundingClaim(ACCOUNT, [note('a')], { manualRetry: true });

    expect((await consumeRows()).filter(row => row.status === ITransactionStatus.Queued)).toHaveLength(1);
  });
});

describe('initiateConsumeNotesTransaction after the extraction', () => {
  it('still writes unflagged rows', async () => {
    await initiateConsumeNotesTransaction(ACCOUNT, [note('a'), note('b')], false, false, true, BASE_FEE);

    const rows = await consumeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rotationFunding).toBeUndefined();
  });

  it('still counts a flagged failure in its own backoff', async () => {
    const failed = await failedRow(['a'], 10, true);

    const id = await initiateConsumeNotesTransaction(ACCOUNT, [note('a')], false, false, true, BASE_FEE);

    expect(id).toBe(failed.id);
  });

  it('refuses an empty list, naming itself', async () => {
    await expect(initiateConsumeNotesTransaction(ACCOUNT, [])).rejects.toThrow(
      'initiateConsumeNotesTransaction requires at least one note'
    );
  });
});

beforeEach(() => {
  mockLegacyFeeIdentity = undefined;
});
