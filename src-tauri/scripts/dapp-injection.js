/**
 * dApp Browser Injection Script
 *
 * Runs at document start in the dApp browser window, and takes effect only in the
 * TOP-LEVEL document (see the frame check below). It provides:
 * 1. A toolbar with navigation controls (back, forward, refresh, close)
 * 2. window.midenWallet API for dApps to interact with the wallet
 *
 * Communication with Tauri is a hidden iframe navigated to
 * `https://miden-wallet-request/<base64>`, which the `on_navigation` handler
 * intercepts and cancels; responses arrive by the wallet window calling
 * `window.__midenWalletResponse` through the `dapp_wallet_response` command.
 */
(function() {
  'use strict';

  // SECURITY: per-window bridge token, prepended to this script by
  // `dapp_browser::injection_script_with_token`. Rust drops any wallet request that
  // does not carry it, which is what stops an embedded third-party frame (an ad
  // slot, a chat widget, a compromised CDN script) from navigating itself to
  // `https://miden-wallet-request/…` and having the request attributed to the
  // TOP-LEVEL dApp's origin and approved session — `on_navigation` fires for
  // sub-frame navigations and is handed only a URL, so it cannot tell them apart.
  //
  // This runs FIRST, before the top-frame check below, because initialization
  // scripts execute at document-start ahead of every page script: reading the token
  // into this closure and removing the global here means no script in this document
  // can ever observe it, in ANY frame. That matters because Tauri injects with
  // `for_main_frame_only: true` — WebKit-enforced on macOS/WKWebView and
  // Linux/WebKitGTK — but wry documents that "Windows: scripts are always added to
  // subframes regardless of the `for_main_frame_only` option", so on WebView2 this
  // script DOES run in sub-frames and must deny them the token itself.
  const BRIDGE_TOKEN = globalThis.__MIDEN_BRIDGE_TOKEN__ || '';
  try {
    delete globalThis.__MIDEN_BRIDGE_TOKEN__;
  } catch (e) {
    globalThis.__MIDEN_BRIDGE_TOKEN__ = undefined;
  }

  // Only the top-level document gets a wallet bridge (and a toolbar). A sub-frame
  // that reaches this point on Windows leaves with neither the token nor
  // `window.midenWallet`. `window.top`/`window.self` are read here, at document
  // start, before any page script could redefine them.
  if (window.top !== window.self) return;

  // Prevent multiple injections
  if (window.__midenInjected) return;
  window.__midenInjected = true;

  // Pending requests waiting for responses
  const pendingRequests = new Map();
  let requestId = 0;

  // Store original hash to restore after signaling
  let originalHash = window.location.hash;

  // Debug: expose pendingRequests for troubleshooting
  window.__midenPendingRequests = pendingRequests;

  // Function for Tauri to call to send responses
  window.__midenWalletResponse = function(responseStr) {
    try {
      const response = typeof responseStr === 'string' ? JSON.parse(responseStr) : responseStr;
      const { type, payload, reqId, error } = response;

      const pending = pendingRequests.get(reqId);
      if (!pending) {
        return;
      }

      pendingRequests.delete(reqId);

      if (type === 'MIDEN_PAGE_ERROR_RESPONSE' || error) {
        pending.reject(new Error(error || payload || 'Unknown error'));
      } else {
        pending.resolve(payload);
      }
    } catch (e) {
      // Silent fail
    }
  };

  // Send request to wallet by triggering a navigation that Tauri intercepts
  // Uses a hidden iframe to avoid affecting the main page's navigation state
  function sendToWallet(message) {
    // Encode the message as base64 to safely include in URL
    const jsonStr = JSON.stringify(message);
    const encoded = btoa(unescape(encodeURIComponent(jsonStr)));

    // Use a fake HTTPS URL that Tauri will intercept
    // The URL pattern is: https://miden-wallet-request/{base64-encoded-payload}
    const signalUrl = `https://miden-wallet-request/${encoded}`;

    // Use a hidden iframe to trigger navigation without affecting main page state
    // This preserves the pendingRequests map and other JavaScript state
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = signalUrl;
    document.body.appendChild(iframe);

    // Clean up iframe after a short delay
    setTimeout(() => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    }, 1000);
  }

  // Send a request to the wallet
  function request(payload) {
    return new Promise((resolve, reject) => {
      const reqId = 'req_' + ++requestId;
      pendingRequests.set(reqId, { resolve, reject });

      const message = {
        type: 'MIDEN_PAGE_REQUEST',
        payload,
        reqId,
        // Authenticates this as a main-frame bridge request; Rust strips it before
        // the request reaches the wallet window.
        token: BRIDGE_TOKEN
      };

      sendToWallet(message);

      // Timeout after 5 minutes
      setTimeout(() => {
        if (pendingRequests.has(reqId)) {
          pendingRequests.delete(reqId);
          reject(new Error('Request timeout'));
        }
      }, 300000);
    });
  }

  function injectToolbar() {
    // SECURITY: this toolbar is ordinary DOM inside the dApp's own document, and
    // this script runs in the page's main world — so the page can rewrite, restyle
    // or remove anything here. It therefore carries NAVIGATION ACTIONS ONLY and
    // must never display the address the user is on: a `#miden-url` div used to sit
    // here, and one line of page script (`document.getElementById('miden-url')
    // .textContent = 'app.uniswap.org'`, re-applied from a MutationObserver) made
    // the wallet's own chrome vouch for any hostname the page chose. The real
    // origin is now shown in the OS window title, which Rust sets from
    // `dapp_request_origin` on every page load (see `dapp_browser.rs`) and the page
    // cannot reach. Do not "defend" an injected URL element instead — the page runs
    // in the same realm and wins every such race.
    const toolbar = document.createElement('div');
    toolbar.id = 'miden-dapp-toolbar';
    toolbar.innerHTML = `
      <button id="miden-back" title="Back" aria-label="Go back">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <button id="miden-forward" title="Forward" aria-label="Go forward">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
      </button>
      <button id="miden-refresh" title="Refresh" aria-label="Refresh page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 4v6h-6M1 20v-6h6"/>
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
        </svg>
      </button>
      <button id="miden-close" title="Close" aria-label="Close browser">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    `;

    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      #miden-dapp-toolbar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 40px;
        background: linear-gradient(to bottom, #2a2a2a, #1a1a1a);
        border-bottom: 1px solid #3a3a3a;
        display: flex;
        align-items: center;
        padding: 0 8px;
        gap: 4px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
      #miden-dapp-toolbar button {
        background: transparent;
        border: none;
        color: #ccc;
        cursor: pointer;
        padding: 6px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
      }
      #miden-dapp-toolbar button:hover {
        background: rgba(255,255,255,0.1);
        color: #fff;
      }
      #miden-dapp-toolbar button:active {
        background: rgba(255,255,255,0.15);
        transform: scale(0.95);
      }
      #miden-close {
        margin-left: auto;
      }
      #miden-close:hover {
        color: #ff6b6b !important;
      }
      body {
        margin-top: 40px !important;
        height: calc(100vh - 40px) !important;
        min-height: calc(100vh - 40px) !important;
      }
      html {
        overflow-y: auto !important;
      }
    `;

    document.head.appendChild(style);
    document.body.insertBefore(toolbar, document.body.firstChild);

    // Navigation button handlers - use window.history directly
    document.getElementById('miden-back').addEventListener('click', () => {
      window.history.back();
    });

    document.getElementById('miden-forward').addEventListener('click', () => {
      window.history.forward();
    });

    document.getElementById('miden-refresh').addEventListener('click', () => {
      window.location.reload();
    });

    document.getElementById('miden-close').addEventListener('click', () => {
      // Request close through the wallet API
      request({ type: 'CLOSE_WINDOW' }).catch(() => {});
    });
  }

  function injectWalletAPI() {
    // MidenWallet class that mimics the browser extension API (MidenWindowObject)
    // Must match the interface from @demox-labs/miden-wallet-adapter-miden
    class MidenWallet {
      constructor() {
        // Public properties matching MidenWindowObject
        this.address = undefined;
        this.publicKey = undefined;
        this.permission = undefined;
        this.network = undefined;
        this.appName = undefined;
        // Internal
        this._listeners = new Map();
      }

      async isAvailable() {
        return true;
      }

      async connect(privateDataPermission, network, allowedPrivateData) {
        const res = await request({
          type: 'PERMISSION_REQUEST',
          appMeta: { name: window.location.hostname },
          force: false,
          privateDataPermission,
          network,
          allowedPrivateData,
        });

        // Set public properties matching MidenWindowObject
        this.address = res.accountId;
        this.network = network;
        this.publicKey = res.publicKey ? base64ToUint8Array(res.publicKey) : undefined;
        this.permission = {
          rpc: res.network,
          address: res.accountId,
          privateDataPermission: res.privateDataPermission,
          allowedPrivateData: res.allowedPrivateData,
          publicKey: this.publicKey
        };

        // Emit accountChange event (what the adapter listens for)
        this._emit('accountChange', this.permission);
      }

      async disconnect() {
        const res = await request({
          type: 'DISCONNECT_REQUEST',
          network: this.network,
        });

        this.address = undefined;
        this.publicKey = undefined;
        this.permission = undefined;
        this.network = undefined;

        // Emit accountChange with null
        this._emit('accountChange', null);

        return res;
      }

      async requestSend(transaction) {
        const res = await request({
          type: 'SEND_TRANSACTION_REQUEST',
          sourcePublicKey: this.address,
          transaction,
        });
        return { transactionId: res.transactionId };
      }

      async requestTransaction(transaction) {
        const res = await request({
          type: 'TRANSACTION_REQUEST',
          sourcePublicKey: this.address,
          transaction,
        });
        return { transactionId: res.transactionId };
      }

      async requestConsume(transaction) {
        const res = await request({
          type: 'CONSUME_REQUEST',
          sourcePublicKey: this.address,
          transaction,
        });
        return { transactionId: res.transactionId };
      }

      async signBytes(data, kind) {
        const res = await request({
          type: 'SIGN_REQUEST',
          sourceAccountId: this.address,
          sourcePublicKey: uint8ArrayToHex(this.publicKey),
          payload: uint8ArrayToBase64(data),
          kind: kind,
        });
        return { signature: base64ToUint8Array(res.signature) };
      }

      async requestAssets() {
        const res = await request({
          type: 'ASSETS_REQUEST',
          sourcePublicKey: this.address,
        });
        return { assets: res.assets };
      }

      async requestPrivateNotes(notefilterType, noteIds) {
        const res = await request({
          type: 'PRIVATE_NOTES_REQUEST',
          sourcePublicKey: this.address,
          notefilterType,
          noteIds,
        });
        return { privateNotes: res.privateNotes };
      }

      async requestConsumableNotes() {
        const res = await request({
          type: 'CONSUMABLE_NOTES_REQUEST',
          sourcePublicKey: this.address,
        });
        return { consumableNotes: res.consumableNotes };
      }

      async importPrivateNote(note) {
        const res = await request({
          type: 'IMPORT_PRIVATE_NOTE_REQUEST',
          sourcePublicKey: this.address,
          note: uint8ArrayToBase64(note),
        });
        return { noteId: res.noteId };
      }

      async waitForTransaction(txId) {
        const res = await request({
          type: 'WAIT_FOR_TRANSACTION_REQUEST',
          txId,
        });
        return res.transactionOutput;
      }

      // Legacy methods for backwards compatibility
      isConnected() {
        return !!this.address;
      }

      getPermission() {
        return this.permission;
      }

      // Event emitter methods
      on(event, callback) {
        if (!this._listeners.has(event)) {
          this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);
        return () => this.off(event, callback);
      }

      off(event, callback) {
        const listeners = this._listeners.get(event);
        if (listeners) {
          listeners.delete(callback);
        }
      }

      emit(event, data) {
        this._emit(event, data);
      }

      _emit(event, data) {
        const listeners = this._listeners.get(event);
        if (listeners) {
          listeners.forEach(cb => {
            try {
              cb(data);
            } catch (e) {
              // Silent fail for listener errors
            }
          });
        }
      }
    }

    // Helper functions for base64/Uint8Array conversion
    function base64ToUint8Array(base64) {
      if (!base64) return undefined;
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    }

    function uint8ArrayToBase64(bytes) {
      if (!bytes) return '';
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    function uint8ArrayToHex(bytes) {
      if (!bytes) return '';
      return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Create and expose the wallet instance
    const midenWallet = new MidenWallet();

    try {
      Object.defineProperty(window, 'midenWallet', {
        value: midenWallet,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch (e) {
      // Fallback if defineProperty fails
      window.midenWallet = midenWallet;
    }
  }

  // Initialize when DOM is ready
  function init() {
    if (document.body) {
      injectToolbar();
      injectWalletAPI();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        injectToolbar();
        injectWalletAPI();
      });
    }
  }

  init();
})();
