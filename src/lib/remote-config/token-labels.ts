// The leaf, never lib/miden/swap/tokens: the metadata overrides read these labels (see faucet-ids.ts).
import { AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL } from 'lib/agglayer/constant';
import type { IBridgeProvider } from 'lib/miden/db/types';
import { normalizedFaucetId } from 'lib/miden/swap/faucet-ids';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import type { BridgeConfigSnapshot } from './runtime';
import { selectEpochToken, selectMidenUsdcFaucetId, selectSwapTokenFaucetId } from './values';

/** What testnet calls the bridge's own USDC, on Sepolia and on Miden alike (#1247). A token name: never translated. */
export const TEST_EPOCH_USDC_LABEL = 'Test Epoch USDC';

/** What testnet calls the swap registry's iETH, a test asset that is not ETH (#477). A token name: never translated. */
export const TEST_IETH_LABEL = 'Test iETH';

/** The ticker the swap solver lists testnet's iETH under; its faucet is whatever the solver says. */
export const IETH_SYMBOL = 'IETH';

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

// The swap token testnet describes as well as names: the solver's IETH token, at whatever faucet it lists.
function describedTestnetTokens(s: BridgeConfigSnapshot): TestnetToken[] {
  return [
    {
      faucetId: selectSwapTokenFaucetId(s, IETH_SYMBOL),
      label: TEST_IETH_LABEL,
      info: { descriptionKey: 'testIethDescription', executionKey: 'testIethExecution' }
    }
  ];
}

// Each Miden token testnet shows under a name of the wallet's own; another token is one more entry.
function testnetMidenTokens(s: BridgeConfigSnapshot): TestnetToken[] {
  return [{ faucetId: selectMidenUsdcFaucetId(s), label: TEST_EPOCH_USDC_LABEL }, ...describedTestnetTokens(s)];
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

/**
 * On testnet, the info of the entry for `faucetId` (iETH's, #477) once `snapshot` names it; null for any other
 * token and off testnet.
 */
export function testnetTokenInfo(
  snapshot: BridgeConfigSnapshot,
  faucetId: string | undefined
): TestnetTokenInfo | null {
  return testnetTokenFor(describedTestnetTokens(snapshot), faucetId)?.info ?? null;
}

/**
 * The name the bridge's own EVM USDC is shown under, for a caller that names that token by its role: on testnet, the
 * label whenever the document names an EVM USDC, whether or not the token's Sepolia read has succeeded; else `symbol`.
 */
export function evmUsdcLabel(snapshot: BridgeConfigSnapshot, symbol: string): string {
  return getTestNetworkNameKey() === 'testnet' &&
    Object.values(snapshot.config?.supportedEvmChains ?? {}).some(chain => chain.bridges.epoch?.tokens.USDC)
    ? TEST_EPOCH_USDC_LABEL
    : symbol;
}

/**
 * Whether an Epoch output is the bridge's own USDC, the only symbol `evmUsdcLabel` may rename. `USDC` is that token.
 * On a chain, so is the route USDC's read symbol, and an `address` whose lowercase form equals that token's address.
 * With no chain, the USDC read symbol of every Epoch route is compared.
 */
export function epochOutputIsBridgeUsdc(
  snapshot: BridgeConfigSnapshot,
  chainId: number | undefined,
  symbol: string,
  address?: string
): boolean {
  if (symbol === 'USDC') return true;
  if (chainId !== undefined) {
    const token = selectEpochToken(snapshot, chainId, 'USDC');
    return (
      symbol === token?.symbol || (address !== undefined && address.toLowerCase() === token?.address.toLowerCase())
    );
  }
  return Object.values(snapshot.config?.supportedEvmChains ?? {}).some(
    chain => symbol === selectEpochToken(snapshot, chain.chainId, 'USDC')?.symbol
  );
}

/**
 * The name a bridge-in's EVM source is shown under. ETH and Circle's USDC keep their symbol. An AggLayer row that saved
 * the ERC-20 it deposited (`sourceToken`) takes the bridge USDC's label only when that token is the document's EVM
 * USDC; any other ERC-20 keeps its symbol. A row with no saved token takes that label only when its symbol is the
 * bridge USDC, so a Fast deposit of POL or WETH keeps its symbol.
 */
export function bridgeInSourceLabel(
  snapshot: BridgeConfigSnapshot,
  source: { provider?: IBridgeProvider; symbol: string; sourceToken?: string }
): string {
  if (source.provider === 'usdcx' || source.symbol === AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL) return source.symbol;
  if (source.sourceToken !== undefined) {
    const token = source.sourceToken.toLowerCase();
    const isBridgeUsdc = Object.values(snapshot.config?.supportedEvmChains ?? {}).some(
      chain => chain.bridges.epoch?.tokens.USDC?.contractAddress.toLowerCase() === token
    );
    if (!isBridgeUsdc) return source.symbol;
  } else if (!epochOutputIsBridgeUsdc(snapshot, undefined, source.symbol)) {
    return source.symbol;
  }
  return evmUsdcLabel(snapshot, source.symbol);
}
