import type { NearIntentsAddressKind } from 'lib/one-click/types';

/**
 * A placeholder refund address for each address kind. 1Click refuses a quote without a refund address, so the
 * preview quote uses one of these until the user types an address. A preview quote is a dry quote: it has no
 * deposit address and moves no funds. These addresses must never go into a deposit quote; `isPreviewRefundAddress`
 * is the guard for that. 1Click accepts each of them on a dry quote (it refuses well-known burn addresses).
 */
const PREVIEW_REFUND_ADDRESSES: Readonly<Record<NearIntentsAddressKind, string>> = {
  evm: '0x15da65977522e0f70204b5795c3f90eee9ae6812',
  solana: 'ES452S7HwooFCN93gENCAzQ8oSywVFpjNHFGRv4kUgtx',
  bitcoin: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  near: '0000000000000000000000000000000000000000000000000000000000000000'
};

/** The placeholder refund address that a preview quote uses for a chain of this address kind. */
export function previewRefundAddress(kind: NearIntentsAddressKind): string {
  return PREVIEW_REFUND_ADDRESSES[kind];
}

/** True when `address` is a preview placeholder. A deposit quote with such an address must not be requested. */
export function isPreviewRefundAddress(address: string): boolean {
  const lower = address.trim().toLowerCase();
  return Object.values(PREVIEW_REFUND_ADDRESSES).some(placeholder => placeholder.toLowerCase() === lower);
}
