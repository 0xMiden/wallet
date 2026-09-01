import { useCallback, useEffect, useMemo } from 'react';

import {
  NOTE_SPAM_STORAGE_KEY,
  NoteSpamSets,
  NoteSpamState,
  parseNoteSpamState,
  SpamAction,
  SpamEntryKind,
  toNoteSpamSets
} from 'lib/miden/note-spam';
import { useWalletStore } from 'lib/store';

import { TokenBalanceData } from './balance';
import { onStorageChanged } from './storage';

export interface NoteSpamController {
  state: NoteSpamState;
  sets: NoteSpamSets;
  loaded: boolean;
  isBlockedFaucet: (faucetId: string) => boolean;
  run: (action: SpamAction) => Promise<void>;
  undo: (action: SpamAction) => Promise<void>;
  remove: (kind: SpamEntryKind, value: string) => Promise<void>;
}

/**
 * Frontend view of the note spam list. Reads the store slice (synchronous, so a
 * hide and its Undo are one render), hydrates it from storage on first use, and
 * on the extension follows the storage key so the popup, side panel and
 * full-page views agree without a refetch. Off-extension `onStorageChanged` is
 * a no-op — there is only one realm to keep in sync.
 */
export function useNoteSpamState(): NoteSpamController {
  const state = useWalletStore(s => s.noteSpam);
  const loaded = useWalletStore(s => s.noteSpamLoaded);
  const loadNoteSpam = useWalletStore(s => s.loadNoteSpam);
  const setNoteSpam = useWalletStore(s => s.setNoteSpam);
  const run = useWalletStore(s => s.runNoteSpamAction);
  const undo = useWalletStore(s => s.undoNoteSpamAction);
  const remove = useWalletStore(s => s.removeNoteSpamEntry);

  useEffect(() => {
    if (!loaded) loadNoteSpam().catch(() => {});
  }, [loaded, loadNoteSpam]);

  useEffect(
    () => onStorageChanged<unknown>(NOTE_SPAM_STORAGE_KEY, next => setNoteSpam(parseNoteSpamState(next))),
    [setNoteSpam]
  );

  const sets = useMemo(() => toNoteSpamSets(state), [state]);
  const isBlockedFaucet = useCallback((faucetId: string) => sets.faucets.has(faucetId), [sets]);

  return { state, sets, loaded, isBlockedFaucet, run, undo, remove };
}

/** Drops balances of blocked assets — the Explore list and the portfolio total agree on the same set. */
export function filterBlockedBalances(balances: TokenBalanceData[], sets: NoteSpamSets): TokenBalanceData[] {
  return sets.faucets.size === 0 ? balances : balances.filter(balance => !sets.faucets.has(balance.tokenId));
}
