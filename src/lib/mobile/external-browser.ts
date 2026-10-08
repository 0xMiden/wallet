import type { PluginListenerHandle } from '@capacitor/core';
import { InAppBrowser, ToolBarType } from '@miden/dapp-browser';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
import { webviewToolbarColors } from 'lib/mobile/webview-theme';
import { isMobile } from 'lib/platform';

const EXPLORER_INSTANCE_ID = 'explorer-webview';

export interface OpenExternalUrlOptions {
  url: string;
  title: string;
  /** Optional instance id; defaults to a shared explorer id. Lets callers open distinct overlays. */
  id?: string;
}

/**
 * True when an InAppBrowser event belongs to the instance `id`. An event without an id comes from a legacy
 * single-instance caller and is accepted.
 */
export function isWebviewEventFor(event: object | null | undefined, id: string): boolean {
  if (event === null || event === undefined || !('id' in event) || typeof event.id !== 'string') return true;
  return event.id === id;
}

/**
 * Listen for the close of the InAppBrowser instance `id`. On close: mark the return from the webview, remove this
 * listener, run `onClose`, then reset the viewport. The caller can also remove the returned handle itself.
 */
export async function addWebviewCloseListener(id: string, onClose?: () => void): Promise<PluginListenerHandle> {
  const closeListener = await InAppBrowser.addListener('closeEvent', async event => {
    if (!isWebviewEventFor(event, id)) {
      return;
    }
    markReturningFromWebview();
    closeListener.remove();
    onClose?.();
    await resetViewportAfterWebview();
  });
  return closeListener;
}

/**
 * Open a URL in a new tab on desktop / extension, or as a native InAppBrowser
 * overlay on mobile. On mobile, the underlying React screen stays mounted
 * behind the overlay, so closing the overlay returns the user to exactly
 * where they were (e.g. the "Transaction Completed" modal).
 */
export async function openExternalUrl({
  url,
  title,
  id = EXPLORER_INSTANCE_ID
}: OpenExternalUrlOptions): Promise<void> {
  if (!isMobile()) {
    window.open(url, '_blank');
    return;
  }

  await addWebviewCloseListener(id);

  await InAppBrowser.openWebView({
    id,
    url,
    title,
    toolbarType: ToolBarType.NAVIGATION,
    showReloadButton: true,
    isPresentAfterPageLoad: false,
    ...webviewToolbarColors()
  });
}
