import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { ProposalChainSyncError } from 'lib/miden/guardian';
import { GUARDIAN_REQUEST_TIMEOUT_MS, GuardianRequestTimeoutError } from 'lib/miden/guardian/native-http';
import { markFailedReexecution, StaleProofError } from 'lib/miden/guardian/proof-freshness';
import { ApplyAfterSubmitError, SubmitCrossingUnrecordedError } from 'lib/miden/sdk/sdk-error-code';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import {
  chunkAutoConsumeBatch,
  deterministicKernelFailureCopy,
  ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH_CODE,
  formatRawTransactionError,
  GUARDIAN_UNREACHABLE_ERROR,
  guardianHoldRetryMessage,
  INVALID_NOTE_ERROR,
  isFeeConversionCommitmentMismatchError,
  isGuardianOutage,
  isNodeOutage,
  isOutcomeUnconfirmed,
  isProverProcedureMismatch,
  isUnconfirmedFailure,
  isVaultShortfallError,
  isVaultShortfallRow,
  resolveTransactionErrorMessage,
  ROTATION_FUNDING_NON_NATIVE_ERROR,
  ROTATION_FUNDING_NOTE_UNAVAILABLE_ERROR,
  ROTATION_PENDING_CONSUME_ERROR,
  RotationGateConsumeRefusal,
  STALE_PROOF_ERROR,
  SUBMIT_CROSSING_UNRECORDED_ERROR,
  TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR,
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
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

describe('chunkAutoConsumeBatch', () => {
  const notes = (count: number, amount: string) =>
    Array.from({ length: count }, (_unused, index) => ({ id: `n${String(index).padStart(2, '0')}`, amount }));

  it('keeps a batch of up to eight notes whole, whatever it is worth, since the caller measured it', () => {
    expect(chunkAutoConsumeBatch(notes(8, '1'), 10000).map(chunk => chunk.length)).toEqual([8]);
  });

  it('splits a larger batch into chunks of eight in id order and leaves out a chunk not worth its own fee', () => {
    // 20 notes of 5 fees: two chunks of 8 are worth 40 fees each, the 4 left over only the floor.
    const chunks = chunkAutoConsumeBatch([...notes(20, '50000')].reverse(), 10000);
    expect(chunks.map(chunk => chunk.map(note => note.id))).toEqual([
      notes(8, '50000').map(note => note.id),
      notes(16, '50000')
        .slice(8)
        .map(note => note.id)
    ]);
  });

  it('keeps every chunk on a chain that charges no fee', () => {
    expect(chunkAutoConsumeBatch(notes(20, '1'), 0).map(chunk => chunk.length)).toEqual([8, 8, 4]);
  });
});

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
    for (const error of [
      new WasmClientPoisonedError('watchdog'),
      new OperationAbortedError('op-1', 'deadline'),
      new Error('WebClient terminated')
    ]) {
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

  it('hedges the same way for a terminated client, and leaves the landed shape to its own copy', () => {
    for (const message of ['Client terminated', 'WebClient terminated']) {
      const wrapped = new Error('send failed', { cause: new Error(message) });
      expect(resolveTransactionErrorMessage(wrapped, 'proving', true)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
      expect(resolveTransactionErrorMessage(wrapped, 'sending', false)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    }
    const landed = new ApplyAfterSubmitError(new Error('Client terminated'));
    expect(resolveTransactionErrorMessage(landed, 'sending', true)).not.toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
  });

  it('hedges the same way for a kill wrapped in another error (#1313)', () => {
    const wrapped = new Error('could not create the proposal', {
      cause: new OperationAbortedError('op-1', 'deadline')
    });
    expect(resolveTransactionErrorMessage(wrapped, 'creating-proposal')).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    expect(resolveTransactionErrorMessage(wrapped, 'syncing', false, true)).toBe(
      TRANSACTION_ENGINE_RECOVERED_PRE_WRITE_ERROR
    );
  });

  it('names a failed crossing write as nothing sent, never as a prover failure, at any depth (#1081)', () => {
    const crossing = new SubmitCrossingUnrecordedError('tx-1', new Error('QuotaExceededError'));
    const wrapped = new Error('the send failed', { cause: crossing });
    for (const error of [crossing, wrapped]) {
      for (const delegateTransaction of [true, false]) {
        expect(resolveTransactionErrorMessage(error, 'proving', delegateTransaction)).toBe(
          SUBMIT_CROSSING_UNRECORDED_ERROR
        );
      }
    }
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

describe('a dApp request whose own fee commitment does not verify (#1475)', () => {
  // What the extension stored for #1475: the offscreen wrapper, the SDK chain and the kernel's ANSI marks.
  const reported = new Error(
    "Offscreen call 'newTransaction' failed: failed to execute transaction: transaction execution failed: " +
      'failed to execute transaction kernel program: \x1b[31mx\x1b[0m assertion failed with error code: ' +
      '15404814807981965102'
  );

  it('names the dApp request instead of the hashed kernel code', () => {
    expect(resolveTransactionErrorMessage(reported, 'sending')).toBe(TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR);
  });

  it('is the code of the masm message', () => {
    expect(ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH_CODE).toBe('15404814807981965102');
    expect(isFeeConversionCommitmentMismatchError('assertion failed with error code: 15404814807981965102')).toBe(true);
  });

  it('does not read a longer number that contains the code', () => {
    expect(isFeeConversionCommitmentMismatchError('error code: 115404814807981965102')).toBe(false);
    expect(isFeeConversionCommitmentMismatchError('error code: 154048148079819651021')).toBe(false);
  });

  it('says a retry fails the same way and does not blame the balance', () => {
    expect(TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR).toMatch(/dApp/);
    expect(TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR).toMatch(/nothing was submitted/);
    expect(TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR).toMatch(/fail the same way/);
    expect(TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR).not.toMatch(/balance|receive some/i);
  });

  it('leaves the missing-info code its own copy', () => {
    const missing = new Error('assertion failed with error code: 14712559985122731094');
    expect(resolveTransactionErrorMessage(missing)).toBe(TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR);
  });
});

// The dApp consent sheet reads a failed dry run through this helper, so it must give exactly the Failed row's copy.
describe('deterministicKernelFailureCopy', () => {
  it.each([
    ['14712559985122731094', TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR],
    ['15404814807981965102', TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR],
    ['644413868907058392', TRANSACTION_VAULT_SHORTFALL_ERROR]
  ])('agrees with the classifier for code %s', (code, copy) => {
    const raw = `failed to execute transaction kernel program: assertion failed with error code: ${code}`;
    expect(deterministicKernelFailureCopy(raw)).toBe(copy);
    expect(resolveTransactionErrorMessage(new Error(raw), 'sending')).toBe(copy);
  });

  it('names nothing for text without a code the classifier names', () => {
    expect(deterministicKernelFailureCopy('assertion failed with error code: 9876543210')).toBeUndefined();
    expect(deterministicKernelFailureCopy('note not found')).toBeUndefined();
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

describe('isUnconfirmedFailure and isOutcomeUnconfirmed (#1081)', () => {
  const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const failed = (overrides: Partial<ITransaction> = {}): ITransaction => ({
    id: 'r',
    type: 'send',
    accountId: 'a',
    status: ITransactionStatus.Failed,
    initiatedAt: 1,
    displayIcon: 'FAILED',
    error: 'Some failure',
    ...overrides
  });
  const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
    attemptId: 'a',
    capturedAt: 1,
    source: 'stage',
    ...overrides
  });

  it('a proven row is not unconfirmed, although it still carries mayHaveSubmitted', () => {
    expect(isUnconfirmedFailure(failed({ mayHaveSubmitted: true }))).toBe(true);
    expect(isUnconfirmedFailure(failed({ mayHaveSubmitted: true, neverCommittedAt: 5 }))).toBe(false);
  });

  it('an Unconfirmed row is not confirmed, whatever else it holds', () => {
    expect(isOutcomeUnconfirmed(failed({ status: ITransactionStatus.Unconfirmed }))).toBe(true);
  });

  it('a Failed eligible row with an unresolved entry reads not confirmed; dead or retired entries do not', () => {
    expect(isOutcomeUnconfirmed(failed({ submitEvidence: [entry({ transactionId: hex(1) })] }))).toBe(true);
    expect(isOutcomeUnconfirmed(failed({ submitEvidence: [entry({ verdict: 'never-committed' })] }))).toBe(false);
    expect(isOutcomeUnconfirmed(failed({ submitEvidence: [entry({ preSubmitEnd: true })] }))).toBe(false);
    expect(
      isOutcomeUnconfirmed(failed({ submitEvidence: [entry(), entry({ attemptId: 'b', preSubmitEnd: true })] }))
    ).toBe(true);
    expect(isOutcomeUnconfirmed(failed({ submitEvidence: [entry()], neverCommittedAt: 5 }))).toBe(false);
  });

  // Only a Failed row's open entry speaks for it: the screens read this predicate for every row they show.
  it.each([
    ['Queued', ITransactionStatus.Queued],
    ['GeneratingTransaction', ITransactionStatus.GeneratingTransaction],
    ['Completed', ITransactionStatus.Completed]
  ])('a %s row with an open entry is not not-confirmed', (_label, status) => {
    expect(isOutcomeUnconfirmed(failed({ status, error: undefined, submitEvidence: [entry()] }))).toBe(false);
  });

  it('an ineligible row`s entries are inert, and a definite failure stays one', () => {
    expect(isOutcomeUnconfirmed(failed({ type: 'earn-deposit', submitEvidence: [entry()] }))).toBe(false);
    expect(isOutcomeUnconfirmed(failed({ restoredFromBackup: true, submitEvidence: [entry()] }))).toBe(false);
    expect(
      isOutcomeUnconfirmed(
        failed({
          type: 'bridged-send',
          extraInputs: { provider: 'agglayer', epochStatus: 'failed' },
          submitEvidence: [entry()]
        })
      )
    ).toBe(false);
  });
});

describe('a proof that kept going stale (#2060)', () => {
  it.each([
    ['at the stage that reads as a prover failure, delegated', 'proving', true],
    ['at the stage that reads as a prover failure, local', 'proving', false],
    ['on an extension row, whose stage stays at sending', 'sending', true]
  ] as const)('never blames the prover %s', (_label, stage, delegated) => {
    expect(resolveTransactionErrorMessage(new StaleProofError(), stage, delegated)).toBe(STALE_PROOF_ERROR);
  });

  it('reads the same through a wrapper', () => {
    const wrapped = new Error('wrapped', { cause: new StaleProofError() });
    expect(resolveTransactionErrorMessage(wrapped, 'proving', true)).toBe(STALE_PROOF_ERROR);
  });

  it('lets a kill in the chain win, since that pipeline may still submit', () => {
    const killed = new WasmClientPoisonedError('watchdog', new StaleProofError());
    expect(resolveTransactionErrorMessage(killed, 'proving', true)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
  });

  it('tells the user nothing went out and to try again', () => {
    expect(STALE_PROOF_ERROR).toMatch(/nothing was sent and no funds moved/);
    expect(STALE_PROOF_ERROR).toMatch(/try again/);
  });

  it('reads as Failed, not Not confirmed', () => {
    expect(isUnconfirmedFailure({ type: 'send', status: ITransactionStatus.Failed, error: STALE_PROOF_ERROR })).toBe(
      false
    );
  });
});

describe('a sync or execute that failed on a re-execution (#2060)', () => {
  it.each([
    ['a dropped request, delegated', 'Failed to fetch', true],
    ['a dropped request, local', 'Failed to fetch', false],
    ['a timeout, delegated', 'sync timeout', true],
    ['a timeout, local', 'sync timeout', false]
  ])('keeps its own words at the proving stage: %s', (_label, message, delegated) => {
    const failure = markFailedReexecution(new Error(message));
    expect(resolveTransactionErrorMessage(failure, 'proving', delegated)).toBe(formatRawTransactionError(failure));
  });

  it('keeps the kernel copy a failed execute earns', () => {
    const shortfall = new Error('the amount of the asset in the vault is less than the amount to remove');
    expect(resolveTransactionErrorMessage(markFailedReexecution(shortfall), 'proving', true)).toBe(
      TRANSACTION_VAULT_SHORTFALL_ERROR
    );
  });

  it('leaves a kill as a kill, since that pipeline may still submit', () => {
    const killed = markFailedReexecution(new WasmClientPoisonedError('watchdog', new Error('evicted')));
    expect(resolveTransactionErrorMessage(killed, 'proving', true)).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
  });

  it('leaves every other failure at the proving stage to the prover', () => {
    expect(resolveTransactionErrorMessage(new Error('Failed to fetch'), 'proving', true)).toBe(
      REMOTE_PROVER_FAILED_ERROR
    );
  });
});

describe('guardianHoldRetryMessage (#2060)', () => {
  // AM and PM are no zone, and a runner in UTC has no offset to print, so a bare GMT or UTC has to pass.
  const NAMES_A_ZONE = /\b(?:(?:GMT|UTC)(?:[+-]\d{1,2}(?::\d{2})?)?|(?![AP]M\b)[A-Z]{2,5})\b/;

  it('names an explicit zone or UTC offset', () => {
    expect(guardianHoldRetryMessage(Math.floor(Date.now() / 1000) + 600)).toMatch(NAMES_A_ZONE);
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

describe('a failed proposal chain sync as an outage (#1442)', () => {
  it('reads as an outage, so a value-moving row requeues', () => {
    expect(isGuardianOutage(new ProposalChainSyncError(new TypeError('Failed to fetch')))).toBe(true);
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
    const terminated = Object.assign(new Error('WebClient terminated'), { cause: timeout() });
    expect(isGuardianOutage(poisoned)).toBe(false);
    expect(isGuardianOutage(aborted)).toBe(false);
    expect(isGuardianOutage(terminated)).toBe(false);
    expect(isGuardianOutage(wrap(poisoned))).toBe(false);
    expect(isGuardianOutage(wrap(aborted))).toBe(false);
    expect(isGuardianOutage(wrap(terminated))).toBe(false);
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

describe('a node that gave the leaf no usable answer (#2060)', () => {
  // web-sdk's `build_error_chain`: its context, `ClientError::RpcError`, the request, then the tonic status.
  const REQUEST = 'failed to sync chain: RPC error: grpc request failed for sync_chain_mmr: ';
  const EXECUTE_REQUEST = 'failed to execute transaction: RPC error: grpc request failed for get_account: ';
  const UNAVAILABLE = 'Miden node is unavailable; check that the node is running and reachable';
  const INTERNAL = 'Miden node returned an internal error; this is likely a node-side issue';
  const HEADER_MISSING = 'grpc-status header missing, mapped from HTTP status code';
  // idxdb-store's `await_js_value`. wasm-bindgen's Debug prints the rejection's name, message and stack, and Dexie
  // words an aborted transaction 'AbortError: <cause's name> <cause's message>'.
  const STORE_REJECTED = 'database-related non-query error: failed to apply state sync: ';

  it.each([
    ['the SDK naming an unavailable node', `${REQUEST}${UNAVAILABLE}`],
    ['the SDK timing a request out', `${REQUEST}request to Miden node timed out; the node may be under heavy load`],
    ['a dropped request the SDK has no status for', `${REQUEST}unknown error: `],
    ['a cancelled request', `${REQUEST}operation was cancelled`],
    ['an aborted request', `${REQUEST}operation was aborted`],
    ['a node-side failure', `${REQUEST}${INTERNAL}`],
    ['a rate limit', `${REQUEST}request was rate-limited or the node's resources are exhausted; retry after a delay`],
    [
      'an outage, whatever its status says',
      `${EXECUTE_REQUEST}${UNAVAILABLE}: code: 'The service is currently unavailable', message: "no healthy upstream"`
    ],
    ['a connection that never opened', 'failed to execute transaction: RPC error: failed to connect to the Miden node'],
    ['Chrome dropping a fetch', 'Failed to fetch'],
    ['WebKit dropping a fetch', 'Load failed'],
    ['WebKit losing a connection', 'The network connection was lost.'],
    ['a named read that failed on the network', `failed to fetch note script via RPC: ${REQUEST}${UNAVAILABLE}`],
    ['a gateway that is struggling', 'transport error: status code 503'],
    [
      'a failed connection under the data store wrapper, which only sounds like the store',
      'failed to execute transaction: data store error: failed to fetch storage map via RPC: ' +
        'failed to connect to the Miden node'
    ],
    [
      'an outage whose status quotes the store, since the kind decides a request',
      `${REQUEST}${UNAVAILABLE}: code: 'The service is currently unavailable', ` +
        `message: "storage error: ${STORE_REJECTED}"`
    ]
  ])('reads %s as an outage', (_label, message) => {
    expect(isNodeOutage(new Error(message))).toBe(true);
  });

  it.each([
    [
      'a store that ran out of quota',
      `failed to sync chain: storage error: ${STORE_REJECTED}` +
        'JsValue(AbortError: QuotaExceededError The quota has been exceeded.)'
    ],
    [
      'an aborted IndexedDB transaction',
      `failed to sync chain: storage error: ${STORE_REJECTED}JsValue(AbortError: Transaction aborted)`
    ],
    [
      'a rejection whose stack prints a 5xx line',
      `failed to sync chain: storage error: ${STORE_REJECTED}JsValue(ConstraintError: Key already exists\n` +
        'ConstraintError: Key already exists\n    at put (https://wallet.test/assets/Cargo-2c1.js:512:17))'
    ],
    [
      'the same failure through the data store',
      'failed to execute transaction: transaction execution failed: failed to fetch transaction inputs from the data ' +
        `store: store error: ${STORE_REJECTED}JsValue(AbortError: Transaction aborted)`
    ],
    [
      'a StoreError the SDK reports bare',
      `failed to get setting value from the store: ${STORE_REJECTED}JsValue(AbortError: Transaction aborted)`
    ],
    ['a block number the store prints', 'failed to sync chain: storage error: block header for block 512 not found'],
    ['the data store printing one', 'failed to fetch inputs: store error: block header for block 512 not found']
  ])('reads %s as no statement about the node', (_label, message) => {
    expect(isNodeOutage(new Error(message))).toBe(false);
  });

  it('reads the outage at any depth, and off a value that is not an Error', () => {
    expect(isNodeOutage(new Error('could not execute', { cause: new TypeError('Failed to fetch') }))).toBe(true);
    expect(isNodeOutage('Failed to fetch')).toBe(true);
  });

  it.each([
    [
      'a read of the local store the SDK named',
      'failed to fetch transaction inputs from the data store: account with id 0xabc not found in data store'
    ],
    ['a request that can never succeed', `${HEADER_MISSING} 404`],
    ['a node that refused', `${REQUEST}invalid request parameters`],
    [
      'a note the node does not hold',
      'failed to execute transaction: RPC error: note 0xabc was not found on the Miden node'
    ],
    [
      'an answer the SDK cannot read',
      'failed to sync chain: RPC error: received an invalid response from the Miden node: missing block header'
    ],
    [
      'an answer that does not decode',
      'failed to sync chain: RPC error: failed to deserialize response from the Miden node: eof'
    ],
    [
      'a client the node does not support',
      'failed to sync chain: RPC error: accept header validation failed: server rejected request - please check your ' +
        'version and network settings (client version: 0.17.5, genesis commitment: 0xabc)'
    ],
    [
      'a gateway that rejects the bytes',
      `${REQUEST}${INTERNAL}: code: 'Internal error', message: "${HEADER_MISSING} 400"`
    ],
    [
      // Base ended these at once. A gateway's refusal the SDK words as a node's stays on that side of the lopsided cost.
      'a gateway refusal the SDK words as the node refusing',
      `${REQUEST}permission denied: code: 'The caller does not have permission to execute the specified operation', ` +
        `message: "${HEADER_MISSING} 403"`
    ],
    [
      'a kernel failure, whatever its diagnostic prints',
      'failed to execute transaction: transaction execution failed: failed to execute transaction kernel program:\n' +
        '  x connection assertion failed\n 512 |   exec.note::abort'
    ],
    ['a kernel failure read by its code', `execution failed: ${ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH_CODE} 503`],
    ['a prover that lacks a procedure', 'procedure with root digest 0xabc could not be found: connection']
  ])('leaves %s to the terminal path', (_label, message) => {
    expect(isNodeOutage(new Error(message))).toBe(false);
  });

  // The gRPC kinds that answer the request, each with tonic's own text for the code.
  it.each([
    ['resource not found', 'Some requested entity was not found'],
    ['invalid request parameters', 'Client specified an invalid argument'],
    ['permission denied', 'The caller does not have permission to execute the specified operation'],
    ['resource already exists', 'Some entity that we attempted to create already exists'],
    ['precondition failed', "The system is not in a state required for the operation's execution"],
    [
      'the requested method is not implemented by this version of the Miden node',
      'Operation is not implemented or not supported'
    ],
    [
      'request was rejected as unauthenticated; check your credentials and connection settings',
      'The request does not have valid authentication credentials'
    ],
    ['operation was attempted past the valid range', 'Operation was attempted past the valid range'],
    ['unrecoverable data loss or corruption', 'Unrecoverable data loss or corruption']
  ])('reads a node that answered "%s" by that kind alone, not by what its message prints', (kind, code) => {
    for (const request of [REQUEST, EXECUTE_REQUEST]) {
      expect(isNodeOutage(new Error(`${request}${kind}`))).toBe(false);
      const printed = `${request}${kind}: code: '${code}', message: "connection timed out at block 512"`;
      expect(isNodeOutage(new Error(printed))).toBe(false);
    }
  });

  it('reads a kind this SDK does not name as an answer, the cheap side of the lopsided cost', () => {
    expect(isNodeOutage(new Error(`${REQUEST}the node has moved on: connection`))).toBe(false);
  });

  it('is no statement about the node when a Guardian went silent', () => {
    const timeout = new GuardianRequestTimeoutError('https://guardian.test/delta', GUARDIAN_REQUEST_TIMEOUT_MS);
    expect(isNodeOutage(timeout)).toBe(false);
    expect(isNodeOutage(new Error('the send failed', { cause: timeout }))).toBe(false);
  });

  it('is never an outage under a killed pipeline, at any depth', () => {
    // The abandoned pipeline may still submit, and every kill reads as transport-shaped text.
    const poisoned = new WasmClientPoisonedError('watchdog', new TypeError('Failed to fetch'));
    const aborted = new OperationAbortedError('op-1', 'deadline');
    for (const kill of [poisoned, aborted]) {
      expect(isNodeOutage(kill)).toBe(false);
      expect(isNodeOutage(new Error('transport error', { cause: kill }))).toBe(false);
    }
  });
});

describe('formatRawTransactionError', () => {
  it('prints each link of the cause chain, and a trailing non-Error value as text', () => {
    const chain = new Error('outer', { cause: new TypeError('middle', { cause: new RangeError('inner') }) });
    expect(formatRawTransactionError(chain)).toBe(
      'Error: outer <- caused by TypeError: middle <- caused by RangeError: inner'
    );
    expect(formatRawTransactionError(new Error('outer', { cause: 'socket hang up' }))).toBe(
      'Error: outer <- caused by socket hang up'
    );
  });

  it('stops at the first link that is not an Error', () => {
    const chain = new Error('outer', { cause: { code: 7, cause: new Error('hidden') } });
    expect(formatRawTransactionError(chain)).toBe('Error: outer <- caused by [object Object]');
  });

  it('prints at most five links', () => {
    let deep = new Error('link 6');
    for (let i = 5; i >= 0; i--) deep = new Error(`link ${i}`, { cause: deep });
    expect(formatRawTransactionError(deep)).toBe([0, 1, 2, 3, 4].map(i => `Error: link ${i}`).join(' <- caused by '));
  });
});

describe('an error whose cause getter throws (#1313)', () => {
  const withThrowingCause = <T extends Error>(error: T): T =>
    Object.defineProperty(error, 'cause', {
      get() {
        throw new Error('boom');
      }
    });

  const proposal = () => withThrowingCause(new Error('could not create the proposal'));

  it('is classified from the links before the getter', () => {
    expect(() => isGuardianOutage(proposal())).not.toThrow();
    expect(isGuardianOutage(proposal())).toBe(false);
  });

  it('is printed from the links before the getter', () => {
    expect(formatRawTransactionError(proposal())).toBe('Error: could not create the proposal');
  });

  it('drops only the text of a link whose name cannot be read', () => {
    const unreadable = Object.defineProperty(new Error('outer', { cause: new Error('inner') }), 'name', {
      get() {
        throw new Error('boom');
      }
    });
    expect(formatRawTransactionError(unreadable)).toBe('Error: inner');
  });

  it('still reads a deadline kill as a recovered engine', () => {
    const aborted = withThrowingCause(new OperationAbortedError('op-1', 'deadline'));
    expect(resolveTransactionErrorMessage(aborted, 'creating-proposal')).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
  });
});
