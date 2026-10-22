import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import type { GcClaimContext } from './gc-claim-operation';
import { queueGcReclaim } from './gc-claim-service';

const mockWake = jest.fn(async () => undefined);
jest.mock('lib/miden/back/transaction-processor', () => ({ startTransactionProcessing: () => mockWake() }));
jest.mock('lib/miden/sdk/helpers', () => ({ canonicalWalletAccountId: (value: string) => value }));
jest.mock('lib/miden/note-quarantine', () => ({ releaseNoteIds: jest.fn(async () => undefined) }));
const word = (value: string) => `0x${value.repeat(64)}`;
const context: GcClaimContext = {
  network: 'testnet',
  genesisCommitment: word('1'),
  issuerId: 'issuer',
  accountId: 'account',
  issuerCodeCommitment: word('2'),
  nativeAssetId: 'native'
};
const original: ITransaction = {
  id: 'original',
  type: 'execute',
  accountId: 'account',
  status: ITransactionStatus.Completed,
  initiatedAt: 1,
  displayIcon: 'DEFAULT',
  gcClaim: {
    version: 1,
    scope: { ...context, approvedWeek: 1 },
    issuerCodeCommitment: word('2'),
    nativeAssetId: 'native',
    requestNoteId: word('3'),
    receiptRecipientCommitment: word('4'),
    nativeBudget: 30n,
    outgoingNativeAmount: 35n,
    approvalExpiresAt: 100,
    reclaimHeight: 20
  }
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(100_000);
});
afterEach(() => jest.restoreAllMocks());
it('atomically deduplicates concurrent recovery approvals and holds the exact request note', async () => {
  await Promise.all(Array.from({ length: 8 }, () => queueGcReclaim(context, original, new Uint8Array([7]), 2n, 200)));
  expect(await Repo.transactions.count()).toBe(1);
  expect(mockWake).toHaveBeenCalled();
  expect(await Repo.transactions.get('gc-reclaim:original')).toMatchObject({
    type: 'execute',
    gcReclaimOf: 'original',
    requestBytes: new Uint8Array([7]),
    inputNoteIds: [word('3')],
    heldNoteIds: [word('3')],
    noteIds: [word('3')],
    spentAssetTotals: [{ faucetId: 'native', amount: 2n }]
  });
});
it('rejects expired recovery approval without creating an executable row', async () => {
  await expect(queueGcReclaim(context, original, new Uint8Array([7]), 2n, 100)).rejects.toThrow('expired');
  expect(await Repo.transactions.count()).toBe(0);
  expect(mockWake).not.toHaveBeenCalled();
});
it('retains unknown failed attempts and renews only proven non-submissions, preserving prior evidence', async () => {
  await queueGcReclaim(context, original, new Uint8Array([7]), 2n, 200);
  await Repo.transactions.update('gc-reclaim:original', { status: ITransactionStatus.Failed });
  await queueGcReclaim(context, original, new Uint8Array([8]), 3n, 200);
  expect(await Repo.transactions.count()).toBe(1);
  await Repo.transactions.update('gc-reclaim:original', {
    neverCommittedAt: 100,
    submitEvidence: [
      {
        attemptId: 'a1',
        capturedAt: 1,
        source: 'pin',
        transactionId: word('5'),
        initialCommitment: word('6'),
        finalCommitment: word('7'),
        initialNonce: '1',
        outputNoteIds: [],
        nullifiers: [word('8')],
        refBlock: 10,
        refBlockCommitment: word('9'),
        verdict: 'never-committed',
        neverCommittedBy: 'expired'
      }
    ]
  });
  await queueGcReclaim(context, original, new Uint8Array([8]), 3n, 200);
  expect(await Repo.transactions.count()).toBe(2);
  expect((await Repo.transactions.get('gc-reclaim:original'))?.requestBytes).toEqual(new Uint8Array([7]));
  expect((await Repo.transactions.get('gc-reclaim:original:attempt:1'))?.requestBytes).toEqual(new Uint8Array([8]));
});
