/**
 * DesktopDappHandler - Handles wallet requests from dApp browser window
 *
 * This component should be mounted in the main wallet app to listen for
 * and process wallet requests from dApps opened in the desktop browser.
 *
 * The confirmation UI is handled by DesktopDappConfirmationModal which
 * also subscribes to dappConfirmationStore.
 */

import { useEffect } from 'react';

import { invoke } from '@tauri-apps/api/core';

import { MidenDAppRequest } from 'lib/adapter/types';
import { handleWebViewMessage, WebViewMessage } from 'lib/dapp-browser/message-handler';
import { isDesktop } from 'lib/platform';

import { onDappWalletRequest, sendDappWalletResponse, DappWalletRequest } from './dapp-browser';

// Log to Rust stdout for debugging (kept for future use)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function jsLog(message: string): void {
  invoke('js_log', { message }).catch(() => {});
}

/**
 * Hook that handles dApp wallet requests on desktop
 *
 * This sets up a listener for wallet requests from the dApp browser window
 * and processes them using the existing message handler infrastructure.
 *
 * Note: Confirmation UI is handled separately by DesktopDappConfirmationModal.
 */
export function useDesktopDappHandler(): void {
  useEffect(() => {
    // Only run on desktop
    if (!isDesktop()) return;

    let unsubscribe: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unsubscribe = await onDappWalletRequest(async (request: DappWalletRequest, origin: string) => {
          try {
            // Convert to WebViewMessage format used by existing handler
            const webViewMessage: WebViewMessage = {
              type: request.type,
              payload: request.payload as MidenDAppRequest | string,
              reqId: request.reqId
            };

            // Handle the message using existing infrastructure
            // This will trigger dappConfirmationStore for connection/transaction requests,
            // which DesktopDappConfirmationModal will pick up and show UI for
            const response = await handleWebViewMessage(webViewMessage, origin);

            // Send response back to dApp window
            await sendDappWalletResponse(response);
          } catch (error) {
            // Send error response
            const errorResponse = {
              type: 'MIDEN_PAGE_ERROR_RESPONSE',
              reqId: request.reqId,
              error: error instanceof Error ? error.message : 'Unknown error'
            };
            await sendDappWalletResponse(errorResponse);
          }
        });
      } catch (error) {
        // Silent fail - listener setup failed
      }
    };

    setupListener();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);
}

/**
 * Component wrapper for the desktop dApp handler hook
 *
 * Mount this component in your app to enable desktop dApp browser functionality.
 */
export function DesktopDappHandler(): null {
  useDesktopDappHandler();
  return null;
}

export default DesktopDappHandler;
