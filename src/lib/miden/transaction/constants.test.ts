import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { GUARDIAN_REQUEST_TIMEOUT_MS, GuardianRequestTimeoutError } from 'lib/miden/guardian/native-http';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import {
  GUARDIAN_UNREACHABLE_ERROR,
  INVALID_NOTE_ERROR,
  isGuardianOutage,
  isProverProcedureMismatch,
  isUnconfirmedFailure,
  isVaultShortfallError,
  isVaultShortfallRow,
  resolveTransactionErrorMessage,
  ROTATION_FUNDING_NON_NATIVE_ERROR,
  ROTATION_FUNDING_NOTE_UNAVAILABLE_ERROR,
  ROTATION_PENDING_CONSUME_ERROR,
  RotationGateConsumeRefusal,
  TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR,
  TRANSACTION_FORCE_CANCELLED_ERROR,
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_VAULT_SHORTFALL_ERROR,
  PROVER_PROCEDURE_MISMATCH_ERROR,
  REMOTE_PROVER_FAILED_ERROR,
  LOCAL_PROVER_FAILED_ERROR,
  TRANSACTION_ENGINE_RECOVERED_ERROR,
  TRANSACTION_ENGINE_RECOVERED_PRE_WRITE_ERROR,
  TRANSACTION_EXPIRED_ERROR,
  TRANSACTION_STUCK_ERROR,
  USER_CANCELLED_TRANSACTION_REASON
} from './constants';
import { ITransaction, ITransactionStatus } from '../db/types';

// The real native-prover error captured in #487.
const MISSING_PROCEDURE =
  'MidenNativeProver: prover rejected the transaction: failed to execute transaction kernel program: ' +
  'procedure with root digest 0x8bf4fec02765083b9280422f01a814de8f2a53564797969fac2f608197727b22 could not be found';

describe('isProverProcedureMismatch', () => {
  it('matches the native-prover missing-procedure signature', () => {
    expect(isProverProcedureMismatch(new Error(MISSING_PROCEDURE))).toBe(true);
  });

  it('matches regardless of order/casing of the two markers', () => {
    expect(isProverProcedureMismatch('Could Not Be Found ... procedure with root digest 0xabc')).toBe(true);
  });

  it('does not match a transient prover timeout', () => {
    expect(isProverProcedureMismatch(new Error('request timeout while proving'))).toBe(false);
  });

  it('does not match an unrelated failure', () => {
    expect(isProverProcedureMismatch(new Error('insufficient balance'))).toBe(false);
  });
});

describe('resolveTransactionErrorMessage', () => {
  it('surfaces the real cause for a native-prover procedure mismatch instead of a remote-timeout relabel (#487)', () => {
    // On the delegated proving stage a generic failure is rewritten to
    // REMOTE_PROVER_FAILED_ERROR ("please try again"); a deterministic procedure
    // mismatch must keep its own message instead of that misleading copy.
    expect(resolveTransactionErrorMessage(new Error(MISSING_PROCEDURE), 'proving', true)).toBe(
      PROVER_PROCEDURE_MISMATCH_ERROR
    );
    expect(resolveTransactionErrorMessage(new Error(MISSING_PROCEDURE), 'proving', true)).not.toBe(
      REMOTE_PROVER_FAILED_ERROR
    );
    // Same when local/native proving ran (non-delegated), under the broad
    // 'sending' stage.
    expect(resolveTransactionErrorMessage(new Error(MISSING_PROCEDURE), 'sending', false)).toBe(
      PROVER_PROCEDURE_MISMATCH_ERROR
    );
  });

  it('refuses to promise "no funds moved" for a lock-recovery eviction at the proving stage (#775)', () => {
    // The stage-based copy is only honest for an error that STOPPED the
    // pipeline. An eviction abandons one that keeps running and can still
    // submit, so the reassuring version would be a promise the wallet cannot
    // keep — and it invites the retry that pays twice.
    const poisoned = new WasmClientPoisonedError('watchdog');
    expect(resolveTransactionErrorMessage(poisoned, 'proving', true)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    expect(resolveTransactionErrorMessage(poisoned, 'proving', true)).not.toBe(REMOTE_PROVER_FAILED_ERROR);
    // Local prover, and the broad non-guardian 'sending' stage, take the same
    // hedged copy rather than "please try again".
    expect(resolveTransactionErrorMessage(poisoned, 'proving', false)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    expect(resolveTransactionErrorMessage(poisoned, 'sending', true)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    expect(resolveTransactionErrorMessage(poisoned, undefined, undefined)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
  });

  it('drops the hedge when the caller proved the abandonment landed BEFORE any write (#777)', () => {
    // The hedge is honest only where a submit is possible. `cancel.ts` can prove it is
    // not — a row still at a pre-write stage with no `processingStartedAt` was never
    // picked up — and there the hedge is a falsehood that costs something real: it tells
    // the user to go check their activity and wait, on a row whose Retry is safe. The
    // extension reaches this on a routine non-critical `deadline-no-kill`.
    for (const error of [new WasmClientPoisonedError('watchdog'), new OperationAbortedError('op-1', 'deadline')]) {
      expect(resolveTransactionErrorMessage(error, 'syncing', false, true)).toBe(
        TRANSACTION_ENGINE_RECOVERED_PRE_WRITE_ERROR
      );
      // Absent or false, the hedge stands: the flag is opt-in, so no existing caller
      // silently starts promising "nothing was submitted".
      expect(resolveTransactionErrorMessage(error, 'syncing', false, false)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
      expect(resolveTransactionErrorMessage(error, 'syncing', false)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    }
    // And it never leaks onto an unrelated error, whose stage copy is already accurate.
    expect(resolveTransactionErrorMessage(new Error(MISSING_PROCEDURE), 'proving', false, true)).toBe(
      PROVER_PROCEDURE_MISMATCH_ERROR
    );
  });

  it('hedges the same way for an offscreen DEADLINE kill, not just a watchdog eviction (#777)', () => {
    // The other half of the same equivalence class. `cancel.ts` stamps
    // `mayHaveSubmitted` for an abort exactly as it does for a poison, so the
    // reassuring copy put "No funds moved — please try again" on the very row whose
    // Retry then refuses with "may already have been submitted": two contradictory
    // statements about the same money, from one error.
    const aborted = new OperationAbortedError('op-1', 'offscreen deadline');
    expect(resolveTransactionErrorMessage(aborted, 'proving', true)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    expect(resolveTransactionErrorMessage(aborted, 'proving', true)).not.toBe(REMOTE_PROVER_FAILED_ERROR);
    expect(resolveTransactionErrorMessage(aborted, 'proving', false)).not.toBe(LOCAL_PROVER_FAILED_ERROR);
    expect(resolveTransactionErrorMessage(aborted, 'sending', true)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
  });

  it('still maps a generic delegated proving failure to the remote-prover message', () => {
    expect(resolveTransactionErrorMessage(new Error('prover exploded'), 'proving', true)).toBe(
      REMOTE_PROVER_FAILED_ERROR
    );
  });

  it('still maps a generic local proving failure to the local-prover message', () => {
    expect(resolveTransactionErrorMessage(new Error('prover exploded'), 'proving', false)).toBe(
      LOCAL_PROVER_FAILED_ERROR
    );
  });

  it('passes through an unrelated failure raw', () => {
    expect(resolveTransactionErrorMessage(new Error('insufficient balance'), 'sending')).toBe(
      'Error: insufficient balance'
    );
  });

  it('names an unreachable guardian before submit in plain language (#779)', () => {
    // Hedged between the guardian and the network, since the proposal stages also call the node.
    expect(resolveTransactionErrorMessage(new TypeError('Failed to fetch'), 'creating-proposal')).toBe(
      'The guardian or the Miden network could not be reached, so this transaction was not sent. Your funds are ' +
        'safe; try again in a moment.'
    );
    expect(
      resolveTransactionErrorMessage(Object.assign(new Error('Bad Gateway'), { status: 502 }), 'signing-proposal')
    ).toBe(GUARDIAN_UNREACHABLE_ERROR);
  });

  it('leaves an unreachable-looking failure at any other stage raw (#779)', () => {
    expect(resolveTransactionErrorMessage(new TypeError('Failed to fetch'), 'sending')).toBe(
      'TypeError: Failed to fetch'
    );
  });

  it('names a fee or vault failure a guardian 5xx carries rather than calling it unreachable (#779)', () => {
    // A 5xx reads as unreachable, but the kernel's own code in its text is the more specific reading.
    const feeCode = Object.assign(new Error('assertion failed with error code: 14712559985122731094'), {
      status: 500
    });
    expect(resolveTransactionErrorMessage(feeCode, 'creating-proposal')).toBe(
      TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR
    );
    const shortfall = Object.assign(
      new Error('the amount of the asset in the vault is less than the amount to remove'),
      { status: 502 }
    );
    expect(resolveTransactionErrorMessage(shortfall, 'signing-proposal')).toBe(TRANSACTION_VAULT_SHORTFALL_ERROR);
  });

  it.each(['creating-proposal', 'signing-proposal'] as const)(
    'passes the reaper reasons through unchanged at %s, where every requeued row is reaped (#779)',
    stage => {
      // The reapers write these as bare strings; a copy edit adding "timed out" or "connection" would otherwise
      // relabel every reaped row as a guardian outage.
      expect(resolveTransactionErrorMessage(TRANSACTION_EXPIRED_ERROR, stage)).toBe(TRANSACTION_EXPIRED_ERROR);
      expect(resolveTransactionErrorMessage(TRANSACTION_STUCK_ERROR, stage)).toBe(TRANSACTION_STUCK_ERROR);
    }
  );
});
describe('fee failures', () => {
  const vaultShortfall = new Error(
    'failed to execute transaction kernel program: failed to remove the fungible asset from ' +
      'the vault since the amount of the asset in the vault is less than the amount to remove'
  );

  it('does not attribute the generic vault-shortfall assertion to the fee', () => {
    // The kernel assertion says a vault held less of SOME asset than the transaction
    // tried to remove -- it does not say which. The fee is one producer; an ordinary
    // send against a stale local balance is another, and `resolveHeldFungibleAsset`
    // documents two more. Attributing all of them to the fee told users holding plenty
    // of MIDEN to "Receive some MIDEN", and called a stale-state failure deterministic
    // -- talking them out of the resync that actually fixes it.
    const message = resolveTransactionErrorMessage(vaultShortfall);
    expect(message).toBe(TRANSACTION_VAULT_SHORTFALL_ERROR);
    expect(message).not.toBe(TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR);
  });

  it('still replaces that raw assertion with something a user can act on', () => {
    // Not attributing it is not the same as passing the kernel text through: raw, it
    // reads as an internal error. The replacement names both candidates and points at
    // the resync, without claiming which asset fell short.
    const message = resolveTransactionErrorMessage(vaultShortfall);
    expect(message).not.toContain('transaction kernel program');
    expect(message).toContain('network fee');
  });

  it('names a missing fee conversion info abort rather than its numeric error code', () => {
    // ERR_FEE_CONVERSION_INFO_MISSING surfaces only as a hashed code, which tells
    // the user nothing and tells support even less.
    const err = new Error('assertion failed with error code: 14712559985122731094');
    expect(resolveTransactionErrorMessage(err)).toBe(TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR);
  });

  it('does not blame the balance for a missing conversion-info commitment', () => {
    // The code says "requires conversion info", not "insufficient funds". The old
    // copy read "Not enough MIDEN to pay the network fee. Receive some MIDEN and
    // try again", which on a Guardian custom proposal sent the user to top up an
    // account that was already funded — the one action that provably cannot help.
    const err = new Error('assertion failed with error code: 14712559985122731094');
    const message = resolveTransactionErrorMessage(err);
    expect(message).not.toMatch(/receive some miden/i);
    expect(message).not.toMatch(/not enough/i);
  });
});

describe('the vault shortfall by its kernel code (#805)', () => {
  // What an unfunded account's rotation failed with on a fee-charging chain: the code, no text.
  const codeOnly = 'assertion failed with error code: 644413868907058392';

  it('maps the code-only kernel line to the vault-shortfall copy', () => {
    expect(isVaultShortfallError(codeOnly)).toBe(true);
    expect(resolveTransactionErrorMessage(new Error(codeOnly))).toBe(TRANSACTION_VAULT_SHORTFALL_ERROR);
  });

  it('reads the code-only line in a guardian 5xx as the shortfall, not an outage to retry (#779)', () => {
    const in5xx = Object.assign(new Error(codeOnly), { status: 500 });
    expect(isGuardianOutage(in5xx)).toBe(false);
    expect(resolveTransactionErrorMessage(in5xx, 'creating-proposal')).toBe(TRANSACTION_VAULT_SHORTFALL_ERROR);
  });

  it('keeps the conversion-info reading when a line carries both codes', () => {
    const both = new Error('assertion failed with error code: 14712559985122731094, then 644413868907058392');
    expect(resolveTransactionErrorMessage(both)).toBe(TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR);
  });

  it('does not read another kernel code as a shortfall', () => {
    expect(isVaultShortfallError('assertion failed with error code: 9876543210')).toBe(false);
  });
});

describe('isVaultShortfallRow', () => {
  type RowShape = Pick<ITransaction, 'type' | 'status' | 'error' | 'rawError'>;
  const failedRotation: RowShape = { type: 'replace-hot-key', status: ITransactionStatus.Failed };

  it('is true for a failed rotation classified as a vault shortfall', () => {
    expect(isVaultShortfallRow({ ...failedRotation, error: TRANSACTION_VAULT_SHORTFALL_ERROR })).toBe(true);
  });

  it('is true for a failed rotation an older build left with the raw code-only line', () => {
    expect(
      isVaultShortfallRow({ ...failedRotation, error: 'assertion failed with error code: 644413868907058392' })
    ).toBe(true);
  });

  it('reads the raw error when the display message was rewritten', () => {
    const row: RowShape = {
      ...failedRotation,
      error: 'Something else',
      rawError: 'Error: assertion failed with error code: 644413868907058392'
    };
    expect(isVaultShortfallRow(row)).toBe(true);
  });

  it('is false for a rotation that failed for another reason', () => {
    expect(isVaultShortfallRow({ ...failedRotation, error: 'guardian unreachable' })).toBe(false);
    expect(isVaultShortfallRow(failedRotation)).toBe(false);
  });

  it('is false for other types and for a rotation that has not failed', () => {
    expect(isVaultShortfallRow({ ...failedRotation, type: 'consume', error: TRANSACTION_VAULT_SHORTFALL_ERROR })).toBe(
      false
    );
    expect(
      isVaultShortfallRow({
        ...failedRotation,
        status: ITransactionStatus.Queued,
        error: TRANSACTION_VAULT_SHORTFALL_ERROR
      })
    ).toBe(false);
  });
});

// The one predicate the rotation gate (HotKeyRotationGate.selectors) and Activity History both
// read a failed row through (#1250), so the two never disagree on which rows are unconfirmed.
describe('isUnconfirmedFailure', () => {
  type Row = Pick<ITransaction, 'type' | 'status' | 'error' | 'rawError' | 'mayHaveSubmitted' | 'processingStartedAt'> &
    Partial<Pick<ITransaction, 'extraInputs'>>;
  const failed = (extra: Partial<Row> = {}): Row => ({ type: 'send', status: ITransactionStatus.Failed, ...extra });

  it.each<[string, Row]>([
    ['mayHaveSubmitted', failed({ mayHaveSubmitted: true })],
    [
      'a non-rotation row with the vault-shortfall error and mayHaveSubmitted',
      failed({ error: TRANSACTION_VAULT_SHORTFALL_ERROR, mayHaveSubmitted: true })
    ],
    ['the engine-recovered copy as error', failed({ error: TRANSACTION_ENGINE_RECOVERED_ERROR })],
    ['the stuck-reaper reason as error', failed({ error: TRANSACTION_STUCK_ERROR })],
    [
      'the stuck-reaper reason as rawError under a classifier prover rewrite',
      failed({ error: LOCAL_PROVER_FAILED_ERROR, rawError: TRANSACTION_STUCK_ERROR })
    ],
    ['the cold-start-sweep reason as error', failed({ error: TRANSACTION_INTERRUPTED_ON_STARTUP })],
    [
      'the cold-start-sweep reason as rawError under a classifier prover rewrite',
      failed({ error: LOCAL_PROVER_FAILED_ERROR, rawError: TRANSACTION_INTERRUPTED_ON_STARTUP })
    ],
    ['the not-landed-consume reason as error', failed({ error: TRANSACTION_INTERRUPTED_ERROR })],
    [
      'the not-landed-consume reason as rawError under a classifier prover rewrite',
      failed({ error: LOCAL_PROVER_FAILED_ERROR, rawError: TRANSACTION_INTERRUPTED_ERROR })
    ],
    ['the debug force-cancel reason as error', failed({ error: TRANSACTION_FORCE_CANCELLED_ERROR })],
    [
      'the debug force-cancel reason as rawError under a classifier prover rewrite',
      failed({ error: LOCAL_PROVER_FAILED_ERROR, rawError: TRANSACTION_FORCE_CANCELLED_ERROR })
    ],
    [
      'a user cancel the write stamp reached',
      failed({ error: USER_CANCELLED_TRANSACTION_REASON, processingStartedAt: 1_700_000_000 })
    ],
    [
      'a bridged-send whose fill is still pending, mayHaveSubmitted',
      failed({ type: 'bridged-send', mayHaveSubmitted: true, extraInputs: { epochStatus: 'pending' } })
    ],
    [
      'a bridged-send whose fill confirmed, mayHaveSubmitted',
      failed({ type: 'bridged-send', mayHaveSubmitted: true, extraInputs: { epochStatus: 'confirmed' } })
    ],
    [
      'a send row carrying the discard marker, mayHaveSubmitted',
      failed({ mayHaveSubmitted: true, extraInputs: { nodeDiscarded: true } })
    ],
    [
      'a rotation whose error names the discard but carries no marker, mayHaveSubmitted',
      failed({
        type: 'replace-hot-key',
        error: 'Guardian replace-hot-key 0xabc did not land: the node discarded it.',
        mayHaveSubmitted: true
      })
    ]
  ])('is true for %s', (_label, row) => {
    expect(isUnconfirmedFailure(row)).toBe(true);
  });

  it.each<[string, Row]>([
    ['a user cancel the write stamp never reached', failed({ error: USER_CANCELLED_TRANSACTION_REASON })],
    ['the expired-in-queue final reason', failed({ error: TRANSACTION_EXPIRED_ERROR })],
    ['the invalid-note final reason', failed({ error: INVALID_NOTE_ERROR })],
    ['an unclassified failure before the submit crossing', failed({ error: 'some other reason' })],
    ['a row that has not failed', { type: 'send', status: ITransactionStatus.Queued, error: TRANSACTION_STUCK_ERROR }],
    [
      'a shortfall rotation row with the vault-shortfall error and mayHaveSubmitted',
      failed({ type: 'replace-hot-key', error: TRANSACTION_VAULT_SHORTFALL_ERROR, mayHaveSubmitted: true })
    ],
    [
      'a shortfall rotation row with the raw kernel shortfall line as rawError and mayHaveSubmitted',
      failed({
        type: 'replace-hot-key',
        rawError: 'assertion failed with error code: 644413868907058392',
        mayHaveSubmitted: true
      })
    ],
    [
      'a bridged-send its own route evidence proves failed, mayHaveSubmitted (#1250)',
      failed({ type: 'bridged-send', mayHaveSubmitted: true, extraInputs: { epochStatus: 'failed' } })
    ],
    [
      'a rotation row with no extraInputs at all',
      { type: 'replace-hot-key', status: ITransactionStatus.Failed, error: 'guardian unreachable' }
    ],
    [
      'a switch-guardian row the node discarded, mayHaveSubmitted (#1233)',
      failed({ type: 'switch-guardian', mayHaveSubmitted: true, extraInputs: { nodeDiscarded: true } })
    ],
    [
      'a replace-hot-key row the node discarded, mayHaveSubmitted (#1233)',
      failed({ type: 'replace-hot-key', mayHaveSubmitted: true, extraInputs: { nodeDiscarded: true } })
    ],
    [
      'a update-procedure-threshold row the node discarded, mayHaveSubmitted (#1233)',
      failed({ type: 'update-procedure-threshold', mayHaveSubmitted: true, extraInputs: { nodeDiscarded: true } })
    ]
  ])('is false for %s', (_label, row) => {
    expect(isUnconfirmedFailure(row)).toBe(false);
  });
});

describe('RotationGateConsumeRefusal', () => {
  it.each([ROTATION_PENDING_CONSUME_ERROR, ROTATION_FUNDING_NOTE_UNAVAILABLE_ERROR, ROTATION_FUNDING_NON_NATIVE_ERROR])(
    'lands on the row as written: %s',
    message => {
      expect(resolveTransactionErrorMessage(new RotationGateConsumeRefusal(message))).toBe(message);
    }
  );

  it('keeps its own text at a proving stage and over a shortfall reading', () => {
    const refusal = new RotationGateConsumeRefusal(
      'amount of the asset in the vault is less than the amount to remove'
    );
    expect(resolveTransactionErrorMessage(refusal, 'proving', true)).toBe(refusal.message);
  });

  it('is never read as a guardian outage, whatever its text (#779)', () => {
    // The requeue arm would retry a refusal until it expired, holding back the gate's claim or rotation meanwhile.
    expect(isGuardianOutage(new RotationGateConsumeRefusal('connection timed out'))).toBe(false);
  });
});

describe('a Guardian request timeout as an outage (#1313)', () => {
  const timeout = () =>
    new GuardianRequestTimeoutError('https://guardian.test/delta/proposal', GUARDIAN_REQUEST_TIMEOUT_MS);
  const wrap = (cause: Error) => Object.assign(new Error('could not create the proposal'), { cause });

  it('is an outage wherever it sits in the cause chain', () => {
    expect(isGuardianOutage(timeout())).toBe(true);
    expect(isGuardianOutage(wrap(timeout()))).toBe(true);
    expect(resolveTransactionErrorMessage(wrap(timeout()), 'creating-proposal')).toBe(GUARDIAN_UNREACHABLE_ERROR);
  });

  it('is never an outage under a killed pipeline, at any depth', () => {
    // A requeue would re-broadcast a write that may have submitted, and the copy would say it was not sent.
    const poisoned = new WasmClientPoisonedError('realm-error', timeout());
    const aborted = Object.assign(new OperationAbortedError('op-1', 'deadline'), { cause: timeout() });
    expect(isGuardianOutage(poisoned)).toBe(false);
    expect(isGuardianOutage(aborted)).toBe(false);
    expect(isGuardianOutage(wrap(poisoned))).toBe(false);
    expect(isGuardianOutage(wrap(aborted))).toBe(false);
  });

  it('never reads a wrapped kill as an outage, even with no timeout in its chain', () => {
    const abort = new OperationAbortedError('op-1', 'deadline');
    const wrapped = Object.assign(new Error(`could not create the proposal: ${abort.message}`), { cause: abort });
    expect(isGuardianOutage(wrapped)).toBe(false);
    expect(resolveTransactionErrorMessage(wrapped, 'creating-proposal')).not.toBe(GUARDIAN_UNREACHABLE_ERROR);
  });

  it('ends on a cyclic cause chain', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(isGuardianOutage(a)).toBe(false);
  });
});
