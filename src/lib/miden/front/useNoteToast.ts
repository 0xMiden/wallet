import { useEffect, useRef } from 'react';

import { getPersistedSeenNoteIds, persistSeenNoteIds } from 'lib/miden/back/note-checker-storage';
import { isExtension } from 'lib/platform';
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
  const hydratedFromStorage = useRef(false);

  // On extension: hydrate seenNoteIds from chrome.storage.local on mount
  useEffect(() => {
    if (!isExtension() || hydratedFromStorage.current) return;
    hydratedFromStorage.current = true;

    getPersistedSeenNoteIds()
      .then(persisted => {
        if (persisted.size > 0) {
          useWalletStore.setState(state => ({
            seenNoteIds: new Set([...state.seenNoteIds, ...persisted])
          }));
        }
      })
      .catch(err => console.warn('[useNoteToast] Failed to hydrate seenNoteIds:', err));
  }, []);

  useEffect(() => {
    if (!enabled || !claimableNotes) return;

    const currentNoteIds = claimableNotes.map(note => note.id);

    // On first fetch, seed the seen notes without showing toast
    // This prevents toasting for existing notes when the app loads
    if (isFirstFetch.current) {
      isFirstFetch.current = false;

      // Seed seen notes directly to avoid showing toast
      const updatedIds = new Set([...useWalletStore.getState().seenNoteIds, ...currentNoteIds]);
      useWalletStore.setState({ seenNoteIds: updatedIds });

      // On extension: persist the seed so service worker inherits
      if (isExtension()) {
        persistSeenNoteIds(updatedIds).catch(() => {});
      }
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
