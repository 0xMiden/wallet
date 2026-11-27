/**
 * Types that the deposit-address views share. The views take props and callbacks only: the caller
 * reads the relay, the quotes and the store, and gives the values here.
 */

/** The two layouts of the mock-up: the phone frame and the extension popup frame. */
export type DepositLayout = 'mobile' | 'extension';

/**
 * An amount to show. Base units go with their `decimals`. A decimal string is already in token
 * units and has no `decimals`. Never a rounded display value.
 */
export type DepositAmountValue = { amount: bigint; decimals: number } | { amount: string; decimals?: never };

/** A token as the views draw it: its symbol and the Miden faucet that keys its logo. */
export interface DepositTokenDisplay {
  symbol: string;
  /** The Miden faucet the token arrives in. It keys the logo. `undefined` draws the default mark. */
  logoFaucetId: string | undefined;
}

/** A source network as the views draw it. */
export interface DepositNetworkDisplay {
  /** The bridge network slug (`BridgeNetwork.id`). It keys the network logo. */
  id: string;
  /** The network name, as the user reads it (Ethereum, Base). */
  name: string;
}

/**
 * The bridge fee of a route:
 * - `amount`: a quoted fee in the source token.
 * - `rate`: a rate before an amount is known ("0.3%"), already translated.
 * - `none`: the route takes no bridge fee.
 */
export type DepositFee =
  | { kind: 'amount'; value: DepositAmountValue }
  | { kind: 'rate'; text: string }
  | { kind: 'none' };
