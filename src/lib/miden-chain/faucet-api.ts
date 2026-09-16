import { getEffectiveFaucetApiUrl, getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { MIDEN_FAUCET_API_ENDPOINTS } from './constants';

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
// Upper bound on how long we'll honor a `Retry-After` before giving up — a
// faucet that asks us to wait minutes is treated as unavailable, not obeyed.
const MAX_RETRY_AFTER_MS = 30_000;
// Wall-clock ceiling on the PoW solve. A well-formed challenge solves in well
// under this; a malformed one (e.g. `target=0`, which NO nonce can satisfy)
// would otherwise spin the CPU forever — bound it and fail cleanly instead.
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

/**
 * `fetch` bounded by a timeout, honoring a single `429 Retry-After` back-off.
 *
 * The timeout (via AbortController) guarantees a wedged faucet can't hang the
 * caller. A `429 Too Many Requests` is retried ONCE after the server-requested
 * delay (capped) rather than surfaced as a hard failure — a rate limit is
 * transient and self-clears. Any other non-ok status is returned as-is for the
 * caller to classify.
 */
export async function faucetFetch(
  url: string,
  init?: RequestInit,
  timeoutMs: number = FAUCET_FETCH_TIMEOUT_MS
): Promise<Response> {
  // The timeout needs its own controller, so a caller-provided `init.signal`
  // can't ride through to `fetch` directly — link it to the internal one
  // instead (abort either way, preserving the caller's abort reason).
  const external = init?.signal ?? undefined;
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort(external?.reason);
    if (external?.aborted) abortFromExternal();
    external?.addEventListener('abort', abortFromExternal, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', abortFromExternal);
    }
  };

  const first = await attempt();
  if (first.status !== 429) return first;

  const waitMs = retryAfterMs(first);
  if (waitMs === null) return first; // 429 with no honorable delay — let the caller fail it
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return attempt();
}

export async function getPowChallenge(
  baseUrl: string,
  accountId: string,
  amount: bigint,
  signal?: AbortSignal
): Promise<PowChallenge> {
  const params = new URLSearchParams({ account_id: accountId, amount: amount.toString() });
  const response = await faucetFetch(`${baseUrl}/pow?${params}`, { signal });

  if (!response.ok) {
    throw new Error(`Faucet PoW request failed with status ${response.status}: ${await response.text()}`);
  }

  const json: { challenge: string; target: number } = await response.json();
  return { challenge: json.challenge, target: BigInt(json.target) };
}

// A nonce solves the challenge when the first 8 bytes of
// SHA-256(challengeBytes ‖ nonce_as_be_u64), read as a big-endian u64, are < target.
export async function solvePowChallenge(
  challengeHex: string,
  target: bigint,
  opts: { deadlineMs?: number; signal?: AbortSignal } = {}
): Promise<number> {
  const challengeBytes = hexToBytes(challengeHex);
  const buffer = new Uint8Array(challengeBytes.length + 8);
  buffer.set(challengeBytes);
  const view = new DataView(buffer.buffer);

  // A `target` of 0 (or an absurdly small one) is unsatisfiable: no digest is
  // `< 0`, so the loop would never terminate. Bound the solve by wall clock and
  // fail cleanly — a malformed/hostile challenge can't wedge the funding flow.
  const deadline = Date.now() + (opts.deadlineMs ?? POW_SOLVE_DEADLINE_MS);

  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    view.setBigUint64(challengeBytes.length, BigInt(nonce), false);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    if (new DataView(digest.buffer).getBigUint64(0, false) < target) {
      return nonce;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Faucet PoW challenge unsolved within ${opts.deadlineMs ?? POW_SOLVE_DEADLINE_MS}ms ` +
          `(target=${target}); the challenge is likely malformed or too hard.`
      );
    }
  }
}

export async function requestTokens(
  baseUrl: string,
  accountId: string,
  amount: bigint,
  challenge: string,
  nonce: number,
  signal?: AbortSignal
): Promise<MintedNote> {
  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: amount.toString(),
    challenge,
    nonce: nonce.toString()
  });
  const response = await faucetFetch(`${baseUrl}/get_tokens?${params}`, { signal });

  if (!response.ok) {
    throw new Error(`Faucet token request failed with status ${response.status}: ${await response.text()}`);
  }

  const json: { tx_id: string; note_id: string } = await response.json();
  return { txId: json.tx_id, noteId: json.note_id };
}

export async function mintFromMidenFaucet(address: string, amount: bigint, signal?: AbortSignal): Promise<MintedNote> {
  const baseUrl = getFaucetApiUrl();
  const { challenge, target } = await getPowChallenge(baseUrl, address, amount, signal);
  const nonce = await solvePowChallenge(challenge, target, { signal });
  return requestTokens(baseUrl, address, amount, challenge, nonce, signal);
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
