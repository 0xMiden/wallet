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
 */
import { Account, AuthSecretKey } from '@miden-sdk/miden-sdk/lazy';
import type { LookupResponse, StateObject } from '@openzeppelin/guardian-client';
import { GuardianHttpClient } from '@openzeppelin/guardian-client';
import { EcdsaSigner } from '@openzeppelin/miden-multisig-client';
import { Buffer } from 'buffer';

import { registerGuardianOrigin } from 'lib/miden/guardian/native-http';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import type { MIDEN_NETWORK_NAME, ResolvedGuardianOption } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { sanitizeGuardianUrl } from 'lib/settings/helpers';

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

export class GuardianProbeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianProbeTimeoutError';
  }
}

/**
 * Reject with {@link GuardianProbeTimeoutError} if `promise` hasn't settled in
 * `timeoutMs`. The underlying request keeps running (no abort in the guardian
 * client) — its result is just dropped, which is harmless for these small
 * read-only JSON calls.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new GuardianProbeTimeoutError(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
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
 * Lives here rather than beside either registration path because BOTH need it:
 * the direct switch's `/configure` loop and the coordinated switch's
 * `registerOnGuardian` loop each retry a write that may have landed before its
 * response was lost, and treating the operator's "I already have it" as a failure
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

/** Classify a probe rejection so the UI can say something useful without leaking internals. */
export function classifyProbeError(error: unknown): { reason: GuardianProbeFailureReason; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GuardianProbeTimeoutError) return { reason: 'timeout', message };

  const status = readNumericStatus(error);
  if (status === 401 || status === 403) return { reason: 'auth', message };

  if (/network|fetch|econn|dns|offline|cors/i.test(message)) return { reason: 'network', message };
  return { reason: 'unknown', message };
}

/**
 * Highest account nonce across `states`, or `undefined` when NONE could be
 * decoded (empty list, or every blob failed to deserialize). `undefined` marks
 * the nonce as UNKNOWN rather than zero: a state we can't read must not be
 * treated as nonce `0n`, because that silently loses the nonce ranking to any
 * operator that did decode — which is exactly how a stale operator could win.
 */
export function decodeMaxNonce(states: readonly StateObject[]): bigint | undefined {
  let max: bigint | undefined;
  for (const state of states) {
    let account: Account | undefined;
    try {
      account = Account.deserialize(new Uint8Array(Buffer.from(state.stateJson.data, 'base64')));
      const nonce = account.nonce().asInt();
      if (max === undefined || nonce > max) max = nonce;
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
  return max;
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
 * Ranking rule: a KNOWN nonce outranks an unknown one → highest known nonce
 * (current state) → newest `updatedAt` → the order the operators appear in
 * GUARDIAN_OPTIONS (stable, so the default operator wins a total tie). Ordering
 * an unknown nonce last is only half the fix — `selectBest` additionally refuses
 * to auto-pick when an unknown nonce leaves the winner genuinely ambiguous.
 */
export function compareMatches(a: GuardianProbeMatch, b: GuardianProbeMatch, endpointOrder: readonly string[]): number {
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
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches.some(match => match.nonce === undefined) ? undefined : matches[0];
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
  // The EFFECTIVE network, not the build-baked DEFAULT_NETWORK: a dev-settings
  // endpoint override repoints the whole wallet at another network, and probing
  // the baked network's operators would silently ask the wrong guardians.
  const known = getGuardianOptionsForNetwork(options.network ?? getEffectiveNetworkName());
  if (!options.endpoints) {
    return known.map(option => ({ endpoint: sanitizeGuardianUrl(option.endpoint), option }));
  }
  return options.endpoints.map(raw => {
    const endpoint = sanitizeGuardianUrl(raw);
    return { endpoint, option: known.find(option => sanitizeGuardianUrl(option.endpoint) === endpoint) };
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
  const { maxHdIndex = GUARDIAN_PROBE_MAX_HD_INDEX, timeoutMs = GUARDIAN_PROBE_TIMEOUT_MS, signal } = options;

  const targets = resolveTargets(options);
  const probedEndpoints = targets.map(target => target.endpoint);
  console.log(
    '[guardian/discover] probing',
    probedEndpoints.length,
    'endpoint(s) on network',
    options.network ?? getEffectiveNetworkName(),
    '— hd indices 0..' + (maxHdIndex - 1) + ':',
    probedEndpoints
  );
  for (const endpoint of probedEndpoints) {
    // Built-ins are pre-seeded for the mobile CORS bypass; register defensively
    // so an overridden/custom endpoint also routes through native HTTP.
    registerGuardianOrigin(endpoint);
  }

  const tasks: { target: ProbeTarget; hdIndex: number }[] = [];
  for (const target of targets) {
    for (let hdIndex = 0; hdIndex < maxHdIndex; hdIndex++) {
      tasks.push({ target, hdIndex });
    }
  }

  const settled = await runPooled(tasks, GUARDIAN_PROBE_CONCURRENCY, async ({ target, hdIndex }) => {
    if (signal?.aborted) return [];
    // One AuthSecretKey + EcdsaSigner PER TASK. `ecdsaWithRNG(seed)` is
    // deterministic, so per-task instances are byte-identical to a shared one —
    // and sharing a WASM handle across concurrent `sign` calls is exactly the
    // "recursive use of an object … unsafe aliasing" hazard.
    const coldSecretKey = AuthSecretKey.ecdsaWithRNG(deriveColdSeed(hdIndex));
    try {
      const signer = new EcdsaSigner(coldSecretKey);
      const client = new GuardianHttpClient(target.endpoint);
      client.setSigner(signer);

      // Retry the lookup too, not just getState: a transient lookup failure of
      // the CURRENT operator drops it from `matches` entirely, leaving a stale
      // operator as a lone match that `selectBest` would auto-pick.
      console.log(
        `[guardian/discover] lookup at ${target.endpoint} (hdIndex ${hdIndex})`,
        'key commitment:',
        signer.commitment
      );
      const lookup: LookupResponse = await attemptWithRetries(
        () => client.lookupAccountByKeyCommitment(signer.commitment),
        timeoutMs,
        `guardian lookup at ${target.endpoint}`,
        signal
      );
      console.log(
        `[guardian/discover] lookup at ${target.endpoint} (hdIndex ${hdIndex}) answered with`,
        lookup?.accounts?.length ?? 0,
        'account(s):',
        (lookup?.accounts ?? []).map(a => a.accountId)
      );

      const hits: ProbeHit[] = [];
      // An operator that doesn't hold the account answers `{ accounts: [] }` —
      // a miss, not an error.
      for (const account of lookup?.accounts ?? []) {
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
        console.log(
          `[guardian/discover] state for ${account.accountId} at ${target.endpoint}:`,
          state ? `fetched (updatedAt ${state.updatedAt ?? 'unset'})` : 'FAILED — nonce stays unknown'
        );
        hits.push({ endpoint: target.endpoint, hdIndex, accountId: account.accountId, state });
      }
      return hits;
    } finally {
      try {
        coldSecretKey.free();
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
      console.warn(`[guardian/discover] endpoint ${endpoint} FAILED (${reason}):`, message);
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

  // Nonce decoding runs sequentially, AFTER the parallel section: it touches
  // WASM (`Account.deserialize`) and must not overlap with anything else.
  const matches: GuardianProbeMatch[] = [];
  for (const target of targets) {
    const hits = hitsByEndpoint.get(target.endpoint);
    if (!hits || hits.length === 0) continue;
    const states = hits.flatMap(hit => (hit.state ? [hit.state] : []));
    matches.push({
      endpoint: target.endpoint,
      option: target.option,
      accountIds: Array.from(new Set(hits.map(hit => hit.accountId))),
      hdIndices: Array.from(new Set(hits.map(hit => hit.hdIndex))).sort((a, b) => a - b),
      nonce: decodeMaxNonce(states),
      updatedAt: newestUpdatedAt(states)
    });
  }

  matches.sort((a, b) => compareMatches(a, b, probedEndpoints));

  const best = selectBest(matches);
  console.log(
    '[guardian/discover] result:',
    matches.length,
    'match(es)',
    matches.map(m => ({ endpoint: m.endpoint, accountIds: m.accountIds, nonce: m.nonce?.toString() ?? 'unknown' })),
    '| failures:',
    failures.length,
    '| best:',
    best?.endpoint ?? '(none — falling back to manual picker)'
  );

  return { best, matches, probedEndpoints, failures };
}
