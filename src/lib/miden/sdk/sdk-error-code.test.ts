import { extractSdkErrorCode, isApplyAfterSubmitError } from './sdk-error-code';

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

  it('stops walking a self-referential cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('loop');
    err.cause = err;
    expect(isApplyAfterSubmitError(err)).toBe(false);
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
