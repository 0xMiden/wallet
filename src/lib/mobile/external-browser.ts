import { InAppBrowser, ToolBarType } from '@miden/dapp-browser';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
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

  const closeListener = await InAppBrowser.addListener('closeEvent', async event => {
    const eventId = (event as { id?: string })?.id;
    if (eventId !== undefined && eventId !== id) {
      return;
    }
    markReturningFromWebview();
    closeListener.remove();
    await resetViewportAfterWebview();
  });

  await InAppBrowser.openWebView({
    id,
    url,
    title,
    toolbarType: ToolBarType.NAVIGATION,
    showReloadButton: true,
    isPresentAfterPageLoad: false
  });
}
