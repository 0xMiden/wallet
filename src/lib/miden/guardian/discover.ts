/**
 * Guardian auto-detection for seed-phrase recovery (issue #418).
 *
 * A recovering user has to name the guardian operator that holds their account
 * before anything can be looked up — and most people don't remember which one
 * they picked. This module probes EVERY built-in operator with the cold keys
 * derived from the entered mnemonic and reports which of them actually knows
 * the account, so the recovery screen can preselect it.
 *
 * Why highest-nonce wins: after a guardian switch the OLD operator still holds
 * the account's pre-switch state, so more than one operator can answer. The
 * account state each operator stores carries the account nonce, and the nonce
 * only ever increases — so the operator returning the highest nonce is the one
 * holding the current state. `updatedAt` (then GUARDIAN_OPTIONS order) breaks
 * exact ties.
 *
 * When a nonce can't be read (getState fails, after one retry) it stays UNKNOWN,
 * never `0n` — because a stale operator whose state loads could otherwise outrank
 * the current operator whose state flaked. With several operators answering, an
 * unknown nonce makes the winner genuinely ambiguous, so `selectBest` refuses to
 * auto-pick and the caller falls back to the manual picker rather than silently
 * recovering against an operator that will never co-sign. A lone operator is
 * always picked — its nonce is moot when nothing competes with it.
 *
 * Frontend-only: no intercom, no vault, no shared WASM `WebClient`. The
 * guardian lookup/state endpoints are plain authenticated HTTP; the only WASM
 * touched is `AuthSecretKey.ecdsaWithRNG` (deterministic, static) and
 * `Account.deserialize` for the nonce. Deliberately does NOT import
 * `lib/miden/sdk/miden-client` — that pulls the offscreen prover and the whole
 * client interface into whatever chunk imports this.
 *
 * Limits, by design:
 * - Custom / self-hosted guardians are undiscoverable (there is nothing to
 *   enumerate) — the recovery screen keeps its manual URL entry for those.
 * - Only HD indices 0..{@link GUARDIAN_PROBE_MAX_HD_INDEX}-1 are probed, to
 *   bound the request fan-out. A wallet whose only account sits at a deeper
 *   index falls through to the manual picker — and still recovers FULLY once an
 *   endpoint is chosen, because `recoverGuardianAccountsBySeed` walks 20
 *   indices with its own gap limit. Detection depth is not recovery depth.
 * - An operator that is unreachable for the WHOLE probe window (both attempts of
 *   its lookup fail) can't be detected — there is nothing to rank. One retry
 *   absorbs a transient blip; a sustained outage of the current operator while a
 *   stale one answers can still mislead detection, but the user always retains
 *   the manual picker, so this degrades convenience, not recoverability.
 *
 * Why the chain is asked too (#1648): an account moved to a CUSTOM guardian is
 * still known to the built-in operator it left, and that operator answers with
 * the pre-switch state. With the current operator absent from the list, the
 * stale one is the lone match, and a lone match used to be picked whatever its
 * nonce - so the recovery adopted a state the chain had moved past, and the
 * hot-key rotation that follows failed against an operator the account no
 * longer has. The node holds every account's current commitment, even a private
 * one's, so each match's state commitment is compared with the chain's tip:
 * a match whose state is behind the chain is marked `holdsCurrentState: false`
 * and never auto-picked, and the recovery screen asks for the guardian's URL
 * instead. A node that cannot be read leaves the verdict unknown and the
 * ranking as it was, so an offline probe is no worse than before.
 */
import { Account, AccountId, AuthSecretKey, Endpoint, RpcClient } from '@miden-sdk/miden-sdk/lazy';
import type { LookupResponse, StateObject } from '@openzeppelin/guardian-client';
import { GuardianHttpClient } from '@openzeppelin/guardian-client';
import { EcdsaSigner } from '@openzeppelin/miden-multisig-client';
import { Buffer } from 'buffer';

import { probeGuardianOrigin } from 'lib/miden/guardian/native-http';
import { normalizeHex } from 'lib/miden/sdk/submit-evidence';
import { ensureSdkWasmReady, getGuardianOptionsForNetwork, MIDEN_NETWORK_ENDPOINTS } from 'lib/miden-chain/constants';
import type { MIDEN_NETWORK_NAME, ResolvedGuardianOption } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { setRunningTimeout } from 'lib/mobile/background-time';
import { sameGuardianEndpoint, sanitizeGuardianUrl } from 'lib/settings/helpers';

/** One operator that answered the probe with at least one account. */
export interface GuardianProbeMatch {
  endpoint: string;
  /** The built-in operator behind `endpoint`, when it is one. */
  option?: ResolvedGuardianOption;
  /** Account ids this operator holds for the probed seed. */
  accountIds: string[];
  /** HD indices that matched, ascending. */
  hdIndices: number[];
  /**
   * Highest account nonce across this operator's matched accounts, or `undefined`
   * when no state could be decoded (every getState failed / was undecodable).
   * `undefined` means "unknown", which is deliberately NOT the same as `0n` — an
   * unknown nonce must not outrank, nor be silently outranked by, a known one.
   */
  nonce: bigint | undefined;
  /** Newest `StateObject.updatedAt` across the matches — tiebreak only. */
  updatedAt?: string;
  /**
   * Whether the state this operator holds is the account's current on-chain state.
   * `false` when the chain's commitment of every account it holds differs from
   * the state it serves: the account moved on without this operator, most often
   * to a guardian the wallet cannot enumerate. `undefined` when the node could not
   * be read, or no state decoded, so nothing was compared.
   */
  holdsCurrentState?: boolean;
}

export type GuardianProbeFailureReason = 'timeout' | 'network' | 'auth' | 'unknown';

/** An operator that could not be probed. Never fails the overall probe. */
export interface GuardianProbeFailure {
  endpoint: string;
  reason: GuardianProbeFailureReason;
  message: string;
}

export interface GuardianDiscoveryResult {
  /** Highest-nonce match, i.e. the operator to preselect. Undefined => none found. */
  best?: GuardianProbeMatch;
  /** All matches, best first. */
  matches: GuardianProbeMatch[];
  probedEndpoints: string[];
  failures: GuardianProbeFailure[];
}

export interface GuardianDiscoveryOptions {
  /**
   * The network whose operators to probe. Defaults to the effective network, never the build's: a release build is a
   * testnet or devnet build, and mainnet is a stored choice.
   */
  network?: MIDEN_NETWORK_NAME;
  /** Override the endpoint set (tests / custom operator lists). */
  endpoints?: string[];
  maxHdIndex?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * HD indices probed: 0 .. this - 1. Guardian wallets are single-account today,
 * so only index 0 is probed; raise this when multi-account guardian wallets ship.
 */
export const GUARDIAN_PROBE_MAX_HD_INDEX = 1;
/** Per-request deadline. The guardian client exposes no abort, so late responses are simply ignored. */
export const GUARDIAN_PROBE_TIMEOUT_MS = 8_000;
/** Max in-flight probe requests, so a wider endpoint × index grid doesn't open every socket at once. */
export const GUARDIAN_PROBE_CONCURRENCY = 6;
/**
 * Total attempts per guardian request — lookup AND getState — before it is
 * treated as failed (1 = no retry). A single transient failure of the CURRENT
 * operator would otherwise silently hand recovery to a stale one: a failed lookup
 * drops it from the ranking entirely (→ a stale operator becomes the lone match
 * that `selectBest` auto-picks), and a failed getState leaves its nonce unknown.
 * One retry absorbs the common blip; a persistently unreachable operator is
 * genuinely undetectable (see "Limits, by design").
 */
export const GUARDIAN_PROBE_REQUEST_ATTEMPTS = 2;

/**
 * Running-time ceiling on one round trip to the OUTGOING guardian of a switch, after which the wallet
 * stops waiting and treats the operator as unreachable. Generous: this is a backstop against an
 * operator that has stopped answering, not a latency target, and expiring early costs the user a
 * coordinated switch they could have had. Every outgoing-guardian wait shares it (#1233).
 */
export const OUTGOING_GUARDIAN_DEADLINE_MS = 30_000;

export class GuardianProbeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianProbeTimeoutError';
  }
}

/**
 * Reject with {@link GuardianProbeTimeoutError} if `promise` hasn't settled in
 * `timeoutMs` of running time. Several callers read that rejection as a verdict on
 * the operator, and an overdue timer runs the moment a frozen WebView resumes, ahead
 * of the answer the native layer then delivers (#2060). The underlying request keeps
 * running (the guardian client has no abort) and its late result is dropped: harmless
 * for a read, and a caller that wraps a write makes a late landing safe itself, by
 * retrying it idempotently (the registration loops count `account_already_exists` as
 * success) or by recording it for reconciliation (the transaction's endpoint persist). Inside a
 * WASM lock hold, use it only when the abandoned tail makes no WASM call after its
 * first suspension except on objects the flow built itself from plain inputs (such
 * as a signer key from a seed), never the client or any object a client call returned.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelTimer = setRunningTimeout(
      () => reject(new GuardianProbeTimeoutError(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      value => {
        cancelTimer();
        resolve(value);
      },
      error => {
        cancelTimer();
        reject(error);
      }
    );
  });
}

/**
 * Does this error mean the operator already has a record of the account?
 *
 * Duck-typed on the guardian's stable machine-readable code, like every other
 * guardian error check (see `isGuardianUnreachableError`), so it survives the
 * duplicate-package error-class instances this repo can end up with.
 *
 * Lives here rather than beside any one registration path because all three need
 * it: the direct switch's `/configure` loop, the coordinated switch's
 * `registerOnGuardian` loop and Guardian creation's `registerGuardianAccount` each
 * retry a write that may have landed before its response was lost, and treating the operator's "I already have it" as a failure
 * would turn the idempotent case into a false `registerFailed`.
 */
export const isGuardianAccountAlreadyRegistered = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 'account_already_exists';

/**
 * Attempt `makeRequest` up to {@link GUARDIAN_PROBE_REQUEST_ATTEMPTS} times, each
 * under a `timeoutMs` deadline, returning the first success. Retries a transient
 * failure so a single blip on the CURRENT operator's request doesn't drop it from
 * the ranking (which would silently hand recovery to a stale operator). Stops
 * retrying — and rethrows the last error — once every attempt has failed or the
 * probe is aborted; the caller decides whether that is fatal (lookup → the
 * endpoint becomes a failure) or merely a lost refinement (getState → unknown nonce).
 */
async function attemptWithRetries<T>(
  makeRequest: () => Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < GUARDIAN_PROBE_REQUEST_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(makeRequest(), timeoutMs, label);
    } catch (error) {
      lastError = error;
      const lastAttempt = attempt === GUARDIAN_PROBE_REQUEST_ATTEMPTS - 1 || Boolean(signal?.aborted);
      console.warn(
        `[guardian/discover] ${label} failed (attempt ${attempt + 1}/${GUARDIAN_PROBE_REQUEST_ATTEMPTS})` +
          `${lastAttempt ? '' : ', retrying'}:`,
        error
      );
      if (lastAttempt) throw error;
    }
  }
  // Unreachable: the loop always returns a value or throws. Satisfies the type checker.
  throw lastError;
}

function readNumericStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status: unknown = error.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The fields of a probe rejection worth printing. A `GuardianHttpError` carries
 * `status`, `code` and `body`; a fetch failure carries only a message and a
 * `cause`. Read them off the object so the log names the operator's answer,
 * not just the error class.
 */
function describeProbeError(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return { error };
  const details: Record<string, unknown> = {
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
  for (const key of ['status', 'statusText', 'code', 'body', 'cause']) {
    if (key in error) details[key] = Reflect.get(error, key);
  }
  return details;
}

/** Classify a probe rejection so the UI can say something useful without leaking internals. */
export function classifyProbeError(error: unknown): { reason: GuardianProbeFailureReason; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GuardianProbeTimeoutError) return { reason: 'timeout', message };

  const status = readNumericStatus(error);
  if (status === 401 || status === 403) return { reason: 'auth', message };

  if (/network|fetch|econn|dns|offline|cors/i.test(message)) return { reason: 'network', message };
  return { reason: 'unknown', message };
}

/** What one operator's decoded states say: the ranking nonce and, per account, the commitment of the state it serves. */
export interface DecodedStates {
  /** See {@link decodeMaxNonce}. */
  nonce: bigint | undefined;
  /** Account id (hex, as the SDK prints it) → commitment of the state this operator serves for it. */
  commitments: Map<string, string>;
}

/**
 * Decode `states` once for everything the ranking reads: the highest account
 * nonce, and each account's state commitment, which the chain comparison needs.
 *
 * The nonce is `undefined` when NONE could be decoded (empty list, or every blob
 * failed to deserialize). `undefined` marks the nonce as UNKNOWN rather than zero:
 * a state we can't read must not be treated as nonce `0n`, because that silently
 * loses the nonce ranking to any operator that did decode — which is exactly how
 * a stale operator could win. A state whose commitment cannot be read is left out
 * of `commitments`, so it is compared with nothing.
 */
export function decodeStates(states: readonly StateObject[]): DecodedStates {
  let max: bigint | undefined;
  const commitments = new Map<string, string>();
  for (const state of states) {
    let account: Account | undefined;
    try {
      account = Account.deserialize(new Uint8Array(Buffer.from(state.stateJson.data, 'base64')));
      const nonce = account.nonce().asInt();
      if (max === undefined || nonce > max) max = nonce;
      commitments.set(normalizeHex(account.id().toString()), normalizeHex(account.to_commitment().toHex()));
    } catch (error) {
      console.warn('[guardian/discover] Could not decode account state for nonce, leaving it unknown:', error);
    } finally {
      try {
        account?.free();
      } catch {
        // Handle already freed / not a real WASM handle — nothing to release.
      }
    }
  }
  return { nonce: max, commitments };
}

/** Highest account nonce across `states`, or `undefined` when none decoded; see {@link decodeStates}. */
export function decodeMaxNonce(states: readonly StateObject[]): bigint | undefined {
  return decodeStates(states).nonce;
}

/**
 * The commitment of the account `0x`-hex id `accountIdHex` at the node's tip, through one standalone
 * `RpcClient` (no store, no WASM client lock); `undefined` when the read failed, timed out, or the
 * node holds no commitment for the account (not deployed yet).
 */
async function readChainCommitment(
  rpc: RpcClient,
  accountIdHex: string,
  timeoutMs: number
): Promise<string | undefined> {
  try {
    const proof = await withTimeout(
      rpc.getAccountProof(AccountId.fromHex(accountIdHex), null, null),
      timeoutMs,
      `chain commitment of ${accountIdHex}`
    );
    const commitment = normalizeHex(proof.accountCommitment().toHex());
    return /^(0x)?0+$/.test(commitment) ? undefined : commitment;
  } catch (error) {
    console.warn(`[guardian/discover] Could not read the chain commitment of ${accountIdHex}:`, error);
    return undefined;
  }
}

/**
 * The chain's tip commitment of every account in `accountIdHexes` on `network`, keyed as given. An account whose
 * read failed is absent. Never rejects: a node that cannot be reached leaves every verdict unknown.
 *
 * The node is the probed network's, not the effective one's: a recover-only reset probes mainnet before the wallet
 * switches there. On the effective network it is the effective node, so a custom RPC override is kept.
 */
async function readChainCommitments(
  accountIdHexes: readonly string[],
  network: MIDEN_NETWORK_NAME,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const commitments = new Map<string, string>();
  const rpcUrl = network === getEffectiveNetworkName() ? getEffectiveRpcUrl() : MIDEN_NETWORK_ENDPOINTS.get(network);
  if (accountIdHexes.length === 0 || !rpcUrl || signal?.aborted) return commitments;
  let rpc: RpcClient;
  try {
    await ensureSdkWasmReady();
    rpc = new RpcClient(new Endpoint(rpcUrl));
  } catch (error) {
    console.warn('[guardian/discover] Could not build the RPC client for the chain comparison:', error);
    return commitments;
  }
  const settled = await runPooled(accountIdHexes, GUARDIAN_PROBE_CONCURRENCY, async accountIdHex => {
    if (signal?.aborted) return undefined;
    return readChainCommitment(rpc, accountIdHex, timeoutMs);
  });
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value !== undefined) {
      commitments.set(accountIdHexes[index]!, result.value);
    }
  });
  return commitments;
}

/**
 * Does the operator serve the current state of at least one of its accounts? `true` as soon as one
 * state's commitment is the chain's, `false` when every compared state is behind the chain, and
 * `undefined` when nothing could be compared (the chain read failed, or no state decoded).
 */
export function holdsCurrentState(
  stateCommitments: ReadonlyMap<string, string>,
  chainCommitments: ReadonlyMap<string, string>
): boolean | undefined {
  let verdict: boolean | undefined;
  for (const [accountIdHex, commitment] of stateCommitments) {
    const onChain = chainCommitments.get(accountIdHex);
    if (onChain === undefined) continue;
    if (onChain === commitment) return true;
    verdict = false;
  }
  return verdict;
}

function newestUpdatedAt(states: readonly StateObject[]): string | undefined {
  let newest: string | undefined;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const state of states) {
    if (!state.updatedAt) continue;
    const ms = Date.parse(state.updatedAt);
    const comparable = Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
    if (newest === undefined || comparable > newestMs) {
      newest = state.updatedAt;
      newestMs = comparable;
    }
  }
  return newest;
}

/**
 * Ranking rule: an operator whose state the chain has moved past ranks last →
 * a KNOWN nonce outranks an unknown one → highest known nonce
 * (current state) → newest `updatedAt` → the order the operators appear in
 * GUARDIAN_OPTIONS (stable, so the default operator wins a total tie). Ordering
 * an unknown nonce last is only half the fix — `selectBest` additionally refuses
 * to auto-pick when an unknown nonce leaves the winner genuinely ambiguous.
 */
export function compareMatches(a: GuardianProbeMatch, b: GuardianProbeMatch, endpointOrder: readonly string[]): number {
  const aBehind = a.holdsCurrentState === false;
  const bBehind = b.holdsCurrentState === false;
  if (aBehind !== bBehind) return aBehind ? 1 : -1;

  const aKnown = a.nonce !== undefined;
  const bKnown = b.nonce !== undefined;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && bKnown && a.nonce !== b.nonce) return a.nonce! > b.nonce! ? -1 : 1;

  const aUpdated = a.updatedAt ? Date.parse(a.updatedAt) : Number.NaN;
  const bUpdated = b.updatedAt ? Date.parse(b.updatedAt) : Number.NaN;
  const aValid = !Number.isNaN(aUpdated);
  const bValid = !Number.isNaN(bUpdated);
  if (aValid && bValid && aUpdated !== bUpdated) return bUpdated - aUpdated;
  if (aValid !== bValid) return aValid ? -1 : 1;

  return endpointOrder.indexOf(a.endpoint) - endpointOrder.indexOf(b.endpoint);
}

/**
 * Pick the operator to auto-select from the already-ranked `matches`, or
 * `undefined` when the pick is not safe to make silently.
 *
 * A match whose state the chain has moved past (`holdsCurrentState === false`) is
 * never picked: the account left that operator, and recovering against it adopts
 * a superseded state (#1648). The rules below apply to the matches that remain.
 *
 * - 0 matches → nothing to pick.
 * - exactly 1 match → that operator is the sole holder; its nonce is irrelevant,
 *   so a failed getState never blocks the common (no-switch) case.
 * - 2+ matches (a guardian switch, or a misconfig) → the pick is only trustworthy
 *   when EVERY match's nonce is known. A single unknown nonce could belong to the
 *   real current operator and silently lose the ranking to a stale one — so we
 *   refuse and let the caller fall back to the manual picker / stored endpoint
 *   rather than risk recovering against an operator that will never co-sign.
 */
export function selectBest(matches: readonly GuardianProbeMatch[]): GuardianProbeMatch | undefined {
  const current = matches.filter(match => match.holdsCurrentState !== false);
  if (current.length === 0) return undefined;
  if (current.length === 1) return current[0];
  return current.some(match => match.nonce === undefined) ? undefined : current[0];
}

interface ProbeTarget {
  endpoint: string;
  option?: ResolvedGuardianOption;
}

interface ProbeHit {
  endpoint: string;
  hdIndex: number;
  accountId: string;
  /** Absent when the follow-up getState failed — the lookup match still stands. */
  state?: StateObject;
}

/** Run `worker` over `items` with at most `limit` concurrently; never rejects. */
async function runPooled<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem) => Promise<TResult>
): Promise<PromiseSettledResult<TResult>[]> {
  const results = new Array<PromiseSettledResult<TResult>>(items.length);
  let cursor = 0;

  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const [settled] = await Promise.allSettled([worker(items[index]!)]);
      results[index] = settled!;
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function resolveTargets(options: GuardianDiscoveryOptions): ProbeTarget[] {
  const known = getGuardianOptionsForNetwork(options.network ?? getEffectiveNetworkName());
  if (!options.endpoints) {
    return known.map(option => ({ endpoint: sanitizeGuardianUrl(option.endpoint), option }));
  }
  return options.endpoints.map(raw => {
    const endpoint = sanitizeGuardianUrl(raw);
    return { endpoint, option: known.find(option => sameGuardianEndpoint(option.endpoint, endpoint)) };
  });
}

/**
 * Probe every known guardian operator for accounts authorized by the cold keys
 * derived from a seed, and rank the operators that answer.
 *
 * Resolves — never throws — when no operator holds the account: `best` is
 * simply `undefined` (unlike `recoverGuardianAccountsBySeed`, which throws;
 * detection failing is an expected outcome the UI recovers from with the manual
 * picker). Individual operator failures are collected in `failures`.
 *
 * @param deriveColdSeed - Sync closure returning the HD-derived cold seed for an
 *   index; use `makeColdSeedDeriver` from `lib/miden/sdk/derive-seed` so the
 *   PBKDF2 cost is paid once.
 */
export async function discoverGuardianForSeed(
  deriveColdSeed: (hdIndex: number) => Uint8Array,
  options: GuardianDiscoveryOptions = {}
): Promise<GuardianDiscoveryResult> {
  return discoverGuardianForKeys(hdIndex => AuthSecretKey.ecdsaWithRNG(deriveColdSeed(hdIndex)), options);
}

/**
 * Probe every known guardian operator for the account authorized by a pasted
 * HOT secret key (the seed-less import flow). The guardian lookup is by key
 * commitment and indexes every registered signer, so the hot commitment finds
 * the account exactly like the cold one does. A single key has no HD walk —
 * one probe task per operator.
 */
export async function discoverGuardianForHotKey(
  hotSecretKeyHex: string,
  options: GuardianDiscoveryOptions = {}
): Promise<GuardianDiscoveryResult> {
  const { deserializeHotSecretKey } = await import('./hot-key-import');
  return discoverGuardianForKeys(() => deserializeHotSecretKey(hotSecretKeyHex), { ...options, maxHdIndex: 1 });
}

/**
 * Shared entry of both discovery flows. On mobile each endpoint's origin routes
 * through native HTTP while it is probed, and stays routed only for an operator
 * that holds the account.
 */
async function discoverGuardianForKeys(
  makeKey: (hdIndex: number) => AuthSecretKey,
  options: GuardianDiscoveryOptions = {}
): Promise<GuardianDiscoveryResult> {
  const targets = resolveTargets(options);
  const probes = targets.map(({ endpoint }) => ({ endpoint, settle: probeGuardianOrigin(endpoint) }));
  try {
    const result = await probeTargets(targets, makeKey, options);
    for (const probe of probes) {
      if (result.matches.some(match => match.endpoint === probe.endpoint)) probe.settle(true);
    }
    return result;
  } finally {
    for (const probe of probes) probe.settle(false);
  }
}

/**
 * Shared probe body: `makeKey` must return a FRESH `AuthSecretKey` handle per
 * call (one per task) — sharing a WASM handle across concurrent `sign` calls is
 * the "recursive use of an object … unsafe aliasing" hazard. The handle is
 * freed here after the task settles.
 */
async function probeTargets(
  targets: readonly ProbeTarget[],
  makeKey: (hdIndex: number) => AuthSecretKey,
  options: GuardianDiscoveryOptions
): Promise<GuardianDiscoveryResult> {
  const { maxHdIndex = GUARDIAN_PROBE_MAX_HD_INDEX, timeoutMs = GUARDIAN_PROBE_TIMEOUT_MS, signal } = options;
  const probedEndpoints = targets.map(target => target.endpoint);
  console.info('[guardian/discover] Probing guardians', {
    network: options.network ?? getEffectiveNetworkName(),
    endpoints: probedEndpoints,
    hdIndices: maxHdIndex,
    timeoutMs,
    attempts: GUARDIAN_PROBE_REQUEST_ATTEMPTS
  });

  const tasks: { target: ProbeTarget; hdIndex: number }[] = [];
  for (const target of targets) {
    for (let hdIndex = 0; hdIndex < maxHdIndex; hdIndex++) {
      tasks.push({ target, hdIndex });
    }
  }

  const settled = await runPooled(tasks, GUARDIAN_PROBE_CONCURRENCY, async ({ target, hdIndex }) => {
    if (signal?.aborted) return [];
    // One AuthSecretKey + EcdsaSigner PER TASK. Key construction is
    // deterministic, so per-task instances are byte-identical to a shared one —
    // and sharing a WASM handle across concurrent `sign` calls is exactly the
    // "recursive use of an object … unsafe aliasing" hazard.
    const secretKey = makeKey(hdIndex);
    try {
      const signer = new EcdsaSigner(secretKey);
      const client = new GuardianHttpClient(target.endpoint);
      client.setSigner(signer);
      // The commitment is the public key digest the operator indexes accounts
      // by, so it is safe to print and is what to compare against the operator.
      console.info(`[guardian/discover] Lookup at ${target.endpoint} for hd index ${hdIndex}`, {
        commitment: signer.commitment
      });

      // Retry the lookup too, not just getState: a transient lookup failure of
      // the CURRENT operator drops it from `matches` entirely, leaving a stale
      // operator as a lone match that `selectBest` would auto-pick.
      const lookup: LookupResponse = await attemptWithRetries(
        () => client.lookupAccountByKeyCommitment(signer.commitment),
        timeoutMs,
        `guardian lookup at ${target.endpoint}`,
        signal
      );

      const hits: ProbeHit[] = [];
      // An operator that doesn't hold the account answers `{ accounts: [] }` —
      // a miss, not an error.
      const found = lookup?.accounts ?? [];
      console.info(`[guardian/discover] Lookup at ${target.endpoint} answered with ${found.length} account(s)`, {
        accountIds: found.map(account => account.accountId)
      });
      for (const account of found) {
        if (signal?.aborted) break;
        // The lookup already PROVED this operator holds the account; a state
        // fetch that fails even after a retry must not throw that certainty away.
        // It only leaves the nonce UNKNOWN for the ranking — and `selectBest`
        // refuses to auto-pick when that ambiguity could hide a higher-nonce
        // operator, so a lost nonce never silently promotes a stale one.
        let state: StateObject | undefined;
        try {
          state = await attemptWithRetries(
            () => client.getState(account.accountId),
            timeoutMs,
            `guardian state at ${target.endpoint}`,
            signal
          );
        } catch {
          // Already logged per-attempt by attemptWithRetries; nonce stays unknown.
        }
        hits.push({ endpoint: target.endpoint, hdIndex, accountId: account.accountId, state });
      }
      return hits;
    } finally {
      try {
        secretKey.free();
      } catch {
        // Already freed / stubbed handle — nothing to release.
      }
    }
  });

  const failures: GuardianProbeFailure[] = [];
  const hitsByEndpoint = new Map<string, ProbeHit[]>();
  settled.forEach((result, index) => {
    const { endpoint } = tasks[index]!.target;
    if (result.status === 'rejected') {
      const { reason, message } = classifyProbeError(result.reason);
      console.error(`[guardian/discover] Operator ${endpoint} could not be probed (${reason})`, {
        ...describeProbeError(result.reason),
        hdIndex: tasks[index]!.hdIndex
      });
      // One entry per endpoint, not per HD index — the user cares about the
      // operator, not the derivation index that happened to fail first.
      if (!failures.some(failure => failure.endpoint === endpoint)) {
        failures.push({ endpoint, reason, message });
      }
      return;
    }
    if (result.value.length === 0) return;
    hitsByEndpoint.set(endpoint, [...(hitsByEndpoint.get(endpoint) ?? []), ...result.value]);
  });

  if (signal?.aborted) {
    return { matches: [], probedEndpoints, failures };
  }

  // State decoding runs sequentially, AFTER the parallel section: it touches
  // WASM (`Account.deserialize`) and must not overlap with anything else.
  const decoded: { match: GuardianProbeMatch; commitments: Map<string, string> }[] = [];
  for (const target of targets) {
    const hits = hitsByEndpoint.get(target.endpoint);
    if (!hits || hits.length === 0) continue;
    const states = hits.flatMap(hit => (hit.state ? [hit.state] : []));
    const { nonce, commitments } = decodeStates(states);
    decoded.push({
      match: {
        endpoint: target.endpoint,
        option: target.option,
        accountIds: Array.from(new Set(hits.map(hit => hit.accountId))),
        hdIndices: Array.from(new Set(hits.map(hit => hit.hdIndex))).sort((a, b) => a - b),
        nonce,
        updatedAt: newestUpdatedAt(states)
      },
      commitments
    });
  }

  // The chain decides whether a state is current (#1648): an operator the account
  // left still serves the state it had, and with the current operator absent from
  // the list that stale state would otherwise be the lone match and get picked.
  const chainCommitments = await readChainCommitments(
    Array.from(new Set(decoded.flatMap(entry => Array.from(entry.commitments.keys())))),
    options.network ?? getEffectiveNetworkName(),
    timeoutMs,
    signal
  );
  if (signal?.aborted) {
    return { matches: [], probedEndpoints, failures };
  }
  const matches: GuardianProbeMatch[] = decoded.map(({ match, commitments }) => ({
    ...match,
    holdsCurrentState: holdsCurrentState(commitments, chainCommitments)
  }));

  matches.sort((a, b) => compareMatches(a, b, probedEndpoints));
  const best = selectBest(matches);
  console.info('[guardian/discover] Probe finished', {
    best: best?.endpoint,
    matches: matches.map(match => ({
      endpoint: match.endpoint,
      accountIds: match.accountIds,
      nonce: match.nonce?.toString(),
      updatedAt: match.updatedAt,
      holdsCurrentState: match.holdsCurrentState
    })),
    failures
  });

  return { best, matches, probedEndpoints, failures };
}
