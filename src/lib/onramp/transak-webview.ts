import type { PluginListenerHandle } from '@capacitor/core';
import { InAppBrowser, ToolBarType } from '@miden/dapp-browser';

import { addWebviewCloseListener, isWebviewEventFor } from 'lib/mobile/external-browser';
import { captureCrash } from 'lib/telemetry/crash';

import { type TransakExpectation, checkTransakEvent, parseTransakEvent } from './transak-guard';

export const TRANSAK_INSTANCE_ID = 'transak-webview';

/** If no Transak event arrives in this time, the bridge is broken and the guard gives no protection. */
export const TRANSAK_NO_EVENTS_TIMEOUT_MS = 60_000;

/**
 * Injected at document start on iOS. Android has no document-start injection: the plugin injects the script when
 * each page load ends, and it refuses `preShowScript` unless `isPresentAfterPageLoad` is true. The flag stops a
 * second install on the same page. Transak sends its widget events to `window.Android.postMessage` (Android),
 * `window.webkit.messageHandlers.IosWebview` (iOS) and window `postMessage`. The script forwards each of them to the
 * wallet as `{ detail: { transak: payload } }`, through the plugin bridge `window.mobileApp`.
 */
export const TRANSAK_BRIDGE_SCRIPT = `(function () {
  if (window.__midenTransakBridge) return;
  window.__midenTransakBridge = true;
  function forward(payload) {
    try {
      window.mobileApp.postMessage({ detail: { transak: payload } });
    } catch (e) {}
  }
  window.Android = { postMessage: function (s) { forward(s); } };
  try {
    var handlers = window.webkit && window.webkit.messageHandlers;
    if (handlers && !handlers.IosWebview) {
      Object.defineProperty(handlers, 'IosWebview', {
        configurable: true,
        value: { postMessage: function (s) { forward(s); } }
      });
    }
  } catch (e) {}
  window.addEventListener('message', function (event) { forward(event.data); });
})();`;

export interface OpenTransakWidgetInput {
  url: string;
  expected: TransakExpectation;
  onMismatch: () => void;
  onClosed: () => void;
}

function isTransakUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'transak.com' || hostname.endsWith('.transak.com'));
  } catch {
    return false;
  }
}

/** Send a Sentry event. The error has no address values. */
function reportGuardEvent(tag: 'transak-address-mismatch' | 'transak-guard-no-events'): void {
  const error = new Error(tag);
  error.name = tag;
  captureCrash(error);
}

/**
 * Open the Transak widget in the mobile InAppBrowser and check each widget event with `checkTransakEvent`. On a
 * mismatch, close the widget before the user pays and call `onMismatch`. Call `onClosed` once when the widget closes.
 */
export async function openTransakWidget({
  url,
  expected,
  onMismatch,
  onClosed
}: OpenTransakWidgetInput): Promise<void> {
  const handles: PluginListenerHandle[] = [];
  let lastUrl = url;
  let sawEvent = false;
  let mismatched = false;
  let closed = false;

  const noEventsTimer = setTimeout(() => {
    if (!sawEvent && !closed) reportGuardEvent('transak-guard-no-events');
  }, TRANSAK_NO_EVENTS_TIMEOUT_MS);

  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(noEventsTimer);
    for (const handle of handles) {
      handle.remove();
    }
    onClosed();
  };

  handles.push(
    await InAppBrowser.addListener('urlChangeEvent', event => {
      if (isWebviewEventFor(event, TRANSAK_INSTANCE_ID)) lastUrl = event.url;
    })
  );

  handles.push(
    await InAppBrowser.addListener('messageFromWebview', async event => {
      if (closed || mismatched || !isWebviewEventFor(event, TRANSAK_INSTANCE_ID)) return;
      // Only the Transak page can speak for Transak.
      if (!isTransakUrl(lastUrl)) return;
      const transakEvent = parseTransakEvent(event.detail?.transak);
      if (transakEvent === null) return;
      sawEvent = true;
      if (checkTransakEvent(transakEvent, expected) === 'ok') return;

      mismatched = true;
      try {
        await InAppBrowser.close({ id: TRANSAK_INSTANCE_ID });
      } catch {
        // The widget can be closed already. The error screen must show all the same.
      }
      reportGuardEvent('transak-address-mismatch');
      onMismatch();
    })
  );

  handles.push(await addWebviewCloseListener(TRANSAK_INSTANCE_ID, finish));

  try {
    await InAppBrowser.openWebView({
      id: TRANSAK_INSTANCE_ID,
      url,
      title: 'Transak',
      toolbarType: ToolBarType.NAVIGATION,
      showReloadButton: true,
      isPresentAfterPageLoad: true,
      preShowScript: TRANSAK_BRIDGE_SCRIPT,
      preShowScriptInjectionTime: 'documentStart'
    });
  } catch (error) {
    clearTimeout(noEventsTimer);
    for (const handle of handles) {
      handle.remove();
    }
    throw error;
  }
}
