import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { recordGcClaimEvidence } from './gc-claim-evidence';
import {
  GcClaimContext,
  GcClaimDeliveryEvidence,
  GcClaimIssuanceEvidence,
  GcClaimReclaimEvidence,
  gcClaimPhase
} from './gc-claim-operation';
import { queuePreparedGcClaim } from './gc-claim-queue';

// These tests validate persistence and evidence admission, not chain proof verification/execution.
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: async () => undefined }));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (value: string) => ({ toString: () => value.toLowerCase() }),
  canonicalWalletAccountId: (value: string) => value.toLowerCase()
}));
jest.mock('lib/miden/spending-limits/valuation', () => ({ resolveSpendsUsd: jest.fn() }));

const word = (value: string) => `0x${value.repeat(64)}`;
const ACCOUNT = `0x${'11'.repeat(15)}`;
const ISSUER = `0x${'22'.repeat(15)}`;
const NATIVE = `0x${'33'.repeat(15)}`;
const context: GcClaimContext = {
  network: 'testnet',
  genesisCommitment: word('a'),
  accountId: ACCOUNT,
  issuerId: ISSUER,
  issuerCodeCommitment: word('b'),
  nativeAssetId: NATIVE
};
const request = {
  scope: { genesisCommitment: word('a'), accountId: ACCOUNT, issuerId: ISSUER, approvedWeek: 123 },
  issuerCodeCommitment: word('b'),
  nativeAssetId: NATIVE,
  requestNoteId: word('c'),
  receiptRecipientCommitment: word('d'),
  nativeBudget: 10_000n,
  outgoingNativeAmount: 11_700n,
  approvalExpiresAt: 4_000_000_000,
  reclaimHeight: 200,
  requestBytes: new Uint8Array([1, 2, 3])
};
const issuance = (overrides: Partial<GcClaimIssuanceEvidence> = {}): GcClaimIssuanceEvidence => ({
  kind: 'issued',
  genesisCommitment: word('a'),
  blockNumber: 150,
  blockCommitment: word('e'),
  transactionId: word('f'),
  requestNoteId: word('c'),
  requestNullifier: word('1'),
  issuerId: ISSUER,
  accountId: ACCOUNT,
  receiptNoteId: word('2'),
  receiptRecipientCommitment: word('d'),
  gcAmount: 10_000_000n,
  nativeRefund: 8_400n,
  issuerFee: 1_600n,
  ...overrides
});
const reclaim = (overrides: Partial<GcClaimReclaimEvidence> = {}): GcClaimReclaimEvidence => ({
  kind: 'reclaimed',
  genesisCommitment: word('a'),
  blockNumber: 201,
  blockCommitment: word('3'),
  transactionId: word('4'),
  requestNoteId: word('c'),
  requestNullifier: word('1'),
  accountId: ACCOUNT,
  referenceBlock: 200,
  ...overrides
});

it('requires linked issuer and consumed-receipt evidence before reporting delivered', async () => {
  const queued = await queuePreparedGcClaim(context, request);
  await Repo.transactions.update(queued.transactionId, { status: ITransactionStatus.Completed });
  const delivery: GcClaimDeliveryEvidence = {
    kind: 'delivered',
    genesisCommitment: word('a'),
    blockNumber: 151,
    blockCommitment: word('3'),
    transactionId: word('4'),
    receiptNoteId: word('2'),
    receiptNullifier: word('5'),
    accountId: ACCOUNT
  };
  await expect(recordGcClaimEvidence(context, queued.transactionId, delivery)).rejects.toThrow();
  expect(gcClaimPhase((await Repo.transactions.get(queued.transactionId))!)).toBe('pending');
  await recordGcClaimEvidence(context, queued.transactionId, issuance());
  expect(gcClaimPhase((await Repo.transactions.get(queued.transactionId))!)).toBe('awaiting-receipt');
  await expect(
    recordGcClaimEvidence(context, queued.transactionId, { ...delivery, receiptNoteId: word('6') })
  ).rejects.toThrow();
  await recordGcClaimEvidence(context, queued.transactionId, delivery);
  // A delayed repeated issuer observation must preserve the newer delivery evidence.
  await recordGcClaimEvidence(context, queued.transactionId, issuance());
  Repo.db.close();
  await Repo.db.open();
  expect(gcClaimPhase((await Repo.transactions.get(queued.transactionId))!)).toBe('delivered');
  await expect(recordGcClaimEvidence(context, queued.transactionId, reclaim())).rejects.toThrow();
});

it('rejects mismatched network, recipient, sender, token amount and native conservation', async () => {
  const queued = await queuePreparedGcClaim(context, request);
  for (const invalid of [
    issuance({ genesisCommitment: word('7') }),
    issuance({ requestNoteId: word('7') }),
    issuance({ receiptRecipientCommitment: word('7') }),
    issuance({ issuerId: ACCOUNT }),
    issuance({ accountId: ISSUER }),
    issuance({ gcAmount: 1n }),
    issuance({ nativeRefund: 8_401n }),
    issuance({ issuerFee: -1n }),
    issuance({ blockNumber: -1 })
  ]) {
    await expect(recordGcClaimEvidence(context, queued.transactionId, invalid)).rejects.toThrow();
  }
  expect((await Repo.transactions.get(queued.transactionId))?.gcClaim?.issuance).toBeUndefined();
});

it('admits issuer proof without an undiscoverable transaction id and preserves a later known id', async () => {
  const queued = await queuePreparedGcClaim(context, request);
  await recordGcClaimEvidence(context, queued.transactionId, issuance({ transactionId: undefined }));
  await recordGcClaimEvidence(context, queued.transactionId, issuance());
  await recordGcClaimEvidence(context, queued.transactionId, issuance({ transactionId: undefined }));
  expect((await Repo.transactions.get(queued.transactionId))?.gcClaim?.issuance?.transactionId).toBe(word('f'));
});

it('accepts reclaim only for the original request/sender at or after its authenticated reference cutoff', async () => {
  const queued = await queuePreparedGcClaim(context, request);
  for (const invalid of [
    reclaim({ accountId: ISSUER }),
    reclaim({ referenceBlock: 199 }),
    reclaim({ requestNoteId: word('7') }),
    reclaim({ referenceBlock: 202, blockNumber: 201 })
  ]) {
    await expect(recordGcClaimEvidence(context, queued.transactionId, invalid)).rejects.toThrow();
  }
  await recordGcClaimEvidence(context, queued.transactionId, reclaim());
  expect(gcClaimPhase((await Repo.transactions.get(queued.transactionId))!)).toBe('reclaimed');
  await expect(recordGcClaimEvidence(context, queued.transactionId, issuance())).rejects.toThrow();
});

it('does not treat local failures, unresolvable submits or imported evidence as permission to retry', async () => {
  const queued = await queuePreparedGcClaim(context, request);
  await Repo.transactions.update(queued.transactionId, {
    status: ITransactionStatus.Failed,
    neverCommittedAt: 400,
    submitEvidence: [
      {
        attemptId: 'a1',
        capturedAt: 100,
        source: 'pin',
        transactionId: word('1'),
        initialCommitment: word('2'),
        finalCommitment: word('3'),
        initialNonce: '1',
        outputNoteIds: [word('c')],
        nullifiers: [],
        refBlock: 100,
        refBlockCommitment: word('4'),
        verdict: 'never-committed',
        neverCommittedBy: 'expired'
      }
    ]
  });
  const proven = (await Repo.transactions.get(queued.transactionId))!;
  expect(gcClaimPhase(proven)).toBe('retryable');
  expect(gcClaimPhase({ ...proven, neverCommittedAt: undefined })).toBe('pending');
  expect(gcClaimPhase({ ...proven, restoredFromBackup: true })).toBe('pending');
  expect(gcClaimPhase({ ...proven, status: ITransactionStatus.Queued })).toBe('pending');
  expect(
    gcClaimPhase({
      ...proven,
      submitEvidence: [...proven.submitEvidence!, { attemptId: 'unknown', capturedAt: 100, source: 'pin' }]
    })
  ).toBe('pending');
});
