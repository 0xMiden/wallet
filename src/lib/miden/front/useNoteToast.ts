import { useEffect, useRef } from 'react';

import { useWalletStore } from 'lib/store';

import { useClaimableNotes } from './claimable-notes';

/**
 * Hook that monitors for new claimable notes and shows toast notifications.
 * Active on both mobile and extension platforms.
 *
 * @param publicAddress - The account's public address to monitor notes for
 * @param enabled - Whether to enable monitoring (default: true)
 */
export function useNoteToastMonitor(publicAddress: string, enabled: boolean = true) {
  const { data: claimableNotes } = useClaimableNotes(publicAddress, enabled);
  const checkForNewNotes = useWalletStore(state => state.checkForNewNotes);
  const isFirstFetch = useRef(true);

  useEffect(() => {
    if (!enabled || !claimableNotes) return;

    const currentNoteIds = claimableNotes.map(note => note.id);

    // On first fetch, seed the seen notes without showing toast
    // This prevents toasting for existing notes when the app loads
    if (isFirstFetch.current) {
      isFirstFetch.current = false;

      // Seed seen notes directly to avoid showing toast
      useWalletStore.setState(state => ({
        seenNoteIds: new Set([...state.seenNoteIds, ...currentNoteIds])
      }));
      return;
    }

    // Check for new notes and show toast if any
    checkForNewNotes(currentNoteIds);
  }, [claimableNotes, enabled, checkForNewNotes]);

  // Reset isFirstFetch when publicAddress changes (new account selected)
  useEffect(() => {
    isFirstFetch.current = true;
  }, [publicAddress]);
}
