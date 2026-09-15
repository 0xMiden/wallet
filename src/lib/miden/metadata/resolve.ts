import { DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from './defaults';
import { AssetMetadata } from './types';

/**
 * The metadata record that governs how a faucet is displayed, resolved the way
 * `getTokenMetadata` resolves it, so a screen reading the in-memory store
 * agrees with an activity row reading persisted metadata.
 *
 * Always returns a record, and the choice it makes for a missing one is the
 * whole point:
 *
 * - No faucet at all — the row is about the native asset, so MIDEN.
 * - A faucet the store has resolved — that record.
 * - The native faucet, not yet in the store — MIDEN, whose scale is fixed and
 *   known regardless of what the store has cached.
 * - Any other unresolved faucet — the unknown-token placeholder, so the caller
 *   sees a record that openly declares its scale a guess.
 *
 * That last case is why this exists. Reading `undefined` straight from the
 * store loses the distinction between "native" and "not resolved yet", and
 * every caller that then reached for a default reached for MIDEN's 6 —
 * rendering an unresolved 18-decimal token a trillion times too large.
 */
export function resolveDisplayMetadata(
  faucetId: string | undefined,
  assetsMetadata: Record<string, AssetMetadata> | undefined,
  nativeFaucetId: string | null
): AssetMetadata {
  if (faucetId === undefined) return MIDEN_METADATA;
  const stored = assetsMetadata?.[faucetId];
  if (stored) return stored;
  return nativeFaucetId !== null && faucetId === nativeFaucetId ? MIDEN_METADATA : DEFAULT_TOKEN_METADATA;
}
