import { extractSdkErrorCode, isApplyAfterSubmitError, isTransactionDiscardedError } from './sdk-error-code';

/**
 * The verbatim `Display` text miden-client produces for
 * `ClientError::ApplyTransactionAfterSubmitFailed`, confirmed present in the
 * shipped `@miden-sdk/miden-sdk@0.16.0-rc.3` wasm (both wordings appear there;
 * the second is the one raised through the `apply_transaction_update` path).
 */
const REAL_APPLY_AFTER_SUBMIT_MESSAGES = [
  "Transaction 0xdeadbeef was accepted into the node's mempool at block 42 but the local store update failed. " +
    'The pending update is attached to this error as `pending_update`; you can re-apply it later via ' +
    '`Client::apply_transaction_update`. Do NOT resubmit the same transaction: if the original is still in the ' +
    'mempool or has been finalized in a block, the account (and network) state has already been mutated by the ' +
    'accepted copy, so the node will reject the retry.',
  "transaction 0xfeedface was accepted into the node's mempool at block 7 but the local store update failed. " +
    'The pending store update is attached and can be re-applied later via `apply_transaction_update`. ' +
    'Resubmitting the same transaction will be rejected if the original is still in the mempool or has been ' +
    'finalized in a block, because the account (and network) state has already been mutated by the accepted copy.'
];

describe('extractSdkErrorCode', () => {
  it('reads `code`, the property web-sdk actually sets', () => {
    expect(extractSdkErrorCode(Object.assign(new Error('x'), { code: 'ACCOUNT_NOT_FOUND_ON_CHAIN' }))).toBe(
      'ACCOUNT_NOT_FOUND_ON_CHAIN'
    );
  });

  it('reads `errorCode`, the property the offscreen bus re-attaches', () => {
    expect(extractSdkErrorCode(Object.assign(new Error('x'), { errorCode: 'SOMETHING' }))).toBe('SOMETHING');
  });

  it('prefers `errorCode` when both are present', () => {
    expect(extractSdkErrorCode(Object.assign(new Error('x'), { errorCode: 'a', code: 'b' }))).toBe('a');
  });

  it('returns undefined for non-objects, nullish values and non-string codes', () => {
    expect(extractSdkErrorCode(undefined)).toBeUndefined();
    expect(extractSdkErrorCode(null)).toBeUndefined();
    expect(extractSdkErrorCode('boom')).toBeUndefined();
    expect(extractSdkErrorCode(new Error('plain'))).toBeUndefined();
    expect(extractSdkErrorCode(Object.assign(new Error('x'), { code: 42 }))).toBeUndefined();
  });
});

describe('isApplyAfterSubmitError', () => {
  it.each(REAL_APPLY_AFTER_SUBMIT_MESSAGES)('matches the real SDK error text (%#)', message => {
    // No code property of any name — this is exactly what web-sdk 0.16 throws.
    const err = new Error(message);
    expect(extractSdkErrorCode(err)).toBeUndefined();
    expect(isApplyAfterSubmitError(err)).toBe(true);
  });

  it('matches when the offscreen bus has re-wrapped the SDK message', () => {
    const err = new Error(`Offscreen call 'newSendTransaction' failed: ${REAL_APPLY_AFTER_SUBMIT_MESSAGES[0]}`);
    expect(isApplyAfterSubmitError(err)).toBe(true);
  });

  it('matches through a `cause` chain', () => {
    const err = new Error('Failed to submit transaction', {
      cause: new Error(REAL_APPLY_AFTER_SUBMIT_MESSAGES[0])
    });
    expect(isApplyAfterSubmitError(err)).toBe(true);
  });

  it('still honours an explicitly attached code, for a future SDK that maps the variant', () => {
    expect(
      isApplyAfterSubmitError(Object.assign(new Error('opaque'), { errorCode: 'ApplyTransactionAfterSubmitFailed' }))
    ).toBe(true);
    expect(
      isApplyAfterSubmitError(Object.assign(new Error('opaque'), { code: 'ApplyTransactionAfterSubmitFailed' }))
    ).toBe(true);
  });

  it('accepts a bare string error', () => {
    expect(isApplyAfterSubmitError(REAL_APPLY_AFTER_SUBMIT_MESSAGES[0])).toBe(true);
    expect(isApplyAfterSubmitError('some other failure')).toBe(false);
  });

  it('does NOT match unrelated failures', () => {
    expect(isApplyAfterSubmitError(new Error('Transaction proving failed'))).toBe(false);
    expect(isApplyAfterSubmitError(new Error("was accepted into the node's mempool at block 9"))).toBe(false);
    expect(isApplyAfterSubmitError(new Error('the local store update failed'))).toBe(false);
    expect(isApplyAfterSubmitError(undefined)).toBe(false);
    expect(isApplyAfterSubmitError(null)).toBe(false);
    expect(isApplyAfterSubmitError({})).toBe(false);
    expect(isApplyAfterSubmitError(123)).toBe(false);
  });

  it('requires both phrases to come from the SAME error, not two joined ones', () => {
    // A verdict of `true` here means "the write DID reach the chain", which
    // marks the row Completed. Assembling that verdict out of two unrelated
    // errors — a wrapper that happens to mention the mempool, an inner failure
    // that happens to mention the store — reports a send that never submitted
    // as money sent. Each half alone is already rejected above; the point of
    // this case is that concatenating them must not manufacture a match.
    const split = new Error("was accepted into the node's mempool at block 9", {
      cause: new Error('the local store update failed')
    });
    expect(isApplyAfterSubmitError(split)).toBe(false);
  });

  it('stops walking a self-referential cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('loop');
    err.cause = err;
    expect(isApplyAfterSubmitError(err)).toBe(false);
  });

  it('survives an error whose message or cause is a throwing accessor', () => {
    // These are classifiers, so they run on the failure path. One that throws
    // while inspecting an error converts a handled failure into an unhandled one
    // at the worst possible moment — and the rejections reaching them cross a
    // realm boundary and a wasm-bindgen shim, so their shapes are not this
    // codebase's to guarantee.
    const throwingMessage = {};
    Object.defineProperty(throwingMessage, 'message', {
      get() {
        throw new Error('boom');
      }
    });
    expect(() => isApplyAfterSubmitError(throwingMessage)).not.toThrow();
    expect(isApplyAfterSubmitError(throwingMessage)).toBe(false);

    const throwingCause: Error & { cause?: unknown } = new Error(REAL_APPLY_AFTER_SUBMIT_MESSAGES[0]);
    Object.defineProperty(throwingCause, 'cause', {
      get() {
        throw new Error('boom');
      }
    });
    // The throw costs the rest of the chain, not the node already in hand: this
    // error's own message classifies it, and a throwing `cause` must not take
    // that away.
    expect(() => isApplyAfterSubmitError(throwingCause)).not.toThrow();
    expect(isApplyAfterSubmitError(throwingCause)).toBe(true);
  });

  it('never classifies a lock-recovery poison error as apply-after-submit, even via its cause chain (#775)', () => {
    const { WasmClientPoisonedError } = require('./wasm-client-poison');
    // The poison error's own message is a closed set, but its `cause` carries
    // the raw realm error verbatim — and this classifier walks the cause chain.
    // Misclassifying here writes a never-submitted row as Completed.
    const trapWithSdkText = new Error(
      "Transaction 0xabc was accepted into the node's mempool at block 5 but the local store update failed."
    );
    expect(isApplyAfterSubmitError(new WasmClientPoisonedError('realm-error', trapWithSdkText))).toBe(false);
    expect(isApplyAfterSubmitError(new WasmClientPoisonedError('watchdog'))).toBe(false);
  });
});

describe('isTransactionDiscardedError', () => {
  // Verbatim from both producers of this verdict: the SDK's
  // `TransactionsResource.waitFor` (`throw new Error(\`Transaction rejected: ${hex}\`)`
  // in its `isDiscarded()` branch) and the offscreen realm's in-realm poll loop,
  // which reproduces the same text so one matcher covers all three platforms.
  const DISCARDED_MESSAGE = 'Transaction rejected: 0x1234abcd';

  it('matches the discard text both realms produce', () => {
    expect(isTransactionDiscardedError(new Error(DISCARDED_MESSAGE))).toBe(true);
  });

  it('matches through the offscreen bus wrapper and a cause chain', () => {
    expect(
      isTransactionDiscardedError(new Error(`Offscreen call 'waitForTransactionCommit' failed: ${DISCARDED_MESSAGE}`))
    ).toBe(true);
    expect(isTransactionDiscardedError(new Error('commit wait failed', { cause: new Error(DISCARDED_MESSAGE) }))).toBe(
      true
    );
  });

  it('does NOT match an indeterminate timeout', () => {
    // The whole point of the distinction: a timeout leaves the transaction
    // possibly on chain, so the caller optimistically finalizes. Matching here
    // would turn every slow commit into a hard failure.
    expect(isTransactionDiscardedError(new Error('Timed out waiting for transaction 0xabc to commit'))).toBe(false);
    expect(isTransactionDiscardedError(new Error('network request failed'))).toBe(false);
    expect(isTransactionDiscardedError(undefined)).toBe(false);
    expect(isTransactionDiscardedError(null)).toBe(false);
    expect(isTransactionDiscardedError({})).toBe(false);
  });

  it('never reads a lock-recovery poison error as a node verdict (#775)', () => {
    const { WasmClientPoisonedError } = require('./wasm-client-poison');
    // An eviction is abandonment, not a chain verdict — and its `cause` carries
    // the raw realm error verbatim. Reading it as "discarded" would fail a row
    // whose transaction may well have submitted.
    expect(isTransactionDiscardedError(new WasmClientPoisonedError('realm-error', new Error(DISCARDED_MESSAGE)))).toBe(
      false
    );
    expect(isTransactionDiscardedError(new WasmClientPoisonedError('watchdog'))).toBe(false);
  });
});
