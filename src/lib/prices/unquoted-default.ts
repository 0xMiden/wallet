import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isNominalUnquotedPriceEnabled } from 'lib/settings/nominal-price';

/**
 * Whether a token the feed does not list prices at the nominal test-network rate ($1 per whole
 * unit): only when Developer Settings' switch is on (`lib/settings/nominal-price`, off by
 * default), and never on mainnet. Test-network tokens have no market, so a developer can choose a
 * figure at a nominal rate over no figure at all; the native token is the main case, since
 * nothing prices it. On mainnet a made-up figure is a bug (#1128, #1105), so the switch has no
 * effect there. Read on every call: the switch applies at once, and a Developer Settings save
 * swaps the network without a reload.
 *
 * Its own module so a test of the mainnet rule can pin it with one mock.
 */
export function hasUnquotedDefaultPrice(): boolean {
  return getEffectiveNetworkName() !== MIDEN_NETWORK_NAME.MAINNET && isNominalUnquotedPriceEnabled();
}
