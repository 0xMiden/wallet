import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { buildDefaultOverrideFor, EndpointOverride } from 'lib/miden-chain/effective-endpoints';

export const CUSTOM_PRESET = 'custom';

// The Mainnet preset prefills what the build configures for mainnet: the RPC, prover, note
// transport and explorer URLs and the network id. Mainnet has no faucet, and the guardian has no
// mainnet value yet, so those fields come up empty.
export const ENDPOINT_PRESETS: MIDEN_NETWORK_NAME[] = [
  MIDEN_NETWORK_NAME.MAINNET,
  MIDEN_NETWORK_NAME.TESTNET,
  MIDEN_NETWORK_NAME.DEVNET,
  MIDEN_NETWORK_NAME.LOCALNET
];

// The network-id picker: what the override actually targets.
export const NETWORK_ID_OPTIONS: MIDEN_NETWORK_NAME[] = [
  MIDEN_NETWORK_NAME.MAINNET,
  MIDEN_NETWORK_NAME.TESTNET,
  MIDEN_NETWORK_NAME.DEVNET,
  MIDEN_NETWORK_NAME.LOCALNET
];

export function presetToOverride(preset: MIDEN_NETWORK_NAME): EndpointOverride {
  return buildDefaultOverrideFor(preset);
}
