import { request } from 'lib/miden/front';
import {
  applyEndpointOverride,
  buildNetworkChoiceOverride,
  getEffectiveNetworkName
} from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isExtension } from 'lib/platform';
import { followEffectiveNetwork } from 'lib/remote-config/runtime';
import { WalletMessageType } from 'lib/shared/types';

// One switch at a time for the page, whichever screen asks: onboarding and recovery share it.
let preparing: Promise<void> | undefined;
// The stored choice takes effect in this page at once, so after a refresh that failed the page reads as
// mainnet while the service worker or client still serves the old network: the retry must refresh again.
let refreshOwed = false;

/**
 * Complete the network change before a code check or recovery can start. Already on mainnet, by the
 * build or by a stored override (a custom one included), there is nothing to change.
 */
export function prepareMainnet(): Promise<void> {
  if (preparing) return preparing;
  preparing = (async () => {
    if (getEffectiveNetworkName() !== MIDEN_NETWORK_NAME.MAINNET) {
      await applyEndpointOverride(buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.MAINNET));
      refreshOwed = true;
    }
    if (!refreshOwed) return;
    if (isExtension()) {
      await request({ type: WalletMessageType.ReloadEndpointOverridesRequest });
    } else {
      const { resetMidenClient } = await import('lib/miden/sdk/miden-client');
      await resetMidenClient();
    }
    followEffectiveNetwork();
    refreshOwed = false;
  })().finally(() => {
    preparing = undefined;
  });
  return preparing;
}
