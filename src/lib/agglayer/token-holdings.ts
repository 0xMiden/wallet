import { fetchBoundedJson, type JsonFetch } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

/** An ERC-20 the connected wallet holds on an AggLayer chain, as its Blockscout lists it. */
export interface Erc20Holding {
  /** Lowercase. */
  contractAddress: `0x${string}`;
  symbol: string;
  decimals: number;
  /** The balance in base units at `decimals`, as listed. */
  value: bigint;
}

const HOLDINGS_TIMEOUT_MS = 10_000;
const HOLDINGS_MAX_BYTES = 512 * 1_024;
/** The picker offers at most this many holdings, the largest first. */
export const HOLDINGS_MAX = 32;
/** A holding under 1e-5 of a token is dust and is not offered. */
const DUST_EXPONENT = 5n;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_DECIMALS = 36n;
const MAX_SYMBOL_LENGTH = 32;
// C0 controls, DEL and C1 controls: none belongs in a symbol the picker shows.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** True when `value` base units at `decimals` are at least 1e-5 of a token. */
export function isAboveDust(value: bigint, decimals: number): boolean {
  if (value <= 0n) return false;
  const units = BigInt(decimals);
  return units <= DUST_EXPONENT || value >= 10n ** (units - DUST_EXPONENT);
}

/** A whole number written in decimal, or null. */
function integer(value: unknown): bigint | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,78}$/.test(text)) return null;
  return BigInt(text);
}

function symbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SYMBOL_LENGTH || CONTROL_CHARACTER.test(trimmed)) return null;
  return trimmed;
}

// Blockscout v2 `/addresses/{hash}/token-balances`: `[{ token: { address_hash | address, symbol, decimals, type },
// value }]`. An entry that is not a fungible token, or that lacks a symbol or decimals, is left out.
function holding(entry: unknown): Erc20Holding | null {
  if (!isRecord(entry) || !isRecord(entry.token)) return null;
  const { token } = entry;
  if (token.type !== 'ERC-20') return null;
  const address = typeof token.address_hash === 'string' ? token.address_hash : token.address;
  if (typeof address !== 'string' || !EVM_ADDRESS.test(address)) return null;
  const decimals = integer(token.decimals);
  const value = integer(entry.value);
  const name = symbol(token.symbol);
  if (decimals === null || decimals > MAX_DECIMALS || value === null || name === null) return null;
  return { contractAddress: `0x${address.slice(2).toLowerCase()}`, symbol: name, decimals: Number(decimals), value };
}

/**
 * The ERC-20s `address` holds on the chain `apiUrl` indexes, above dust, largest first by base-unit balance, one per
 * contract. Rejects when the API does not answer or answers no list; the caller says so rather than offering fewer
 * tokens.
 */
export async function readErc20Holdings(
  apiUrl: string,
  address: string,
  fetchFn: JsonFetch = (url, init) => fetch(url, init)
): Promise<Erc20Holding[]> {
  if (!EVM_ADDRESS.test(address)) throw new Error(`Invalid EVM address: ${address}`);
  const body = await fetchBoundedJson(fetchFn, `${apiUrl}/addresses/${address}/token-balances`, {
    maxBytes: HOLDINGS_MAX_BYTES,
    timeoutMs: HOLDINGS_TIMEOUT_MS
  });
  if (!Array.isArray(body)) throw new Error('The token balances answer is not a list');
  const seen = new Set<string>();
  const holdings: Erc20Holding[] = [];
  for (const entry of body) {
    const parsed = holding(entry);
    if (!parsed || seen.has(parsed.contractAddress) || !isAboveDust(parsed.value, parsed.decimals)) continue;
    seen.add(parsed.contractAddress);
    holdings.push(parsed);
  }
  holdings.sort(byTokenAmountDescending);
  return holdings.slice(0, HOLDINGS_MAX);
}

// Compares whole-token amounts across decimals: a / 10^da against b / 10^db, as a * 10^db against b * 10^da.
function byTokenAmountDescending(a: Erc20Holding, b: Erc20Holding): number {
  const left = a.value * 10n ** BigInt(b.decimals);
  const right = b.value * 10n ** BigInt(a.decimals);
  if (left === right) return 0;
  return left > right ? -1 : 1;
}
