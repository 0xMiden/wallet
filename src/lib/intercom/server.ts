import browser, { Runtime } from 'webextension-polyfill';

import { serializeError } from './helpers';
import { MessageType, RequestMessage, ResponseMessage, ErrorMessage, SubscriptionMessage } from './types';

type ReqHandler = (payload: any, port: Runtime.Port) => Promise<any>;

export class IntercomServer {
  private ports = new Set<Runtime.Port>();
  private reqHandlers: Array<ReqHandler> = [];
  private initializedHandlers: boolean = false;
  private disconnectListeners: Array<() => void> = [];

  constructor() {
    browser.runtime.onConnect.addListener(port => {
      this.addPort(port);

      port.onDisconnect.addListener(() => {
        this.removePort(port);
      });
    });

    this.handleMessage = this.handleMessage.bind(this);
  }

  isConnected(port: Runtime.Port) {
    return this.ports.has(port);
  }

  /**
   * Returns true if any popup/fullpage intercom clients are connected.
   * Filters out content script and other non-intercom port connections.
   */
  hasClients(): boolean {
    for (const port of this.ports) {
      if (port.name === 'INTERCOM') return true;
    }
    return false;
  }

  onAllClientsDisconnected(listener: () => void): () => void {
    this.disconnectListeners.push(listener);
    return () => {
      this.disconnectListeners = this.disconnectListeners.filter(l => l !== listener);
    };
  }

  onRequest(handler: ReqHandler) {
    this.addReqHandler(handler);
    this.initializedHandlers = true;
    // Replay any messages that arrived before the handler was registered
    this.replayPendingMessages();
    return () => {
      this.removeReqHandler(handler);
    };
  }

  broadcast(data: any) {
    const msg: SubscriptionMessage = { type: MessageType.Sub, data };
    this.ports.forEach(port => {
      port.postMessage(msg);
    });
  }

  notify(port: Runtime.Port, data: any) {
    this.send(port, { type: MessageType.Sub, data });
  }

  onDisconnect(port: Runtime.Port, listener: () => void) {
    port.onDisconnect.addListener(listener);
    return () => port.onDisconnect.removeListener(listener);
  }

  private pendingMessages: Array<{ msg: RequestMessage; port: Runtime.Port }> = [];

  private handleMessage(msg: any, port: Runtime.Port) {
    if (port.sender?.id === browser.runtime.id && msg?.type === MessageType.Req) {
      // If no request handler registered yet, respond with a default "Idle" state
      // for GetStateRequest so the UI can render (onboarding/unlock screen).
      // Other messages are queued for replay when the handler is registered.
      if (!this.initializedHandlers && this.reqHandlers.length === 0) {
        const reqMsg = msg as RequestMessage;
        if (reqMsg.data?.type === 'GET_STATE_REQUEST') {
          // Respond immediately with Idle state so the UI doesn't show blank
          this.send(port, {
            type: MessageType.Res,
            reqId: reqMsg.reqId,
            data: {
              type: 'GET_STATE_RESPONSE',
              state: {
                status: 0, // WalletStatus.Idle
                accounts: [],
                currentAccount: null,
                networks: [],
                settings: null,
                ownMnemonic: null,
              },
            },
          });
          return;
        } else if (reqMsg.data?.type === 'SYNC_REQUEST') {
          this.send(port, {
            type: MessageType.Res,
            reqId: reqMsg.reqId,
            data: { type: 'SYNC_RESPONSE' },
          });
          return;
        }
        // Queue other messages for replay
        this.pendingMessages.push({ msg: reqMsg, port });
        return;
      }

      this.processMessage(msg as RequestMessage, port);
    }
  }

  private processMessage(msg: RequestMessage, port: Runtime.Port) {
    (async (msgInner) => {
      try {
        for (const handler of this.reqHandlers) {
          const data = await handler(msg.data, port);
          if (data !== undefined) {
            this.send(port, {
              type: MessageType.Res,
              reqId: msgInner.reqId,
              data
            });
            return;
          }
        }
        throw new Error('Not Found');
      } catch (err: any) {
        this.send(port, {
          type: MessageType.Err,
          reqId: msgInner.reqId,
          data: serializeError(err)
        });
      }
    })(msg);
  }

  /** Replay any messages queued before the handler was registered */
  private replayPendingMessages() {
    const pending = this.pendingMessages;
    this.pendingMessages = [];
    for (const { msg, port } of pending) {
      if (this.ports.has(port)) {
        this.processMessage(msg, port);
      }
    }
  }

  private send(port: Runtime.Port, msg: ResponseMessage | SubscriptionMessage | ErrorMessage) {
    if (this.ports.has(port)) {
      port.postMessage(msg);
    }
  }

  private addPort(port: Runtime.Port) {
    port.onMessage.addListener(this.handleMessage);
    this.ports.add(port);
  }

  private removePort(port: Runtime.Port) {
    port.onMessage.removeListener(this.handleMessage);
    this.ports.delete(port);

    if (this.ports.size === 0) {
      for (const listener of this.disconnectListeners) {
        try {
          listener();
        } catch (err) {
          console.error('[IntercomServer] Disconnect listener error:', err);
        }
      }
    }
  }

  private addReqHandler(handler: ReqHandler) {
    this.reqHandlers.unshift(handler);
  }

  private removeReqHandler(handler: ReqHandler) {
    this.reqHandlers = this.reqHandlers.filter(h => h !== handler);
  }
}
