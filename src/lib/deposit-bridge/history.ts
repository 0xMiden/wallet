import { AGGLAYER_CONTRACT_ADDRESS } from 'lib/agglayer/constant';
import { BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS } from 'lib/epoch/bridgeable-token';

import { DEPOSIT_TOKENS, ETH_DECIMALS, ETH_SYMBOL, type DepositTokenId } from './tokens';

/**
 * Recent EVM activity for the deposit address, read from the keyless Blockscout
 * Sepolia REST API. Plain JSON-RPC cannot enumerate INCOMING native transfers
 * (no log is emitted), so an indexer is the only way to show "someone sent you
 * ETH". This list is a convenience: detection stays balance-based, and every
 * failure here degrades to an empty/stale list rather than surfacing an error.
 */

const BLOCKSCOUT_BASE = 'https://eth-sepolia.blockscout.com/api/v2';

const DEFAULT_LIMIT = 10;

export interface DepositEvmTx {
  hash: `0x${string}`;
  direction: 'in' | 'out';
  token: DepositTokenId;
  amount: bigint;
  decimals: number;
  symbol: string;
  counterparty: string;
  /** Unix seconds. */
  timestamp: number;
  status: 'confirmed' | 'pending' | 'failed';
  /** `to` is the AggLayer bridge contract — render as "Bridge to Miden". */
  isBridgeOut: boolean;
}

/**
 * Blockscout does not exist for the local Anvil chain the E2E harness runs, so
 * the list is disabled there unless a stand-in indexer is configured.
 */
function resolveBaseUrl(): string | undefined {
  const override = (process.env.E2E_BLOCKSCOUT_URL ?? '').trim();
  if (override) return override.replace(/\/$/, '');
  if (process.env.MIDEN_E2E_TEST === 'true') return undefined;
  return BLOCKSCOUT_BASE;
}

function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readObject(source: object, key: string): object | undefined {
  const value: unknown = Reflect.get(source, key);
  return value && typeof value === 'object' ? value : undefined;
}

function readAddress(source: object, key: string): string | undefined {
  const nested = readObject(source, key);
  if (nested) return readString(nested, 'hash');
  return readString(source, key);
}

function readBigInt(value: string | undefined): bigint | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function readTimestamp(source: object): number {
  const raw = readString(source, 'timestamp');
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}

function readHash(source: object): `0x${string}` | undefined {
  const hash = readString(source, 'hash') ?? readString(source, 'transaction_hash');
  return hash && hash.startsWith('0x') ? `0x${hash.slice(2)}` : undefined;
}

function sameAddress(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function readStatus(source: object): DepositEvmTx['status'] {
  const status = readString(source, 'status');
  if (status === 'ok') return 'confirmed';
  if (status === 'error') return 'failed';
  const result = readString(source, 'result');
  if (result && result.toLowerCase() !== 'success' && result.toLowerCase() !== 'pending') return 'failed';
  return status || result ? 'confirmed' : 'pending';
}

async function fetchItems(url: string): Promise<object[]> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Blockscout ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') return [];
  const items: unknown = Reflect.get(payload, 'items');
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is object => Boolean(item) && typeof item === 'object');
}

function parseNativeTx(item: object, address: string, bridgeContract: string | undefined): DepositEvmTx | undefined {
  const hash = readHash(item);
  const amount = readBigInt(readString(item, 'value'));
  if (!hash || amount === undefined || amount === 0n) return undefined;
  const from = readAddress(item, 'from');
  const to = readAddress(item, 'to');
  const outgoing = sameAddress(from, address);
  if (!outgoing && !sameAddress(to, address)) return undefined;
  return {
    hash,
    direction: outgoing ? 'out' : 'in',
    token: 'ETH',
    amount,
    decimals: ETH_DECIMALS,
    symbol: ETH_SYMBOL,
    counterparty: (outgoing ? to : from) ?? '',
    timestamp: readTimestamp(item),
    status: readStatus(item),
    isBridgeOut: outgoing && sameAddress(to, bridgeContract)
  };
}

function parseTokenTransfer(item: object, address: string): DepositEvmTx | undefined {
  const token = readObject(item, 'token');
  const tokenAddress = token ? readString(token, 'address') : undefined;
  // Only the known mock-USDC contract — any other token is not bridgeable here.
  if (!sameAddress(tokenAddress, BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS)) return undefined;
  const hash = readHash(item);
  const total = readObject(item, 'total');
  const amount = readBigInt(total ? readString(total, 'value') : undefined);
  if (!hash || amount === undefined || amount === 0n) return undefined;
  const from = readAddress(item, 'from');
  const to = readAddress(item, 'to');
  const outgoing = sameAddress(from, address);
  if (!outgoing && !sameAddress(to, address)) return undefined;
  return {
    hash,
    direction: outgoing ? 'out' : 'in',
    token: 'USDC',
    amount,
    decimals: DEPOSIT_TOKENS.USDC.decimals,
    symbol: DEPOSIT_TOKENS.USDC.symbol,
    counterparty: (outgoing ? to : from) ?? '',
    timestamp: readTimestamp(item),
    status: readStatus(item),
    isBridgeOut: false
  };
}

/**
 * Merged native + mock-USDC transfers touching `address`, newest first. Both
 * requests are independent: one failing still yields the other's rows.
 */
export async function fetchRecentDepositTxs(address: string, limit: number = DEFAULT_LIMIT): Promise<DepositEvmTx[]> {
  const base = resolveBaseUrl();
  if (!base || !/^0x[0-9a-fA-F]{40}$/.test(address.trim())) return [];
  const account = address.trim();
  const bridgeContract = AGGLAYER_CONTRACT_ADDRESS.get('sepolia');

  const [native, tokens] = await Promise.allSettled([
    fetchItems(`${base}/addresses/${account}/transactions`),
    fetchItems(`${base}/addresses/${account}/token-transfers`)
  ]);
  if (native.status === 'rejected' && tokens.status === 'rejected') {
    throw native.reason instanceof Error ? native.reason : new Error(String(native.reason));
  }

  const rows: DepositEvmTx[] = [];
  if (native.status === 'fulfilled') {
    for (const item of native.value) {
      const parsed = parseNativeTx(item, account, bridgeContract);
      if (parsed) rows.push(parsed);
    }
  }
  if (tokens.status === 'fulfilled') {
    for (const item of tokens.value) {
      const parsed = parseTokenTransfer(item, account);
      if (parsed) rows.push(parsed);
    }
  }

  return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}
