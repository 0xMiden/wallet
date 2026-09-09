import { useMemo } from 'react';

import { ActivityAction, groupIdForAddress } from 'app/templates/history/activity-grouping';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { isAutoConsumeEnabled } from 'lib/settings/helpers';

/**
 * The single definition of "the user has something to do".
 *
 * Both the Activity tab dot and the per-group counts read this, so they cannot
 * disagree. It exists because the wallet has several claim flows — user-to-user
 * notes, auto-consumed swaps, manual claims, EVM bridge claims — and no shared
 * answer to which of them actually need a person.
 *
 * Two corrections over the old `useHasUnclaimedNotes` predicate:
 *
 *  - **Auto-consumed notes are not actions.** Auto-consume defaults ON, and
 *    `NativeNoteAutoConsumeManager` claims every native note that is not a swap
 *    order. Badging those tells the user to do something the wallet is already
 *    doing. Swap-order notes that auto-settle are filtered out further upstream.
 *  - **In-flight claims are not actions.** `useClaimableNotes` keeps returning a
 *    note while its claim transaction is queued, so the old dot stayed lit
 *    through the very act of clearing it.
 */
export interface ActionableActivity {
  actions: ActivityAction[];
  /** True when anything needs the user — what the Activity tab dot renders. */
  hasAny: boolean;
}

/**
 * Per-group opt-out, the "muted conversation" seam: a muted group auto-accepts
 * and never badges. Nothing sets this yet — the toggle ships with the
 * terminology research — but threading it here means adding it later is
 * storage plus a switch, not a reshape of grouping or ranking.
 */
export type MutedGroups = ReadonlySet<string>;

/**
 * Just the fields this predicate reads. Structural rather than importing the
 * note type, because the claimable-notes hook returns a decorated shape and
 * this only cares about what decides actionability.
 */
export interface ActionableNoteInput {
  faucetId: string;
  isBeingClaimed: boolean;
  swapOrder?: unknown;
  senderAddress?: string;
  recallableAtMs?: number;
}

/** A claimable note needs a person unless something else will claim it first. */
export function isNoteActionable(
  note: ActionableNoteInput,
  nativeFaucetId: string | null,
  autoConsume: boolean
): boolean {
  if (note.isBeingClaimed) return false;
  const willAutoConsume = autoConsume && !!nativeFaucetId && note.faucetId === nativeFaucetId && !note.swapOrder;
  return !willAutoConsume;
}

export function useActionableActivity(muted: MutedGroups = new Set()): ActionableActivity {
  const account = useAccount();
  const { data: claimableNotes } = useClaimableNotes(account.publicKey);

  // Read on every render rather than once: the toggle is a live setting, so
  // turning auto-consume off has to light the dot without a reload.
  const autoConsume = isAutoConsumeEnabled();
  const nativeFaucetId = getNativeAssetIdSync();

  return useMemo(() => {
    const actions: ActivityAction[] = [];

    for (const note of claimableNotes ?? []) {
      if (!note) continue;
      if (!isNoteActionable(note, nativeFaucetId, autoConsume)) continue;

      const groupId = groupIdForAddress(note.senderAddress || undefined);
      if (muted.has(groupId)) continue;

      actions.push({
        groupId,
        // A P2IDE note returns to its sender if unclaimed — the only real
        // deadline in the product, and the "funds won't arrive unless you act"
        // framing the research asked for.
        deadlineAt: note.recallableAtMs
      });
    }

    return { actions, hasAny: actions.length > 0 };
  }, [claimableNotes, nativeFaucetId, autoConsume, muted]);
}
