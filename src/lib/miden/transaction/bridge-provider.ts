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
