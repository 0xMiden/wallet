import {
  PENDING_RETRY_REASONS,
  annotateUiProducer,
  snapshotUiProducer,
  validateUiEvidence
} from './ui-producer-diagnostics';

const origins = [
  ['raw_history_retry_failed', 'inline', 'history_retry', 'history_primary'],
  ['raw_history_retry_failed', 'inline', 'history_retry', 'history_earn_receive'],
  ['raw_history_retry_failed', 'notice', 'history_payback_retry', 'history_payback'],
  ['raw_transaction_retry_failed', 'inline', 'transaction_retry', 'status_screen']
] as const;
const groups = [origins[0], origins[2], origins[3]] as const;
const cases = origins.flatMap(([id, surface, kind, origin]) =>
  PENDING_RETRY_REASONS.map(reason => [id, surface, kind, origin, reason] as const)
);

describe('closed retry notice evidence', () => {
  it.each(cases)('keeps %s/%s %s %s %s on its own root', (id, surface, kind, origin, reason) => {
    const evidence = { kind, retryNoticeOrigin: origin, pendingRetryReason: reason };
    expect(validateUiEvidence(id, surface, evidence)).toEqual(evidence);
    const error = new Error('synthetic retry refusal');
    annotateUiProducer(error, id, surface, evidence);
    expect(snapshotUiProducer(error, id, surface)).toEqual({ retryNoticeOrigin: origin, pendingRetryReason: reason });
    expect(snapshotUiProducer({ cause: error }, id, surface)).toBeUndefined();
    expect(snapshotUiProducer(error, id, 'field')).toBeUndefined();
  });

  it.each(groups)('clears invalid replacement metadata for %s/%s %s', (id, surface, kind, origin) => {
    const error = new Error('synthetic retry refusal');
    const evidence = { kind, retryNoticeOrigin: origin, pendingRetryReason: 'guardian_hold' };
    annotateUiProducer(error, id, surface, evidence);
    expect(snapshotUiProducer(error, id, surface)).toEqual({
      retryNoticeOrigin: origin,
      pendingRetryReason: 'guardian_hold'
    });
    annotateUiProducer(error, id, surface, { ...evidence, privateDetail: 'synthetic rejected detail' });
    expect(snapshotUiProducer(error, id, surface)).toBeUndefined();
  });

  it.each(origins)('rejects unknown or missing facts for %s/%s %s %s', (id, surface, kind, origin) => {
    const evidence = { kind, retryNoticeOrigin: origin, pendingRetryReason: 'guardian_hold' };
    for (const invalid of [
      { kind, retryNoticeOrigin: origin },
      { kind, pendingRetryReason: 'guardian_hold' },
      { ...evidence, pendingRetryReason: 'synthetic unknown reason' },
      { ...evidence, pendingRetryReason: { value: 'guardian_hold' } },
      { ...evidence, retryNoticeOrigin: 'synthetic unknown origin' },
      { ...evidence, privateDetail: 'synthetic rejected detail' },
      Object.assign(Object.create(evidence), { kind })
    ]) {
      expect(validateUiEvidence(id, surface, invalid)).toBeUndefined();
    }
    expect(validateUiEvidence('invalidAmount', surface, evidence)).toBeUndefined();
    expect(validateUiEvidence(id, 'field', evidence)).toBeUndefined();
    let reads = 0;
    const getter = Object.defineProperty({ ...evidence }, 'pendingRetryReason', {
      enumerable: true,
      get() {
        reads++;
        return 'guardian_hold';
      }
    });
    expect(validateUiEvidence(id, surface, getter)).toBeUndefined();
    expect(reads).toBe(0);
    const trapped = new Proxy(evidence, {
      getOwnPropertyDescriptor() {
        throw new Error('synthetic descriptor refusal');
      }
    });
    expect(validateUiEvidence(id, surface, trapped)).toBeUndefined();
  });

  it('rejects a valid origin belonging to another retry surface', () => {
    for (const [id, surface, kind, origin] of origins) {
      for (const [, , , other] of origins) {
        const historyOrigin = other === 'history_primary' || other === 'history_earn_receive';
        if (other === origin || (kind === 'history_retry' && historyOrigin)) continue;
        expect(
          validateUiEvidence(id, surface, { kind, retryNoticeOrigin: other, pendingRetryReason: 'guardian_hold' })
        ).toBeUndefined();
      }
    }
  });

  it('preserves the existing pending activity notice without an origin', () => {
    const evidence = { kind: 'pending_retry', pendingRetryReason: 'guardian_hold' };
    expect(validateUiEvidence('raw_pending_activity_retry_failed', 'notice', evidence)).toEqual(evidence);
  });
});
