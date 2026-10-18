import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isAndroid, isIOS } from 'lib/platform';

import { TelemetryContext, TelemetryNetwork, TelemetryPlatform } from './types';
import packageJson from '../../../package.json';

function resolvePlatform(): TelemetryPlatform {
  if (isIOS()) return 'ios';
  if (isAndroid()) return 'android';
  return 'extension';
}

// Read per event: the network can change without a reload. Mapped case by case so only a closed literal can reach
// the wire.
function resolveNetwork(): TelemetryNetwork {
  switch (getEffectiveNetworkName()) {
    case MIDEN_NETWORK_NAME.MAINNET:
      return 'mainnet';
    case MIDEN_NETWORK_NAME.TESTNET:
      return 'testnet';
    case MIDEN_NETWORK_NAME.DEVNET:
      return 'devnet';
    case MIDEN_NETWORK_NAME.LOCALNET:
      return 'localnet';
  }
}

/**
 * Derive the allowed context in the background. Deliberately not passed in from
 * the frontend: a caller that could supply `appVersion`, `platform` or `network`
 * could supply anything, which is the hole the allowlist exists to close.
 */
export function resolveTelemetryContext(): TelemetryContext {
  return {
    appVersion: packageJson.version,
    platform: resolvePlatform(),
    network: resolveNetwork()
  };
}
