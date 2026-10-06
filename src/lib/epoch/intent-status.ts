import type { IntentTransactionStatus } from '@epoch-protocol/epoch-intents-sdk';

/** The allocator's status request has no timeout of its own, so a hung request would never settle. */
export const EPOCH_INTENT_STATUS_TIMEOUT_MS = 15_000;

interface IntentStatusReader {
  getIntentStatus(userAddress: string, nonce: string, signal?: AbortSignal): Promise<IntentTransactionStatus[]>;
}

/**
 * Read an intent's status, aborting the request and rejecting after `EPOCH_INTENT_STATUS_TIMEOUT_MS`. Every Epoch
 * status read goes through this: a watcher pass holds its direction until each read settles, consume completion runs
 * under the transaction loop's lock, an earn poll schedules its next tick only once its read settles, and an abandoned
 * request would keep a connection to the allocator open.
 */
export function readEpochIntentStatus(
  sdk: IntentStatusReader,
  userAddress: string,
  nonce: string
): Promise<IntentTransactionStatus[]> {
  const controller = new AbortController();
  return new Promise<IntentTransactionStatus[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `Epoch intent status for ${userAddress} nonce ${nonce} timed out after ${EPOCH_INTENT_STATUS_TIMEOUT_MS} ms`
        )
      );
    }, EPOCH_INTENT_STATUS_TIMEOUT_MS);
    sdk.getIntentStatus(userAddress, nonce, controller.signal).then(
      results => {
        clearTimeout(timer);
        resolve(results);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
