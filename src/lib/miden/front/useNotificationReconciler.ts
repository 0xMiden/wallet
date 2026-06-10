import { useEffect } from 'react';

import { useWalletStore } from 'lib/store';
import { PendingNotePayload } from 'lib/store/notifications';

import { useClaimableNotes } from './claimable-notes';

/**
 * Keeps the persisted notification center in sync with the claimable-notes
 * set: hydrates persisted notifications once, then on every claimable-notes
 * refresh adds an unread notification per unseen note and prunes
 * notifications whose note left the set (claimed/consumed/recalled).
 *
 * @param publicAddress - The account's public address to monitor notes for
 * @param enabled - Whether to enable monitoring (default: true)
 */
export function useNotificationReconciler(publicAddress: string, enabled: boolean = true) {
  const { data: claimableNotes } = useClaimableNotes(publicAddress, enabled);
  const hydrated = useWalletStore(s => s.notificationsHydrated);
  const hydrateNotifications = useWalletStore(s => s.hydrateNotifications);
  const reconcilePendingNoteNotifications = useWalletStore(s => s.reconcilePendingNoteNotifications);

  useEffect(() => {
    hydrateNotifications().catch(() => {});
  }, [hydrateNotifications]);

  useEffect(() => {
    if (!enabled || !hydrated || !claimableNotes) return;

    const payloads: PendingNotePayload[] = claimableNotes.map(note => ({
      noteId: note.id,
      faucetId: note.faucetId,
      amount: note.amount,
      senderAddress: note.senderAddress,
      symbol: note.metadata.symbol,
      decimals: note.metadata.decimals
    }));

    reconcilePendingNoteNotifications(publicAddress, payloads);
  }, [enabled, hydrated, claimableNotes, publicAddress, reconcilePendingNoteNotifications]);
}
