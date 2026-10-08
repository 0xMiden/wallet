// The leaf, never lib/miden/swap/tokens: the metadata overrides read these labels (see faucet-ids.ts).
import { IETH_FAUCET_ID, normalizedFaucetId } from 'lib/miden/swap/faucet-ids';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import type { BridgeConfigSnapshot } from './runtime';
import { selectMidenUsdcFaucetId } from './values';

/** What testnet calls the bridge's own USDC, on Sepolia and on Miden alike (#1247). A token name: never translated. */
export const TEST_EPOCH_USDC_LABEL = 'Test Epoch USDC';

/** What testnet calls the swap registry's iETH, a test asset that is not ETH (#477). A token name: never translated. */
export const TEST_IETH_LABEL = 'Test iETH';

/** The copy a token page and an info sheet show for a token: what it is, and where its swaps execute. */
export interface TestnetTokenInfo {
  descriptionKey: string;
  executionKey: string;
}

interface TestnetToken {
  faucetId: string | null;
  label: string;
  info?: TestnetTokenInfo;
}

// The tokens testnet names whatever the bridge config says; one with info is described as well as named.
function staticTestnetTokens(): TestnetToken[] {
  return [
    {
      faucetId: IETH_FAUCET_ID,
      label: TEST_IETH_LABEL,
      info: { descriptionKey: 'testIethDescription', executionKey: 'testIethExecution' }
    }
  ];
}

// Each Miden token testnet shows under a name of the wallet's own; another token is one more entry.
function testnetMidenTokens(s: BridgeConfigSnapshot): TestnetToken[] {
  return [{ faucetId: selectMidenUsdcFaucetId(s), label: TEST_EPOCH_USDC_LABEL }, ...staticTestnetTokens()];
}

function testnetTokenFor(tokens: TestnetToken[], faucetId: string | undefined): TestnetToken | undefined {
  if (!faucetId || getTestNetworkNameKey() !== 'testnet') return undefined;
  const canonical = normalizedFaucetId(faucetId);
  return tokens.find(({ faucetId: id }) => !!id && normalizedFaucetId(id) === canonical);
}

/**
 * The name a Miden token is shown under: on testnet, the label of the entry for its faucet, matched by canonical id and
 * never by the symbol a faucet gives itself (#1131); otherwise `symbol`; a faucet the config names
 * is labelled once `snapshot` names it.
 * Display only: data, logos and price lookups keep the symbol. A component passes the snapshot it subscribes to
 * (`useBridgeConfigSnapshot`), so the label appears when the config lands.
 */
export function midenTokenLabel(snapshot: BridgeConfigSnapshot, faucetId: string | undefined, symbol: string): string {
  return midenTokenLabelFor(snapshot, faucetId) ?? symbol;
}

/** The label `midenTokenLabel` shows for `faucetId`, or null when the token keeps its own symbol. */
export function midenTokenLabelFor(snapshot: BridgeConfigSnapshot, faucetId: string | undefined): string | null {
  return testnetTokenFor(testnetMidenTokens(snapshot), faucetId)?.label ?? null;
}

/** On testnet, the info of the entry for `faucetId` (iETH's, #477); null for any other token and off testnet. */
export function testnetTokenInfo(faucetId: string | undefined): TestnetTokenInfo | null {
  return testnetTokenFor(staticTestnetTokens(), faucetId)?.info ?? null;
}

/**
 * The name the bridge's own EVM USDC is shown under, for a caller that names that token by its role: on testnet, the
 * label whenever the document names an EVM USDC, whether or not the token's Sepolia read has succeeded; else `symbol`.
 */
export function evmUsdcLabel(snapshot: BridgeConfigSnapshot, symbol: string): string {
  return getTestNetworkNameKey() === 'testnet' && snapshot.config?.epoch.evmUsdc ? TEST_EPOCH_USDC_LABEL : symbol;
}
