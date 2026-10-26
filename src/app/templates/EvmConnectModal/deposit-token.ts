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

/**
 * New deposits use Circle USDC, configured native ETH, or an ERC-20 offered on the AggLayer chain. `USDC` identifies
 * the retired Epoch test token in existing engine states; it is never offered by the picker.
 */
export type DepositToken = 'ETH' | 'USDC' | 'CIRCLE_USDC' | DepositErc20;

/** One string per choice, for equality and test ids. */
export function depositTokenKey(token: DepositToken): string {
  return typeof token === 'string' ? token : `ERC20_${token.contractAddress}`;
}

export function sameDepositToken(a: DepositToken, b: DepositToken): boolean {
  return depositTokenKey(a) === depositTokenKey(b);
}
