import { KNOWN_SYMBOLS } from 'lib/prices/constant';
import { isRecord } from 'lib/update/guards';

/** The route of the solver's Pairs API, appended to the document's `swap.etaUrl`. */
export const SWAP_PAIRS_PATH = '/v2/pairs';

/** A fungible faucet's decimals: the protocol allows up to 12 (miden-objects `BasicFungibleFaucet::MAX_DECIMALS`). */
export const MAX_SWAP_TOKEN_DECIMALS = 12;

/** A token the solver swaps, as `GET /v2/pairs` lists it. */
export interface SwapPairsToken {
  /** '0x' + 30 lowercase hex; unique in the list. */
  faucetId: string;
  /** The token's on-chain ticker: 1 to 12 upper-case letters, the wallet's symbol limit; unique in the list. */
  ticker: string;
  /** The faucet's on-chain decimals: typed amounts are converted with it. */
  decimals: number;
  /**
   * The asset the solver prices the token with, kept only when the wallet's price feed quotes it (a `KNOWN_SYMBOLS`
   * key); absent means unpriced. Never shown: on testnet some are stand-ins.
   */
  binanceAsset?: string;
}

/** The two faucets of one pair. Unordered: every pair swaps in both directions. */
export interface SwapPairsPair {
  faucetIds: [string, string];
}

/** The solver's registry: every token it swaps, in picker order, and every pair between them. */
export interface SwapPairs {
  tokens: SwapPairsToken[];
  /** The first pair is the one the swap form opens on. */
  pairs: SwapPairsPair[];
}

const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;
// 12 is TOKEN_SYMBOL_MAX_LENGTH (lib/miden/metadata/overrides), spelled out: importing it would cycle through runtime.
const TOKEN_TICKER = /^[A-Z]{1,12}$/;

function faucetId(value: unknown): string | null {
  return typeof value === 'string' && MIDEN_ACCOUNT_ID.test(value) ? value.toLowerCase() : null;
}

const isDecimals = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SWAP_TOKEN_DECIMALS;

// A token with an unreadable field, or with no ticker (the API types it as nullable), has no name or scale to show,
// so it is left out with its pairs and the rest of the list stands.
function readToken(value: unknown): SwapPairsToken | null {
  if (!isRecord(value)) return null;
  const id = faucetId(value.faucetId);
  const { ticker, decimals, binanceAsset } = value;
  if (id === null || typeof ticker !== 'string' || !TOKEN_TICKER.test(ticker) || !isDecimals(decimals)) return null;
  if (binanceAsset !== undefined && binanceAsset !== null && typeof binanceAsset !== 'string') return null;
  // An asset the feed does not quote is dropped, not an error: the token is then unpriced, like any unknown token.
  const priced = typeof binanceAsset === 'string' && typeof KNOWN_SYMBOLS[binanceAsset] === 'string';
  return { faucetId: id, ticker, decimals, ...(priced ? { binanceAsset } : {}) };
}

function readPair(value: unknown): SwapPairsPair | null {
  if (!isRecord(value) || !Array.isArray(value.faucetIds) || value.faucetIds.length !== 2) return null;
  const first = faucetId(value.faucetIds[0]);
  const second = faucetId(value.faucetIds[1]);
  return first === null || second === null || first === second ? null : { faucetIds: [first, second] };
}

function repeated(values: (string | null)[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    if (value !== null) (seen.has(value) ? twice : seen).add(value);
  }
  return twice;
}

/**
 * The solver's `GET /v2/pairs` response, or null when its token or pair list is not a list. A token or pair with an
 * unreadable field is left out, with every pair naming that token, so one bad listing costs only itself. Ids come
 * back in lowercase. The result parses to itself, which is how the stored copy is checked.
 */
export function parseSwapPairs(body: unknown): SwapPairs | null {
  if (!isRecord(body) || !Array.isArray(body.tokens) || !Array.isArray(body.pairs)) return null;
  const entries = body.tokens.map(entry => (isRecord(entry) ? entry : {}));
  // Two entries for one faucet, or one ticker, would make the picker ambiguous. Every entry carrying it is left out,
  // malformed or not, so the list never depends on the solver's order or on which entry another check drops.
  const sharedIds = repeated(entries.map(entry => faucetId(entry.faucetId)));
  const sharedTickers = repeated(entries.map(entry => (typeof entry.ticker === 'string' ? entry.ticker : null)));
  const tokens = entries.flatMap(entry => {
    const token = readToken(entry);
    return token && !sharedIds.has(token.faucetId) && !sharedTickers.has(token.ticker) ? [token] : [];
  });
  // A pair of a token that was left out has nothing to show on one side.
  const listed = new Set(tokens.map(token => token.faucetId));
  const pairs = body.pairs.flatMap(entry => {
    const pair = readPair(entry);
    return pair && pair.faucetIds.every(id => listed.has(id)) ? [pair] : [];
  });
  return { tokens, pairs };
}
