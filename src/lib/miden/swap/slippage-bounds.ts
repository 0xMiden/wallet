// No imports: the service worker's settlement reads these through `fill-target`, and the quote
// client (`./quote`, which re-exports them) pulls in the SDK helpers and the remote config.

/** One basis point is 0.01 %. */
export const BPS_DENOMINATOR = 10_000n;

/** The slippage the ask opens on: 5 bps (0.05 %). On testnet an order above about 25 bps does not fill. */
export const DEFAULT_SWAP_SLIPPAGE_BPS = 5;
/** The least slippage the form accepts, 0.01 %. */
export const MIN_SWAP_SLIPPAGE_BPS = 1;
/** The most slippage the form accepts, 1 %. */
export const MAX_SWAP_SLIPPAGE_BPS = 100;

/** Is this a slippage the flow may build an ask with? A whole number of basis points inside the range. */
export const isValidSlippageBps = (bps: number): boolean =>
  Number.isInteger(bps) && bps >= MIN_SWAP_SLIPPAGE_BPS && bps <= MAX_SWAP_SLIPPAGE_BPS;
