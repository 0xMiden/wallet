/**
 * Desktop dApp Confirmation Handler
 *
 * Instead of showing a modal in the main wallet window, this component
 * injects a confirmation overlay directly into the dApp browser window.
 * This provides a better UX since the user is already looking at the dApp.
 */

import { useEffect, useMemo, useRef } from 'react';

import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { useTranslation } from 'react-i18next';

import {
  dappConfirmationStore,
  DAppConfirmationRequest,
  DAppConfirmationResult
} from 'lib/dapp-browser/confirmation-store';
import { isDesktop } from 'lib/platform';
import { useWalletStore } from 'lib/store';

import {
  generateDesktopConfirmationOverlay,
  onDappConfirmationResponse,
  showDappConfirmationOverlay
} from './dapp-browser';

/**
 * Desktop confirmation handler component
 *
 * Listens for dApp confirmation requests and shows an overlay in the dApp webview.
 * This component doesn't render anything - it just manages the overlay lifecycle.
 */
export function DesktopDappConfirmationModal(): null {
  const { t } = useTranslation();
  const pendingRequestRef = useRef<DAppConfirmationRequest | null>(null);

  // Get account info
  const currentAccount = useWalletStore(s => s.currentAccount);
  const accounts = useWalletStore(s => s.accounts);

  const accountId = useMemo(() => {
    if (currentAccount?.publicKey) return currentAccount.publicKey;
    if (accounts && accounts.length > 0) return accounts[0]!.publicKey;
    return null;
  }, [currentAccount, accounts]);

  const shortAccountId = useMemo(() => {
    if (!accountId) return '';
    return `${accountId.slice(0, 10)}...${accountId.slice(-8)}`;
  }, [accountId]);

  // Listen for confirmation responses from the overlay
  useEffect(() => {
    if (!isDesktop()) return;

    let unsubscribe: (() => void) | undefined;

    onDappConfirmationResponse(response => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest || pendingRequest.id !== response.requestId) {
        return;
      }

      // Resolve the confirmation store
      const result: DAppConfirmationResult = response.confirmed
        ? {
            confirmed: true,
            accountPublicKey: accountId || undefined,
            privateDataPermission: pendingRequest.privateDataPermission || PrivateDataPermission.UponRequest
          }
        : {
            confirmed: false
          };

      // Use setTimeout to match the original auto-approval timing
      // This avoids race conditions with the confirmation store setup.
      // PR-4 chunk 8: pass undefined sessionId so this falls into the
      // legacy default slot.
      setTimeout(() => {
        dappConfirmationStore.resolveConfirmation(undefined, result);
        pendingRequestRef.current = null;
      }, 100);
    }).then(unsub => {
      unsubscribe = unsub;
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [accountId]);

  // Subscribe to confirmation store and show overlay when needed
  useEffect(() => {
    if (!isDesktop()) return;

    const unsubscribe = dappConfirmationStore.subscribe(() => {
      const request = dappConfirmationStore.getPendingRequest();

      if (request && request !== pendingRequestRef.current) {
        pendingRequestRef.current = request;

        // Show the overlay in the dApp webview
        const appName = request.appMeta?.name || request.origin;
        const isTransaction = request.type === 'transaction' || request.type === 'consume';

        const overlayScript = generateDesktopConfirmationOverlay(
          request.id,
          appName,
          request.origin,
          request.network,
          shortAccountId,
          isTransaction,
          request.transactionMessages || [],
          {
            connectionRequest: t('dappConnectionRequest'),
            transactionRequest: t('dappTransactionRequest'),
            account: t('account'),
            network: t('network'),
            noAccountSelected: t('noAccountSelected'),
            deny: t('deny'),
            approve: t('approve'),
            confirm: t('confirm')
          }
        );

        showDappConfirmationOverlay(overlayScript).catch(() => {
          // If overlay fails, deny the request. PR-4 chunk 8: legacy
          // default-slot resolution.
          dappConfirmationStore.resolveConfirmation(undefined, { confirmed: false });
          pendingRequestRef.current = null;
        });
      } else if (!request) {
        pendingRequestRef.current = null;
      }
    });

    return unsubscribe;
  }, [shortAccountId, t]);

  // This component doesn't render anything - it just manages the overlay
  return null;
}

export default DesktopDappConfirmationModal;
