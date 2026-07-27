import type { PluginListenerHandle } from '@capacitor/core';
import { registerPlugin } from '@capacitor/core';

import { isAndroid, isIOS } from 'lib/platform';

export interface ReownConfigureOptions {
  projectId: string;
  appName: string;
  appDescription: string;
  appUrl: string;
  icons: string[];
  verifyUrl?: string;
  nativeRedirect?: string;
  universalRedirect?: string;
  linkMode?: boolean;
  chainIds: number[];
  methods?: string[];
  events?: string[];
}

export interface ReownState {
  configured: boolean;
  connected: boolean;
  topic?: string;
  address?: string;
  accounts: string[];
  chainId?: number;
  walletName?: string;
  socketStatus?: string;
}

export interface ReownSession {
  topic: string;
  address?: string;
  accounts: string[];
  chainId?: number;
  walletName?: string;
}

export interface ReownSessionResponse {
  topic?: string;
  id?: string | number;
  result?: unknown;
  error?: string;
}

export interface ReownSendTransactionOptions {
  chainId: number;
  from?: string;
  to: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface ReownRequestOptions {
  topic?: string;
  chainId: number;
  method: string;
  params: unknown;
}

export interface ReownPlugin {
  configure(options: ReownConfigureOptions): Promise<void>;
  present(): Promise<void>;
  getState(): Promise<ReownState>;
  getSessions(): Promise<{ sessions: ReownSession[] }>;
  selectChain(options: { chainId: number }): Promise<void>;
  request(options: ReownRequestOptions): Promise<{ result: unknown }>;
  sendTransaction(options: ReownSendTransactionOptions): Promise<{ hash: string }>;
  disconnect(options?: { topic?: string }): Promise<void>;
  launchWallet(): Promise<void>;
  cleanup(options?: { topic?: string }): Promise<void>;

  addListener(eventName: 'stateChanged', listenerFunc: (state: ReownState) => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'sessionResponse',
    listenerFunc: (event: ReownSessionResponse) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'socketStatus',
    listenerFunc: (event: { status: string }) => void
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const NativeReown = registerPlugin<ReownPlugin>('Reown');

export function isNativeReownAvailable(): boolean {
  return isIOS() || isAndroid();
}

export interface NativeReownProviderOptions {
  chainId: number;
  address: string;
  /**
   * HTTP RPC endpoint for read-only JSON-RPC calls. The connected wallet only
   * answers signing/sending methods over the WalletConnect relay; reads
   * (`eth_call`, `eth_estimateGas`, receipts, …) must hit a node directly.
   */
  rpcUrl: string;
}

// Methods the external wallet must sign — routed over the WalletConnect relay.
const NATIVE_SIGN_METHODS = new Set([
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4'
]);

function txField(tx: object, key: string): string | undefined {
  const value: unknown = Reflect.get(tx, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The native plugins hand back the wallet's JSON-RPC result verbatim, which for
 * a string value (tx hash, signature) is JSON-encoded — i.e. wrapped in quotes
 * (`"\"0x…\""`). Decode it back to the raw hex so viem can consume it (e.g.
 * `waitForTransactionReceipt` → `eth_getTransactionByHash` rejects a quoted
 * hash). A value that is already raw hex is returned untouched.
 */
export function unwrapNativeResult(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not valid JSON — fall through and return the original string.
    }
  }
  return value;
}

async function rpcRead(rpcUrl: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] })
  });
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Invalid RPC response for ${method}`);
  }
  const errorValue: unknown = Reflect.get(payload, 'error');
  if (errorValue) {
    const rawMessage: unknown =
      typeof errorValue === 'object' && errorValue !== null ? Reflect.get(errorValue, 'message') : undefined;
    throw new Error(typeof rawMessage === 'string' ? rawMessage : `RPC error for ${method}`);
  }
  return Reflect.get(payload, 'result');
}

/**
 * Build a minimal EIP-1193 provider backed by the native Reown plugin so viem
 * (and SDKs that take a viem `walletClient`, e.g. Epoch) work unchanged on
 * iOS/Android. Signing/sending is forwarded to the connected wallet over the
 * relay; account/chain lookups are answered locally; every other read falls
 * through to `rpcUrl`. Mirrors how wagmi's WalletConnect provider splits
 * wallet vs. RPC traffic on web.
 */
export function buildNativeReownProvider({ chainId, address, rpcUrl }: NativeReownProviderOptions) {
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    switch (method) {
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [address];
      case 'eth_chainId':
        return `0x${chainId.toString(16)}`;
      case 'eth_sendTransaction': {
        const tx = Array.isArray(params) && typeof params[0] === 'object' && params[0] !== null ? params[0] : undefined;
        if (!tx) throw new Error('eth_sendTransaction requires a transaction object');
        const { hash } = await NativeReown.sendTransaction({
          chainId,
          from: txField(tx, 'from') ?? address,
          to: txField(tx, 'to') ?? '',
          value: txField(tx, 'value'),
          data: txField(tx, 'data'),
          gas: txField(tx, 'gas'),
          gasPrice: txField(tx, 'gasPrice'),
          maxFeePerGas: txField(tx, 'maxFeePerGas'),
          maxPriorityFeePerGas: txField(tx, 'maxPriorityFeePerGas')
        });
        return unwrapNativeResult(hash);
      }
      default:
        if (NATIVE_SIGN_METHODS.has(method)) {
          const { result } = await NativeReown.request({ chainId, method, params });
          return unwrapNativeResult(result);
        }
        return rpcRead(rpcUrl, method, params);
    }
  };

  return { request };
}
