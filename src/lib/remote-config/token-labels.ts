import { normalizedFaucetId, TOKEN_IETH } from 'lib/miden/swap/tokens';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import type { BridgeConfigSnapshot } from './runtime';
import { selectMidenUsdcFaucetId } from './values';

/** What testnet calls the bridge's own USDC, on Sepolia and on Miden alike (#1247). A token name: never translated. */
export const TEST_EPOCH_USDC_LABEL = 'Test Epoch USDC';

/** What testnet calls the swap registry's iETH, a test asset that is not ETH (#477). A token name: never translated. */
export const TEST_IETH_LABEL = 'Test iETH';

interface TestnetTokenLabel {
  faucetId: string | null;
  label: string;
}

// Each Miden token testnet shows under a name of the wallet's own; another token is one more entry.
function testnetMidenTokenLabels(s: BridgeConfigSnapshot): TestnetTokenLabel[] {
  return [
    { faucetId: selectMidenUsdcFaucetId(s), label: TEST_EPOCH_USDC_LABEL },
    { faucetId: TOKEN_IETH.faucetId, label: TEST_IETH_LABEL }
  ];
}

/**
 * The name a Miden token is shown under: on testnet, the label of the entry for its faucet, matched by canonical id and
 * never by the symbol a faucet gives itself (#1131); otherwise `symbol`; a faucet the config names
 * is labelled once `snapshot` names it.
 * Display only: data, logos and price lookups keep the symbol. A component passes the snapshot it subscribes to
 * (`useBridgeConfigSnapshot`), so the label appears when the config lands.
 */
export function midenTokenLabel(snapshot: BridgeConfigSnapshot, faucetId: string | undefined, symbol: string): string {
  if (!faucetId || getTestNetworkNameKey() !== 'testnet') return symbol;
  const labels = testnetMidenTokenLabels(snapshot).flatMap(({ faucetId: id, label }) => (id ? [{ id, label }] : []));
  const canonical = normalizedFaucetId(faucetId);
  return labels.find(({ id }) => normalizedFaucetId(id) === canonical)?.label ?? symbol;
}

/**
 * The name the bridge's own EVM USDC is shown under, for a caller that names that token by its role: on testnet, the
 * label whenever the document names an EVM USDC, whether or not the token's Sepolia read has succeeded; else `symbol`.
 */
export function evmUsdcLabel(snapshot: BridgeConfigSnapshot, symbol: string): string {
  return getTestNetworkNameKey() === 'testnet' && snapshot.config?.epoch.evmUsdc ? TEST_EPOCH_USDC_LABEL : symbol;
}
