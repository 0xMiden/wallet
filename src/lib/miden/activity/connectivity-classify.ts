/**
 * Classification helpers for connectivity errors.
 *
 * These are intentionally string-matching heuristics, not type checks: the
 * wallet's WASM client / fetch layer / Tonic transport / browser fetch each
 * surface failures with different shapes (Error / DOMException / object
 * without prototype). Strings are the only stable join key.
 */

/**
 * Does this error look transport-shaped (vs semantic / validation)?
 *
 * True examples: Failed to fetch, NetworkError, Load failed, abort/timeout,
 * tonic-web-wasm-client `transport error: ...`, RPC `status code 5xx`.
 *
 * False examples: "invalid transaction request", "note has already been
 * consumed" — the WASM client throws these BEFORE any RPC, so they are
 * never connectivity issues.
 */
export function isLikelyNetworkError(err: unknown): boolean {
  const message = (err as { message?: string } | null | undefined)?.message ?? String(err ?? '');
  const lower = message.toLowerCase();
  if (lower.includes('invalid transaction request')) return false;
  if (lower.includes('has already been consumed')) return false;
  if (lower.includes('failed to fetch')) return true;
  if (lower.includes('networkerror')) return true;
  if (lower.includes('network error')) return true;
  if (lower.includes('load failed')) return true; // Safari fetch failure
  if (lower.includes('aborted') || lower.includes('abort')) return true;
  if (lower.includes('timeout') || lower.includes('timed out')) return true;
  if (lower.includes('connection')) return true;
  if (/\b5\d{2}\b/.test(message)) return true; // 500, 502, 503, 504 etc
  if (lower.includes('status code')) return true;
  if (lower.includes('transport error')) return true; // tonic-web-wasm-client
  if (lower.includes('rpc error')) return true;
  return false;
}

/**
 * `navigator.onLine` is famously unreliable (returns true if a network
 * interface is up, regardless of whether anything is reachable on the other
 * end). It's still useful as a one-way signal: if it returns FALSE, the
 * browser/OS is sure we have no connectivity, and we should categorize as
 * `network` rather than `node`. If it returns true, we can't conclude
 * anything — fall through to the heuristic.
 */
export function isDefinitelyOffline(): boolean {
  // SW context has navigator but not always navigator.onLine. Be defensive.
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.onLine !== 'boolean') return false;
  return navigator.onLine === false;
}

/**
 * Classify a sync error into either `network` or `node`. Sync going through
 * the WASM client always means we tried to hit the Miden node's RPC, so the
 * choice is narrowly between "we couldn't even reach the internet" (network)
 * vs "we reached something but the node didn't answer right" (node).
 */
export type SyncErrorCategory = 'network' | 'node';

export function classifySyncError(_err: unknown): SyncErrorCategory {
  if (isDefinitelyOffline()) return 'network';
  // We have no way from inside the WASM client to distinguish "DNS failed"
  // from "node returned 502" — both surface as transport / RPC errors.
  // Default to `node` because that's the higher-information category for
  // the user (it tells them the wallet, not their connection, is the issue).
  // If they get a hard `network` failure, navigator.onLine usually catches it.
  return 'node';
}
