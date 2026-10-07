/**
 * Display metadata of a fungible token. The fields mirror the `TokenMetadata`
 * storage of the faucet account.
 */
export type AssetMetadata = {
  symbol: string;
  name: string;
  decimals: number;
  /** The faucet's description, when it set one. */
  description?: string;

  // [default: false]
  // Set only on the unknown-token placeholder: `decimals` is a guess, not a
  // fact about the faucet. Callers that convert base units to a displayed
  // quantity must check this and withhold the number rather than scale by 6 —
  // an 18-decimal token renders 10^12 too large otherwise, and nothing on
  // screen distinguishes that from a correct total.
  //
  // A durable field rather than an identity check against the placeholder
  // constant, because the placeholder is CACHED: `fetchTokenMetadata` persists
  // it for a private or non-faucet account, and what comes back from storage is
  // a deserialized copy that is never `===` the constant.
  scaleIsUnknown?: boolean;
};
