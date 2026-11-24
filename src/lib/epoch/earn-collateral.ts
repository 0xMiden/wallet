import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';
import { getE2eOverrides, type MidenUsdc } from 'lib/remote-config/e2e-overrides';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

/**
 * Earn spends the native USDCx on every network; the legacy bridge output (`selectMidenUsdc`) remains available to
 * recovery and history. The snapshot is kept in the signature for the callers that pass it.
 */
export function selectEarnCollateral(_snapshot: BridgeConfigSnapshot): MidenUsdc | null {
  const override = getE2eOverrides().earnCollateralFaucet;
  if (override) return override;
  const faucetId = getNativeAssetIdSync();
  const metadata = getNativeAssetMetadataSync();
  if (
    !faucetId ||
    !metadata ||
    !hasKnownScale({ ...metadata, name: metadata.symbol }) ||
    metadata.symbol.toUpperCase() !== 'USDCX'
  )
    return null;
  return { faucetId, symbol: 'USDCx', decimals: metadata.decimals };
}
