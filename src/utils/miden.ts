import { isAddress } from 'viem';

export const isHexAddress = (address: string) => {
  return address.startsWith('0x');
};

const MIDEN_MAINNET_PREFIX = 'mm1';
const MIDEN_TESTNET_PREFIX = 'mtst1';
const MIDEN_DEVNET_PREFIX = 'mdev1';
const MIDEN_BECH32_PREFIXES = [MIDEN_MAINNET_PREFIX, MIDEN_TESTNET_PREFIX, MIDEN_DEVNET_PREFIX];

const isValidBech32Address = (address: string) => {
  return MIDEN_BECH32_PREFIXES.some(prefix => address.startsWith(prefix));
};

export const isValidMidenAddress = (address: string) => {
  return isValidBech32Address(address);
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

/** Chain-aware recipient validity: a Miden bech32 address OR an Ethereum hex address. */
export const isValidRecipientAddress = (address: string) =>
  isValidMidenAddress(address) || isValidEthereumAddress(address);

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
