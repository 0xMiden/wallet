// Real Dexie: the dedup lives in a rw transaction over the noteId/noteIds indexes.
import * as Repo from 'lib/miden/repo';

import { ConsumeTransaction, ISubmitEvidence, ITransactionStatus } from '../db/types';
import { ConsumableNote, NoteTypeEnum } from '../types';

jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isExtension: () => false }));
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
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const note = (id: string): ConsumableNote => ({
  id,
  faucetId: 'native-faucet',
  amount: '1000000',
  senderAddress: 'mtst1sender',
  isBeingClaimed: false,
  type: NoteTypeEnum.Public
});
const checkable: ISubmitEvidence = {
  attemptId: 'a1',
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

const existingClaim = async (
  status: ITransactionStatus,
  submitEvidence: ISubmitEvidence[],
  extra: { neverCommittedAt?: number } = {}
) => {
  const row = new ConsumeTransaction(ACCOUNT, [note('n1')], false);
  await Repo.transactions.put({ ...row, status, submitEvidence, completedAt: 1, ...extra });
  return row.id;
};

beforeEach(async () => {
  await Repo.transactions.clear();
});

describe('the consume dedup and held notes (#1081)', () => {
  it.each([ITransactionStatus.Unconfirmed, ITransactionStatus.Failed])(
    'a claim in status %s that holds its notes blocks a second claim of them',
    async status => {
      const held = await existingClaim(status, [checkable]);
      const id = await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true);
      expect(id).toBe(held);
      expect(await Repo.transactions.count()).toBe(1);
    }
  );

  it.each<[string, ISubmitEvidence[], { neverCommittedAt?: number }]>([
    ['whose only entry is evidence-less', [{ attemptId: 'x', capturedAt: 1, source: 'end' }], {}],
    ['whose only entry is unresolvable', [{ ...checkable, verdict: 'unresolvable' }], {}],
    ['proven never committed', [{ ...checkable, verdict: 'never-committed' }], { neverCommittedAt: 5 }]
  ])('an Unconfirmed claim %s holds nothing, so a fresh claim is admitted', async (_label, entries, extra) => {
    await existingClaim(ITransactionStatus.Unconfirmed, entries, extra);
    await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true);
    expect(await Repo.transactions.count()).toBe(2);
  });
});
