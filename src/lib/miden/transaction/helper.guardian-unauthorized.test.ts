import { isGuardianUnauthorizedExecutionError } from './helper';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { where: jest.fn() };
  }
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn()
}));

/**
 * The verbatim text observed on every one of the 67 guardian failures in a
 * 300-send devnet stress run. Building the fixtures from the real message —
 * rather than from what the predicate happens to match — is what makes these
 * tests fail if the SDK's wording moves.
 */
const REAL_MESSAGE =
  "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
  'transaction execution failed: transaction is unauthorized with summary ' +
  'TransactionSummary { nonce_delta: 1 }';

// The classifier is the ONLY thing standing between "retry this transfer" and
// "retry a transfer that may already be on chain". The requeue arm it gates has
// no stage gate and no input-note nullifier behind it, so every widening of this
// predicate is a potential double-send and every narrowing silently reinstates
// the terminal failure the fix exists to remove.
describe('isGuardianUnauthorizedExecutionError', () => {
  it('matches the execution rejection the guardian race actually produces', () => {
    expect(isGuardianUnauthorizedExecutionError(new Error(REAL_MESSAGE))).toBe(true);
  });

  it('matches a bare string throw carrying the same text', () => {
    expect(isGuardianUnauthorizedExecutionError(REAL_MESSAGE)).toBe(true);
  });

  it('matches when the reason is on the cause chain rather than the top message', () => {
    // The offscreen bus re-wraps errors and callers may attach a cause, so the
    // execution reason does not always land on `.message`. `isApplyAfterSubmitError`
    // — the classifier sharing this catch chain — walks the chain for exactly
    // this reason; a predicate that reads only `.message` fails CLOSED here, which
    // silently switches the fix back off rather than announcing itself.
    const wrapped = new Error('Guardian pipeline failed', { cause: new Error(REAL_MESSAGE) });
    expect(isGuardianUnauthorizedExecutionError(wrapped)).toBe(true);
  });

  it('matches through more than one layer of wrapping', () => {
    // One wrapper is what today's offscreen bus happens to add; the walk is
    // budgeted for five. Pinning only the single-wrapper case would let that
    // budget be cut to one without reddening anything, and this predicate fails
    // CLOSED — a chain one layer too deep silently switches the retry off.
    const deep = new Error('Offscreen call failed', {
      cause: new Error('Guardian pipeline failed', { cause: new Error(REAL_MESSAGE) })
    });
    expect(isGuardianUnauthorizedExecutionError(deep)).toBe(true);
  });

  it('matches at the far end of the budgeted depth, not just two links in', () => {
    // The two-wrapper fixture above reaches depth 2, so the budget could be cut
    // from five to three, or to two, and every assertion would stay green —
    // which is exactly the shape of a budget nobody is testing. This builds the
    // chain out to the last link the walk is documented to reach, so shrinking
    // the budget at all reddens something.
    let chain = new Error(REAL_MESSAGE);
    for (let depth = 0; depth < 5; depth += 1) {
      chain = new Error(`wrapper ${depth}`, { cause: chain });
    }
    expect(isGuardianUnauthorizedExecutionError(chain)).toBe(true);
  });

  it('requires the word to be about the TRANSACTION, not any unauthorized thing', () => {
    // Widening this half to a bare /unauthorized/ leaves the whole suite green,
    // yet it would swallow a transport 401 and the kernel's commitment-mismatch
    // abort — different failures with different right answers, folded into the
    // one arm that retries. The execution marker keeps them pre-submit, so this
    // is not a double-send; it is the arm claiming a diagnosis it does not have.
    expect(isGuardianUnauthorizedExecutionError(new Error('transaction execution failed: 401 Unauthorized'))).toBe(
      false
    );
    expect(
      isGuardianUnauthorizedExecutionError(
        new Error('transaction execution failed: transaction returned unauthorized event, commitment did not match')
      )
    ).toBe(false);
  });

  it('does not match a prove-time kernel failure that mentions the same words', () => {
    // The native prover reports "failed to execute transaction kernel program".
    // Accepting that phrase as the execution marker would let a prove-time error
    // through on a text coincidence. Proving is still pre-submit so this is not a
    // double-send today, but the arm's whole safety argument is that the text pins
    // the failure to ONE step, and a marker this loose does not pin anything.
    const proveError = new Error(
      'failed to execute transaction kernel program: transaction is unauthorized with summary TransactionSummary {}'
    );
    expect(isGuardianUnauthorizedExecutionError(proveError)).toBe(false);
  });

  it('does not match when the two halves come from different errors in the chain', () => {
    // The chain is searched so a wrapped error still classifies, but each half
    // must come from the SAME error. Searching the flattened chain would let a
    // post-submit rejection supply "unauthorized" while some unrelated inner
    // error supplies the execution marker — assembling a match for a transfer
    // that may already be on chain out of two errors that never described one
    // failure. No such pairing is constructible in the wallet today, which is
    // exactly why this needs a test: nothing else would notice if one appeared.
    const split = new Error('submit rejected by node: transaction is unauthorized', {
      cause: new Error('transaction execution failed: unrelated earlier step')
    });
    expect(isGuardianUnauthorizedExecutionError(split)).toBe(false);
  });

  it('does not match a lock-recovery eviction, even when its cause carries the reason (#775)', () => {
    // The requeue this gates is safe only because the execute step STOPPED the
    // pipeline short of prove and submit. An eviction breaks that: it rejects
    // the caller while the abandoned pipeline runs on and can still submit, so
    // matching one here would broadcast the transfer a second time. The poison
    // error wraps the raw realm error as its `cause`, and this classifier walks
    // the chain — so the guard has to be on the TYPE, not on the text.
    expect(
      isGuardianUnauthorizedExecutionError(new WasmClientPoisonedError('realm-error', new Error(REAL_MESSAGE)))
    ).toBe(false);
    expect(isGuardianUnauthorizedExecutionError(new WasmClientPoisonedError('watchdog'))).toBe(false);
  });

  it('does not match a rejection that merely contains the word unauthorized', () => {
    expect(isGuardianUnauthorizedExecutionError(new Error('401 Unauthorized'))).toBe(false);
  });

  it('does not match a post-submit rejection carrying the same phrase', () => {
    // A transfer rejected after submit may already be on chain; requeueing it
    // could pay the recipient twice.
    expect(
      isGuardianUnauthorizedExecutionError(new Error('submit rejected by node: transaction is unauthorized'))
    ).toBe(false);
  });

  it('does not match an execution failure with an unrelated reason', () => {
    expect(isGuardianUnauthorizedExecutionError(new Error('transaction execution failed: insufficient balance'))).toBe(
      false
    );
  });

  it('is false for null, undefined and non-error objects', () => {
    expect(isGuardianUnauthorizedExecutionError(null)).toBe(false);
    expect(isGuardianUnauthorizedExecutionError(undefined)).toBe(false);
    expect(isGuardianUnauthorizedExecutionError({})).toBe(false);
  });
});
