import { useEffect, useRef } from 'react';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { isExtension } from 'lib/platform';
import { isAutoConsumeEnabled, isDelegateProofEnabled } from 'lib/settings/helpers';

import { useClaimableNotes } from './claimable-notes';
import { useMidenContext } from './client';
import { zustandProvider } from './guardian-sync';
import { ConsumableNote } from '../types';

/**
 * Mobile/desktop counterpart to the extension service worker's native-note
 * auto-consume (sync-manager `runSync`). Those platforms have NO service worker —
 * their "background" is this in-page loop — and their only native-note auto-consumer
 * used to be the Home (Explore) page, so an async-delivered native (MIDEN) note (e.g.
 * an Earn-withdraw payout) sat in Pending unless the user happened to be on Home.
 * This always-mounted, headless manager consumes native notes regardless of route.
 *
 * No-op on the extension (the SW owns that path). Idempotent with the Home-page
 * consumer and the SW: `initiateConsumeNotesTransaction` dedups against non-Failed
 * consume rows and throttles auto-consume retries (#215).
 */
export function NativeNoteAutoConsumeManager(): null {
  const { currentAccount, signTransaction } = useMidenContext();
  const publicKey = currentAccount?.publicKey;
  const { data: claimableNotes } = useClaimableNotes(publicKey ?? '');
  const running = useRef(false);

  useEffect(() => {
    if (!publicKey || isExtension() || running.current) return;
    if (!isAutoConsumeEnabled() || !claimableNotes || claimableNotes.length === 0) return;

    let disposed = false;
    running.current = true;
    void (async () => {
      try {
        const nativeFaucetId = await getFaucetIdSetting();
        if (disposed || !nativeFaucetId) return;
        const nativeNotes: ConsumableNote[] = claimableNotes.filter(
          n => n.faucetId === nativeFaucetId && !n.swapOrder && !n.isBeingClaimed
        );
        if (disposed || nativeNotes.length === 0) return;
        const { initiateConsumeNotesTransaction, startBackgroundTransactionProcessing } =
          await import('../transaction');
        await initiateConsumeNotesTransaction(publicKey, nativeNotes, isDelegateProofEnabled());
        if (!disposed) startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
      } catch (err) {
        console.warn('[native-auto-consume] frontend pass failed', err);
      } finally {
        running.current = false;
      }
    })();

    return () => {
      disposed = true;
    };
  }, [publicKey, claimableNotes, signTransaction]);

  return null;
}
