import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import {
  isProverProcedureMismatch,
  resolveTransactionErrorMessage,
  PROVER_PROCEDURE_MISMATCH_ERROR,
  REMOTE_PROVER_FAILED_ERROR,
  LOCAL_PROVER_FAILED_ERROR,
  TRANSACTION_ENGINE_RECOVERED_ERROR
} from './constants';

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
});
