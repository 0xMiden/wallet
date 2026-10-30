import fs from 'fs';
import path from 'path';

import { ITransactionStatus } from 'lib/miden/db/types';

import {
  REMOTE_PROVER_FAILED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_NEVER_COMMITTED_ERROR,
  TRANSACTION_STUCK_ERROR
} from './constants';
import { readsAsNotConfirmed, shownSubmissionFeedback, submissionFeedback } from './submission-feedback';

const en = require('../../../../public/_locales/en/en.json') as Record<string, string>;

const NETWORK_REFUSAL =
  'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: invalid request parameters';
const PERMISSION_REFUSAL =
  'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: permission denied';
const DEADLINE =
  'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: request to Miden node timed out; the node may be under heavy load';
const INDEFINITE = `submission of transaction 0x${'ab'.repeat(32)} came back without a definite outcome, so the node may or may not have accepted it`;
const DROPPED = 'TypeError: Failed to fetch';
const GUARDIAN_REFUSAL = 'GUARDIAN HTTP error 400: Bad Request - the proposal was rejected';
const GUARDIAN_OUTAGE = 'GUARDIAN HTTP error 500: Internal Server Error';
const ACCEPTED =
  "Transaction 0xabc was accepted into the node's mempool at block 9 but the local store update failed. Sync and try again.";

const row = (overrides: Record<string, unknown> = {}) => ({
  status: ITransactionStatus.Failed,
  stage: 'submitting' as const,
  type: 'consume' as const,
  ...overrides
});

const MESSAGE_KEYS = [
  'submissionRejectedByNetwork',
  'submissionRejectedByGuardian',
  'submissionBlockedByIssuer',
  'submissionHeldByGuardian',
  'submissionProvenHeldByGuardian',
  'submissionInterrupted',
  'submissionUnanswered'
] as const;

describe('submissionFeedback (#1689)', () => {
  it('explains an explicit network refusal, including one the submit stamp already crossed', () => {
    expect(submissionFeedback(row({ error: NETWORK_REFUSAL, mayHaveSubmitted: true }))).toMatchObject({
      kind: 'rejected',
      messageKey: 'submissionRejectedByNetwork',
      details: NETWORK_REFUSAL
    });
    expect(submissionFeedback(row({ error: PERMISSION_REFUSAL, rawError: PERMISSION_REFUSAL }))).toMatchObject({
      kind: 'rejected',
      messageKey: 'submissionRejectedByNetwork'
    });
  });

  it('reads a submit gRPC status through the shared table, including the encryption-key request', () => {
    const during = (endpoint: string, kind: string) =>
      `failed to submit proven transaction: RPC error: grpc request failed for ${endpoint}: ${kind}`;
    expect(
      submissionFeedback(row({ error: during('get_transaction_encryption_key', 'permission denied') }))
    ).toMatchObject({ kind: 'rejected', messageKey: 'submissionRejectedByNetwork' });
    expect(
      submissionFeedback(row({ error: during('get_transaction_encryption_key', 'operation was aborted') }))
    ).toBeUndefined();
    expect(
      submissionFeedback(
        row({
          error: during(
            'get_transaction_encryption_key',
            'request to Miden node timed out; the node may be under heavy load'
          )
        })
      )
    ).toBeUndefined();
    expect(
      submissionFeedback(row({ error: during('get_transaction_encryption_key', 'a status no table lists') }))
    ).toBeUndefined();
    expect(submissionFeedback(row({ error: during('submit_proven_batch', 'resource already exists') }))).toMatchObject({
      kind: 'rejected',
      messageKey: 'submissionRejectedByNetwork'
    });
    expect(
      submissionFeedback(row({ error: during('submit_proven_transaction', 'a status no table lists') }))
    ).toMatchObject({ kind: 'unanswered', messageKey: 'submissionUnanswered' });
  });

  it('explains an explicit Guardian refusal', () => {
    expect(submissionFeedback(row({ error: GUARDIAN_REFUSAL, mayHaveSubmitted: true }))).toMatchObject({
      kind: 'rejected',
      messageKey: 'submissionRejectedByGuardian',
      details: GUARDIAN_REFUSAL
    });
  });

  it('names the token issuer when its blocklist refused the account, ahead of the generic network refusal', () => {
    const KERNEL = 'transaction execution failed: assertion failed with error code: 17080150814197948856';
    const NAMED = 'note script failed: ERR_ACCOUNT_IS_BLOCKED';
    const WRAPPED = `${NETWORK_REFUSAL}: ${KERNEL}`;
    for (const error of [KERNEL, NAMED, WRAPPED]) {
      expect(submissionFeedback(row({ type: 'send' as const, error, mayHaveSubmitted: true }))).toMatchObject({
        kind: 'rejected',
        messageKey: 'submissionBlockedByIssuer',
        details: error
      });
    }
    expect(submissionFeedback(row({ error: 'prose', rawError: KERNEL }))).toMatchObject({
      messageKey: 'submissionBlockedByIssuer'
    });
    // A different code that merely contains the digits must not match.
    expect(
      submissionFeedback(row({ error: 'assertion failed with error code: 117080150814197948856' }))
    ).toBeUndefined();
  });

  it('explains a dropped connection as unconfirmed, not as a failed transaction', () => {
    const feedback = submissionFeedback(row({ error: DROPPED, mayHaveSubmitted: true }));

    expect(feedback).toMatchObject({ kind: 'interrupted', messageKey: 'submissionInterrupted', details: DROPPED });
    expect(en[feedback!.messageKey]).not.toMatch(/transaction failed|funds were lost|vpn|geofenc/i);
  });

  it('explains a deadline, an indefinite outcome, and a Guardian outage as no answer', () => {
    expect(submissionFeedback(row({ error: DEADLINE, mayHaveSubmitted: true }))).toMatchObject({
      kind: 'unanswered',
      messageKey: 'submissionUnanswered'
    });
    expect(
      submissionFeedback(row({ status: ITransactionStatus.Unconfirmed, error: INDEFINITE, mayHaveSubmitted: true }))
    ).toMatchObject({ kind: 'unanswered', messageKey: 'submissionUnanswered' });
    expect(submissionFeedback(row({ error: GUARDIAN_OUTAGE }))).toMatchObject({
      kind: 'unanswered',
      messageKey: 'submissionUnanswered'
    });
    expect(submissionFeedback(row({ error: 'Transaction took too long to process and was cancelled' }))).toMatchObject({
      kind: 'unanswered',
      messageKey: 'submissionUnanswered'
    });
    expect(en.submissionUnanswered).not.toMatch(/transaction failed|funds were lost|vpn|geofenc/i);
  });

  it('leaves a completed acceptance alone when the response was lost after the node took it', () => {
    expect(
      submissionFeedback(
        row({ status: ITransactionStatus.Completed, error: ACCEPTED, rawError: ACCEPTED, mayHaveSubmitted: true })
      )
    ).toBeUndefined();
  });

  it('leaves an in-progress submission and a proving failure on their existing copy', () => {
    expect(submissionFeedback(row({ status: ITransactionStatus.GeneratingTransaction }))).toBeUndefined();
    expect(
      submissionFeedback(
        row({
          stage: 'proving',
          error: 'The proving service was temporarily unavailable, so the transaction could not be completed.'
        })
      )
    ).toBeUndefined();
  });

  it('gives an unrecognized submit error no verdict, with or without the submit stamp', () => {
    expect(submissionFeedback(row({ error: 'Note is invalid', mayHaveSubmitted: true }))).toBeUndefined();
    expect(submissionFeedback(row({ error: 'Note is invalid' }))).toBeUndefined();
  });

  it('does not install its own deadline', () => {
    const source = fs.readFileSync(path.join(__dirname, 'submission-feedback.ts'), 'utf8');

    expect(source).not.toMatch(/60_000|60000|setTimeout|setInterval/);
  });

  it('keeps the shared sentences free of a geofence or lost-funds claim', () => {
    for (const key of MESSAGE_KEYS) {
      expect(en[key]).toEqual(expect.any(String));
      expect(en[key]).not.toMatch(/vpn|geofenc|geographic|funds were lost|lost your funds/i);
    }
  });
});

it.each([
  [REMOTE_PROVER_FAILED_ERROR, 'prover_at_submit'],
  [GUARDIAN_OUTAGE, 'guardian_unanswered'],
  [DEADLINE, 'grpc_unknown'],
  [TRANSACTION_STUCK_ERROR, 'no_answer']
])('retains the selected existing unanswered branch', (error, branch) => {
  const feedback = submissionFeedback(row({ error }));
  expect(feedback).toMatchObject({
    kind: 'unanswered',
    messageKey: 'submissionUnanswered',
    details: error,
    submissionFeedbackBranch: branch
  });
});

describe('a refused row with something left to judge (#2060)', () => {
  const NOW = 1_700_000_000;
  const entry = (overrides: Record<string, unknown> = {}) => ({
    attemptId: 'a1',
    capturedAt: NOW - 60,
    source: 'stage' as const,
    transactionId: '0x01',
    initialCommitment: '0x02',
    finalCommitment: '0x03',
    initialNonce: '4',
    outputNoteIds: ['0x05'],
    nullifiers: [],
    refBlock: 100,
    refBlockCommitment: '0x06',
    ...overrides
  });
  const refused = (overrides: Record<string, unknown> = {}) =>
    row({ error: NETWORK_REFUSAL, mayHaveSubmitted: true, ...overrides });

  it.each<[string, Record<string, unknown>]>([
    ['an entry the reconciler still judges', { submitEvidence: [entry()] }],
    ['an earlier attempt still open', { submitEvidence: [entry(), entry({ attemptId: 'a2', preSubmitEnd: true })] }],
    ['an Unconfirmed status', { status: ITransactionStatus.Unconfirmed, submitEvidence: [entry()] }]
  ])('reads not confirmed with %s, and shows no refusal', (_label, fields) => {
    const tx = refused(fields);

    expect(submissionFeedback(tx)?.kind).toBe('rejected');
    expect(readsAsNotConfirmed(tx)).toBe(true);
    expect(shownSubmissionFeedback(tx, NOW)).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['no evidence, even past the stamp', {}],
    ['only an attempt retired before its submit', { submitEvidence: [entry({ preSubmitEnd: true })] }],
    ['an entry proven dead', { submitEvidence: [entry({ verdict: 'never-committed' })] }],
    ['an entry the reconciler gave up on', { submitEvidence: [entry({ verdict: 'unresolvable' })] }],
    ['an entry with too little to check', { submitEvidence: [entry({ transactionId: undefined })] }],
    ['an entry a day on another network', { submitEvidence: [entry({ otherNetworkSince: NOW - 90_000 })] }],
    [
      'a row proven safe',
      {
        submitEvidence: [entry()],
        neverCommittedAt: NOW,
        error: TRANSACTION_NEVER_COMMITTED_ERROR,
        rawError: NETWORK_REFUSAL
      }
    ],
    ['a restored row', { submitEvidence: [entry()], restoredFromBackup: true }],
    ['an Epoch bridge', { type: 'bridged-send', extraInputs: { provider: 'epoch' }, submitEvidence: [entry()] }]
  ])('stays Failed with %s, and keeps its refusal', (_label, fields) => {
    const tx = refused(fields);

    expect(readsAsNotConfirmed(tx)).toBe(false);
    expect(shownSubmissionFeedback(tx, NOW)).toMatchObject({ kind: 'rejected' });
  });

  // The gate shows its key-pair exit only on a definite failure, so Activity follows it rather than the reverse.
  it.each<[string, Record<string, unknown>]>([
    ['a key rotation', { type: 'replace-hot-key' }],
    ['a rotation-funding claim', { rotationFunding: true }]
  ])('reads %s as the rotation gate does', (_label, fields) => {
    expect(readsAsNotConfirmed(refused(fields))).toBe(true);
    expect(shownSubmissionFeedback(refused(fields), NOW)).toBeUndefined();
    expect(readsAsNotConfirmed(refused({ ...fields, mayHaveSubmitted: undefined }))).toBe(false);
    expect(shownSubmissionFeedback(refused({ ...fields, mayHaveSubmitted: undefined }), NOW)).toMatchObject({
      kind: 'rejected'
    });
  });

  it('applies to every refusal, whatever the node said', () => {
    const tx = refused({ error: PERMISSION_REFUSAL, submitEvidence: [entry()] });

    expect(readsAsNotConfirmed(tx)).toBe(true);
    expect(readsAsNotConfirmed(refused({ error: GUARDIAN_REFUSAL, submitEvidence: [entry()] }))).toBe(true);
  });

  it('says why a refused row cannot be retried while a hold applies, and returns the refusal after', () => {
    const tx = refused({
      rawError: NETWORK_REFUSAL,
      submitEvidence: [entry({ verdict: 'unresolvable', candidateKept: true, capturedAt: NOW - 100 })]
    });

    expect(readsAsNotConfirmed(tx, NOW)).toBe(false);
    expect(shownSubmissionFeedback(tx, NOW)).toEqual({
      kind: 'guardianHold',
      messageKey: 'submissionHeldByGuardian',
      details: NETWORK_REFUSAL
    });
    expect(shownSubmissionFeedback(tx, NOW + 980)).toMatchObject({ kind: 'rejected' });
  });

  it.each<[string, string, string]>([
    ['a refusal', NETWORK_REFUSAL, 'rejected'],
    ['a text no category lists', 'node verdict: never committed', 'none'],
    ['a missing answer', TRANSACTION_INTERRUPTED_ON_STARTUP, 'none']
  ])(
    'keeps "safe to retry" off a proven row while a hold applies, whatever it stored: %s',
    (_label, rawError, after) => {
      const tx = row({
        error: TRANSACTION_NEVER_COMMITTED_ERROR,
        rawError,
        mayHaveSubmitted: true,
        neverCommittedAt: NOW,
        submitEvidence: [entry({ verdict: 'never-committed', candidateKept: true, capturedAt: NOW - 100 })]
      });

      expect(readsAsNotConfirmed(tx, NOW)).toBe(false);
      expect(shownSubmissionFeedback(tx, NOW)).toEqual({
        kind: 'guardianHold',
        messageKey: 'submissionProvenHeldByGuardian',
        details: rawError
      });
      expect(shownSubmissionFeedback(tx, NOW + 980)?.kind ?? 'none').toBe(after);
    }
  );

  it('adds no detail a proven row does not have', () => {
    const tx = row({
      error: TRANSACTION_NEVER_COMMITTED_ERROR,
      neverCommittedAt: NOW,
      submitEvidence: [entry({ verdict: 'never-committed', candidateKept: true })]
    });

    expect(shownSubmissionFeedback(tx, NOW)).toEqual({
      kind: 'guardianHold',
      messageKey: 'submissionProvenHeldByGuardian'
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['landed', { status: ITransactionStatus.Completed }],
    ['back in the queue', { status: ITransactionStatus.Queued }],
    ['running again', { status: ITransactionStatus.GeneratingTransaction }]
  ])('says nothing about a hold on a row that has %s', (_label, fields) => {
    expect(shownSubmissionFeedback(refused({ ...fields, submitEvidence: [entry({ candidateKept: true })] }), NOW)).toBe(
      undefined
    );
  });

  it('reads Not confirmed through a hold while the reconciler still judges the row', () => {
    const tx = refused({ submitEvidence: [entry({ candidateKept: true })] });

    expect(readsAsNotConfirmed(tx, NOW)).toBe(true);
    expect(shownSubmissionFeedback(tx, NOW)).toBeUndefined();
  });

  it('keeps every answer that is not a refusal', () => {
    const tx = row({ error: DEADLINE, submitEvidence: [entry({ candidateKept: true })] });

    expect(readsAsNotConfirmed(tx)).toBe(true);
    expect(shownSubmissionFeedback(tx, NOW)).toMatchObject({ kind: 'unanswered', messageKey: 'submissionUnanswered' });
  });

  it.each<[string, string]>([
    ['the startup sweep', TRANSACTION_INTERRUPTED_ON_STARTUP],
    ['the stuck reaper', TRANSACTION_STUCK_ERROR],
    ['a submit deadline', DEADLINE],
    ['a dropped connection', DROPPED],
    ['a Guardian outage', GUARDIAN_OUTAGE]
  ])(
    'reads a row the node proved never committed as Failed after %s, with no missing-answer copy',
    (_label, rawError) => {
      const tx = row({
        error: TRANSACTION_NEVER_COMMITTED_ERROR,
        rawError,
        mayHaveSubmitted: true,
        neverCommittedAt: NOW,
        submitEvidence: [entry({ verdict: 'never-committed' })]
      });

      expect(submissionFeedback(tx)?.kind).not.toBe('rejected');
      expect(readsAsNotConfirmed(tx, NOW)).toBe(false);
      expect(shownSubmissionFeedback(tx, NOW)).toBeUndefined();
    }
  );

  // A rotation row keeps the gate's rule for every stored text, or a timeout before its crossing reads Not confirmed in
  // Activity while the gate offers the key-pair exit for the failure it sees.
  it.each<[string, Record<string, unknown>]>([
    ['a key rotation', { type: 'replace-hot-key' }],
    ['a rotation-funding claim', { rotationFunding: true }]
  ])('reads a missing answer on %s as the rotation gate does', (_label, fields) => {
    const TIMED_OUT = 'Guardian request to guardian.example timed out after 30000 ms';
    const before = row({ ...fields, stage: 'creating-proposal', error: TIMED_OUT });
    const after = row({ ...fields, error: TIMED_OUT, mayHaveSubmitted: true });

    expect(readsAsNotConfirmed(before)).toBe(false);
    expect(shownSubmissionFeedback(before, NOW)).toBeUndefined();
    expect(readsAsNotConfirmed(after)).toBe(true);
    expect(shownSubmissionFeedback(after, NOW)).toMatchObject({ kind: 'unanswered' });
  });

  it('falls back to the outcome rule when no category recognizes the error', () => {
    expect(readsAsNotConfirmed(row({ error: 'a reason no category lists', mayHaveSubmitted: true }))).toBe(true);
    expect(readsAsNotConfirmed(row({ error: 'a reason no category lists' }))).toBe(false);
    expect(readsAsNotConfirmed(row({ status: ITransactionStatus.Completed }))).toBe(false);
  });
});
