/**
 * Desktop dApp confirmation prompt.
 *
 * SECURITY — the prompt renders in the WALLET's own window, never in the dApp's.
 * It used to be built as a JS string and handed to `show_dapp_confirmation_overlay`
 * → `dapp_window.eval(...)`, i.e. injected into the requesting page's main world.
 * The modal's DOM, its `#miden-btn-approve` click listener and its
 * standing-private-data checkbox were therefore page-owned: a `MutationObserver` in
 * the dApp could tick the box and fire a synthetic `.click()` the instant the
 * overlay appeared, granting standing private-data access and executing sends with
 * no user interaction beyond having the page open. The verdict then travelled back
 * over a navigation to a fixed host that any page could perform itself, with no
 * proof it came from the wallet's overlay.
 *
 * Now the request drives `dappConfirmationStore` and the shared
 * `<DappConfirmationModal>` — the same component mobile renders inside its own React
 * tree — and the user's click resolves the store directly. Nothing about the
 * decision is reachable from the requesting origin.
 */

import React, { useEffect, useRef, useState } from 'react';

import { DappConfirmationModal } from 'app/pages/Browser/DappConfirmationModal';
import {
  dappConfirmationStore,
  DAppConfirmationRequest,
  DAppConfirmationResult
} from 'lib/dapp-browser/confirmation-store';
import { isDesktop } from 'lib/platform';
import { useWalletStore } from 'lib/store';

import { focusMainWindow } from './dapp-browser';

/**
 * Renders the pending dApp confirmation, if any, on top of the wallet UI.
 *
 * Desktop uses the legacy default slot of the store (`sessionId: undefined`) — the
 * dApp browser is a single window, so there is only ever one session.
 */
export function DesktopDappConfirmationModal(): React.ReactElement | null {
  const [request, setRequest] = useState<DAppConfirmationRequest | null>(null);
  // Which request we have already raised the window for. A ref, not state, so the
  // focus call happens once per request without re-running the subscription.
  const focusedForRef = useRef<DAppConfirmationRequest | null>(null);

  const currentAccount = useWalletStore(s => s.currentAccount);
  const accounts = useWalletStore(s => s.accounts);

  const accountId = currentAccount?.publicKey ?? accounts?.[0]?.publicKey ?? null;

  useEffect(() => {
    if (!isDesktop()) return;

    const sync = () => {
      const pending = dappConfirmationStore.getPendingRequest();
      // The wallet window sits behind the dApp browser window the user was just
      // looking at, so raise it whenever a NEW request needs an answer. Any failure
      // is non-fatal: the prompt is rendered and answerable either way.
      if (pending && pending !== focusedForRef.current) {
        focusMainWindow().catch(() => {});
      }
      focusedForRef.current = pending;
      setRequest(pending);
    };

    sync();
    return dappConfirmationStore.subscribe(sync);
  }, []);

  if (!request) return null;

  const resolve = (result: DAppConfirmationResult) => {
    // PR-4 chunk 8: desktop is single-session, so it resolves the legacy default
    // slot. `resolveConfirmation` notifies subscribers, which clears `request` via
    // `sync`; setting it here too keeps the modal from lingering for a frame.
    dappConfirmationStore.resolveConfirmation(undefined, result);
    focusedForRef.current = null;
    setRequest(null);
  };

  return <DappConfirmationModal request={request} accountId={accountId} onResolve={resolve} />;
}

export default DesktopDappConfirmationModal;
