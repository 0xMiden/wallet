/**
 * Pure derivation of the four steps that the Miden Name status page shows.
 *
 * The data is the `register-name` row, the consume row that claims the delivery
 * note, the newest `publish-name-record` row of the same label, and the state
 * of the registry record on chain. This file has no React and no I/O.
 */

import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { phaseOf, publishPhaseOf, registerNameInputsOf } from 'lib/miden/name/registrations';
import type { MidenNameRecordState } from 'lib/miden/name/useMidenNameRecord';

export type MidenNameStepState = 'complete' | 'active' | 'pending' | 'failed';

export type MidenNameStepId = 'request-sent' | 'issued' | 'adding' | 'publishing';

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
  adding: 'midenNameStepAdding',
  publishing: 'midenNameStepPublishing'
};

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

/** Durations (seconds) of the first three steps. Rows store whole seconds. */
function durationsOf(row: ITransaction, claimRow?: ITransaction): [number?, number?, number?] {
  return [
    secondsBetween(row.initiatedAt, row.completedAt),
    secondsBetween(row.completedAt, claimRow?.initiatedAt),
    claimRow?.status === ITransactionStatus.Completed
      ? secondsBetween(claimRow.initiatedAt, claimRow.completedAt)
      : undefined
  ];
}

/** What the status page knows about the publish of the name to the registry. */
export interface MidenNamePublishView {
  /** The newest `publish-name-record` row of the label, when there is one. */
  row?: ITransaction;
  /** The registry record of the label, read from the chain. */
  record: MidenNameRecordState;
}

/**
 * The state of the publishing step of an owned name.
 *
 * A publish in flight is `active`. A record that points to the account is
 * `complete`, also when the wallet has no publish row (published from an
 * other device). A failed publish with no record is `failed`. With no publish
 * at all the step waits for the user: `pending`.
 */
export function publishStepState(publish: MidenNamePublishView | undefined): MidenNameStepState {
  if (!publish) return 'pending';
  const phase = publish.row ? publishPhaseOf(publish.row) : undefined;
  switch (phase) {
    case 'requested':
    case 'submitted':
    case 'recorded':
    case 'returning':
      return 'active';
    case 'done':
      return 'complete';
    case 'failed':
      return publish.record === 'here' ? 'complete' : 'failed';
    default:
      return publish.record === 'here' ? 'complete' : 'pending';
  }
}

/** True when the user can start (or start again) the publish of the name. */
export function canPublish(row: ITransaction, publish: MidenNamePublishView | undefined): boolean {
  if (phaseOf(row) !== 'owned' || !publish) return false;
  switch (publishStepState(publish)) {
    case 'pending':
    case 'failed':
      // A tap before the registry answered could publish twice.
      return publish.record !== 'checking';
    default:
      return false;
  }
}

/**
 * The four steps of a registration. Step 4 (publishing to the registry) is
 * `pending` until the name is owned; then `publishStepState` decides.
 */
export function stepsFor(row: ITransaction, claimRow?: ITransaction, publish?: MidenNamePublishView): MidenNameStep[] {
  const states = stepStatesOf(row, claimRow);
  const durations = durationsOf(row, claimRow);
  const ids: readonly MidenNameStepId[] = ['request-sent', 'issued', 'adding'];
  const steps: MidenNameStep[] = ids.map((id, index) => {
    const state = states[index] ?? 'pending';
    const durationSec = state === 'complete' ? durations[index] : undefined;
    return { id, labelKey: STEP_LABEL_KEYS[id], state, ...(durationSec !== undefined ? { durationSec } : {}) };
  });
  const publishing = phaseOf(row) === 'owned' ? publishStepState(publish) : 'pending';
  steps.push({ id: 'publishing', labelKey: STEP_LABEL_KEYS.publishing, state: publishing });
  return steps;
}
