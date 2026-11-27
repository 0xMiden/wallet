import type { TrackedPosition } from 'lib/prices/position-pnl';

/** The quote an arrival was priced with, as stored when its transaction completed. */
export interface PositionQuote {
  priceMicro: bigint;
  kind: 'market' | 'fixed';
  /** Retrieval time in milliseconds; a fixed quote has none. */
  observedAt?: number;
}

/**
 * What one completed transaction did to one token of one account, recorded on this device only.
 * `heldAfter` is the vault balance read right after the transaction, or null when it could not be read.
 */
export interface PositionEvent {
  /** `${txId}:${faucetId}`. */
  key: string;
  seq?: number;
  txId: string;
  accountId: string;
  network: string;
  /** Canonical bech32 faucet id. */
  faucetId: string;
  /** Milliseconds: the row's completion time. */
  eventAt: number;
  arrived: bigint;
  departed: bigint;
  heldAfter: bigint | null;
  decimals: number | null;
  quote: PositionQuote | null;
}

export async function appendPositionEvents(_txId: string, _rows: readonly PositionEvent[]): Promise<boolean> {
  return false;
}

export async function readPositionEvents(
  _accountId: string,
  _network: string,
  _faucetId: string
): Promise<PositionEvent[]> {
  return [];
}

export async function readTrackingSince(_accountId: string, _network: string): Promise<number | undefined> {
  return undefined;
}

export function foldPositionEvents(_rows: readonly PositionEvent[]): TrackedPosition {
  return { quantity: 0n, costMicro: undefined };
}
