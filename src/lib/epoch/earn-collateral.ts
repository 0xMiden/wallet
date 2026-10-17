import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';
import { getE2eOverrides, type MidenUsdc } from 'lib/remote-config/e2e-overrides';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectMidenUsdc } from 'lib/remote-config/values';

/** Testnet Earn spends native USDCx; the legacy bridge output remains available to recovery and history. */
export function selectEarnCollateral(s: BridgeConfigSnapshot): MidenUsdc | null {
  const override = getE2eOverrides().earnCollateralFaucet;
  if (override) return override;
  if (s.network !== 'testnet') return selectMidenUsdc(s);
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
