import { getEffectiveFaucetApiUrl, getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { requestTimeoutError } from 'lib/remote-json';

import { MIDEN_FAUCET_API_ENDPOINTS } from './constants';
import { spawnFaucetPowWorker } from './spawn-faucet-pow-worker';

export interface PowChallenge {
  challenge: string;
  target: bigint;
}

export interface MintedNote {
  txId: string;
  noteId: string;
}

// A faucet HTTP call that accepts the socket but never answers must not hang the
// funding flow forever; bound each request.
const FAUCET_FETCH_TIMEOUT_MS = 15_000;
// Upper bound on how long we'll honor a `Retry-After` before giving up - a
// faucet that asks us to wait minutes is treated as unavailable, not obeyed.
const MAX_RETRY_AFTER_MS = 30_000;
// Wall-clock ceiling on the PoW solve. A well-formed challenge solves in well
// under this; a malformed one (e.g. `target=0`, which NO nonce can satisfy)
// would otherwise spin the CPU forever - bound it and fail cleanly instead.
const POW_SOLVE_DEADLINE_MS = 30_000;

export function getFaucetApiUrl(networkId: string = getEffectiveNetworkName()): string {
  if (networkId === getEffectiveNetworkName()) return getEffectiveFaucetApiUrl();
  return MIDEN_FAUCET_API_ENDPOINTS.get(networkId) ?? getEffectiveFaucetApiUrl();
}

/** Milliseconds to wait for a `Retry-After` header value (seconds or HTTP-date), capped, or null if absent/unparseable. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), MAX_RETRY_AFTER_MS));
  return null;
}

/** Called around each attempt: before its fetch goes out, and once its status arrives. */
export type FaucetFetchHooks = {
  onAttempt?: () => void;
  onStatus?: (status: number) => void;
};

/**
 * `fetch` bounded by a timeout, honoring a single `429 Retry-After` back-off,
 * with `read` run on the response inside the same bound.
 *
 * The timeout (via AbortController) guarantees a wedged faucet can't hang the
 * caller, its body included: each attempt's signal stays armed and linked to the
 * caller's until `read` settles, then aborts, which ends any body left unread.
 * A `429 Too Many Requests` is retried ONCE after the server-requested delay
 * (capped) rather than surfaced as a hard failure - a rate limit is transient
 * and self-clears - and its body is never read. Any other response, a final 429
 * included, goes to `read` for the caller to classify.
 */
export async function faucetFetch<T>(
  url: string,
  init: RequestInit | undefined,
  read: (response: Response) => Promise<T>,
  timeoutMs: number = FAUCET_FETCH_TIMEOUT_MS,
  hooks?: FaucetFetchHooks
): Promise<T> {
  // The timeout needs its own controller, so a caller-provided `init.signal`
  // can't ride through to `fetch` directly - link it to the internal one
  // instead (abort either way, preserving the caller's abort reason).
  const external = init?.signal ?? undefined;
  const attempt = async <R>(settle: (response: Response) => Promise<R>): Promise<R> => {
    // An attempt the caller already gave up on is never sent, so no hook reports it as out.
    if (external?.aborted) throw external.reason;
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort(external?.reason);
    external?.addEventListener('abort', abortFromExternal, { once: true });
    const timer = setTimeout(() => controller.abort(requestTimeoutError(timeoutMs)), timeoutMs);
    try {
      hooks?.onAttempt?.();
      const response = await fetch(url, { ...init, signal: controller.signal });
      hooks?.onStatus?.(response.status);
      return await settle(response);
    } finally {
      clearTimeout(timer);
      controller.abort();
      external?.removeEventListener('abort', abortFromExternal);
    }
  };

  // The first attempt ends in the caller's read, or in the wait before its one retry.
  type FirstAttempt = { value: T } | { waitMs: number };
  const first = await attempt(async (response): Promise<FirstAttempt> => {
    // A 429 with no honorable delay is not retried: the caller fails it.
    const waitMs = response.status === 429 ? retryAfterMs(response) : null;
    return waitMs === null ? { value: await read(response) } : { waitMs };
  });
  if ('value' in first) return first.value;

  const { waitMs } = first;
  // A capped Retry-After can still be 30s; the caller's abort must cut this sleep
  // short instead of waiting it out before the rejection is seen.
  await new Promise<void>((resolve, reject) => {
    if (external?.aborted) {
      reject(external.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(external?.reason);
    };
    const timer = setTimeout(() => {
      external?.removeEventListener('abort', onAbort);
      resolve();
    }, waitMs);
    external?.addEventListener('abort', onAbort, { once: true });
  });
  return attempt(read);
}

export async function getPowChallenge(
  baseUrl: string,
  accountId: string,
  amount: bigint,
  signal?: AbortSignal
): Promise<PowChallenge> {
  const params = new URLSearchParams({ account_id: accountId, amount: amount.toString() });
  return faucetFetch(`${baseUrl}/pow?${params}`, { signal }, async response => {
    if (!response.ok) {
      // The status is the error; a body that fails or stalls past the bound only loses the explanation.
      const detail = await response.text().catch(() => '');
      throw new Error(`Faucet PoW request failed with status ${response.status}: ${detail}`);
    }

    const json: { challenge: string; target: number } = await response.json();
    return { challenge: json.challenge, target: BigInt(json.target) };
  });
}

export async function solvePowChallenge(
  challengeHex: string,
  target: bigint,
  opts: { deadlineMs?: number; signal?: AbortSignal } = {}
): Promise<number> {
  const deadlineMs = opts.deadlineMs ?? POW_SOLVE_DEADLINE_MS;
  const timeoutError = () =>
    new Error(
      `Faucet PoW challenge unsolved within ${deadlineMs}ms ` +
        `(target=${target}); the challenge is likely malformed or too hard.`
    );
  if (opts.signal?.aborted) throw opts.signal.reason;
  if (deadlineMs <= 0) throw timeoutError();

  // Chromium can resolve digest promises inline. Repeated awaits then starve input
  // and rendering, so hashing must stay in a worker, including its continuation loop.
  const worker = spawnFaucetPowWorker();
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, nonce?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      worker.terminate();
      if (nonce !== undefined) resolve(nonce);
      else reject(error);
    };
    const onAbort = () => finish(opts.signal?.reason);
    const onMessage = (event: MessageEvent<{ nonce?: number; error?: string }>) => {
      const { nonce, error } = event.data;
      if (typeof nonce === 'number' && Number.isSafeInteger(nonce) && nonce >= 0) finish(undefined, nonce);
      else finish(new Error(error ?? 'Invalid faucet PoW worker response'));
    };
    const onError = (event: ErrorEvent) => finish(new Error(event.message || 'Faucet PoW worker failed'));
    const onMessageError = () => finish(new Error('Faucet PoW worker response could not be read'));
    // The document owns cancellation: a busy worker need not process another message.
    const timer = setTimeout(() => finish(timeoutError()), deadlineMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    try {
      if (opts.signal?.aborted) onAbort();
      else worker.postMessage({ challengeHex, target });
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * A token request that was sent but never answered (aborted, timed out, or the
 * connection failed), answered with a server or gateway error other than 503, or
 * accepted with a body that could not be read. The faucet may already have queued
 * the mint, so a retry is not safe: it could mint a second time. Distinct from a
 * 4xx or 503, which the faucet sends before or instead of queueing the mint: a
 * definitive refusal, safe to retry.
 */
export class FaucetOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FaucetOutcomeUnknownError';
  }
}

type TokenResponse =
  | { kind: 'failed'; status: number; detail: string }
  | { kind: 'minted'; note: MintedNote }
  | { kind: 'unreadable'; error: unknown };

export async function requestTokens(
  baseUrl: string,
  accountId: string,
  amount: bigint,
  challenge: string,
  nonce: number,
  signal?: AbortSignal,
  // Told whether a token request may be minting right now: true while one is out, false
  // once a status that refuses it arrives (before its body, and through a 429 back-off).
  onMayMint?: (mayMint: boolean) => void
): Promise<MintedNote> {
  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: amount.toString(),
    challenge,
    nonce: nonce.toString()
  });
  // The body is read inside faucetFetch's bound and its outcome comes back as data, so a rejection
  // is an unknown outcome only while a token request is out (onAttempt fired and no status
  // arrived); any other rejection is the caller's abort, rethrown.
  const readOutcome = async (response: Response): Promise<TokenResponse> => {
    if (!response.ok) {
      // The status decides what happened; an unreadable body only loses the explanation.
      return { kind: 'failed', status: response.status, detail: await response.text().catch(() => '') };
    }
    try {
      const json: { tx_id: string; note_id: string } = await response.json();
      return { kind: 'minted', note: { txId: json.tx_id, noteId: json.note_id } };
    } catch (error) {
      return { kind: 'unreadable', error };
    }
  };
  let requestOut = false;
  let outcome: TokenResponse;
  try {
    outcome = await faucetFetch(`${baseUrl}/get_tokens?${params}`, { signal }, readOutcome, undefined, {
      onAttempt: () => {
        requestOut = true;
        onMayMint?.(true);
      },
      onStatus: status => {
        requestOut = false;
        onMayMint?.(faucetStatusMayHaveMinted(status));
      }
    });
  } catch (error) {
    // A rejection is an unknown outcome only while a token request is out (onAttempt fired and no
    // status arrived); any other rejection is the caller's abort, rethrown.
    if (!requestOut) throw error;
    throw new FaucetOutcomeUnknownError('Faucet token request got no response', { cause: error });
  }

  if (outcome.kind === 'minted') return outcome.note;
  if (outcome.kind === 'unreadable') {
    // The faucet accepted the request, so it may have minted; only the ids were lost.
    throw new FaucetOutcomeUnknownError('Faucet token response could not be read', { cause: outcome.error });
  }
  const failure = new Error(`Faucet token request failed with status ${outcome.status}: ${outcome.detail}`);
  if (faucetStatusMayHaveMinted(outcome.status)) {
    throw new FaucetOutcomeUnknownError(failure.message, { cause: failure });
  }
  throw failure;
}

// 0xMiden/faucet answers 503 when it cannot queue the mint, and 500 once a queued mint's
// result is lost; a gateway 502 or 504 says nothing about the faucet behind it. Any other
// non-OK status is sent before a mint is queued.
function faucetStatusMayHaveMinted(status: number): boolean {
  return status < 300 || (status >= 500 && status !== 503);
}

export async function mintFromMidenFaucet(
  address: string,
  amount?: bigint,
  signal?: AbortSignal,
  // Awaited after the proof of work and immediately before the token request is
  // sent: the last point at which nothing can have been minted yet.
  onBeforeSubmit?: () => Promise<void>,
  onMayMint?: (mayMint: boolean) => void
): Promise<MintedNote> {
  const baseUrl = getFaucetApiUrl();
  const resolvedAmount = amount ?? (await getFaucetBaseAmount(baseUrl, signal));
  const { challenge, target } = await getPowChallenge(baseUrl, address, resolvedAmount, signal);
  const nonce = await solvePowChallenge(challenge, target, { signal });
  await onBeforeSubmit?.();
  return requestTokens(baseUrl, address, resolvedAmount, challenge, nonce, signal, onMayMint);
}

async function getFaucetBaseAmount(baseUrl: string, signal?: AbortSignal): Promise<bigint> {
  return faucetFetch(`${baseUrl}/get_metadata`, { signal }, async response => {
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Faucet metadata request failed with status ${response.status}: ${detail}`);
    }
    const metadata: unknown = await response.json();
    const baseAmount = metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'base_amount') : undefined;
    if (typeof baseAmount !== 'number' || !Number.isSafeInteger(baseAmount) || baseAmount <= 0) {
      throw new Error('Faucet metadata base_amount must be a positive safe integer');
    }
    return BigInt(baseAmount);
  });
}
