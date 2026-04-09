/**
 * Multi-instance dApp browser API. See multi-instance.js for the runtime
 * implementation and the Miden Wallet PR-4 plan for the design rationale.
 */

import type { OpenWebViewOptions } from './definitions';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export declare class DappWebViewInstance {
  readonly id: string;
  constructor(id: string);
  /** Move the webview to the given rect (delegates to updateDimensions). */
  setRect(rect: Rect): Promise<void>;
  /** Toggle this instance's visibility. The WebView's JS context survives. */
  setVisible(visible: boolean): Promise<void>;
  /** Take a JPEG snapshot of the current page as a base64 data URL. */
  snapshot(scale?: number, quality?: number): Promise<{ data: string }>;
  /** Inject JS into this instance's webview. */
  executeScript(code: string): Promise<void>;
  /** Close this instance and tear down its WebView. */
  close(): Promise<void>;
}

export interface DappWebViewManager {
  /**
   * Open a new dApp webview. If `id` is omitted, a UUID is generated.
   * If an instance with the given id already exists, the existing one is
   * returned (idempotent — protects against double-open races without
   * throwing).
   */
  open(opts: OpenWebViewOptions): Promise<DappWebViewInstance>;
  /** Look up a previously-opened instance by id. */
  get(id: string): DappWebViewInstance | undefined;
  /** Snapshot of all live JS-side instances. */
  list(): DappWebViewInstance[];
  /** Re-sync the JS-side cache from the native registry. */
  sync(): Promise<void>;
  /** Close every live instance. */
  closeAll(): Promise<void>;
}

export declare const dappWebViewManager: DappWebViewManager;
