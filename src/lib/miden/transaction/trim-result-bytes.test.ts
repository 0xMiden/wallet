import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';

import { RESULT_BYTES_RETENTION_MS, selectRowsToTrim } from './trim-result-bytes';

const SECOND = 1000;
const NOW = 1_000_000_000_000;
const old = Math.floor((NOW - RESULT_BYTES_RETENTION_MS - 60 * SECOND) / 1000);
const recent = Math.floor((NOW - 30 * SECOND) / 1000);

const row = (over: Partial<ITransaction>): ITransaction =>
  ({
    id: 'tx',
    type: 'send',
    status: ITransactionStatus.Completed,
    completedAt: old,
    resultBytes: new Uint8Array([1, 2, 3]),
    ...over
  }) as unknown as ITransaction;

describe('selectRowsToTrim', () => {
  it('trims a completed row whose result has outlived the retention window', () => {
    expect(selectRowsToTrim([row({ id: 'a' })], NOW).map(r => r.id)).toEqual(['a']);
  });

  it('spares a row still inside the window, so window.miden.waitForTransaction can still read it', () => {
    // waitForTransactionCompletion resolves on the row reaching Completed and only THEN
    // deserializes resultBytes. Trimming at completion would race that public dApp API.
    expect(selectRowsToTrim([row({ id: 'b', completedAt: recent })], NOW)).toEqual([]);
  });

  it('spares earn-deposit, whose caller reads the result back off the finished row', () => {
    expect(selectRowsToTrim([row({ id: 'c', type: 'earn-deposit' })], NOW)).toEqual([]);
  });

  it('spares an epoch bridged-send for the same reason', () => {
    const bridged = row({ id: 'd', type: 'bridged-send', extraInputs: { provider: 'epoch' } });
    expect(selectRowsToTrim([bridged], NOW)).toEqual([]);
  });

  it('trims a bridged-send from a provider that does not await the result', () => {
    const bridged = row({ id: 'e', type: 'bridged-send', extraInputs: { provider: 'across' } });
    expect(selectRowsToTrim([bridged], NOW).map(r => r.id)).toEqual(['e']);
  });

  it('ignores rows that are not Completed, and rows already trimmed', () => {
    const queued = row({ id: 'f', status: ITransactionStatus.Queued });
    const already = row({ id: 'g', resultBytes: undefined });
    expect(selectRowsToTrim([queued, already], NOW)).toEqual([]);
  });

  it('falls back to initiatedAt when a completed row carries no completedAt', () => {
    const noCompletedAt = row({ id: 'h', completedAt: undefined, initiatedAt: old });
    expect(selectRowsToTrim([noCompletedAt], NOW).map(r => r.id)).toEqual(['h']);
  });
});
