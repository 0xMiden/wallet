/**
 * Handles messages from the DApp browser WebView and forwards them to the wallet backend.
 */

import { MidenDAppRequest } from 'lib/adapter/types';
import { processDApp } from 'lib/miden/back/actions';

export interface WebViewMessage {
  type: string;
  payload: MidenDAppRequest | string;
  reqId: string;
}

export interface WebViewResponse {
  type: 'MIDEN_PAGE_RESPONSE' | 'MIDEN_PAGE_ERROR_RESPONSE';
  payload: unknown;
  reqId: string;
  error?: string;
}

/**
 * Process a message from the WebView and return a response.
 *
 * @param message  - the parsed wallet message from the dApp bridge
 * @param origin   - origin of the requesting page
 * @param sessionId - PR-4 chunk 8: optional multi-instance session id.
 *   When set, the backend threads this through to the confirmation
 *   store so the React modal can route the prompt to the matching
 *   foreground session. Single-session callers (extension popup,
 *   desktop dapp browser, faucet-webview) may omit it — the backend
 *   then uses the legacy default slot.
 */
// Debug logger — gated so production builds don't dump full wallet
// request payloads (addresses, amounts, public keys) into platform
// logs. Enable via `DEBUG_DAPP_BRIDGE=1` env at build time.
const DEBUG = typeof process !== 'undefined' && process.env?.DEBUG_DAPP_BRIDGE === '1';
const dlog = (...args: unknown[]) => {
  /* c8 ignore start */ if (DEBUG) console.log(...args); /* c8 ignore stop */
};

export async function handleWebViewMessage(
  message: WebViewMessage,
  origin: string,
  sessionId?: string
): Promise<WebViewResponse> {
  const { payload, reqId } = message;
  dlog('[MessageHandler] Received message:', { type: message.type, reqId, payloadType: typeof payload });

  try {
    // Handle PING for availability check
    if (payload === 'PING') {
      dlog('[MessageHandler] Responding to PING');
      return {
        type: 'MIDEN_PAGE_RESPONSE',
        payload: 'PONG',
        reqId
      };
    }

    // Runtime shape-check before handing off to processDApp. The dApp
    // controls this payload so we never trust it — only { type: string,
    // ... } objects may reach the backend dispatcher. Everything else
    // is rejected with an error response and does not touch the queue.
    if (!payload || typeof payload !== 'object' || typeof (payload as { type?: unknown }).type !== 'string') {
      return {
        type: 'MIDEN_PAGE_ERROR_RESPONSE',
        payload: null,
        reqId,
        error: 'Invalid dApp request payload'
      };
    }

    const dappRequest = payload as MidenDAppRequest;
    dlog('[MessageHandler] Processing DApp request, payload type:', dappRequest?.type);
    const response = await processDApp(origin, dappRequest, sessionId);
    dlog('[MessageHandler] DApp request completed:', { reqId, responseType: response?.type });

    return {
      type: 'MIDEN_PAGE_RESPONSE',
      payload: response ?? null,
      reqId
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[MessageHandler] Error processing message:', errorMessage);

    return {
      type: 'MIDEN_PAGE_ERROR_RESPONSE',
      payload: null,
      reqId,
      error: errorMessage
    };
  }
}
