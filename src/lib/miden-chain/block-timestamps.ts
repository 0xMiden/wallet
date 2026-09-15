import { Endpoint, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

import { ensureSdkWasmReady } from './constants';
import { withRpcTimeout } from './rpc-timeout';

const MAX_LOOKUPS_PER_CALL = 64;
const LOOKUP_CONCURRENCY = 8;
const LOOKUP_TIMEOUT_MS = 3_000;
const FAILED_LOOKUP_COOLDOWN_MS = 60_000;
const MAX_CACHED_BLOCKS = 4_096;

let cacheScope = '';
// One client per visit to an endpoint; only its own results and failures reach the cache.
let scopeClient: RpcClient | undefined;
// Header requests not yet settled, per endpoint URL: a timeout abandons a request without ending it, so a request the
// node accepted and never answered stays outstanding, even after the wallet has left that endpoint and come back.
const outstanding = new Map<string, number>();
const timestamps = new Map<number, number>();
const retryAfter = new Map<number, number>();

function coolDown(blocks: readonly number[], scope: string) {
  if (cacheScope !== scope || getEffectiveRpcUrl() !== scope) return;
  const until = Date.now() + FAILED_LOOKUP_COOLDOWN_MS;
  for (const block of blocks) retryAfter.set(block, until);
}

// Every endpoint change drops the client, so a result or failure lands only while the client it was sent on is still
// current: a request from an earlier visit to the same URL fills nothing of a later one. A switch reaches this module
// only when the next lookup starts, so the effective URL is asked again too. A request stays counted against its URL
// until it settles, whichever visit sent it.
async function lookUpBlock(rpc: RpcClient, url: string, block: number) {
  try {
    const request = rpc.getBlockHeaderByNumber(block);
    outstanding.set(url, (outstanding.get(url) ?? 0) + 1);
    const settle = () => {
      const left = (outstanding.get(url) ?? 1) - 1;
      if (left > 0) outstanding.set(url, left);
      else outstanding.delete(url);
    };
    request.then(settle, settle);
    const header = await withRpcTimeout(() => request, 'note-block-timestamp', {
      timeoutMs: LOOKUP_TIMEOUT_MS,
      retries: 0
    });
    if (scopeClient === rpc && getEffectiveRpcUrl() === url) timestamps.set(block, header.timestamp());
  } catch (error) {
    if (scopeClient === rpc && getEffectiveRpcUrl() === url)
      retryAfter.set(block, Date.now() + FAILED_LOOKUP_COOLDOWN_MS);
    console.warn('[block-timestamps] Could not read block', block, error);
  }
}

/**
 * Unix-second timestamps of the given blocks, for display.
 *
 * Callers resolve dates after their note read has released the WASM client: headers come from a
 * standalone `RpcClient`, so no lock is needed, and awaiting the network inside a hold would stall
 * every other client call behind it. Never throws. A block that cannot be read is left out and not
 * asked for again for a minute, so a failing node costs one bounded attempt per block rather than one
 * per poll. One call resolves up to 64 uncached blocks, eight at a time, so a refresh does not publish
 * part of a list undated. At most eight requests stay outstanding per endpoint URL, counting ones a timeout
 * abandoned and ones sent before the wallet last left that endpoint, so a node that accepts requests and never
 * answers holds eight rather than a new batch a minute or a new batch per visit.
 *
 * The cache belongs to one RPC endpoint, because another network's block numbers name other blocks.
 * `readScope` is the endpoint the blocks were read from, taken before that read: once the wallet has
 * moved to another endpoint nothing is looked up, and a lookup queries the endpoint it started on and
 * returns nothing if the wallet moved before it finished.
 */
export async function getBlockTimestamps(
  blockNums: readonly number[],
  readScope: string
): Promise<Map<number, number>> {
  const scope = getEffectiveRpcUrl();
  if (readScope !== scope) return new Map();
  if (scope !== cacheScope) {
    cacheScope = scope;
    scopeClient = undefined;
    timestamps.clear();
    retryAfter.clear();
  }
  const now = Date.now();
  const missing = [...new Set(blockNums)]
    .filter(block => !timestamps.has(block) && (retryAfter.get(block) ?? 0) <= now)
    .slice(0, MAX_LOOKUPS_PER_CALL);
  if (missing.length > 0 && (outstanding.get(scope) ?? 0) < LOOKUP_CONCURRENCY) {
    try {
      await ensureSdkWasmReady();
      if (cacheScope === scope) {
        scopeClient ??= new RpcClient(new Endpoint(scope));
        const rpc = scopeClient;
        let next = 0;
        while (next < missing.length && scopeClient === rpc) {
          const room = LOOKUP_CONCURRENCY - (outstanding.get(scope) ?? 0);
          if (room <= 0) break;
          const batch = missing.slice(next, next + room);
          next += batch.length;
          await Promise.all(batch.map(block => lookUpBlock(rpc, scope, block)));
        }
      }
    } catch (error) {
      coolDown(missing, scope);
      console.warn('[block-timestamps] Could not create the RPC client', error);
    }
  }
  const result = new Map<number, number>();
  if (cacheScope !== scope || getEffectiveRpcUrl() !== scope) return result;
  for (const block of blockNums) {
    const time = timestamps.get(block);
    if (time !== undefined) result.set(block, time);
  }
  if (timestamps.size + retryAfter.size > MAX_CACHED_BLOCKS) {
    timestamps.clear();
    retryAfter.clear();
  }
  return result;
}
