import * as Repo from 'lib/miden/repo';

import { isSwapTransaction } from './classification';
import { swapOrderExpired } from './expiry';
import { ITransactionStatus } from '../db/types';

/**
 * Stop waiting for a fill and take the offered tip back.
 *
 * There is no protocol-level cancel to call here, and this does not invent one.
 * A swap order's expiry is entirely the WALLET's bookkeeping - `expirySeconds`
 * never reaches the SDK (`screens/swap-flow/expiry.ts`), it is stamped onto the
 * row as `extraInputs.expiresAt` at completion, and `reconcileSwapOrderNotes` is
 * the one thing that reads it: past that moment it stops waiting for a solver and
 * queues the consume that reclaims the tip. So "cancel this swap" is exactly
 * "bring that moment forward to now", and the reclaim that follows is the same
 * path, with the same solver race and the same consume dedup/backoff, that every
 * order already takes when its own expiry lapses. Nothing new is asked of the
 * chain.
 *
 * The write is all this does. The settlement tick queues the consume on its next
 * lap (3s on mobile/desktop via `SwapSettlementManager`, the SW sync cycle on the
 * extension), which is why there is no processing nudge to fire here: the reclaim
 * transaction does not exist yet.
 *
 * Refused rather than silently no-oped in three cases, because each is a button
 * that could not have worked:
 *
 *  - a row restored from a backup, which `localSwapOrders` excludes from
 *    settlement outright, so no tick would ever act on the stamp;
 *  - `autoConsume === false`, which `reconcileSwapOrderNotes` skips before it
 *    looks at expiry at all - the user asked to settle that order by hand;
 *  - a row with no `orderId`, i.e. one whose place-order transaction has not
 *    completed, so there is no on-chain order to reclaim from.
 */
export const cancelSwapOrder = async (
  txId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  const tx = await Repo.transactions.where({ id: txId }).first();
  // Read before the narrowing: `SwapTransaction` is the constructor's shape and
  // does not declare the import flag, which only `ITransaction` carries.
  const restoredFromBackup = tx?.restoredFromBackup === true;
  if (!tx || !isSwapTransaction(tx)) throw new Error(`Transaction ${txId} is not a swap`);
  if (restoredFromBackup) {
    throw new Error(`Swap ${txId} was restored from a backup, so this wallet cannot reclaim it`);
  }
  if (tx.status !== ITransactionStatus.Completed || tx.extraInputs?.orderId == null) {
    throw new Error(`Swap ${txId} has no open order to cancel`);
  }
  if (tx.extraInputs.autoConsume === false) {
    throw new Error(`Swap ${txId} settles manually, so the wallet will not reclaim it`);
  }

  await Repo.transactions.where({ id: txId }).modify(dbTx => {
    // Re-read off the live row: the lookup above is a separate IndexedDB trip, and
    // a tick that expired this order in between has already stamped
    // `expiryTriggeredAt` and queued the consume. Moving `expiresAt` later or
    // earlier at that point changes nothing on chain and only rewrites history.
    // `false`, so Dexie skips the put rather than re-writing the unchanged clone.
    if (!isSwapTransaction(dbTx)) return false;
    const expiresAt = dbTx.extraInputs?.expiresAt;
    if (swapOrderExpired(expiresAt, nowSeconds)) return false;
    dbTx.extraInputs = { ...dbTx.extraInputs, expiresAt: nowSeconds };
    return undefined;
  });
};
