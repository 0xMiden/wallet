import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import { selectMidenUsdcFaucetId } from './values';

/** What testnet calls the bridge's own USDC, on Sepolia and on Miden alike (#1247). A token name: never translated. */
export const TEST_EPOCH_USDC_LABEL = 'Test Epoch USDC';

interface TestnetTokenLabel {
  faucetId: string | null;
  label: string;
}

// Each Miden token testnet shows under a name of the wallet's own; another token is one more entry.
function testnetMidenTokenLabels(s: BridgeConfigSnapshot): TestnetTokenLabel[] {
  return [{ faucetId: selectMidenUsdcFaucetId(s), label: TEST_EPOCH_USDC_LABEL }];
}

/**
 * The name a Miden token is shown under: on testnet, the label of the entry for its faucet, matched by canonical id and
 * never by the symbol a faucet gives itself (#1131); otherwise, and before the snapshot names the faucet, `symbol`.
 * Display only: data, logos and price lookups keep the symbol.
 */
export function midenTokenLabel(faucetId: string | undefined, symbol: string): string {
  if (!faucetId || getTestNetworkNameKey() !== 'testnet') return symbol;
  const labels = testnetMidenTokenLabels(getBridgeConfigSnapshot()).flatMap(({ faucetId: id, label }) =>
    id ? [{ id, label }] : []
  );
  // Nothing is named before the snapshot loads, so no id needs parsing.
  if (labels.length === 0) return symbol;
  const canonical = normalizedFaucetId(faucetId);
  return labels.find(({ id }) => normalizedFaucetId(id) === canonical)?.label ?? symbol;
}

/** The name an EVM token is shown under: on testnet, the label for the bridge's configured token; else `symbol`. */
export function evmTokenLabel(address: string | undefined, symbol: string): string {
  if (!address || getTestNetworkNameKey() !== 'testnet') return symbol;
  const configured = getBridgeConfigSnapshot().config?.epoch.evmUsdc;
  return configured?.toLowerCase() === address.toLowerCase() ? TEST_EPOCH_USDC_LABEL : symbol;
}
