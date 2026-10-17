import { NATIVE_ASSET_FEE_CACHE, NATIVE_ASSET_ID_CACHE } from '../../../src/lib/miden-chain/native-asset-cache-keys';

/**
 * Store and IndexedDB reads a mobile wallet's webview answers the same way on iOS and Android, run through a page
 * object's raw `evalJs`. Promises are stashed on `window` and polled, because the iOS bridge cannot await one.
 */

/** `readTransactionRowsInPage`'s database and store (src/lib/miden/repo.ts), the same on every platform. */
export const TX_DB = 'TridentMain';
export const TX_STORE = 'transactions';

// The Capacitor Preferences entries lib/miden-chain/native-asset writes, one per (RPC URL, network) scope; the
// extension harness reads the same entries from chrome.storage (balance-truth.ts walletCacheEntry).
export const NATIVE_ASSET_CACHE_EXPR =
  `(async function () { var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences; ` +
  `if (!P) throw new Error('no Capacitor Preferences plugin'); var keys = (await P.keys()).keys || []; var out = {}; ` +
  `for (var i = 0; i < keys.length; i++) { var k = keys[i]; ` +
  `if (k.indexOf(${JSON.stringify(`${NATIVE_ASSET_ID_CACHE}:`)}) === 0 || ` +
  `k.indexOf(${JSON.stringify(`${NATIVE_ASSET_FEE_CACHE}:`)}) === 0) out[k] = (await P.get({ key: k })).value; } ` +
  `return out; })()`;

// `balances` is keyed by the account's public key, so another account's rows cannot leak into the current one's.
export const CURRENT_ACCOUNT_ROWS_JS =
  `var s = window.__TEST_STORE__; if (!s) return null; var st = s.getState(); ` +
  `var pk = st.currentAccount && st.currentAccount.publicKey; if (!pk) return null; var meta = st.assetsMetadata || {}; ` +
  `return { account: pk, displayFaucetId: (st.balancesDisplayFaucetId && st.balancesDisplayFaucetId[pk]) || null, ` +
  `rows: ((st.balances && st.balances[pk]) || []).map(function (r) { var m = r.metadata || meta[r.tokenId] || {}; ` +
  `return { tokenId: String(r.tokenId), symbol: m.symbol || '', decimals: m.decimals, balance: r.balance }; }) };`;

export interface CurrentAccountRows {
  account: string;
  displayFaucetId: string | null;
  rows: Array<{ tokenId: string; symbol: string; decimals: number; balance: number }>;
}

/** The chain's native (fee) asset as the wallet discovered it and as the current account's balance row shows it. */
export interface MobileNativeAsset {
  /** The composite id (`<bech32>_<suffix>`) the store keys the balance row by. */
  tokenId: string;
  symbol: string;
  decimals: number;
  /** The chain's `verification_base_fee`, which bounds a landed path's fee. */
  baseFee: number;
}

/** The one Preferences value under `prefix`; a cache that has seen two chains would let key order pick one. */
function onePreference(entries: Record<string, string | null>, prefix: string): string {
  const keys = Object.keys(entries).filter(key => key.startsWith(`${prefix}:`));
  const [key] = keys;
  const value = key === undefined ? undefined : entries[key];
  if (keys.length !== 1 || typeof value !== 'string') {
    throw new Error(
      `the wallet's ${prefix} cache has ${keys.length} entries (${keys.join(', ') || 'none'}), expected one`
    );
  }
  return value;
}

export function nativeAssetOf(
  entries: Record<string, string | null>,
  view: CurrentAccountRows | null
): MobileNativeAsset {
  const tokenId = onePreference(entries, NATIVE_ASSET_ID_CACHE);
  const fee: unknown = JSON.parse(onePreference(entries, NATIVE_ASSET_FEE_CACHE));
  const feeFaucetId = fee !== null && typeof fee === 'object' ? Reflect.get(fee, 'faucetId') : undefined;
  const baseFee = fee !== null && typeof fee === 'object' ? Reflect.get(fee, 'baseFee') : undefined;
  if (feeFaucetId !== tokenId || typeof baseFee !== 'number' || !Number.isInteger(baseFee) || baseFee < 0) {
    throw new Error(
      `the wallet's ${NATIVE_ASSET_FEE_CACHE} entry ${JSON.stringify(fee)} has no base fee for ${tokenId}`
    );
  }
  if (view?.displayFaucetId && view.displayFaucetId !== tokenId) {
    throw new Error(`the store shows ${view.displayFaucetId} as the native token; the wallet discovered ${tokenId}`);
  }
  const row = view?.rows.find(candidate => candidate.tokenId === tokenId);
  if (!row || row.symbol === '' || !Number.isInteger(row.decimals)) {
    throw new Error(
      `no balance row with a symbol and decimals for the native token ${tokenId}: ${JSON.stringify(view)}`
    );
  }
  return { tokenId, symbol: row.symbol, decimals: row.decimals, baseFee };
}

export type EvalJs = (js: string) => Promise<unknown>;

let stashSeq = 0;
const STASH_POLL_MS = 500;

interface Stashed {
  ok: boolean;
  v?: unknown;
  e?: string;
}
const isStashed = (value: unknown): value is Stashed =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'ok') === 'boolean';

/** Starts `promiseExpr` in the webview and polls a sync eval for its stashed result, deleting the stash it read. */
export async function stashAndPoll<T>(
  evalJs: EvalJs,
  prefix: string,
  promiseExpr: string,
  timeoutMs = 30_000
): Promise<T> {
  // The sequence keeps two reads started in the same millisecond apart.
  stashSeq += 1;
  const k = JSON.stringify(`${prefix}_${Date.now()}_${stashSeq}`);
  await evalJs(
    `window[${k}] = undefined; ` +
      `Promise.resolve(${promiseExpr})` +
      `.then(function (v) { window[${k}] = { ok: true, v: v }; })` +
      `.catch(function (e) { window[${k}] = { ok: false, e: String((e && e.message) || e) }; }); ` +
      `return null;`
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Deleted once read: a row read's stash can hold half a megabyte of result bytes.
    const stashed = await evalJs(`var r = window[${k}]; if (r) { delete window[${k}]; } return r || null;`);
    if (isStashed(stashed)) {
      if (stashed.ok) return stashed.v as T;
      throw new Error(`stashAndPoll(${prefix}): ${stashed.e ?? 'rejected'}`);
    }
    if (Date.now() > deadline) throw new Error(`stashAndPoll(${prefix}): timed out after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, STASH_POLL_MS));
  }
}
