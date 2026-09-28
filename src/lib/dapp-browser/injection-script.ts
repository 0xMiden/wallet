/**
 * This script is injected into web pages loaded in the DApp browser.
 * It creates a `window.midenWallet` object that DApps can use to interact with the wallet.
 * Communication happens via webkit/android message handlers provided by Capacitor InAppBrowser.
 */

export const INJECTION_SCRIPT = `
(function() {
  // CSS injection MUST run before the window.midenWallet early-return
  // below, because the wallet bridge is idempotent across re-opens of
  // the same session — but we may have updated the CSS we want to
  // apply (e.g. when the navbar height or padding strategy changes),
  // and the only way that lands on a previously-opened session is to
  // rerun the style block on every executeScript call.
  try {
    const STYLE_ID = 'miden-wallet-bottom-pad';
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    const installPadding = function() {
      if (!document || !document.head) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent =
        'html { scroll-padding-bottom: 96px !important; }' +
        'body { padding-bottom: calc(96px + env(safe-area-inset-bottom, 0px)) !important; }';
      document.head.appendChild(style);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installPadding, { once: true });
    } else {
      installPadding();
    }
  } catch (e) {
    // Best-effort — never block the wallet bridge on a styling failure.
  }

  if (window.midenWallet) return; // Already injected

  // Simple EventEmitter implementation
  class EventEmitter {
    constructor() {
      this._events = {};
    }
    on(event, listener) {
      if (!this._events[event]) this._events[event] = [];
      this._events[event].push(listener);
      return () => this.off(event, listener);
    }
    off(event, listener) {
      if (!this._events[event]) return;
      this._events[event] = this._events[event].filter(l => l !== listener);
    }
    // A listener that throws stops neither the listeners after it nor the code that emitted, as on desktop.
    emit(event, ...args) {
      if (!this._events[event]) return;
      this._events[event].slice().forEach(listener => {
        try {
          listener(...args);
        } catch (e) {
          console.error('[MidenWallet] Error in ' + event + ' listener:', e);
        }
      });
    }
  }

  // Pending requests map
  const pendingRequests = new Map();
  let requestId = 0;

  // Send message to native app via Capacitor InAppBrowser
  function sendToNative(type, payload, reqId) {
    const message = { type, payload, reqId };

    // Use Capacitor InAppBrowser's mobileApp interface
    if (window.mobileApp && window.mobileApp.postMessage) {
      // Intentionally NOT logging payload — this runs inside the dApp
      // page and would leave wallet request breadcrumbs visible via
      // Safari Web Inspector on any device that ever attaches to it.
      window.mobileApp.postMessage(message);
      return;
    }

    // Fallback for testing in regular browser
    window.postMessage({ __midenNative: true, ...message }, '*');
  }

  // Make request to wallet
  function request(payload) {
    return new Promise((resolve, reject) => {
      const reqId = 'req_' + (++requestId);
      pendingRequests.set(reqId, { resolve, reject });
      sendToNative('MIDEN_PAGE_REQUEST', payload, reqId);

      // Timeout after 5 minutes (for long operations like proof generation)
      setTimeout(() => {
        if (pendingRequests.has(reqId)) {
          pendingRequests.delete(reqId);
          reject(new Error('Request timeout'));
        }
      }, 300000);
    });
  }

  // Handle response from native app
  window.__midenWalletResponse = function(responseStr) {
    try {
      const response = typeof responseStr === 'string' ? JSON.parse(responseStr) : responseStr;
      if (!response || typeof response !== 'object') return;
      const { type, payload, reqId, error } = response;
      if (typeof reqId !== 'string') return;

      const pending = pendingRequests.get(reqId);
      if (!pending) return;

      pendingRequests.delete(reqId);

      if (type === 'MIDEN_PAGE_ERROR_RESPONSE' || error) {
        pending.reject(new Error(error || payload || 'Unknown error'));
      } else {
        pending.resolve(payload);
      }
    } catch (e) {
      console.error('[MidenWallet] Error handling response:', e);
    }
  };

  // Helper functions
  function b64ToU8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function u8ToB64(u8) {
    let binary = '';
    for (let i = 0; i < u8.length; i++) {
      binary += String.fromCharCode(u8[i]);
    }
    return btoa(binary);
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Follows the wallet's current account after connect (#174), the way the extension's window
  // object does: a 10 s poll of this origin's grant. The next poll starts only once the last one
  // settles, so a slow answer never stacks polls; only disconnect() stops it.
  const PERMISSION_POLL_MS = 10000;
  let stopPermissionWatch = function() {};
  // disconnect() counts itself before its request; a connect() it overlaps then rejects and starts no watch (#1227).
  let disconnects = 0;

  // The wallet's own fields are the only state. Both emitters isolate their listeners, so the only throw a tick
  // sees is a key that cannot be decoded, before any field changes.
  function watchPermission(wallet) {
    stopPermissionWatch();
    let stopped = false;
    let timer;
    const tick = async function() {
      try {
        const res = await request({ type: 'GET_CURRENT_PERMISSION_REQUEST' });
        const hasPermission = res && typeof res === 'object' && 'permission' in res;
        if (!stopped && hasPermission) {
          // An account switch changes the address; rpc is not compared, as connect names the network by id, the poll by URL.
          const account = res.permission === null ? undefined : res.permission.address;
          if (account !== wallet.address) wallet._applyPermission(res.permission);
        }
      } catch (e) {
        // A refused or timed-out poll, or a key that cannot be decoded, leaves the account as it was; the next one asks again.
      }
      if (!stopped) timer = setTimeout(tick, PERMISSION_POLL_MS);
    };
    timer = setTimeout(tick, PERMISSION_POLL_MS);
    stopPermissionWatch = function() {
      stopped = true;
      clearTimeout(timer);
    };
  }

  // MidenWallet class
  class MidenWallet extends EventEmitter {
    constructor() {
      super();
      this.address = undefined;
      this.publicKey = undefined;
      this.permission = undefined;
      this.appName = undefined;
      this.network = undefined;
    }

    async isAvailable() {
      try {
        const res = await request('PING');
        return res === 'PONG';
      } catch {
        return false;
      }
    }

    async connect(privateDataPermission, network, allowedPrivateData) {
      const disconnectsBefore = disconnects;
      const res = await request({
        type: 'PERMISSION_REQUEST',
        appMeta: { name: window.location.hostname },
        force: false,
        privateDataPermission,
        network,
        allowedPrivateData
      });
      if (disconnects !== disconnectsBefore) throw new Error('The wallet was disconnected while connecting');

      // Decode publicKey BEFORE touching other wallet state so a
      // malformed publicKey response (e.g. wallet bug, corrupt
      // base64) throws a clean error instead of leaving the dApp
      // with a half-populated permission object.
      let decodedPublicKey;
      try {
        decodedPublicKey = b64ToU8(res.publicKey);
      } catch (e) {
        throw new Error('Invalid publicKey in wallet response');
      }

      this.permission = {
        rpc: res.network,
        address: res.accountId,
        privateDataPermission: res.privateDataPermission,
        allowedPrivateData: res.allowedPrivateData,
        publicKey: decodedPublicKey
      };
      this.address = res.accountId;
      this.network = network;
      this.publicKey = decodedPublicKey;

      // The watch starts first, so a listener that disconnects from this emission stops it.
      watchPermission(this);

      // Emit connect event for wallet adapters that listen to events
      this.emit('connect', this.publicKey);
      return this.permission;
    }

    // The connection ends whether the request succeeds, is refused or times out, and its error still reaches the
    // caller. Only the call that clears a connected wallet signals it, so a listener that disconnects on the signal
    // is refused once and stops, and two overlapping calls signal once (#1227).
    async disconnect() {
      stopPermissionWatch();
      disconnects++;
      try {
        await request({ type: 'DISCONNECT_REQUEST' });
      } finally {
        // A connect begun after this call is answered first only if this request was dropped; its timeout
        // then ends that connection too, so the watch stops with the fields.
        stopPermissionWatch();
        const connected = !!this.address;
        this.address = undefined;
        this.permission = undefined;
        this.publicKey = undefined;
        if (connected) this.emit('disconnect');
      }
    }

    // Fields follow the new account before listeners hear of it; null clears them. The permission
    // carries the decoded key, the shape connect gives. A key that cannot be decoded throws before
    // anything changes.
    _applyPermission(perm) {
      if (perm === null) {
        this.address = undefined;
        this.publicKey = undefined;
        this.permission = undefined;
        this.emit('accountChange', null);
        return;
      }
      const publicKey = perm.publicKey ? b64ToU8(perm.publicKey) : undefined;
      const permission = { ...perm, publicKey };
      this.permission = permission;
      this.address = perm.address;
      this.publicKey = publicKey;
      this.emit('accountChange', permission);
    }

    async requestSend(transaction) {
      const res = await request({
        type: 'SEND_TRANSACTION_REQUEST',
        sourcePublicKey: this.address,
        transaction
      });
      return { transactionId: res.transactionId };
    }

    async requestConsume(transaction) {
      const res = await request({
        type: 'CONSUME_REQUEST',
        sourcePublicKey: this.address,
        transaction
      });
      return { transactionId: res.transactionId };
    }

    async requestTransaction(transaction) {
      const res = await request({
        type: 'TRANSACTION_REQUEST',
        sourcePublicKey: this.address,
        transaction
      });
      return { transactionId: res.transactionId };
    }

    async requestPrivateNotes(notefilterType, noteIds) {
      const res = await request({
        type: 'PRIVATE_NOTES_REQUEST',
        sourcePublicKey: this.address,
        notefilterType,
        noteIds
      });
      return { privateNotes: res.privateNotes };
    }

    async waitForTransaction(txId) {
      const res = await request({
        type: 'WAIT_FOR_TRANSACTION_REQUEST',
        txId
      });
      return res.transactionOutput;
    }

    async signBytes(data, kind) {
      const publicKeyAsHex = bytesToHex(this.publicKey);
      const messageAsB64 = u8ToB64(data);

      const res = await request({
        type: 'SIGN_REQUEST',
        sourceAccountId: this.address,
        sourcePublicKey: publicKeyAsHex,
        payload: messageAsB64,
        kind
      });

      return { signature: b64ToU8(res.signature) };
    }

    async importPrivateNote(note) {
      const noteAsB64 = u8ToB64(note);

      const res = await request({
        type: 'IMPORT_PRIVATE_NOTE_REQUEST',
        sourcePublicKey: this.address,
        note: noteAsB64
      });

      return { noteId: res.noteId };
    }

    async requestAssets() {
      const res = await request({
        type: 'ASSETS_REQUEST',
        sourcePublicKey: this.address
      });
      return { assets: res.assets };
    }

    async requestConsumableNotes() {
      const res = await request({
        type: 'CONSUMABLE_NOTES_REQUEST',
        sourcePublicKey: this.address
      });
      return { consumableNotes: res.consumableNotes };
    }

    async requestGuardianInfo() {
      const res = await request({
        type: 'GUARDIAN_INFO_REQUEST',
        sourcePublicKey: this.address
      });
      return { guardianInfo: res.guardianInfo };
    }
  }

  // Create and expose the wallet instance
  const midenWallet = new MidenWallet();

  try {
    Object.defineProperty(window, 'midenWallet', {
      value: midenWallet,
      writable: false,
      configurable: false
    });
  } catch (e) {
    window.midenWallet = midenWallet;
  }
})();
`;
