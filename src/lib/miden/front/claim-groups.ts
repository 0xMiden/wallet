/**
 * Splits the notes of one claim into consume batches: one transaction per faucet, native asset first.
 *
 * Per faucet, not one transaction for the whole claim: a completed consume row carries a single
 * (faucetId, amount) pair. `completeConsumeTransaction` takes the faucet from the first input note and
 * sums only the assets whose faucet matches it, so a mixed-faucet batch recorded "Received 10 MIDEN" for
 * a transaction that also delivered 25 USDC. Nothing else creates a row for the dropped asset, so it was
 * absent from the activity list and the detail screen, and `tx.faucetId` reconciliation (swap, bridge)
 * never saw it. Grouping makes each row's asset attribution correct by construction; notes sharing a
 * faucet still go out in a single proof and submit.
 *
 * Native asset first: the fee is withdrawn from the account's own vault, and a consume credits that
 * vault before `pay_fee` takes from it, so claiming the native note funds the groups that follow. A
 * non-native group attempted first on an empty vault fails on the fee while a native note that would
 * have paid for it sits unclaimed. The other groups keep note-arrival order.
 */
export function groupNotesForClaim<T extends { faucetId: string }>(
  notes: readonly T[],
  nativeFaucetId: string | null
): T[][] {
  const byFaucet = new Map<string, T[]>();
  for (const note of notes) {
    const group = byFaucet.get(note.faucetId);
    if (group) group.push(note);
    else byFaucet.set(note.faucetId, [note]);
  }
  return [...byFaucet.entries()]
    .sort(([a], [b]) => Number(b === nativeFaucetId) - Number(a === nativeFaucetId))
    .map(([, group]) => group);
}
