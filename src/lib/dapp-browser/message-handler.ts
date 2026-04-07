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
export async function handleWebViewMessage(
  message: WebViewMessage,
  origin: string,
  sessionId?: string
): Promise<WebViewResponse> {
  const { payload, reqId } = message;
  console.log('[MessageHandler] Received message:', { type: message.type, reqId, payloadType: typeof payload });
  console.log('[MessageHandler] Full payload:', JSON.stringify(payload));

  try {
    // Handle PING for availability check
    if (payload === 'PING') {
      console.log('[MessageHandler] Responding to PING');
      return {
        type: 'MIDEN_PAGE_RESPONSE',
        payload: 'PONG',
        reqId
      };
    }

    // Process the DApp request
    const dappRequest = payload as MidenDAppRequest;
    console.log('[MessageHandler] Processing DApp request, payload type:', dappRequest?.type);
    console.log(
      '[MessageHandler] Calling processDApp with origin:',
      origin,
      'sessionId:',
      sessionId,
      'and request:',
      JSON.stringify(dappRequest)
    );
    const response = await processDApp(origin, dappRequest, sessionId);
    console.log('[MessageHandler] DApp request completed:', { reqId, responseType: response?.type, response });

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
