/**
 * Desktop dApp Browser - TypeScript bindings for Tauri commands
 *
 * This module provides functions to control the dApp browser window
 * from the main wallet window.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

/**
 * Open a dApp in a new browser window
 *
 * @param url - The URL to open
 * @returns Promise that resolves when the window is opened
 */
export async function openDappWindow(url: string): Promise<void> {
  await invoke('open_dapp_window', { url });
}

/**
 * Close the dApp browser window
 *
 * @returns Promise that resolves when the window is closed
 */
export async function closeDappWindow(): Promise<void> {
  await invoke('close_dapp_window');
}

/**
 * Navigate the dApp browser
 *
 * @param action - 'back', 'forward', or 'refresh'
 * @returns Promise that resolves when navigation is triggered
 */
export async function dappNavigate(action: 'back' | 'forward' | 'refresh'): Promise<void> {
  await invoke('dapp_navigate', { action });
}

/**
 * Get the current URL of the dApp browser
 *
 * @returns Promise that resolves with the current URL
 */
export async function dappGetUrl(): Promise<string> {
  return await invoke('dapp_get_url');
}

/**
 * Send a wallet response back to the dApp window
 *
 * @param response - The response to send (will be JSON stringified)
 */
export async function sendDappWalletResponse(response: unknown): Promise<void> {
  await invoke('dapp_wallet_response', { response: JSON.stringify(response) });
}

/**
 * Interface for wallet request event payload
 */
export interface DappWalletRequestEvent {
  request: string; // JSON stringified request
  origin: string;
}

/**
 * Interface for parsed wallet request
 */
export interface DappWalletRequest {
  type: string;
  payload?: unknown;
  reqId: string;
}

/**
 * Listen for wallet requests from the dApp window
 *
 * @param callback - Function to call when a request is received
 * @returns Promise that resolves with an unsubscribe function
 */
export function onDappWalletRequest(
  callback: (request: DappWalletRequest, origin: string) => void | Promise<void>
): Promise<UnlistenFn> {
  return listen<DappWalletRequestEvent>('dapp-wallet-request', event => {
    try {
      const parsed = JSON.parse(event.payload.request) as DappWalletRequest;
      const result = callback(parsed, event.payload.origin);
      // If callback returns a promise, handle errors silently
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Silent fail for parse errors
    }
  });
}

/**
 * Listen for dApp window close events
 *
 * @param callback - Function to call when the window is closed
 * @returns Promise that resolves with an unsubscribe function
 */
export function onDappWindowClose(callback: () => void): Promise<UnlistenFn> {
  return listen('dapp-window-closed', () => {
    callback();
  });
}

/**
 * Bring the wallet's own window to the front.
 *
 * The desktop dApp approval prompt renders inside the wallet window
 * (`DesktopDappConfirmationModal`), which sits behind the dApp browser window the
 * user was just looking at, so the prompt raises it before asking.
 *
 * It replaces an overlay that was `eval`ed into the requesting page's own JS realm:
 * the modal's DOM, its approve button and its standing-private-data checkbox were
 * all page-owned, so a `MutationObserver` in the dApp could tick the box and
 * synthesise the click before the user could react — self-approving connections and
 * fund-moving transactions — and the verdict came back over a navigation any page
 * could perform itself. No approval decision is produced inside a document the
 * requesting origin controls any more, which is how mobile always worked.
 */
export async function focusMainWindow(): Promise<void> {
  await invoke('focus_main_window');
}
