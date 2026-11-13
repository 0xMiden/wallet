import {
  attemptMayHaveCrossed,
  awaitingVerdict,
  canAwaitVerdict,
  crossedCandidateNonce,
  evidenceKey,
  holdsNotes,
  isCheckable,
  isFailedClaim,
  isProvable,
  isUnresolvedEntry,
  keptCandidateHoldUntil,
  notConfirmedHintKey,
  OTHER_NETWORK_GIVE_UP_SEC,
  upsertEvidenceEntry
} from './verdict-rules';
import { hasLeftQueue, ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

const NOW = 1_800_000_000;
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const provable = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 10,
  source: 'stage',
  transactionId: hex(1),
  initialCommitment: hex(2),
  finalCommitment: hex(3),
  initialNonce: '4',
  outputNoteIds: [hex(5)],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: hex(6),
  ...overrides
});

const row = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx',
  type: 'send',
  accountId: 'acct',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: NOW - 100,
  displayIcon: 'SEND',
  submitEvidence: [provable()],
  ...overrides
});

describe('the Unconfirmed status (#1081)', () => {
  it('is appended as 4, so persisted 0 to 3 keep their meaning', () => {
    expect(ITransactionStatus.Unconfirmed).toBe(4);
    expect(ITransactionStatus.Failed).toBe(3);
  });

  it.each([
    [ITransactionStatus.Queued, false],
    [ITransactionStatus.GeneratingTransaction, false],
    [ITransactionStatus.Completed, true],
    [ITransactionStatus.Failed, true],
    [ITransactionStatus.Unconfirmed, true]
  ])('hasLeftQueue(%s) is %s', (status, expected) => {
    expect(hasLeftQueue({ status })).toBe(expected);
  });
});

describe('canAwaitVerdict', () => {
  it.each<[string, Partial<ITransaction>, boolean]>([
    ['send', { type: 'send' }, true],
    ['consume', { type: 'consume' }, true],
    ['swap', { type: 'swap' }, true],
    ['execute', { type: 'execute' }, true],
    ['Agglayer bridged-send', { type: 'bridged-send', extraInputs: { provider: 'agglayer' } }, true],
    ['USDCx bridged-send', { type: 'bridged-send', extraInputs: { provider: 'usdcx' } }, true],
    ['Epoch bridged-send', { type: 'bridged-send', extraInputs: { provider: 'epoch' } }, false],
    ['bridged-send with no provider', { type: 'bridged-send' }, false],
    ['earn-deposit', { type: 'earn-deposit' }, false],
    ['switch-guardian', { type: 'switch-guardian' }, false],
    ['a restored send', { type: 'send', restoredFromBackup: true }, false],
    ['a rotation-funding claim', { type: 'consume', rotationFunding: true }, false]
  ])('%s %j -> %s', (_label, overrides, expected) => {
    expect(canAwaitVerdict(row(overrides))).toBe(expected);
  });
});

describe('provable and checkable entries', () => {
  it('needs every field but the expiration', () => {
    expect(isProvable(provable())).toBe(true);
    expect(isProvable(provable({ expirationBlock: undefined }))).toBe(true);
    expect(isProvable(provable({ nullifiers: undefined }))).toBe(false);
    expect(isProvable(provable({ refBlockCommitment: undefined }))).toBe(false);
    expect(isProvable({ attemptId: 'a', capturedAt: NOW, source: 'end' })).toBe(false);
  });

  it.each<[string, Partial<ISubmitEvidence>]>([
    ['transactionId', { transactionId: undefined }],
    ['initialCommitment', { initialCommitment: undefined }],
    ['finalCommitment', { finalCommitment: undefined }],
    ['initialNonce', { initialNonce: undefined }],
    ['outputNoteIds', { outputNoteIds: undefined }],
    ['nullifiers', { nullifiers: undefined }],
    ['refBlock', { refBlock: undefined }],
    ['refBlockCommitment', { refBlockCommitment: undefined }]
  ])('is not provable without %s', (_field, overrides) => {
    expect(isProvable(provable(overrides))).toBe(false);
  });

  it('is checkable while unjudged, not retired and not a day on another network', () => {
    expect(isCheckable(provable(), NOW)).toBe(true);
    expect(isCheckable(provable({ verdict: 'unresolvable' }), NOW)).toBe(false);
    expect(isCheckable(provable({ preSubmitEnd: true }), NOW)).toBe(false);
    expect(isCheckable(provable({ otherNetworkSince: NOW - OTHER_NETWORK_GIVE_UP_SEC }), NOW)).toBe(true);
    expect(isCheckable(provable({ otherNetworkSince: NOW - OTHER_NETWORK_GIVE_UP_SEC - 1 }), NOW)).toBe(false);
  });

  it('counts an entry as unresolved unless it is proven dead or retired before its submit', () => {
    expect(isUnresolvedEntry(provable())).toBe(true);
    expect(isUnresolvedEntry(provable({ verdict: 'unresolvable' }))).toBe(true);
    expect(isUnresolvedEntry(provable({ verdict: 'never-committed' }))).toBe(false);
    expect(isUnresolvedEntry(provable({ preSubmitEnd: true }))).toBe(false);
  });
});

describe('awaitingVerdict, holdsNotes and isFailedClaim', () => {
  it('awaits a verdict for an Unconfirmed or Failed eligible row with a checkable entry', () => {
    expect(awaitingVerdict(row(), NOW)).toBe(true);
    expect(awaitingVerdict(row({ status: ITransactionStatus.Failed }), NOW)).toBe(true);
    expect(awaitingVerdict(row({ status: ITransactionStatus.Completed }), NOW)).toBe(false);
    expect(awaitingVerdict(row({ neverCommittedAt: NOW }), NOW)).toBe(false);
    expect(awaitingVerdict(row({ restoredFromBackup: true }), NOW)).toBe(false);
    expect(awaitingVerdict(row({ submitEvidence: [provable({ verdict: 'unresolvable' })] }), NOW)).toBe(false);
    expect(awaitingVerdict(row({ submitEvidence: [] }), NOW)).toBe(false);
  });

  it('holds a consume`s notes exactly while it awaits a verdict, and calls the rest failed claims', () => {
    const held = row({ type: 'consume' });
    expect(holdsNotes(held, NOW)).toBe(true);
    expect(isFailedClaim(held, NOW)).toBe(false);
    const evidenceLess = row({ type: 'consume', submitEvidence: [{ attemptId: 'a', capturedAt: NOW, source: 'end' }] });
    expect(holdsNotes(evidenceLess, NOW)).toBe(false);
    expect(isFailedClaim(evidenceLess, NOW)).toBe(true);
    const funding = row({ type: 'consume', rotationFunding: true });
    expect(holdsNotes(funding, NOW)).toBe(false);
    expect(isFailedClaim(row({ type: 'consume', status: ITransactionStatus.Queued }), NOW)).toBe(false);
    expect(isFailedClaim(row({ type: 'send', status: ITransactionStatus.Failed }), NOW)).toBe(false);
    expect(holdsNotes(row({ type: 'send' }), NOW)).toBe(false);
  });
});

describe('attemptMayHaveCrossed (#2060)', () => {
  it("answers yes for the attempt's own entry, among others", () => {
    const row = { submitEvidence: [provable({ attemptId: 'a0' }), provable({ attemptId: 'a1' })] };
    expect(attemptMayHaveCrossed(row, 'a1')).toBe(true);
  });

  it.each<[string, Pick<ITransaction, 'submitEvidence'> | undefined, string | undefined]>([
    ['a missing row', undefined, 'a1'],
    ['a row with no evidence', {}, 'a1'],
    ["another attempt's entry", { submitEvidence: [provable({ attemptId: 'a0' })] }, 'a1'],
    ['an entry the leaf retired before its submit call', { submitEvidence: [provable({ preSubmitEnd: true })] }, 'a1'],
    ['no attempt to ask about', { submitEvidence: [provable()] }, undefined]
  ])('answers no for %s', (_label, row, attemptId) => {
    expect(attemptMayHaveCrossed(row, attemptId)).toBe(false);
  });
});

describe('upsertEvidenceEntry', () => {
  it('creates one entry per attempt and fills only what it lacks', () => {
    let entries = upsertEvidenceEntry(
      undefined,
      'a1',
      { source: 'pin', guardianProposalNonce: 7, raisedFlag: true },
      NOW
    );
    expect(entries).toEqual([
      { attemptId: 'a1', capturedAt: NOW, source: 'pin', guardianProposalNonce: 7, raisedFlag: true }
    ]);
    entries = upsertEvidenceEntry(
      entries,
      'a1',
      { source: 'stage', evidence: { transactionId: hex(1), refBlock: 9 } },
      NOW + 5
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'pin',
      capturedAt: NOW,
      transactionId: hex(1),
      refBlock: 9,
      raisedFlag: true
    });
    expect(
      upsertEvidenceEntry([provable()], 'a1', { source: 'stage', evidence: { refBlock: 1 } }, NOW)[0]?.refBlock
    ).toBe(100);
  });

  it('never changes an id once set, logs the contradiction and keeps the entry', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = upsertEvidenceEntry(
      [provable()],
      'a1',
      { source: 'stage', evidence: { transactionId: hex(99), expirationBlock: 50 } },
      NOW
    );
    expect(entries[0]).toEqual(provable());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('lets an error-text id fill only an entry without one', () => {
    const filled = upsertEvidenceEntry(
      [{ attemptId: 'a1', capturedAt: NOW, source: 'end' }],
      'a1',
      { source: 'error-text', evidence: { transactionId: hex(1) } },
      NOW
    );
    expect(filled[0]?.transactionId).toBe(hex(1));
  });

  it('keeps the first end, keeps fromExecute sticky, and never clears preSubmitEnd', () => {
    let entries = upsertEvidenceEntry(undefined, 'a1', { source: 'kill', endedBy: 'kill', fromExecute: true }, NOW);
    entries = upsertEvidenceEntry(
      entries,
      'a1',
      { source: 'out-of-band', endedBy: 'out-of-band', fromExecute: false },
      NOW + 50
    );
    expect(entries[0]).toMatchObject({ endedBy: 'kill', endedAt: NOW, fromExecute: true });
    entries = upsertEvidenceEntry(entries, 'a1', { source: 'pin', preSubmitEnd: true }, NOW);
    entries = upsertEvidenceEntry(entries, 'a1', { source: 'stage', evidence: { refBlock: 3 } }, NOW);
    expect(entries[0]?.preSubmitEnd).toBe(true);
  });

  // An outside end marks a crossed attempt kept, and a live leaf can still prove it stopped short and abandon (#2060).
  it('drops a kept mark at a pre-submit end, and a later keep records it again', () => {
    let entries = upsertEvidenceEntry(undefined, 'a1', { source: 'stage', candidateKept: true }, NOW);
    entries = upsertEvidenceEntry(entries, 'a1', { source: 'stage', preSubmitEnd: true }, NOW);
    expect(entries[0]).toMatchObject({ preSubmitEnd: true });
    expect(entries[0]?.candidateKept).toBeUndefined();
    entries = upsertEvidenceEntry(entries, 'a1', { source: 'kill', candidateKept: true }, NOW);
    expect(entries[0]).toMatchObject({ preSubmitEnd: true, candidateKept: true });
  });

  it('sets raisedFlag only when the pin creates the entry', () => {
    const existing = upsertEvidenceEntry(undefined, 'a1', { source: 'stage' }, NOW);
    expect(
      upsertEvidenceEntry(existing, 'a1', { source: 'pin', raisedFlag: true }, NOW)[0]?.raisedFlag
    ).toBeUndefined();
  });
});

describe('evidenceKey', () => {
  it('ignores the seen fields and nothing else', () => {
    const base = [provable()];
    expect(evidenceKey([provable({ initialSeenAtBlock: 5, landingSeenAtBlock: 7, landingSeenBy: 2 })])).toBe(
      evidenceKey(base)
    );
    expect(evidenceKey([provable({ verdict: 'never-committed' })])).not.toBe(evidenceKey(base));
    expect(evidenceKey([provable({ otherNetworkSince: NOW })])).not.toBe(evidenceKey(base));
    expect(evidenceKey([provable({ outputNoteIds: [hex(5), hex(8)] })])).not.toBe(evidenceKey(base));
    expect(evidenceKey(undefined)).toBe(evidenceKey([]));
  });
});

describe('notConfirmedHintKey (#1081)', () => {
  it('says the row may still complete only while the reconciler still judges it', () => {
    expect(notConfirmedHintKey(row(), NOW)).toBe('transactionNotConfirmedHint');
    expect(notConfirmedHintKey(row({ submitEvidence: [provable({ verdict: 'unresolvable' })] }), NOW)).toBe(
      'transactionUndeterminedHint'
    );
    expect(
      notConfirmedHintKey(row({ submitEvidence: [{ attemptId: 'a', capturedAt: NOW, source: 'end' }] }), NOW)
    ).toBe('transactionUndeterminedHint');
    expect(
      notConfirmedHintKey(
        row({ status: ITransactionStatus.Failed, submitEvidence: undefined, mayHaveSubmitted: true }),
        NOW
      )
    ).toBe('transactionUndeterminedHint');
    expect(
      notConfirmedHintKey(
        row({ submitEvidence: [provable({ otherNetworkSince: NOW - OTHER_NETWORK_GIVE_UP_SEC - 1 })] }),
        NOW
      )
    ).toBe('transactionUndeterminedHint');
    expect(notConfirmedHintKey(row({ status: ITransactionStatus.Failed, restoredFromBackup: true }), NOW)).toBe(
      'transactionRestoredHint'
    );
  });
});

describe('keptCandidateHoldUntil (#1081)', () => {
  const NOW = 1_800_000_000;
  const kept = (capturedAt: number, overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
    attemptId: `a-${capturedAt}`,
    capturedAt,
    source: 'pin',
    candidateKept: true,
    guardianProposalNonce: 4,
    ...overrides
  });

  it('holds until 1080 s after the capture of a kept candidate (#1644)', () => {
    expect(keptCandidateHoldUntil({ submitEvidence: [kept(NOW - 100)] }, NOW)).toBe(NOW + 980);
  });

  it('takes the latest clear time across entries, and ignores entries whose candidate is not kept', () => {
    const entries = [kept(NOW - 300), kept(NOW - 50), kept(NOW - 10, { candidateKept: undefined })];
    expect(keptCandidateHoldUntil({ submitEvidence: entries }, NOW)).toBe(NOW + 1030);
  });

  it('holds nothing once 1080 s have passed', () => {
    expect(keptCandidateHoldUntil({ submitEvidence: [kept(NOW - 1080)] }, NOW)).toBeUndefined();
    expect(keptCandidateHoldUntil({ submitEvidence: [] }, NOW)).toBeUndefined();
  });

  // Review Focus 4: a capture ahead of the clock means the clock stepped back since; its age is unknown.
  it('holds nothing for a capture ahead of the clock, however far', () => {
    expect(keptCandidateHoldUntil({ submitEvidence: [kept(NOW + 5)] }, NOW)).toBeUndefined();
    expect(keptCandidateHoldUntil({ submitEvidence: [kept(NOW + 10 * 24 * 3600)] }, NOW)).toBeUndefined();
  });
});

describe('crossedCandidateNonce (#2060)', () => {
  const row = (overrides: Partial<ITransaction> = {}) => ({
    type: 'send' as const,
    attemptId: 'a1',
    submitEvidence: [provable({ guardianProposalNonce: 8 })],
    ...overrides
  });
  const candidate = { endpoint: 'https://guardian.test', nonce: 9, proposedAt: 1, attemptId: 'a1' };

  it('reads the nonce the crossing recorded, ahead of the row`s candidate', () => {
    expect(crossedCandidateNonce(row({ guardianCandidate: candidate }))).toBe(8);
  });

  it('falls back to the candidate this attempt wrote on the row', () => {
    const submitEvidence = [provable()];

    expect(crossedCandidateNonce(row({ submitEvidence, guardianCandidate: candidate }))).toBe(9);
    expect(
      crossedCandidateNonce(row({ submitEvidence, guardianCandidate: { ...candidate, attemptId: 'a0' } }))
    ).toBeUndefined();
    expect(crossedCandidateNonce(row({ submitEvidence }))).toBeUndefined();
  });

  it.each<[string, Partial<ITransaction>]>([
    ['an attempt retired before its submit', { submitEvidence: [provable({ preSubmitEnd: true })] }],
    ['an earlier attempt`s crossing', { submitEvidence: [provable({ attemptId: 'a0', guardianProposalNonce: 8 })] }],
    ['no evidence', { submitEvidence: undefined }],
    ['a row with no attempt', { attemptId: undefined }],
    ['a restored row', { restoredFromBackup: true }],
    ['a structural type', { type: 'replace-hot-key' }]
  ])('names no nonce for %s', (_label, overrides) => {
    expect(crossedCandidateNonce(row(overrides))).toBeUndefined();
  });
});
