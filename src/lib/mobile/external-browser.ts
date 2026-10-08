import { InAppBrowser, ToolBarType } from '@miden/dapp-browser';
import { externalPageFailed } from 'lib/mobile/external-page-failed';
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
 * Open a URL in a new tab on desktop / extension, or as a native InAppBrowser
 * overlay on mobile. On mobile, the underlying React screen stays mounted
 * behind the overlay, so closing the overlay returns the user to exactly
 * where they were (e.g. the "Transaction Completed" modal). A page whose initial
 * load fails closes its overlay, and the app then tells the user (`onExternalPageFailed`).
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

  // Only the initial load closes the overlay: once a page has loaded, a later failure leaves it
  // open on the platform's own error page.
  let loaded = false;
  const loadListener = await InAppBrowser.addListener('browserPageLoaded', event => {
    if (event.id === id) {
      loaded = true;
    }
  });

  // The flag, not remove(), is what makes this once: removal crosses the bridge, so a repeated
  // error can still arrive before it lands.
  let failed = false;
  const errorListener = await InAppBrowser.addListener('pageLoadError', async event => {
    if (loaded || failed || event.id !== id) {
      return;
    }
    failed = true;
    errorListener.remove();
    try {
      await InAppBrowser.close({ id });
    } catch (error) {
      console.warn('[openExternalUrl] Could not close a page that failed to load:', error);
    }
    externalPageFailed();
  });

  const closeListener = await InAppBrowser.addListener('closeEvent', async event => {
    const eventId = (event as { id?: string })?.id;
    if (eventId !== undefined && eventId !== id) {
      return;
    }
    markReturningFromWebview();
    removeListeners();
    await resetViewportAfterWebview();
  });

  const removeListeners = () => {
    closeListener.remove();
    errorListener.remove();
    loadListener.remove();
  };

  try {
    await InAppBrowser.openWebView({
      id,
      url,
      title,
      toolbarType: ToolBarType.NAVIGATION,
      showReloadButton: true,
      isPresentAfterPageLoad: false,
      ...webviewToolbarColors()
    });
  } catch (error) {
    removeListeners();
    throw error;
  }
}
