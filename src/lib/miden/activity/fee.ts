import type { TransactionResult } from '@miden-sdk/miden-sdk';

import { formatAmount } from 'lib/shared/format';

import { TX_FEE_NOTE_TAG, partitionFeeNote, splitExecutedOutputNotes, splitLandedOutputNotes } from './fee-notes';
import type { FeePaid } from './fee-notes';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { retireLandedTrap } from '../sdk/landed-trap-retirement';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

export { TX_FEE_NOTE_TAG, partitionFeeNote, splitExecutedOutputNotes };
export type { UserOutputNote, FeePaid } from './fee-notes';

/**
 * The fee this transaction actually paid, or `undefined` if it paid none.
 *
 * Read from the emitted note rather than computed, because the charge is
 * `baseFee x (floor(log2(cycles)) + 1)` and the cycle count is only known once the
 * transaction has run -- `verificationBaseFee` alone understates it by an order of
 * magnitude. The vault delta is not usable either: the SDK exposes the post-state
 * absolutely, not as a difference.
 *
 * A fee-check trap is answered by {@link splitLandedOutputNotes}, while a read after the split still drops the
 * figure. This runs while recording a transaction the user has already sent, and losing the whole row to that later
 * read would be worse than losing the fee figure. Either way a trap retires the realm client first, once per
 * `landing`, the wallet row id (`sdk/landed-trap-retirement.ts`).
 *
 * An EVICTION is the one exception and propagates. Every accessor here borrows from the
 * WASM client's RefCell, so once the watchdog has handed the mutex to a successor these
 * reads are touching a client another flow is inside. Swallowing that would return a
 * plausible `undefined` and let the caller run its NEXT WASM read on the same evicted
 * client -- the double borrow the poison contract exists to prevent.
 */
export function feePaidFromResult(result: TransactionResult, landing: string): FeePaid | undefined {
  try {
    const { feeNote } = splitLandedOutputNotes(result, landing);
    if (!feeNote) {
      return undefined;
    }
    const assets = feeNote.assets()?.fungibleAssets() ?? [];
    const first = assets[0];
    if (!first) {
      return undefined;
    }
    // BECH32, like every other faucet id the wallet stores -- `String(AccountId)`
    // gives canonical hex, and the two are different encodings of the same account.
    // `assetsMetadata` is keyed by bech32 and `resolveDisplayMetadata` compares the
    // native faucet id by string equality, so a hex id missed both, resolved to the
    // unknown-token placeholder (`scaleIsUnknown: true`) and made `hasKnownScale`
    // false -- which meant the receipt's fee row was never rendered at all.
    return { amount: BigInt(first.amount()), faucetId: getBech32AddressFromAccountId(first.faucetId()) };
  } catch (err) {
    if (isWasmClientPoisonedError(err)) {
      throw err;
    }
    retireLandedTrap(err, landing, result);
    return undefined;
  }
}

/**
 * The fee fields to record on a transaction row, ready to spread into an update.
 *
 * Returns an empty object rather than `{ feeAmount: undefined }` when no fee was
 * paid: these spread into a partial update that `Object.assign`s over the stored
 * row, so writing explicit undefineds would erase whatever is already there.
 */
export function feeFieldsFromResult(
  result: TransactionResult | undefined,
  landing: string
): {
  feeAmount?: bigint;
  feeFaucetId?: string;
} {
  if (!result) {
    return {};
  }
  const paid = feePaidFromResult(result, landing);
  return paid ? { feeAmount: paid.amount, feeFaucetId: paid.faucetId } : {};
}

/**
 * The fee, formatted for display, or `undefined` when the row recorded none.
 *
 * Absent for every row written before fees were charged and for every row on a
 * zero-fee chain, so callers render the line conditionally rather than showing a
 * blank or a zero that would imply the wallet failed to read it.
 */
export function feeTextFromTransaction(
  transaction: { feeAmount?: bigint },
  decimals: number | undefined,
  symbol: string
): string | undefined {
  if (transaction.feeAmount === undefined) {
    return undefined;
  }
  return `${formatAmount(transaction.feeAmount, decimals)} ${symbol}`;
}
