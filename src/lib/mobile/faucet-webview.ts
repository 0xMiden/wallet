import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

import { InAppBrowser, ToolBarType } from '@miden/dapp-browser';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
import { isMobile } from 'lib/platform';

// PR-4 chunk 9: faucet uses its own instance id so its messageFromWebview
// listener can filter out events from any concurrently-open multi-instance
// dApp browser. Without this filter, a dApp posting a similarly-shaped
// detail object would be mis-routed into the faucet's download handler.
const FAUCET_INSTANCE_ID = 'faucet-webview';

const DOWNLOAD_INTERCEPTOR_SCRIPT = `
(function() {
  if (window.__downloadInterceptorInjected) return;
  window.__downloadInterceptorInjected = true;

  // Store blob URLs and their base64 content
  const blobRegistry = new Map();

  // Helper to convert ArrayBuffer to base64
  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Override URL.createObjectURL to capture blob content as base64
  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(blob) {
    const url = originalCreateObjectURL.call(this, blob);
    if (blob instanceof Blob) {
      blob.arrayBuffer().then(buffer => {
        const base64 = arrayBufferToBase64(buffer);
        blobRegistry.set(url, base64);
      }).catch(() => {});
    }
    return url;
  };

  function handleDownload(href, filename) {
    // Check if we have the blob content cached
    if (blobRegistry.has(href)) {
      const base64Content = blobRegistry.get(href);
      window.mobileApp.postMessage({
        detail: {
          type: 'DOWNLOAD_FILE',
          filename: filename,
          content: base64Content,
          isBase64: true
        }
      });
      return;
    }

    // Fallback to fetching as binary
    fetch(href)
      .then(r => r.arrayBuffer())
      .then(buffer => {
        const base64Content = arrayBufferToBase64(buffer);
        window.mobileApp.postMessage({
          detail: {
            type: 'DOWNLOAD_FILE',
            filename: filename,
            content: base64Content,
            isBase64: true
          }
        });
      })
      .catch(err => console.error('Download error:', err));
  }

  // Intercept programmatic clicks on anchor elements
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() {
    if (this.hasAttribute('download')) {
      const href = this.href;
      const filename = this.download || 'download';
      handleDownload(href, filename);
      return;
    }
    return originalClick.apply(this, arguments);
  };

  // Intercept manual clicks on <a download> links
  document.addEventListener('click', function(e) {
    const link = e.target.closest('a[download]');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      handleDownload(link.href, link.download || 'download');
    }
  }, true);

  // Watch for "TOKENS MINTED!" success message and auto-close browser
  let successMessageSent = false;
  function checkForSuccessMessage() {
    if (successMessageSent) return;
    const bodyText = document.body ? document.body.innerText : '';
    if (bodyText.includes('TOKENS MINTED!') && bodyText.includes('CLICK ANYWHERE TO CONTINUE')) {
      successMessageSent = true;
      // Small delay so user can see the success message
      setTimeout(() => {
        window.mobileApp.postMessage({
          detail: { type: 'PUBLIC_NOTE_SUCCESS' }
        });
      }, 750);
    }
  }

  // Use MutationObserver to detect DOM changes
  const observer = new MutationObserver(checkForSuccessMessage);
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }

  // Also poll periodically as a fallback
  setInterval(checkForSuccessMessage, 1000);
})();
`;

export interface FaucetWebviewOptions {
  url: string;
  title: string;
  recipientAddress?: string;
}

export async function openFaucetWebview({ url, title, recipientAddress }: FaucetWebviewOptions): Promise<void> {
  if (!isMobile()) {
    window.open(url, '_blank');
    return;
  }

  // Script to prefill the recipient address input
  const prefillAddressScript = recipientAddress
    ? `
    (function() {
      const input = document.getElementById('recipient-address');
      if (input) {
        input.value = '${recipientAddress}';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })();
    `
    : '';

  // Guard to prevent duplicate download processing
  let isProcessingDownload = false;

  // Set up message listener for download requests
  const messageListener = await InAppBrowser.addListener('messageFromWebview', async event => {
    try {
      // PR-4 chunk 9: filter to events from this specific instance so a
      // concurrently-open multi-instance dApp doesn't accidentally trip
      // the download handler.
      const eventId = (event as { id?: string })?.id;
      if (eventId !== undefined && eventId !== FAUCET_INSTANCE_ID) {
        return;
      }
      // The event should directly contain our data since notifyListeners passes messageBody as data
      const eventData = event as { detail?: { type?: string; filename?: string; content?: string } };
      const detail = eventData.detail;

      if (!detail) {
        return;
      }

      if (detail.type === 'DOWNLOAD_FILE') {
        // Prevent duplicate processing
        if (isProcessingDownload) {
          return;
        }
        isProcessingDownload = true;
        const { filename, content } = detail;

        // Guard against missing filename or content
        if (!filename || !content) {
          console.error('DOWNLOAD_FILE: missing filename or content');
          isProcessingDownload = false;
          return;
        }

        // Write to cache directory as base64 (no encoding = binary/base64)
        const result = await Filesystem.writeFile({
          path: filename,
          data: content,
          directory: Directory.Cache
        });

        // Store the URI for later sharing
        const fileUri = result.uri;
        const fileTitle = filename;

        // Close browser first (PR-4 chunk 9: id-aware close).
        await InAppBrowser.close({ id: FAUCET_INSTANCE_ID });

        // Use setTimeout to completely decouple share from InAppBrowser context
        setTimeout(async () => {
          try {
            await Share.share({
              files: [fileUri],
              dialogTitle: 'Save ' + fileTitle
            });
          } catch (e) {
            alert('Share error: ' + (e as Error).message);
          }
        }, 1000);
      }

      if (detail.type === 'PUBLIC_NOTE_SUCCESS') {
        // Auto-close browser when public note minting is complete
        // (PR-4 chunk 9: id-aware close).
        await InAppBrowser.close({ id: FAUCET_INSTANCE_ID });
      }
    } catch (error) {
      // Show alert with error for debugging
      if (typeof alert !== 'undefined') {
        alert('Error: ' + (error as Error).message);
      }
    }
  });

  // Inject scripts when page loads (needs DOM to be ready)
  const loadListener = await InAppBrowser.addListener('browserPageLoaded', async event => {
    // PR-4 chunk 9: only react to load events from THIS instance.
    const eventId = (event as { id?: string })?.id;
    if (eventId !== undefined && eventId !== FAUCET_INSTANCE_ID) {
      return;
    }
    try {
      // Inject download interceptor first
      await InAppBrowser.executeScript({ code: DOWNLOAD_INTERCEPTOR_SCRIPT, id: FAUCET_INSTANCE_ID });
      // Then prefill address if provided
      if (prefillAddressScript) {
        await InAppBrowser.executeScript({ code: prefillAddressScript, id: FAUCET_INSTANCE_ID });
      }
    } catch (e) {
      console.error('[FaucetWebview] Error injecting scripts:', e);
    }
  });

  // Clean up listeners when browser closes
  const closeListener = await InAppBrowser.addListener('closeEvent', async event => {
    // PR-4 chunk 9: only respond to OUR instance's close.
    const eventId = (event as { id?: string })?.id;
    if (eventId !== undefined && eventId !== FAUCET_INSTANCE_ID) {
      return;
    }
    markReturningFromWebview();
    messageListener.remove();
    loadListener.remove();
    closeListener.remove();
    await resetViewportAfterWebview();
  });

  // Open the webview immediately (scripts injected via browserPageLoaded listener)
  await InAppBrowser.openWebView({
    id: FAUCET_INSTANCE_ID,
    url,
    title,
    toolbarType: ToolBarType.NAVIGATION,
    showReloadButton: true,
    isPresentAfterPageLoad: false
  });
}
