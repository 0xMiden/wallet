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
 * where they were (e.g. the "Transaction Completed" modal). A page that fails to
 * load closes its overlay, and the app then tells the user (`onExternalPageFailed`).
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

  // The flag, not remove(), is what makes this once: removal crosses the bridge, so a repeated
  // error can still arrive before it lands.
  let failed = false;
  const errorListener = await InAppBrowser.addListener('pageLoadError', async event => {
    if (failed || event.id !== id) {
      return;
    }
    failed = true;
    errorListener.remove();
    await InAppBrowser.close({ id });
    externalPageFailed();
  });

  const closeListener = await InAppBrowser.addListener('closeEvent', async event => {
    const eventId = (event as { id?: string })?.id;
    if (eventId !== undefined && eventId !== id) {
      return;
    }
    markReturningFromWebview();
    closeListener.remove();
    errorListener.remove();
    await resetViewportAfterWebview();
  });

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
