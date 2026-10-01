import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

/**
 * Whether a token the feed does not list prices at the nominal test-network rate ($1 per whole
 * unit): on every network but mainnet. Test-network tokens have no market, so a figure at a
 * nominal rate is more use than no figure at all; the native token is the main case, since
 * nothing prices it. On mainnet a made-up figure is a bug (#1128, #1105), so there is no default
 * there. Read on every call: a Developer Settings save swaps the network without a reload.
 *
 * Its own module so a test of the mainnet rule can pin it with one mock, since jest runs as
 * testnet (jest.setup.js).
 */
export function hasUnquotedDefaultPrice(): boolean {
  return getEffectiveNetworkName() !== MIDEN_NETWORK_NAME.MAINNET;
}
