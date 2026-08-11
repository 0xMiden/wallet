import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { buildDefaultOverrideFor, EndpointOverride } from 'lib/miden-chain/effective-endpoints';

export const CUSTOM_PRESET = 'custom';

export const ENDPOINT_PRESETS: MIDEN_NETWORK_NAME[] = [
  MIDEN_NETWORK_NAME.TESTNET,
  MIDEN_NETWORK_NAME.DEVNET,
  MIDEN_NETWORK_NAME.LOCALNET
];

// The network-id picker (what the override actually targets) additionally offers
// Mainnet, unlike the preset/URL-prefill picker above — mainnet has no dev/test
// endpoints to prefill, but it's still a valid override target.
export const NETWORK_ID_OPTIONS: MIDEN_NETWORK_NAME[] = [
  MIDEN_NETWORK_NAME.MAINNET,
  MIDEN_NETWORK_NAME.TESTNET,
  MIDEN_NETWORK_NAME.DEVNET,
  MIDEN_NETWORK_NAME.LOCALNET
];

export function presetToOverride(preset: MIDEN_NETWORK_NAME): EndpointOverride {
  return buildDefaultOverrideFor(preset);
}
