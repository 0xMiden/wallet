/**
 * Owns the lifecycle of a single dApp webview opened via `@capgo/inappbrowser`.
 *
 * Responsibilities:
 * - Open the native webview at the rect provided by `<NativeWebViewSlot>`
 * - Inject the wallet bridge script (`INJECTION_SCRIPT`)
 * - Wire up `messageFromWebview` → `handleWebViewMessage` → `executeScript` round trip
 * - Track scroll/title via injected listeners
 * - Close on unmount or explicit close
 *
 * Confirmation flow change vs. the old `Browser.tsx`:
 * - The OLD code injected an HTML overlay into the dApp webview itself when
 *   a confirmation was needed.
 * - The NEW code does NOT inject. Instead `<DappActive>` renders a React
 *   `<DappConfirmationModal>` ON TOP of the wallet UI (z-70). The dApp's
 *   visibility is toggled via `executeScript` injecting CSS visibility
 *   instead of resizing the native webview (which can trip the host
 *   viewport bug; see PR-1 risks table).
 *
 * Lifecycle ownership note:
 * - In PR-1 this hook lives inside `<DappActive>`, which is mounted only
 *   when the user is on `/browser` AND has an active session. PR-3 hoists
 *   ownership to a `DappBrowserProvider` at app root so the webview can
 *   survive tab navigation. The hook itself is intentionally portable.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { InAppBrowser, ToolBarType } from '@capgo/inappbrowser';
import { useTranslation } from 'react-i18next';

import {
  INJECTION_SCRIPT,
  type DappSession,
  type WebViewMessage,
  handleWebViewMessage,
  rectFromDOMRect
} from 'lib/dapp-browser';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';

interface UseDappWebViewArgs {
  session: DappSession;
  /** The slot ref. The webview is positioned to the slot's bounding rect. */
  slotRef: React.RefObject<HTMLDivElement | null>;
  /** Called when the user closes the dApp via the capsule, hardware back, or webview close event */
  onClose: () => void;
  /** Called when the dApp page finishes loading; consumer updates the session title */
  onPageLoaded?: (title: string | null) => void;
}

interface UseDappWebViewResult {
  /** True between openWebView and the first browserPageLoaded event */
  isLoading: boolean;
  /** Programmatically close the webview (also called automatically on unmount) */
  close: () => Promise<void>;
  /**
   * Hide the dApp content via injected CSS visibility. Used by
   * `<DappConfirmationModal>` to "remove" the dApp from view while a
   * confirmation modal is displayed, without resizing the native frame
   * (which can trip the host viewport bug — see PR-1 risks).
   */
  setHidden: (hidden: boolean) => Promise<void>;
}

/**
 * Send a response back to the dApp via injected `__midenWalletResponse`.
 * Mirrors the legacy retry/delay logic from the old Browser.tsx because
 * `executeScript` can be unreliable right after the confirmation overlay
 * was dismissed.
 */
async function sendResponseToWebview(response: unknown, retries = 3): Promise<void> {
  const code = `window.__midenWalletResponse(${JSON.stringify(JSON.stringify(response))});`;
  // Small delay before executing script to let the JS context stabilize
  await new Promise(resolve => setTimeout(resolve, 100));

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await InAppBrowser.executeScript({ code });
      return;
    } catch (error) {
      console.warn(`[useDappWebView] executeScript attempt ${attempt} failed:`, error);
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      } else {
        throw error;
      }
    }
  }
}

export function useDappWebView({ session, slotRef, onClose, onPageLoaded }: UseDappWebViewArgs): UseDappWebViewResult {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);

  // Refs that survive renders without triggering them.
  const onCloseRef = useRef(onClose);
  const onPageLoadedRef = useRef(onPageLoaded);
  const originRef = useRef<string>(session.origin);
  const closedRef = useRef(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    onPageLoadedRef.current = onPageLoaded;
  }, [onPageLoaded]);

  // Open the webview once when the session becomes active. We deliberately
  // do NOT depend on `session` here — we want exactly one open call per hook
  // instance. The session id stays stable for the hook's lifetime.
  useEffect(() => {
    let cancelled = false;
    const listeners: Array<{ remove: () => void } | undefined> = [];

    async function open() {
      try {
        // 1. messageFromWebview — wallet bridge requests + confirmation responses
        const messageListener = await InAppBrowser.addListener('messageFromWebview', async event => {
          try {
            const eventData = (event as { detail?: unknown })?.detail ?? event;
            const message = typeof eventData === 'string' ? JSON.parse(eventData) : (eventData as WebViewMessage);
            const walletMessage = message as WebViewMessage;
            const response = await handleWebViewMessage(walletMessage, originRef.current);
            await sendResponseToWebview(response);
          } catch (error) {
            console.error('[useDappWebView] Error handling WebView message:', error);
          }
        });
        listeners.push(messageListener);

        // 2. closeEvent — user closed via the plugin's chrome (PR-1 only fires on
        //    forced closes since we use ToolBarType.BLANK; the React capsule's ✕
        //    calls our `close()` directly).
        const closeListener = await InAppBrowser.addListener('closeEvent', async () => {
          if (closedRef.current) return;
          closedRef.current = true;
          markReturningFromWebview();
          await resetViewportAfterWebview();
          onCloseRef.current();
        });
        listeners.push(closeListener);

        // 3. browserPageLoaded — inject the bridge once per page load and
        //    fetch the page title for the capsule.
        const loadListener = await InAppBrowser.addListener('browserPageLoaded', async () => {
          if (closedRef.current) return;
          setIsLoading(false);
          try {
            await InAppBrowser.executeScript({ code: INJECTION_SCRIPT });
          } catch (e) {
            console.error('[useDappWebView] Error injecting bridge:', e);
          }
          // Fetch the document title via executeScript. The plugin's
          // `executeScript` doesn't return values across all platforms, so
          // we use a postMessage round-trip via `mobileApp.postMessage`.
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
          } catch (e) {
            // Title fetch is best-effort
          }
        });
        listeners.push(loadListener);

        // 4. urlChangeEvent — keep originRef current for SPA navigation.
        //    `browserPageLoaded` doesn't fire on `pushState`, so we also
        //    update origin/title here.
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
        listeners.push(urlListener);

        // 5. pageLoadError — for now log and stop the loading spinner. PR-6
        //    surfaces a real ErrorState UI.
        const errorListener = await InAppBrowser.addListener('pageLoadError', () => {
          if (closedRef.current) return;
          setIsLoading(false);
          console.error('[useDappWebView] Page load error');
        });
        listeners.push(errorListener);

        if (cancelled) {
          for (const l of listeners) l?.remove();
          return;
        }

        // Compute the initial rect from the slot, then open the positioned
        // webview. The ResizeObserver in `<NativeWebViewSlot>` keeps it in
        // sync afterward via `updateDimensions`.
        const slot = slotRef.current;
        const rect = slot ? rectFromDOMRect(slot.getBoundingClientRect()) : undefined;

        await InAppBrowser.openWebView({
          url: session.url,
          title: t('dappBrowser'),
          toolbarType: ToolBarType.BLANK,
          showReloadButton: false,
          ...(rect && {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          })
        });
      } catch (error) {
        console.error('[useDappWebView] Error opening webview:', error);
        setIsLoading(false);
        onCloseRef.current();
      }
    }

    void open();

    return () => {
      cancelled = true;
      for (const l of listeners) l?.remove();
      // Best-effort close on unmount; ignore errors if already closed.
      if (!closedRef.current) {
        closedRef.current = true;
        InAppBrowser.close().catch(() => undefined);
        markReturningFromWebview();
        void resetViewportAfterWebview();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // open exactly once per hook instance

  // Track the slot's rect via ResizeObserver and forward changes to the
  // native webview via `updateDimensions`. This keeps the webview aligned
  // when the wallet's safe-area padding, capsule height, or footer height
  // changes (rotation, dynamic island, etc.).
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    let lastRect = rectFromDOMRect(slot.getBoundingClientRect());
    const ro = new ResizeObserver(() => {
      const next = rectFromDOMRect(slot.getBoundingClientRect());
      if (
        next.x === lastRect.x &&
        next.y === lastRect.y &&
        next.width === lastRect.width &&
        next.height === lastRect.height
      ) {
        return;
      }
      lastRect = next;
      InAppBrowser.updateDimensions({
        x: next.x,
        y: next.y,
        width: next.width,
        height: next.height
      }).catch(() => undefined);
    });
    ro.observe(slot);
    return () => ro.disconnect();
  }, [slotRef]);

  const close = useCallback(async () => {
    if (closedRef.current) return;
    closedRef.current = true;
    try {
      await InAppBrowser.close();
    } catch {
      // Already closed; ignore.
    }
    markReturningFromWebview();
    await resetViewportAfterWebview();
    onCloseRef.current();
  }, []);

  const setHidden = useCallback(async (hidden: boolean) => {
    // Toggle dApp content visibility via injected CSS instead of resizing
    // the native frame. Resizing risks tripping the host viewport bug
    // documented in `lib/mobile/viewport-reset.ts`.
    const code = hidden
      ? `(function(){try{document.documentElement.style.visibility='hidden';}catch(e){}})();`
      : `(function(){try{document.documentElement.style.visibility='visible';}catch(e){}})();`;
    try {
      await InAppBrowser.executeScript({ code });
    } catch {
      // Best-effort; if the script fails, the modal still functions.
    }
  }, []);

  return { isLoading, close, setHidden };
}
