/**
 * Provider-driven version of `useDappWebView` (PR-1) that the
 * `<DappBrowserProvider>` uses to manage the embedded dApp webview.
 *
 * Differences from PR-1's `useDappWebView`:
 *  - The hook does NOT own a `slotRef`. Instead the provider passes the
 *    target rect explicitly via props. This is what lets parking work:
 *    the provider switches the target rect to an offscreen position
 *    without unmounting any visual component.
 *  - `open()` is exposed and is idempotent — the provider calls it once
 *    when a session+rect first becomes available, and the hook ignores
 *    subsequent calls until close.
 *  - `close()` is exposed for the provider to call.
 *  - Listeners (messageFromWebview, browserPageLoaded, urlChangeEvent,
 *    pageLoadError, closeEvent) are wired during open, the same way the
 *    PR-1 hook did. Bridge script injection is the same.
 *
 * The PR-1 hook is removed and `<DappActive>` becomes a thin visual
 * consumer of the provider context.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { InAppBrowser, ToolBarType } from '@capgo/inappbrowser';
import { useTranslation } from 'react-i18next';

import { INJECTION_SCRIPT, type DappSession, type WebViewMessage, handleWebViewMessage } from 'lib/dapp-browser';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';

import { type WebViewRect } from 'lib/dapp-browser/webview-rect';

interface UseDappBrowserWebViewArgs {
  /** The active session, or null when nothing is open. */
  session: DappSession | null;
  /** The rect to draw the native webview at, or null to defer opening. */
  targetRect: WebViewRect | null;
  /** Called when the dApp page finishes loading; consumer updates the session title. */
  onPageLoaded?: (title: string | null) => void;
  /** Called when the native plugin closes itself (e.g. via `closeEvent`). */
  onClose?: () => void;
}

interface UseDappBrowserWebViewResult {
  /** True between openWebView and the first browserPageLoaded event. */
  isLoading: boolean;
  /** Open the webview (idempotent). The provider calls this once per session. */
  open: () => Promise<void>;
  /** Close the webview entirely. The provider calls this on hard close. */
  close: () => Promise<void>;
  /**
   * Inject CSS visibility toggle so the dApp content disappears without
   * resizing the native frame. Used by the confirmation modal hide path.
   */
  setHidden: (hidden: boolean) => Promise<void>;
}

async function sendResponseToWebview(response: unknown, retries = 3): Promise<void> {
  const code = `window.__midenWalletResponse(${JSON.stringify(JSON.stringify(response))});`;
  await new Promise(resolve => setTimeout(resolve, 100));
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await InAppBrowser.executeScript({ code });
      return;
    } catch (error) {
      console.warn(`[useDappBrowserWebView] executeScript attempt ${attempt} failed:`, error);
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      } else {
        throw error;
      }
    }
  }
}

export function useDappBrowserWebView(args: UseDappBrowserWebViewArgs): UseDappBrowserWebViewResult {
  const { session, targetRect, onPageLoaded, onClose } = args;
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);

  // Refs for stable callback access from listeners
  const onPageLoadedRef = useRef(onPageLoaded);
  const onCloseRef = useRef(onClose);
  const originRef = useRef<string>(session?.origin ?? '');
  const openedRef = useRef(false);
  const closedRef = useRef(true);
  const listenersRef = useRef<Array<{ remove: () => void } | undefined>>([]);

  useEffect(() => {
    onPageLoadedRef.current = onPageLoaded;
  }, [onPageLoaded]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (session) originRef.current = session.origin;
  }, [session?.origin]);

  // Drive `updateDimensions` when the target rect changes (and we're open).
  // This is what makes parking work: the provider passes an offscreen rect
  // and the hook moves the native frame to it.
  useEffect(() => {
    if (!openedRef.current || !targetRect) return;
    InAppBrowser.updateDimensions({
      x: targetRect.x,
      y: targetRect.y,
      width: targetRect.width,
      height: targetRect.height
    }).catch(err => console.warn('[useDappBrowserWebView] updateDimensions failed:', err));
  }, [targetRect?.x, targetRect?.y, targetRect?.width, targetRect?.height]);

  const open = useCallback(async () => {
    if (openedRef.current || !session || !targetRect) return;
    openedRef.current = true;
    closedRef.current = false;
    setIsLoading(true);

    try {
      // Wire listeners
      const messageListener = await InAppBrowser.addListener('messageFromWebview', async event => {
        try {
          const eventData = (event as { detail?: unknown })?.detail ?? event;
          const message = typeof eventData === 'string' ? JSON.parse(eventData) : (eventData as WebViewMessage);
          const walletMessage = message as WebViewMessage;
          const response = await handleWebViewMessage(walletMessage, originRef.current);
          await sendResponseToWebview(response);
        } catch (error) {
          console.error('[useDappBrowserWebView] Error handling WebView message:', error);
        }
      });
      listenersRef.current.push(messageListener);

      const closeListener = await InAppBrowser.addListener('closeEvent', async () => {
        if (closedRef.current) return;
        closedRef.current = true;
        markReturningFromWebview();
        await resetViewportAfterWebview();
        onCloseRef.current?.();
      });
      listenersRef.current.push(closeListener);

      const loadListener = await InAppBrowser.addListener('browserPageLoaded', async () => {
        if (closedRef.current) return;
        setIsLoading(false);
        try {
          await InAppBrowser.executeScript({ code: INJECTION_SCRIPT });
        } catch (e) {
          console.error('[useDappBrowserWebView] Error injecting bridge:', e);
        }
        try {
          await InAppBrowser.executeScript({
            code: `
              (function() {
                try {
                  var t = document.title || '';
                  if (window.mobileApp && window.mobileApp.postMessage) {
                    window.mobileApp.postMessage({ __midenInternal: 'title', title: t });
                  }
                } catch (e) { /* ignore */ }
              })();
            `
          });
        } catch {
          // best-effort title fetch
        }
      });
      listenersRef.current.push(loadListener);

      const urlListener = await InAppBrowser.addListener('urlChangeEvent', event => {
        const newUrl = (event as { url?: string })?.url;
        if (newUrl) {
          try {
            originRef.current = new URL(newUrl).origin;
          } catch {
            /* ignore */
          }
        }
      });
      listenersRef.current.push(urlListener);

      const errorListener = await InAppBrowser.addListener('pageLoadError', () => {
        if (closedRef.current) return;
        setIsLoading(false);
        console.error('[useDappBrowserWebView] Page load error');
      });
      listenersRef.current.push(errorListener);

      // Open the positioned webview at the provided rect.
      await InAppBrowser.openWebView({
        url: session.url,
        title: t('dappBrowser'),
        toolbarType: ToolBarType.BLANK,
        showReloadButton: false,
        x: targetRect.x,
        y: targetRect.y,
        width: targetRect.width,
        height: targetRect.height
      });
    } catch (error) {
      console.error('[useDappBrowserWebView] Error opening webview:', error);
      setIsLoading(false);
      openedRef.current = false;
      closedRef.current = true;
    }
  }, [session, targetRect, t]);

  const close = useCallback(async () => {
    if (closedRef.current && !openedRef.current) return;
    closedRef.current = true;
    openedRef.current = false;
    for (const l of listenersRef.current) l?.remove();
    listenersRef.current = [];
    try {
      await InAppBrowser.close();
    } catch {
      // already closed
    }
    markReturningFromWebview();
    await resetViewportAfterWebview();
  }, []);

  const setHidden = useCallback(async (hidden: boolean) => {
    const code = hidden
      ? `(function(){try{document.documentElement.style.visibility='hidden';}catch(e){}})();`
      : `(function(){try{document.documentElement.style.visibility='visible';}catch(e){}})();`;
    try {
      await InAppBrowser.executeScript({ code });
    } catch {
      /* best-effort */
    }
  }, []);

  // Cleanup on unmount: tear down the webview if anything is still open.
  useEffect(() => {
    return () => {
      if (!closedRef.current) {
        for (const l of listenersRef.current) l?.remove();
        listenersRef.current = [];
        InAppBrowser.close().catch(() => undefined);
        markReturningFromWebview();
        void resetViewportAfterWebview();
        closedRef.current = true;
        openedRef.current = false;
      }
    };
  }, []);

  return { isLoading, open, close, setHidden };
}
