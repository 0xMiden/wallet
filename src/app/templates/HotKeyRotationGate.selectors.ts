import { formatBigInt } from 'lib/i18n/numbers';
import { isLiveTransaction, ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { hasNoFeeAsset, ROTATION_FUNDING_MIN_FEE_MULTIPLE } from 'lib/miden/fees/spendable';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { isVaultShortfallRow, TRANSACTION_VAULT_SHORTFALL_ERROR } from 'lib/miden/transaction/constants';

export type RotationGateView = 'recovery-seed' | 'funding' | 'failed' | 'rotating';
export type RotationFundingStatus = 'claiming' | 'activating' | 'claim-failed' | 'too-small' | 'waiting';
export type RotationFundingReason = 'rotation-shortfall' | 'below-base-fee' | 'claim-in-progress';

/** A transaction row as the gate reads it. */
export type GateRow = Pick<
  ITransaction,
  | 'id'
  | 'type'
  | 'status'
  | 'error'
  | 'rawError'
  | 'mayHaveSubmitted'
  | 'awaitingRecoverySeed'
  | 'initiatedAt'
  | 'queuedSeq'
  | 'completedAt'
  | 'noteIds'
>;

export interface RotationGateViewInput {
  /** The rotation row the overlay tracks, once it has one. */
  trackedRow?: GateRow;
  initError: string | null;
  /** `null` while unknown; `0` on a chain that charges nothing. */
  baseFee: number | null;
  /** The account's native balance is known and below one base fee. */
  belowBaseFee: boolean;
  /** Every `replace-hot-key` row of the account. */
  rotationRows: readonly GateRow[];
  /** Every `rotationFunding` consume row of the account. */
  fundingRows: readonly GateRow[];
  /** The native notes the latest live list shows. */
  listedNoteIds: ReadonlySet<string>;
  /** Unclaimed native notes are listed, but together worth less than a claim costs. */
  tooSmall: boolean;
}

export type RotationGateViewResult =
  | { view: 'recovery-seed' | 'failed' | 'rotating' }
  | { view: 'funding'; status: RotationFundingStatus; reason: RotationFundingReason; failedClaim?: GateRow };

const queuedLater = (a: GateRow, b: GateRow): boolean =>
  a.initiatedAt > b.initiatedAt || (a.initiatedAt === b.initiatedAt && (a.queuedSeq ?? 0) > (b.queuedSeq ?? 0));

/** The most recently queued of `rows`. */
export const newestRow = <T extends GateRow>(rows: readonly T[]): T | undefined =>
  rows.reduce<T | undefined>(
    (newest, row) => (newest === undefined || queuedLater(row, newest) ? row : newest),
    undefined
  );

export const claimNoteIds = (row: GateRow): string[] => row.noteIds ?? [];

/** The balance trigger. The pre-fetch placeholder is a zero native row, so it waits for a real read. */
export const isBelowBaseFee = (
  balancesLoading: boolean,
  balances: readonly TokenBalanceData[],
  feeFaucetId: string | null,
  baseFee: number | null
): boolean => !balancesLoading && hasNoFeeAsset(balances, feeFaucetId, baseFee);

/** The suggested amount, in MIDEN, or `null` when the fee or the native scale is not known. */
export const rotationFundingMinimum = (
  baseFee: number | null,
  nativeRow: TokenBalanceData | undefined
): string | null => {
  if (baseFee === null || baseFee <= 0 || nativeRow === undefined || !hasKnownScale(nativeRow.metadata)) return null;
  return formatBigInt(
    BigInt(ROTATION_FUNDING_MIN_FEE_MULTIPLE) * BigInt(Math.trunc(baseFee)),
    nativeRow.metadata.decimals
  );
};

const fundingStatus = (
  input: RotationGateViewInput,
  claimLive: boolean
): { status: RotationFundingStatus; failedClaim?: GateRow } => {
  if (claimLive) return { status: 'claiming' };
  if (input.rotationRows.some(isLiveTransaction)) return { status: 'activating' };
  // Whatever rotation ran since: one that fell short again leaves the failed claim's notes
  // waiting, and Try again claims them now rather than after the backoff.
  const claim = newestRow(input.fundingRows);
  if (claim?.status === ITransactionStatus.Failed && claimNoteIds(claim).some(id => input.listedNoteIds.has(id))) {
    return { status: 'claim-failed', failedClaim: claim };
  }
  return { status: input.tooSmall ? 'too-small' : 'waiting' };
};

/**
 * What the everyday-key rotation gate shows (#805), first match wins: the recovery-seed
 * prompt, the funding panel, the failure surface, the spinner. Funding needs a chain that
 * charges (`baseFee !== 0`) and one of: the tracked rotation failed for want of its fee,
 * the balance is below one fee, or the gate's own claim is live. An unknown fee keeps the
 * shortfall trigger, which is authoritative, and loses only the balance one.
 */
export function resolveRotationGateView(input: RotationGateViewInput): RotationGateViewResult {
  const { trackedRow } = input;
  if (trackedRow?.awaitingRecoverySeed && trackedRow.status === ITransactionStatus.Queued) {
    return { view: 'recovery-seed' };
  }
  const shortfall = trackedRow !== undefined && isVaultShortfallRow(trackedRow);
  const claimLive = input.fundingRows.some(isLiveTransaction);
  if (input.baseFee !== 0 && (shortfall || input.belowBaseFee || claimLive)) {
    const reason: RotationFundingReason = shortfall
      ? 'rotation-shortfall'
      : input.belowBaseFee
        ? 'below-base-fee'
        : 'claim-in-progress';
    return { view: 'funding', reason, ...fundingStatus(input, claimLive) };
  }
  if (input.initError !== null || trackedRow?.status === ITransactionStatus.Failed) return { view: 'failed' };
  return { view: 'rotating' };
}

/** The parts of the tracked rotation row its failure message reads. */
export type RotationFailureRow = Pick<ITransaction, 'type' | 'status' | 'error' | 'rawError' | 'mayHaveSubmitted'>;

export interface RotationFailure {
  /** The rotation may have reached the network, so its outcome is unknown rather than failed. */
  unconfirmed: boolean;
  /** The row's own user-facing copy, or `null` for the gate's translated message. */
  message: string | null;
  /** The raw error behind "Show full error". */
  details?: string;
}

const nonEmpty = (text: string | undefined) => (text ? text : undefined);

/**
 * What the failed view says: a short message, and the raw error kept for "Show full error".
 * The latest thing that went wrong wins: an init error means Retry could not even enqueue.
 */
export const describeRotationFailure = (
  row: RotationFailureRow | undefined,
  initError: string | null
): RotationFailure => {
  if (initError !== null) return { unconfirmed: false, message: null, details: nonEmpty(initError) };
  if (row === undefined) return { unconfirmed: false, message: null };
  if (isVaultShortfallRow(row)) {
    // An old-format shortfall row still carries the raw kernel line as its error.
    const raw = row.rawError ?? row.error;
    return {
      unconfirmed: false,
      message: TRANSACTION_VAULT_SHORTFALL_ERROR,
      details: raw === TRANSACTION_VAULT_SHORTFALL_ERROR ? undefined : nonEmpty(raw)
    };
  }
  // `cancelTransaction` keeps `rawError` only when a classifier rewrote the error for the user.
  if (row.rawError !== undefined) {
    return { unconfirmed: false, message: nonEmpty(row.error) ?? null, details: nonEmpty(row.rawError) };
  }
  // Stamped at the submit crossing, before the submit: an unclassified failure after it may have landed.
  return { unconfirmed: row.mayHaveSubmitted === true, message: null, details: nonEmpty(row.error) };
};
