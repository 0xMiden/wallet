import type { IBridgedSendExtraInputs, IBridgeProvider, ITransaction } from 'lib/miden/db/types';

/**
 * Reads `provider` off a `bridged-send` row; `undefined` for every other type.
 *
 * A leaf on purpose. This lived in `retry.ts`, whose import graph reaches the whole transaction
 * pipeline and, through it, modules that call `isExtension()` at module scope. Any leaf that needs
 * only this predicate — `trim-result-bytes` does — had to drag all of that in to get it.
 */
export const bridgeProviderOf = (tx: Pick<ITransaction, 'type' | 'extraInputs'>): IBridgeProvider | undefined => {
  if (tx.type !== 'bridged-send') return undefined;
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  return extra?.provider;
};

/**
 * How long `waitForTransactionCompletion` waits before giving up (`helper.ts`).
 *
 * Here rather than beside its only user because `trim-result-bytes` must import it too, and
 * `helper.ts`'s module scope pulls the SDK, the miden client and the fee-note reader — the weight
 * this leaf exists to keep out. The reaper's retention window MUST stay strictly greater than this:
 * that inequality is what lets it delete `resultBytes` without racing the awaiting read.
 */
export const WAIT_FOR_TX_TIMEOUT = 5 * 60_000;
