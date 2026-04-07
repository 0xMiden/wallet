/**
 * Top-level shell shown when a dApp session is foregrounded.
 *
 * Composes:
 * - <CapsuleBar/>           — fixed top, z-60
 * - <ProgressBar/>          — under the capsule, fades while loading
 * - <NativeWebViewSlot/>    — fills the area between capsule and footer;
 *                             the native dApp webview renders at this rect
 * - <DappConfirmationModal/> — z-70, rendered when the store has a pending request
 *
 * The `useDappWebView` hook owns the lifecycle: it opens the native webview
 * on mount, tracks the slot rect via ResizeObserver, handles dApp messages,
 * and tears the webview down on unmount.
 */

import React, { type FC, useCallback, useEffect, useMemo, useRef } from 'react';

import { AnimatePresence } from 'framer-motion';

import { type DappSession, useDappConfirmation } from 'lib/dapp-browser';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { useWalletStore } from 'lib/store';

import { CapsuleBar } from './CapsuleBar';
import { DappConfirmationModal } from './DappConfirmationModal';
import { NativeWebViewSlot } from './NativeWebViewSlot';
import { ProgressBar } from './ProgressBar';
import { useDappWebView } from './useDappWebView';

interface DappActiveProps {
  session: DappSession;
  onClose: () => void;
}

export const DappActive: FC<DappActiveProps> = ({ session, onClose }) => {
  const slotRef = useRef<HTMLDivElement>(null);

  const { isLoading, close, setHidden } = useDappWebView({
    session,
    slotRef,
    onClose
  });

  const { request, resolve } = useDappConfirmation();

  // While the confirmation modal is shown, hide the dApp content via injected
  // CSS visibility (NOT by resizing the native frame — see useDappWebView for
  // why). Restore visibility when the modal closes.
  useEffect(() => {
    if (!request) return;
    void setHidden(true);
    return () => {
      void setHidden(false);
    };
  }, [request, setHidden]);

  // Hardware back from `<DappActive>` (when no modal is showing): close the
  // dApp and return to the launcher. The modal registers its own back handler
  // (LIFO order) so back-while-modal-open closes the modal first.
  useMobileBackHandler(() => {
    void close();
    return true;
  }, [close]);

  // The capsule's "Reload" overflow action just navigates the dApp back to
  // its initial URL via setUrl. PR-2 will swap this for the plugin's reload
  // method once the patch lands.
  const handleReload = useCallback(() => {
    // For PR-1 we just leave this as a no-op stub; the menu still shows the
    // option but it relies on PR-1 patch-package adding a working reload.
    // The plugin already exposes a reload() call — wire it up via dynamic
    // import to avoid hard-failing if the patch isn't applied yet.
    import('@capgo/inappbrowser')
      .then(({ InAppBrowser }) => InAppBrowser.reload())
      .catch(err => console.warn('[DappActive] reload failed:', err));
  }, []);

  // Read the current account public key for the confirmation modal. The
  // store update path mirrors the legacy Browser.tsx logic.
  const currentAccount = useWalletStore(s => s.currentAccount);
  const accounts = useWalletStore(s => s.accounts);
  const accountId = useMemo(() => {
    if (currentAccount?.publicKey) return currentAccount.publicKey;
    if (accounts && accounts.length > 0) return accounts[0].publicKey;
    return null;
  }, [currentAccount, accounts]);

  const shortAccountId = useMemo(() => {
    if (!accountId) return null;
    return `${accountId.slice(0, 10)}...${accountId.slice(-8)}`;
  }, [accountId]);

  return (
    <div className="flex h-full flex-col">
      <CapsuleBar session={session} onClose={() => void close()} onReload={handleReload} />

      {/* Spacer matching the capsule height (24 drag + 56 content + 1 hairline) */}
      <div style={{ height: 'calc(env(safe-area-inset-top) + 81px)' }} className="shrink-0" />
      <ProgressBar loading={isLoading} />

      {/* The slot fills the remaining area; the native webview renders here */}
      <NativeWebViewSlot ref={slotRef} className="flex-1" />

      <AnimatePresence>
        {request && (
          <DappConfirmationModal
            request={request}
            accountId={shortAccountId}
            onResolve={result => {
              // Resolve the store first so the React subscription clears,
              // which removes the modal and triggers our setHidden(false)
              // cleanup effect.
              resolve(result);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
};
