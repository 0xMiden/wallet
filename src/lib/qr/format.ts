/**
 * QR code payload format utilities for Miden addresses.
 *
 * Format: miden:<address>
 * Example: miden:mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph
 *
 * Follows BIP21/EIP-681 industry convention for URI schemes.
 */
import { isValidMidenAddress as strictMidenAddressCheck, MidenAddressError } from 'utils/miden';

const MIDEN_URI_PREFIX = 'miden:';

/**
 * Encodes a Miden address into a QR code payload.
 * @param address The raw Miden address (e.g., "mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph")
 * @returns The encoded URI (e.g., "miden:mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph")
 */
export function encodeAddress(address: string): string {
  return `${MIDEN_URI_PREFIX}${address}`;
}

/**
 * Decodes a QR code payload to extract the Miden address.
 * Accepts both:
 * - Full URI format: "miden:mtst1..."
 * - Plain address: "mtst1..."
 *
 * @param payload The scanned QR code content
 * @returns The extracted address
 */
export function decodeAddress(payload: string): string {
  const trimmed = payload.trim();

  // If it has the miden: prefix, strip it
  if (trimmed.toLowerCase().startsWith(MIDEN_URI_PREFIX)) {
    return trimmed.slice(MIDEN_URI_PREFIX.length);
  }

  // Otherwise return as-is (plain address)
  return trimmed;
}

/**
 * Validates if a string is a decodable Miden address (strict bech32 decode).
 * Delegated to the canonical `utils/miden` validator so this QR copy can never
 * drift from the recognized network prefixes (mm1 / mtst1 / mdev1 / mlcl1)
 * again — the old local copy hard-coded `mtst1`/`m1`, so a devnet, localnet or
 * even real mainnet address scanned via QR came back "invalid". A wrong-network
 * address still passes here — the send screen surfaces its specific
 * wrong-network message once the scanned address lands in the field.
 *
 * @param address The address to validate
 * @returns true if the address decodes as a Miden address
 */
export function isValidMidenAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  try {
    return strictMidenAddressCheck(address);
  } catch (error) {
    return error instanceof MidenAddressError && error.reason === 'wrong-network';
  }
}
