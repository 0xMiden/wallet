import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { buildDefaultOverrideFor, EndpointOverride } from 'lib/miden-chain/effective-endpoints';

export const CUSTOM_PRESET = 'custom';

export const ENDPOINT_PRESETS: MIDEN_NETWORK_NAME[] = [
  MIDEN_NETWORK_NAME.TESTNET,
  MIDEN_NETWORK_NAME.DEVNET,
  MIDEN_NETWORK_NAME.LOCALNET
];

export function presetToOverride(preset: MIDEN_NETWORK_NAME): EndpointOverride {
  return buildDefaultOverrideFor(preset);
}
