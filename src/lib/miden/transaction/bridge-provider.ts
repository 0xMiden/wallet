import type { IBridgedSendExtraInputs, IBridgeProvider, ITransaction } from 'lib/miden/db/types';

/**
 * Reads `provider` off a `bridged-send` row; `undefined` for every other type.
 *
 * A leaf on purpose. This lived in `retry.ts`, whose import graph reaches the whole transaction
 * pipeline and, through it, modules that call `isExtension()` at module scope — so any module
 * wanting just this predicate, or just the timeout below, had to drag all of that in. Its
 * importers are `retry.ts`, which re-exports it for `index.ts` and the UI, and `helper.ts`.
 */
export const bridgeProviderOf = (tx: Pick<ITransaction, 'type' | 'extraInputs'>): IBridgeProvider | undefined => {
  if (tx.type !== 'bridged-send') return undefined;
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  return extra?.provider;
};

/**
 * How long `waitForTransactionCompletion` waits before giving up (`helper.ts`).
 *
 * Its only production consumer is `helper.ts`, which is where it used to live; it sits here
 * because the reaper's suite asserts the retention window against it, and importing `helper.ts`
 * for that would pull the SDK, the miden client and the fee-note reader into a storage test.
 * That is the whole reason — a test's import, not a second production caller. What the reaper
 * does with it is documented in the module that owns the retention window; stating it in both
 * places is how the two drift.
 */
export const WAIT_FOR_TX_TIMEOUT = 5 * 60_000;
