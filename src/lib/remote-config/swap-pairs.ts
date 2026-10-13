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
  /** The token's on-chain ticker: 1 to 6 upper-case letters, as the protocol's `TokenSymbol` allows; unique in the list. */
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
const TOKEN_TICKER = /^[A-Z]{1,6}$/;

// Each check throws on a violation and parseSwapPairs catches once: one bad known field rejects the response.
const invalid = (): never => {
  throw new Error('invalid swap pairs');
};

function faucetId(value: unknown): string {
  if (typeof value !== 'string' || !MIDEN_ACCOUNT_ID.test(value)) return invalid();
  return value.toLowerCase();
}

function ticker(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN_TICKER.test(value)) return invalid();
  return value;
}

function decimals(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SWAP_TOKEN_DECIMALS) {
    return invalid();
  }
  return value;
}

// An asset the feed does not quote is dropped, not an error: the token is then unpriced, like any unknown token.
function pricedAsset(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return invalid();
  return typeof KNOWN_SYMBOLS[value] === 'string' ? value : undefined;
}

// The API types `ticker` as nullable. A token with no ticker has no name to show, so it is left out.
function readToken(value: unknown): SwapPairsToken[] {
  if (!isRecord(value)) return invalid();
  const id = faucetId(value.faucetId);
  const scale = decimals(value.decimals);
  if (value.ticker === null || value.ticker === undefined) return [];
  const asset = pricedAsset(value.binanceAsset);
  return [
    {
      faucetId: id,
      ticker: ticker(value.ticker),
      decimals: scale,
      ...(asset === undefined ? {} : { binanceAsset: asset })
    }
  ];
}

function readPair(value: unknown): SwapPairsPair {
  if (!isRecord(value) || !Array.isArray(value.faucetIds) || value.faucetIds.length !== 2) return invalid();
  const first = faucetId(value.faucetIds[0]);
  const second = faucetId(value.faucetIds[1]);
  if (first === second) return invalid();
  return { faucetIds: [first, second] };
}

function readSwapPairs(body: unknown): SwapPairs {
  if (!isRecord(body) || !Array.isArray(body.tokens) || !Array.isArray(body.pairs)) return invalid();
  const tokens = body.tokens.flatMap(readToken);
  // Two entries for one faucet, or one ticker, would make the picker ambiguous.
  const faucetIds = new Set(tokens.map(token => token.faucetId));
  const tickers = new Set(tokens.map(token => token.ticker));
  if (faucetIds.size !== tokens.length || tickers.size !== tokens.length) return invalid();
  // A pair of a token that was left out has nothing to show on one side.
  const pairs = body.pairs.map(readPair).filter(pair => pair.faucetIds.every(id => faucetIds.has(id)));
  return { tokens, pairs };
}

/**
 * The solver's `GET /v2/pairs` response, or null when it is malformed. Strict on the fields the wallet reads, blind to
 * the others. Ids come back in lowercase. The result parses to itself, so the stored copy is read with this too.
 */
export function parseSwapPairs(body: unknown): SwapPairs | null {
  try {
    return readSwapPairs(body);
  } catch {
    return null;
  }
}
