/**
 * Pure derivation of the three steps that the Miden Name status page shows.
 *
 * The data is the `register-name` row and the consume row that claims the
 * delivery note. The registry mints the name and writes its registry records
 * in one transaction, so a name that is issued already resolves. This file has
 * no React and no I/O.
 */

import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { phaseOf, registerNameInputsOf } from 'lib/miden/name/registrations';

export type MidenNameStepState = 'complete' | 'active' | 'pending' | 'failed';

export type MidenNameStepId = 'request-sent' | 'issued' | 'adding';

export interface MidenNameStep {
  id: MidenNameStepId;
  labelKey: string;
  state: MidenNameStepState;
  /** Time of the step in seconds. Only a complete step has a duration. */
  durationSec?: number;
}

export type MidenNameFailureKey =
  | 'midenNameFailedTx'
  | 'midenNameFailedTaken'
  | 'midenNameFailedExpired'
  | 'midenNameFailedDiscarded'
  | 'midenNameFailedClaim';

const STEP_LABEL_KEYS: Record<MidenNameStepId, string> = {
  'request-sent': 'midenNameStepRequestSent',
  issued: 'midenNameStepIssued',
  adding: 'midenNameStepAdding'
};

const STEP_IDS: readonly MidenNameStepId[] = ['request-sent', 'issued', 'adding'];

type StepStates = readonly [MidenNameStepState, MidenNameStepState, MidenNameStepState];

/**
 * True when the claim of the delivery note failed and the user can claim it
 * again. The retry needs the id of the delivery note.
 *
 * - failure `claim-failed`;
 * - phase `issued` or `claiming`, and the claim row is Failed;
 * - phase `issued`, the claim row is missing and the tracker recorded an error.
 */
export function claimNeedsRetry(row: ITransaction, claimRow?: ITransaction): boolean {
  const inputs = registerNameInputsOf(row);
  if (!inputs?.deliveryNoteId) return false;
  const phase = phaseOf(row);
  switch (phase) {
    case 'failed':
      return inputs.failure === 'claim-failed' && claimRow?.status !== ITransactionStatus.Completed;
    case 'issued':
      if (claimRow) return claimRow.status === ITransactionStatus.Failed;
      return inputs.lastError !== undefined;
    case 'claiming':
      return claimRow?.status === ITransactionStatus.Failed;
    default:
      return false;
  }
}

/** The failure copy of the registration, or undefined when nothing failed. */
export function failureKeyOf(row: ITransaction, claimRow?: ITransaction): MidenNameFailureKey | undefined {
  if (claimNeedsRetry(row, claimRow)) return 'midenNameFailedClaim';
  if (phaseOf(row) !== 'failed') return undefined;
  switch (registerNameInputsOf(row)?.failure) {
    case 'taken':
      return 'midenNameFailedTaken';
    case 'expired':
      return 'midenNameFailedExpired';
    case 'discarded':
      return 'midenNameFailedDiscarded';
    case 'claim-failed':
      return 'midenNameFailedClaim';
    default:
      return 'midenNameFailedTx';
  }
}

function claimStepState(row: ITransaction, claimRow?: ITransaction): MidenNameStepState {
  return claimNeedsRetry(row, claimRow) ? 'failed' : 'active';
}

function stepStatesOf(row: ITransaction, claimRow?: ITransaction): StepStates {
  const phase = phaseOf(row);
  switch (phase) {
    case 'requested':
      return ['active', 'pending', 'pending'];
    case 'submitted':
      return ['complete', 'active', 'pending'];
    case 'issued':
    case 'claiming':
      return ['complete', 'complete', claimStepState(row, claimRow)];
    case 'owned':
      return ['complete', 'complete', 'complete'];
    case 'failed':
      switch (registerNameInputsOf(row)?.failure) {
        case 'taken':
        case 'expired':
        case 'discarded':
          return ['complete', 'failed', 'pending'];
        case 'claim-failed':
          return ['complete', 'complete', claimRow?.status === ITransactionStatus.Completed ? 'complete' : 'failed'];
        default:
          return ['failed', 'pending', 'pending'];
      }
  }
}

function secondsBetween(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

/** Durations (seconds) of the three steps. Rows store whole seconds. */
function durationsOf(row: ITransaction, claimRow?: ITransaction): [number?, number?, number?] {
  return [
    secondsBetween(row.initiatedAt, row.completedAt),
    secondsBetween(row.completedAt, claimRow?.initiatedAt),
    claimRow?.status === ITransactionStatus.Completed
      ? secondsBetween(claimRow.initiatedAt, claimRow.completedAt)
      : undefined
  ];
}

/** The three steps of a registration. */
export function stepsFor(row: ITransaction, claimRow?: ITransaction): MidenNameStep[] {
  const states = stepStatesOf(row, claimRow);
  const durations = durationsOf(row, claimRow);
  return STEP_IDS.map((id, index) => {
    const state = states[index] ?? 'pending';
    const durationSec = state === 'complete' ? durations[index] : undefined;
    return { id, labelKey: STEP_LABEL_KEYS[id], state, ...(durationSec !== undefined ? { durationSec } : {}) };
  });
}
