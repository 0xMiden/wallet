/**
 * An ERC-20 the picker offers on the AggLayer chain: one the document lists and the bridge registers, or on a test
 * network one the connected wallet holds. `delivery` names the registry faucet that mints its deliveries, when the
 * registry holds one yet.
 */
export interface OfferedErc20 {
  symbol: string;
  /** Lowercase. */
  contractAddress: `0x${string}`;
  decimals: number;
  delivery?: { midenFaucetId: string; scale: number };
}

/** An ERC-20 the bridge registry holds on the AggLayer chain, picked by its contract address. */
export interface DepositErc20 {
  kind: 'erc20';
  /** Lowercase, as the registry and the document spell it. */
  contractAddress: `0x${string}`;
}

/** A token of the picked chain's Epoch route, picked by the key the bridge config lists it under. */
export interface DepositEpochToken {
  kind: 'epoch';
  /** The document's key on the route (`USDC`, `ETH`, `POL`, `USDG`). */
  key: string;
}

/**
 * New deposits use Circle USDC, configured native ETH, an ERC-20 offered on the AggLayer chain, or a token of the
 * picked chain's Epoch route. `USDC` identifies the Epoch USDC in existing engine states; the picker offers it as the
 * Epoch token keyed `USDC`.
 */
export type DepositToken = 'ETH' | 'USDC' | 'CIRCLE_USDC' | DepositErc20 | DepositEpochToken;

/** One string per choice, for equality and test ids. */
export function depositTokenKey(token: DepositToken): string {
  // An engine state's `USDC` is the Epoch token keyed `USDC`, so it matches that pick.
  if (token === 'USDC') return 'EPOCH_USDC';
  if (typeof token === 'string') return token;
  switch (token.kind) {
    case 'erc20':
      return `ERC20_${token.contractAddress}`;
    case 'epoch':
      return `EPOCH_${token.key}`;
  }
}

/** The Epoch route key of `token`, or null for a token that does not bridge through Epoch. */
export function epochTokenKey(token: DepositToken): string | null {
  if (token === 'USDC') return 'USDC';
  return typeof token !== 'string' && token.kind === 'epoch' ? token.key : null;
}

export function sameDepositToken(a: DepositToken, b: DepositToken): boolean {
  return depositTokenKey(a) === depositTokenKey(b);
}
