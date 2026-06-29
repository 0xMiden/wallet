/**
 * The "being claimed" gate (`extensionClaimingNoteIds`) hides a consumable
 * note's Claim button while its consume transaction is in flight. The service
 * worker's sync reconciliation normally clears the gate once the note is no
 * longer consumable — i.e. its consume committed. But a consume that STALLS or
 * FAILS never reaches that point, which would hide the note indefinitely,
 * leaving it perpetually "pending but unclaimable." This is acute on slow
 * networks like testnet, where consume commits can lag minutes: the note sits
 * with a spinner and no Claim button, and (in the E2E stress harness) the
 * claim loop spins "pending=N, no buttons visible" until it times out.
 *
 * The safety expiry below bounds how long a note can stay gated. Re-showing a
 * note whose consume is merely slow (not dead) is harmless: a re-claim is
 * deduped by `initiateConsumeTransaction` against the live consume row, so a
 * premature retry is a no-op (and a genuinely failed consume *should* become
 * re-claimable).
 */
export const CLAIMING_NOTE_STALL_TIMEOUT_MS = 120_000;

/**
 * Select note ids to drop from the "being claimed" set during a sync poll.
 * Two conditions clear the gate:
 *   1. the note is no longer consumable (its consume committed) — the original
 *      reconciliation behavior;
 *   2. it has been gated longer than `timeoutMs` while still consumable
 *      (a stalled or failed consume) — the safety expiry.
 *
 * `firstSeen` records when each claiming id was first observed; it is updated
 * in place — ids no longer claiming (or being dropped) are pruned, newly-seen
 * ids are stamped with `now`. Passing the same map across successive polls is
 * what gives each id a stable age.
 */
export function selectStaleClaimingIds(
  claimingIds: Iterable<string>,
  consumableIds: Set<string>,
  firstSeen: Map<string, number>,
  now: number,
  timeoutMs: number = CLAIMING_NOTE_STALL_TIMEOUT_MS
): string[] {
  const claimingSet = claimingIds instanceof Set ? claimingIds : new Set(claimingIds);

  // Prune timestamps for ids that are no longer claiming at all, so the map
  // can't grow unbounded across polls.
  for (const id of [...firstSeen.keys()]) {
    if (!claimingSet.has(id)) firstSeen.delete(id);
  }

  const stale: string[] = [];
  for (const id of claimingSet) {
    // (1) consume committed → note dropped from the consumable set.
    if (!consumableIds.has(id)) {
      stale.push(id);
      firstSeen.delete(id);
      continue;
    }
    // (2) still consumable: stamp the first sighting, then expire once stale.
    const seen = firstSeen.get(id);
    if (seen === undefined) {
      firstSeen.set(id, now);
    } else if (now - seen >= timeoutMs) {
      stale.push(id);
      firstSeen.delete(id);
    }
  }

  return stale;
}
