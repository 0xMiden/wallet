import type { PluginListenerHandle } from '@capacitor/core';
import { registerPlugin } from '@capacitor/core';

import { isAndroid, isIOS } from 'lib/platform';

import { getChain } from './config';

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
  /** Methods the proposal offers as optional only. A wallet that does not support them still pairs. */
  optionalMethods?: string[];
  events?: string[];
}

export interface ReownState {
  configured: boolean;
  connected: boolean;
  topic?: string;
  address?: string;
  accounts: string[];
  chainId?: number;
  /**
   * The distinct EVM chain ids that the connected session approved. A native build older than
   * this field omits it, and a state with no session omits it too.
   */
  chainIds?: number[];
  walletName?: string;
  socketStatus?: string;
}

export interface ReownSession {
  topic: string;
  address?: string;
  accounts: string[];
  chainId?: number;
  /** The distinct EVM chain ids that this session approved. An older native build omits it. */
  chainIds?: number[];
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
  /**
   * E2E-only: create a WalletConnect pairing directly and return its `wc:` URI
   * (bypassing the QR modal) so a headless test counterparty can pair. Call
   * INSTEAD of present(). Production connects via present().
   */
  connectUri(): Promise<{ uri: string }>;
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

/**
 * The connected WalletConnect session did not approve the chain of a request. The Sign SDK
 * refuses such a request with the opaque "Invalid permissions for call.", so the wallet refuses
 * it first with this error. This occurs when the session was paired before the wallet proposed
 * the chain.
 */
export class NativeSessionChainNotApprovedError extends Error {
  readonly chainId: number;
  readonly networkName: string;

  constructor(chainId: number, networkName: string) {
    super(`The connected WalletConnect session did not approve ${networkName} (eip155:${chainId}).`);
    this.name = 'NativeSessionChainNotApprovedError';
    this.chainId = chainId;
    this.networkName = networkName;
  }
}

/** The name the wallet gives an EVM chain in messages. */
export function nativeChainName(chainId: number): string {
  return getChain(chainId)?.name ?? `eip155:${chainId}`;
}

/**
 * Throws `NativeSessionChainNotApprovedError` when the session's approved chains do not include
 * `chainId`. A state without `chainIds` comes from an older native build that does not report
 * them: it passes, and the request goes to the Sign SDK as before.
 */
export function assertNativeSessionChain(state: ReownState, chainId: number, networkName: string): void {
  if (Array.isArray(state.chainIds) && !state.chainIds.includes(chainId)) {
    throw new NativeSessionChainNotApprovedError(chainId, networkName);
  }
}

/**
 * Best effort: when the session did not approve `chainId`, asks the connected wallet to add the
 * chain (`wallet_addEthereumChain`) and to switch to it (`wallet_switchEthereumChain`), then reads
 * the state again. Both requests go on a chain that the session did approve. A wallet that does not
 * support these methods, or a user who declines, rejects the request: the rejection is not thrown,
 * and the caller's guard then refuses the request with the reconnect message. Each call sends each
 * request once at most and never retries.
 */
export async function ensureNativeSessionChain(state: ReownState, chainId: number): Promise<ReownState> {
  const approved = state.chainIds;
  if (!Array.isArray(approved) || approved.includes(chainId)) return state;
  const chain = getChain(chainId);
  const requestChainId = state.chainId !== undefined && approved.includes(state.chainId) ? state.chainId : approved[0];
  if (!chain || requestChainId === undefined) return state;

  const hexChainId = `0x${chainId.toString(16)}`;
  try {
    await NativeReown.request({
      topic: state.topic,
      chainId: requestChainId,
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexChainId,
          chainName: chain.name,
          // The public RPC: `rpcUrl` is the WalletConnect proxy and carries our project id.
          rpcUrls: [chain.publicRpcUrl],
          nativeCurrency: chain.nativeCurrency,
          blockExplorerUrls: [chain.explorer]
        }
      ]
    });
    await NativeReown.request({
      topic: state.topic,
      chainId: requestChainId,
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }]
    });
  } catch (err) {
    console.warn(`[NativeReown] could not add or switch to eip155:${chainId}`, err);
  }

  try {
    return await NativeReown.getState();
  } catch (err) {
    console.warn('[NativeReown] could not read the state again after the chain request', err);
    return state;
  }
}

/**
 * Makes sure that the connected session approved `chainId` before the wallet signs on it: reads
 * the state, tries to add and switch to a missing chain, then applies the guard. Call it before
 * the first wallet prompt of a signing flow.
 */
export async function prepareNativeSessionChain(chainId: number): Promise<void> {
  const state = await ensureNativeSessionChain(await NativeReown.getState(), chainId);
  assertNativeSessionChain(state, chainId, nativeChainName(chainId));
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
        // The provider is the one place where the provider path applies the session-chain guard.
        // Only the provider knows the chain it signs on, and every caller that signs through it
        // (the Epoch wallet client of the Fast deposit, the Agglayer claim through
        // `useEvmWalletProvider`) gets the same check before its wallet prompt. The deposit screen
        // also checks before it starts the Fast deposit, so that it can show the localized message
        // before the Epoch SDK starts; this check is the backstop for every provider caller.
        await prepareNativeSessionChain(chainId);
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
          await prepareNativeSessionChain(chainId);
          const { result } = await NativeReown.request({ chainId, method, params });
          return unwrapNativeResult(result);
        }
        return rpcRead(rpcUrl, method, params);
    }
  };

  return { request };
}
