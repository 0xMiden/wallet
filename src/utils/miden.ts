import { Address } from '@miden-sdk/miden-sdk/lazy';
import { isAddress } from 'viem';

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

export const isHexAddress = (address: string) => {
  return address.startsWith('0x');
};

const MIDEN_MAINNET_PREFIX = 'mm1';
const MIDEN_TESTNET_PREFIX = 'mtst1';
const MIDEN_DEVNET_PREFIX = 'mdev1';
// The SDK's NetworkId::Localnet uses the 'mlcl' HRP, so a real localnet node —
// and this wallet on a localnet/localhost network (see getNetworkId's LOCALNET
// branch) — produces 'mlcl1…' addresses. It must be a recognized prefix or a
// genuine localnet address is wrongly rejected as "invalid" at the gate below,
// before the bech32 decode even runs (#599), and the send flow's Confirm button
// never enables.
const MIDEN_LOCALNET_PREFIX = 'mlcl1';
const MIDEN_BECH32_PREFIXES = [MIDEN_MAINNET_PREFIX, MIDEN_TESTNET_PREFIX, MIDEN_DEVNET_PREFIX, MIDEN_LOCALNET_PREFIX];

// NOTE: this maps a network to its OWN-account "correct-network" prefix, read
// through the EFFECTIVE network so it always agrees with what getNetworkId()
// encodes with — including under a dev-settings override pointing at a localhost
// network. Localnet encodes with the 'mlcl' HRP (getNetworkId -> NetworkId.custom
// with the 'mlcl' prefix), so an 'mlcl1…' address is the correct-network form
// there and reads as wrong-network only while the wallet targets another Miden
// network — which the QR wrapper still accepts, surfacing a network message
// instead of the old hard rejection.
const NETWORK_ADDRESS_PREFIXES: Record<MIDEN_NETWORK_NAME, string> = {
  [MIDEN_NETWORK_NAME.MAINNET]: MIDEN_MAINNET_PREFIX,
  [MIDEN_NETWORK_NAME.TESTNET]: MIDEN_TESTNET_PREFIX,
  [MIDEN_NETWORK_NAME.DEVNET]: MIDEN_DEVNET_PREFIX,
  [MIDEN_NETWORK_NAME.LOCALNET]: MIDEN_LOCALNET_PREFIX
};

export class MidenAddressError extends Error {
  readonly reason: 'invalid' | 'wrong-network';

  constructor(reason: 'invalid' | 'wrong-network') {
    super(reason === 'wrong-network' ? 'Miden address belongs to a different network' : 'Invalid Miden address');
    this.name = 'MidenAddressError';
    this.reason = reason;
  }
}

/**
 * Strict Miden address validation: returns `true` for a valid address of the
 * current network, throws `MidenAddressError` otherwise. A prefix check alone
 * lets a typo'd address through to the transaction pipeline, where it only
 * fails after guardian approval — so run the SDK's full bech32 decode
 * (charset + checksum + payload) up front. Decode success is sufficient: both
 * address forms — with the `_…` routing-parameters suffix (BasicWallet
 * interface) and the bare account-id form (unspecified interface) — decode to
 * the same note tag, so no separate routing check is needed. A well-formed
 * address for a different Miden network (e.g. an `mm1…` mainnet address while
 * the wallet targets testnet) throws with reason `wrong-network` so the UI
 * can show a specific message.
 */
export const isValidMidenAddress = (address: string): true => {
  const trimmed = address.trim();
  if (!MIDEN_BECH32_PREFIXES.some(prefix => trimmed.startsWith(prefix))) {
    throw new MidenAddressError('invalid');
  }
  try {
    Address.fromBech32(trimmed);
  } catch {
    throw new MidenAddressError('invalid');
  }
  if (!trimmed.startsWith(NETWORK_ADDRESS_PREFIXES[getEffectiveNetworkName()])) {
    throw new MidenAddressError('wrong-network');
  }
  return true;
};

const ETH_ADDRESS_RGX = /^0x[a-fA-F0-9]{40}$/;

/**
 * A full Ethereum hex address. Uniform-case addresses remain valid, while
 * mixed-case addresses must have a valid EIP-55 checksum.
 */
export const isValidEthereumAddress = (address: string) => {
  const trimmed = (address ?? '').trim();
  if (!ETH_ADDRESS_RGX.test(trimmed)) return false;

  const addressBody = trimmed.slice(2);
  if (addressBody === addressBody.toLowerCase() || addressBody === addressBody.toUpperCase()) return true;

  return isAddress(trimmed);
};

/** Chain-aware recipient validity: `0x…` checks as Ethereum, anything else as Miden. */
export const isValidRecipientAddress = (address: string) => {
  if (isHexAddress(address.trim())) return isValidEthereumAddress(address);
  try {
    return isValidMidenAddress(address);
  } catch {
    return false;
  }
};

export type AddressChain = 'miden' | 'ethereum';

/**
 * Detect which chain a recipient address targets, for UI affordances like the
 * send-flow "To" badge. A hex (`0x…`) address reads as Ethereum (cross-chain);
 * a Miden bech32 address — and any other / partial / empty input — reads as
 * Miden (same-chain), so the badge defaults to Miden until a `0x` is typed.
 */
export const detectAddressChain = (address: string): AddressChain => {
  return isHexAddress(address.trim()) ? 'ethereum' : 'miden';
};
