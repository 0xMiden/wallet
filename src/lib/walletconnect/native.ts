import type { PluginListenerHandle } from '@capacitor/core';
import { registerPlugin } from '@capacitor/core';

import { isAndroid, isIOS } from 'lib/platform';
import {
  markNativeSessionPrecheck,
  type NativeSessionPrecheckFailure,
  type NativeSessionPrecheckRecovery,
  walletRaised
} from 'lib/telemetry/bridge-receive-failure';

import { getChain, type EvmChain } from './config';
import { readNativeFeeFields } from './fees';
import {
  decodeReownNativeFailureCode,
  decodeReownIOSFailureCode,
  markReownNativeFailure,
  readReownNativeFailure,
  type ReownNativeFailure
} from './native-request-failure';

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
  chains?: EvmChain[];
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

const rawNativeReown: ReownPlugin = registerPlugin<ReownPlugin>('Reown');

function nativeRequestRejection(rejection: unknown): unknown {
  if (
    (!isAndroid() && !isIOS()) ||
    rejection === null ||
    (typeof rejection !== 'object' && typeof rejection !== 'function')
  )
    return rejection;

  try {
    // An inherited code belongs to another answer; getters are not a safe wire envelope.
    const code: unknown = Object.getOwnPropertyDescriptor(rejection, 'code')?.value;
    const snapshot = isAndroid() ? decodeReownNativeFailureCode(code) : decodeReownIOSFailureCode(code);
    if (snapshot !== undefined) markReownNativeFailure(rejection, snapshot);
  } catch {
    // Diagnostics must not replace a bridge rejection with an accessor's exception.
  }
  return rejection;
}

export const NativeReown: ReownPlugin = new Proxy(rawNativeReown, {
  get(target, key) {
    if (key === 'request') {
      return (options: ReownRequestOptions) =>
        target.request(options).catch((rejection: unknown) => {
          throw nativeRequestRejection(rejection);
        });
    }
    if (key === 'sendTransaction') {
      return (options: ReownSendTransactionOptions) =>
        target.sendTransaction(options).catch((rejection: unknown) => {
          throw nativeRequestRejection(rejection);
        });
    }
    return Reflect.get(target, key);
  }
});

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
    walletRaised(this);
  }
}

/** The name the wallet gives an EVM chain in messages. */
export function nativeChainName(chainId: number): string {
  return getChain(chainId)?.name ?? `eip155:${chainId}`;
}

/**
 * Throws `NativeSessionChainNotApprovedError` when there is no session (a session deleted before
 * or during the wait reports neither `connected` nor a topic) or when the session's approved
 * chains do not include `chainId`. A connected state without `chainIds` comes from an older
 * native build that does not report them: it passes, and the request goes to the Sign SDK as before.
 */
export function assertNativeSessionChain(state: ReownState, chainId: number, networkName: string): void {
  if (!state.connected || !state.topic) {
    throw new NativeSessionChainNotApprovedError(chainId, networkName);
  }
  if (Array.isArray(state.chainIds) && !state.chainIds.includes(chainId)) {
    throw new NativeSessionChainNotApprovedError(chainId, networkName);
  }
}

/** How long `ensureNativeSessionChain` waits for the session update after the wallet added a chain. */
const NATIVE_SESSION_CHAIN_WAIT_MS = 5000;
// The iOS plugin sends no `stateChanged` for a session update, so the wait also re-reads the state.
const NATIVE_SESSION_CHAIN_POLL_MS = 500;

function sessionApproves(state: ReownState, chainId: number): boolean {
  return Array.isArray(state.chainIds) && state.chainIds.includes(chainId);
}

async function readNativeState(fallback: ReownState): Promise<{ state: ReownState; unread: boolean }> {
  try {
    return { state: await NativeReown.getState(), unread: false };
  } catch (err) {
    console.warn('[NativeReown] could not read the state again after the chain request', err);
    return { state: fallback, unread: true };
  }
}

type SessionWatch = {
  generation: number;
  latest?: ReownState;
  listener?: PluginListenerHandle;
  onEvent?: (state: ReownState) => void;
  /** Chain whose approval the listener is tracking, once a request is in progress. */
  chainId?: number;
  /** A deletion replaced an approval of `chainId`. A non-event reread must not undo it. */
  deletionSupersededApproval?: boolean;
  /** Generation of the snapshot `requestSessionChain` receives. An event at this generation is not after that read. */
  recordedGeneration: number;
  /** That snapshot is the event `newerSession` returned for the initial read. */
  snapshotIsEvent: boolean;
};

async function startSessionWatch(): Promise<SessionWatch> {
  const watch: SessionWatch = { generation: 0, recordedGeneration: 0, snapshotIsEvent: false };
  try {
    watch.listener = await NativeReown.addListener('stateChanged', (next: ReownState) => {
      const previous = watch.latest;
      const chainId = watch.chainId;
      watch.generation += 1;
      watch.latest = next;
      if (
        chainId !== undefined &&
        previous !== undefined &&
        sessionApproves(previous, chainId) &&
        !sessionApproves(next, chainId)
      ) {
        watch.deletionSupersededApproval = true;
      } else if (chainId !== undefined && sessionApproves(next, chainId)) {
        watch.deletionSupersededApproval = false;
      }
      watch.onEvent?.(next);
    });
  } catch (err) {
    console.warn('[NativeReown] could not listen for the session update', err);
  }
  return watch;
}

async function closeSessionWatch(watch: SessionWatch): Promise<void> {
  watch.onEvent = undefined;
  await watch.listener?.remove().catch((err: unknown) => {
    console.warn('[NativeReown] could not remove the session update listener', err);
  });
}

/** A session event recorded after `started`. The read or snapshot at `started` must not replace it. */
function newerSession(watch: SessionWatch, started: number): ReownState | undefined {
  return started !== watch.generation && watch.latest !== undefined ? watch.latest : undefined;
}

/**
 * A wallet can answer the switch before its session update arrives. Resolves with the first state
 * that approves `chainId`, from a `stateChanged` event or a re-read, or with the last state read
 * once `NATIVE_SESSION_CHAIN_WAIT_MS` has passed, whichever comes first.
 */
async function waitForSessionChain(
  state: ReownState,
  chainId: number,
  watch: SessionWatch
): Promise<{ state: ReownState; unread: boolean }> {
  const seeded = newerSession(watch, watch.recordedGeneration);
  let latest = seeded ?? state;
  // Only that newer event is an observation already in hand. An earlier `watch.latest` is not.
  let sawState = seeded !== undefined;
  let sawUnread = false;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>(resolve => {
    finish = () => resolve();
  });
  const apply = (next: ReownState, fromEvent: boolean) => {
    sawState = true;
    // A slower re-read that lacks the chain does not replace a state that approved it.
    // A session event does: a deletion after an approval must not be pinned to the old snapshot.
    // A deletion that superseded an approval stays until a session event replaces it.
    if (!fromEvent && watch.deletionSupersededApproval) return;
    if (!fromEvent && sessionApproves(latest, chainId) && !sessionApproves(next, chainId)) return;
    latest = next;
    if (sessionApproves(latest, chainId)) finish();
  };
  watch.onEvent = next => apply(next, true);
  // An approval after the recorded snapshot must not sit for the whole deadline, and a deletion
  // that lands before that settlement still wins. The completion stays on a microtask.
  if (sessionApproves(latest, chainId)) {
    void Promise.resolve().then(() => {
      if (sessionApproves(latest, chainId)) finish();
    });
  }

  let polling = true;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const reread = async () => {
    const started = watch.generation;
    const next = await readNativeState(latest);
    const newer = newerSession(watch, started);
    // A re-read started before a newer session event does not replace that event.
    if (!newer) {
      // A failed re-read is not a session observation: the last state stands, and the attempt records that it was unread.
      if (next.unread) sawUnread = true;
      else apply(next.state, false);
    }
    if (polling) poll = setTimeout(() => void reread(), NATIVE_SESSION_CHAIN_POLL_MS);
  };
  const deadline = setTimeout(finish, NATIVE_SESSION_CHAIN_WAIT_MS);
  try {
    void reread();
    await finished;
    return { state: latest, unread: !sawState && sawUnread };
  } finally {
    polling = false;
    clearTimeout(poll);
    clearTimeout(deadline);
    watch.onEvent = undefined;
  }
}

/**
 * Best effort: when the session did not approve `chainId`, asks the connected wallet to add the
 * chain (`wallet_addEthereumChain`) and to switch to it (`wallet_switchEthereumChain`), then waits
 * up to `NATIVE_SESSION_CHAIN_WAIT_MS` for the session to approve it. Both requests go on a chain
 * that the session did approve. A wallet that does not support these methods, or a user who
 * declines, rejects the request: the rejection is not thrown, the state is read again without
 * waiting, and the caller's guard then refuses the request with the reconnect message. Each call
 * sends each request once at most and never retries.
 */
export async function ensureNativeSessionChain(state: ReownState, chainId: number): Promise<ReownState> {
  const watch = await startSessionWatch();
  try {
    // `state` was read before this listener existed, so `recordedGeneration` stays 0.
    return (await requestSessionChain(state, chainId, watch)).state;
  } finally {
    await closeSessionWatch(watch);
  }
}

async function requestSessionChain(
  state: ReownState,
  chainId: number,
  watch: SessionWatch
): Promise<{ state: ReownState; native?: ReownNativeFailure; recovery: NativeSessionPrecheckRecovery }> {
  const approved = state.chainIds;
  if (!Array.isArray(approved) || approved.includes(chainId)) return { state, recovery: 'not_attempted' };
  const chain = getChain(chainId);
  const requestChainId = state.chainId !== undefined && approved.includes(state.chainId) ? state.chainId : approved[0];
  // The public RPC: `rpcUrl` can be the WalletConnect proxy, which carries our project id. A chain without one
  // cannot be added, so the caller's guard refuses it.
  if (!chain || !chain.publicRpcUrl || requestChainId === undefined) return { state, recovery: 'unsupported' };

  const hexChainId = `0x${chainId.toString(16)}`;
  watch.chainId = chainId;
  // A session event during either request is already on the watch before this catch samples a
  // generation for the reread, so the reread's generation check does not see it.
  const generationBeforeRequest = watch.generation;
  try {
    await NativeReown.request({
      topic: state.topic,
      chainId: requestChainId,
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexChainId,
          chainName: chain.name,
          rpcUrls: [chain.publicRpcUrl],
          nativeCurrency: chain.nativeCurrency,
          ...(chain.explorer ? { blockExplorerUrls: [chain.explorer] } : {})
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
    const started = watch.generation;
    const buffered = generationBeforeRequest !== started ? watch.latest : undefined;
    const reread = await readNativeState(buffered ?? state);
    const newer = newerSession(watch, started);
    // A failed reread keeps a buffered event. A re-read that lacks the chain does not replace a
    // buffered approval, and no re-read replaces a buffered deletion. A session event during the
    // reread still wins. A connected event whose chains omit the target stays when the re-read
    // would pass the guard, including a re-read that omits `chainIds`. That event was buffered
    // during the request, or adopted from the initial read when nothing was buffered.
    const bufferedDeletion = buffered !== undefined && (!buffered.connected || !buffered.topic);
    const withheld = buffered ?? (watch.snapshotIsEvent ? state : undefined);
    const withheldChain =
      withheld !== undefined &&
      withheld.connected &&
      Array.isArray(withheld.chainIds) &&
      !withheld.chainIds.includes(chainId);
    const approvedChains = reread.state.chainIds;
    const rereadPassesGuard =
      reread.state.connected &&
      reread.state.topic !== undefined &&
      reread.state.topic.length > 0 &&
      (!Array.isArray(approvedChains) || approvedChains.includes(chainId));
    let observed = buffered ?? state;
    if (newer) observed = newer;
    else if (
      !reread.unread &&
      !bufferedDeletion &&
      !(buffered && sessionApproves(buffered, chainId) && !sessionApproves(reread.state, chainId)) &&
      !(withheldChain && rereadPassesGuard)
    ) {
      observed = reread.state;
    }
    return {
      state: observed,
      native: readReownNativeFailure(err),
      recovery: reread.unread ? 'rejected_unread' : 'rejected'
    };
  }
  const waited = await waitForSessionChain(state, chainId, watch);
  return { state: waited.state, recovery: waited.unread ? 'unconfirmed_unread' : 'unconfirmed' };
}

function sessionPrecheckFailure(state: ReownState): NativeSessionPrecheckFailure {
  return !state.connected || !state.topic ? 'session_missing' : 'chain_unapproved';
}

function rememberSessionPrecheck(
  error: unknown,
  failure: NativeSessionPrecheckFailure,
  recovery: NativeSessionPrecheckRecovery
): void {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return;
  markNativeSessionPrecheck(error, { failure, recovery });
}

/**
 * Makes sure that the connected session approved `chainId` before the wallet signs on it: reads
 * the state, tries to add and switch to a missing chain, then applies the guard. Call it before
 * the first wallet prompt of a signing flow. A refusal keeps its message and carries only the closed
 * precheck failure and add-and-switch attempt. A state read that throws is rethrown as itself.
 */
export async function prepareNativeSessionChain(chainId: number): Promise<void> {
  const watch = await startSessionWatch();
  try {
    let current: ReownState;
    const started = watch.generation;
    try {
      current = await NativeReown.getState();
    } catch (err) {
      rememberSessionPrecheck(err, 'state_unread', 'not_attempted');
      throw err;
    }
    const newer = newerSession(watch, started);
    if (newer) current = newer;
    // After the merge: an event from before `started` is not after this read.
    watch.recordedGeneration = watch.generation;
    watch.snapshotIsEvent = newer !== undefined;
    const { state, native, recovery } = await requestSessionChain(current, chainId, watch);
    try {
      assertNativeSessionChain(state, chainId, nativeChainName(chainId));
    } catch (refusal) {
      // Only the refused add or switch request's closed values travel; its text and the rejection stay behind.
      if (native !== undefined && refusal instanceof Error) markReownNativeFailure(refusal, native);
      rememberSessionPrecheck(refusal, sessionPrecheckFailure(state), recovery);
      throw refusal;
    }
  } finally {
    await closeSessionWatch(watch);
  }
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

// Methods the external wallet must sign - routed over the WalletConnect relay.
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
 * a string value (tx hash, signature) is JSON-encoded - i.e. wrapped in quotes
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
      // Not valid JSON - fall through and return the original string.
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
  let selectedChainId = chainId;
  let selectedRpcUrl = rpcUrl;
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    switch (method) {
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [address];
      case 'eth_chainId':
        return `0x${selectedChainId.toString(16)}`;
      case 'wallet_switchEthereumChain': {
        const target = Array.isArray(params) ? params[0] : undefined;
        if (!target || typeof target !== 'object') throw new Error('A destination chain is required');
        const hexId = txField(target, 'chainId');
        const chain = getChain(Number(hexId));
        if (!chain) throw new Error('The destination chain is not supported');
        // Native requests carry their chain ID. Select the same chain for reads and sends.
        selectedChainId = chain.id;
        selectedRpcUrl = chain.rpcUrl;
        return null;
      }
      case 'eth_sendTransaction': {
        const tx = Array.isArray(params) && typeof params[0] === 'object' && params[0] !== null ? params[0] : undefined;
        if (!tx) throw new Error('eth_sendTransaction requires a transaction object');
        // The provider is the one place where the provider path applies the session-chain guard.
        // Only the provider knows the chain it signs on, and every caller that signs through it
        // (the Epoch wallet client of the Fast deposit, the Agglayer claim through
        // `useEvmWalletProvider`) gets the same check before its wallet prompt. The deposit screen
        // also checks before it starts the Fast deposit, so that it can show the localized message
        // before the Epoch SDK starts; this check is the backstop for every provider caller.
        await prepareNativeSessionChain(selectedChainId);
        const { hash } = await NativeReown.sendTransaction({
          chainId: selectedChainId,
          from: txField(tx, 'from') ?? address,
          to: txField(tx, 'to') ?? '',
          value: txField(tx, 'value'),
          data: txField(tx, 'data'),
          gas: txField(tx, 'gas'),
          gasPrice: txField(tx, 'gasPrice'),
          // A caller that set no fee gets fields with headroom (`readNativeFeeFields`): the wallet's own
          // estimate can fall under a base fee that rose during the prompt, and the node then rejects it.
          // A caller that set any fee field keeps exactly what it set.
          ...(txField(tx, 'gasPrice') || txField(tx, 'maxFeePerGas') || txField(tx, 'maxPriorityFeePerGas')
            ? { maxFeePerGas: txField(tx, 'maxFeePerGas'), maxPriorityFeePerGas: txField(tx, 'maxPriorityFeePerGas') }
            : await readNativeFeeFields(selectedChainId))
        });
        return unwrapNativeResult(hash);
      }
      default:
        if (NATIVE_SIGN_METHODS.has(method)) {
          await prepareNativeSessionChain(selectedChainId);
          const { result } = await NativeReown.request({ chainId: selectedChainId, method, params });
          return unwrapNativeResult(result);
        }
        return rpcRead(selectedRpcUrl, method, params);
    }
  };

  return { request };
}
