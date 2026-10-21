import fs from 'fs';
import path from 'path';

import { ITransactionStatus } from 'lib/miden/db/types';

import { submissionFeedback } from './submission-feedback';

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
  'submissionRejectedOnDevice',
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

  it('explains an explicit Guardian refusal', () => {
    expect(submissionFeedback(row({ error: GUARDIAN_REFUSAL, mayHaveSubmitted: true }))).toMatchObject({
      kind: 'rejected',
      messageKey: 'submissionRejectedByGuardian',
      details: GUARDIAN_REFUSAL
    });
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

  it('keeps a definite client sentence when the device refused, including after the submit stamp', () => {
    expect(submissionFeedback(row({ error: 'Note is invalid', mayHaveSubmitted: true }))).toMatchObject({
      kind: 'rejected',
      messageKey: 'submissionRejectedOnDevice',
      rowCopy: 'Note is invalid'
    });
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
