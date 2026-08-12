/**
 * QR code payload format utilities for Miden addresses.
 *
 * Format: miden:<address>
 * Example: miden:mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph
 *
 * Follows BIP21/EIP-681 industry convention for URI schemes.
 */
import { isValidMidenAddress as isValidMidenBech32Address } from 'utils/miden';

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
 * Validates if a string looks like a Miden address for QR-scan purposes: a
 * recognized network bech32 prefix plus a reasonable length.
 *
 * The set of network prefixes (mm1 / mtst1 / mdev1 / mlcl1) is delegated to the
 * canonical `utils/miden` validator so this QR copy can never drift from it
 * again. The previous local copy hard-coded only `mtst1`/`m1`, so it rejected
 * devnet (`mdev1`), localnet (`mlcl1`), and even real mainnet (`mm1`) — a
 * localnet address scanned via QR came back "invalid". The SDK's
 * `Address.fromBech32` remains the authoritative decoder downstream.
 *
 * @param address The address to validate
 * @returns true if the address appears to be a valid Miden address
 */
export function isValidMidenAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  const trimmed = address.trim();

  // Bech32 addresses have a reasonable length; the SDK does the real decode.
  return isValidMidenBech32Address(trimmed) && trimmed.length >= 30 && trimmed.length <= 100;
}
