import { ISellExtraInputs, ISellFailure, ISellPhase, ITransaction, SELL_PHASES } from 'lib/miden/db/types';
import { isPhaseTerminal, PhaseTrack } from 'screens/order-status/phase-progress';

/** The phases of a sell, for the progress functions that the buy and the sell screens share. */
export const SELL_TRACK: PhaseTrack<ISellPhase> = { phases: SELL_PHASES, completed: 'completed', failed: 'failed' };

/** The i18n key of the step row for a phase. `failed` has no row of its own. */
export const sellStepLabelKey = (phase: ISellPhase): string => {
  switch (phase) {
    case 'submitting':
      return 'sellStepSubmitting';
    case 'bridging':
      return 'sellStepBridging';
    case 'on-ethereum':
      return 'sellStepOnEthereum';
    case 'sent':
      return 'sellStepSent';
    case 'received':
      return 'sellStepReceived';
    case 'completed':
    case 'failed':
      return 'sellStepCompleted';
  }
};

const isSellPhase = (value: string): value is ISellPhase => value === 'failed' || SELL_PHASES.some(p => p === value);

/**
 * Get the sell inputs of a row. Return `undefined` when the row is not a `sell` row or when its
 * `extraInputs` do not have the fields the screens read.
 *
 * `extraInputs` has no static type on `ITransaction`, so this function makes the checks at
 * runtime. It does not cast.
 */
export const sellInputsOf = (row: ITransaction | undefined): ISellExtraInputs | undefined => {
  if (row?.type !== 'sell') return undefined;
  const extra: ISellExtraInputs | undefined = row.extraInputs;
  if (!extra || typeof extra !== 'object') return undefined;
  if (typeof extra.orderId !== 'string' || typeof extra.cryptoAmount !== 'string') return undefined;
  if (typeof extra.tokenSymbol !== 'string' || typeof extra.depositAddress !== 'string') return undefined;
  if (typeof extra.phase !== 'string' || !isSellPhase(extra.phase)) return undefined;
  return extra;
};

/** True when the sale cannot change any more. */
export const isSellTerminal = (phase: ISellPhase): boolean => isPhaseTerminal(SELL_TRACK, phase);

/** The amount and the token that are really sold, for example "100 TRNSK". */
export const sellTokenLabel = (inputs: Pick<ISellExtraInputs, 'cryptoAmount' | 'tokenSymbol'>): string =>
  `${inputs.cryptoAmount} ${inputs.tokenSymbol}`;

/** The i18n key of the text for a failure. A row with no recorded cause gets the general text. */
export const sellFailureKey = (failure: ISellFailure | undefined): string => {
  switch (failure) {
    case 'bridge-failed':
      return 'sellFailureBridge';
    case 'bridge-missing':
      return 'sellFailureBridgeMissing';
    case 'order-failed':
      return 'sellFailureOrderFailed';
    case 'order-expired':
      // This text also tells where the token is, so the status page shows no funds notice with it.
      return 'sellFailureOrderExpired';
    case 'transak-expired':
      return 'sellFailureExpired';
    case 'order-cancelled':
    case 'transak-cancelled':
      return 'sellFailureCancelled';
    case 'transak-failed':
      return 'sellFailureTransakFailed';
    case 'transak-refunded':
      return 'sellFailureTransakRefunded';
    case 'timeout':
      return 'sellFailureTimeout';
    case 'restored':
      return 'sellFailureRestored';
    case undefined:
      return 'sellStatusFailedDescription';
  }
};

/**
 * Where the token of a failed sale is.
 *   - miden    : the bridge-out did not go out, so the token did not leave the account
 *   - ethereum : the bridge-out went out (or can still go out) and the relay was not sent: the token stays at the
 *                account's own EVM address
 *   - transak  : the relay was sent, so Transak has the token
 *   - unknown  : the row cannot tell
 */
export type SellFundsLocation = 'miden' | 'ethereum' | 'transak' | 'unknown';

export const sellFundsLocation = (
  inputs: Pick<ISellExtraInputs, 'failure' | 'phaseTimestamps' | 'relayTxHash'>
): SellFundsLocation => {
  switch (inputs.failure) {
    case 'bridge-failed':
      return 'miden';
    case 'order-expired':
      // The backend expires only a sale that it did not relay.
      return 'ethereum';
    case 'bridge-missing':
    case 'timeout':
    case 'restored':
    case undefined:
      return 'unknown';
    default:
      break;
  }
  const relayed = inputs.phaseTimestamps?.sent !== undefined || inputs.relayTxHash !== undefined;
  return relayed ? 'transak' : 'ethereum';
};

/** The i18n key of the notice that tells where the token of a failed sale is, or `undefined` for no notice. */
export const sellFundsNoticeKey = (location: SellFundsLocation): string | undefined => {
  switch (location) {
    case 'miden':
      return 'sellFundsOnMiden';
    case 'ethereum':
      return 'sellFundsOnEthereum';
    case 'transak':
      return 'sellFundsAtTransak';
    case 'unknown':
      return undefined;
  }
};

/**
 * The time at which Transak expires the unpaid order, in Unix milliseconds, while that time still matters: before
 * the relay is sent. `undefined` after the relay, at the end of the sale and when the backend gave no time.
 */
export const sellDeadlineMs = (inputs: Pick<ISellExtraInputs, 'phase' | 'autoExpiresAt'>): number | undefined => {
  if (inputs.autoExpiresAt === undefined) return undefined;
  switch (inputs.phase) {
    case 'submitting':
    case 'bridging':
    case 'on-ethereum':
      return inputs.autoExpiresAt * 1000;
    default:
      return undefined;
  }
};

/** A clock time for a deadline, in the user's locale, for example "14:05". */
export const formatDeadline = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
