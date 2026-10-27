import { getAddress } from 'viem';

import type { EarnVaultInfo } from 'lib/epoch/pools-read';
import { walletRaised } from 'lib/telemetry/bridge-receive-failure';

import type { AgglayerDepositToken, BridgeToken, DerivedChainConfig, Probe, TokenMetadata } from './derive';
import { getE2eOverrides, type MidenUsdc } from './e2e-overrides';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import {
  type AgglayerRecoveryConfig,
  EARN_VAULT_LOGO,
  type EarnVaultConfig,
  epochCollateralFaucetId,
  type SupportedEvmChainConfig
} from './schema';
import { bridgeConfigBaseUrl } from './source';
import type { SwapPairs } from './swap-pairs';

/** Thrown by a `get*` getter while the accepted document or its derivation cannot supply the value. */
export class BridgeConfigUnavailableError extends Error {
  constructor(readonly value: string) {
    super(`The bridge config has no usable ${value}.`);
    this.name = 'BridgeConfigUnavailableError';
    walletRaised(this);
  }
}

export interface EvmUsdc extends TokenMetadata {
  /** Checksummed, as the Epoch intents carry it. */
  address: `0x${string}`;
  chainId: number;
}

export interface EarnMarket {
  marketUid: string;
  protocolHash: `0x${string}`;
  /** Checksummed, as the Epoch intents carry it. */
  underlying: `0x${string}`;
  chainId: number;
}

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

const okValue = <T>(probe: Probe<T> | undefined): T | null => (probe?.state === 'ok' ? probe.value : null);

export function selectEpochChain(s: BridgeConfigSnapshot, chainId?: number): SupportedEvmChainConfig | null {
  const chains = Object.values(s.config?.supportedEvmChains ?? {});
  return chains.find(chain => chain.bridges.epoch && (chainId === undefined || chain.chainId === chainId)) ?? null;
}

export function selectAgglayerChain(s: BridgeConfigSnapshot, chainId?: number): SupportedEvmChainConfig | null {
  const chains = Object.values(s.config?.supportedEvmChains ?? {});
  return chains.find(chain => chain.bridges.agglayer && (chainId === undefined || chain.chainId === chainId)) ?? null;
}

// The reads of the AggLayer chain `chainId`, or of the first one listed when no chain is given.
function agglayerReads(s: BridgeConfigSnapshot, chainId?: number): DerivedChainConfig['agglayer'] | undefined {
  const chain = selectAgglayerChain(s, chainId);
  return chain ? s.derived?.chains[chain.chainId]?.agglayer : undefined;
}

export function selectEvmChainId(s: BridgeConfigSnapshot): number | null {
  return selectEpochChain(s)?.chainId ?? null;
}

/** The Earn collateral faucet: the E2E override first, else the document's, whether or not its read succeeded. */
export function selectMidenUsdcFaucetId(s: BridgeConfigSnapshot): string | null {
  return (
    getE2eOverrides().earnCollateralFaucet?.faucetId ??
    (s.config ? epochCollateralFaucetId(s.config) : undefined) ??
    null
  );
}

export function selectMidenUsdc(s: BridgeConfigSnapshot): MidenUsdc | null {
  const override = getE2eOverrides().earnCollateralFaucet;
  if (override) return override;
  const faucetId = s.config ? epochCollateralFaucetId(s.config) : undefined;
  const metadata = okValue(s.derived?.epoch.midenUsdcFaucet);
  return faucetId && metadata ? { faucetId, ...metadata } : null;
}

/** The solver's tokens and pairs (`GET /v2/pairs` on the document's `swap.etaUrl`), or null while no read has succeeded. */
export function selectSwapPairs(s: BridgeConfigSnapshot): SwapPairs | null {
  return okValue(s.derived?.swap?.pairs);
}

/** The faucet the solver lists a swap token under `ticker` at ('0x' + 30 lowercase hex), or null when it lists none. */
/** One Epoch route the document names: a chain and its USDC contract, checksummed, as the positions service keys markets. */
export interface EpochRoute {
  chainId: number;
  usdc: `0x${string}`;
}

/**
 * Every Epoch route the document names (`supportedEvmChains.<chain>.bridges.epoch` with a USDC token), in document
 * order. Positions live on any of them, whatever the default market, so a positions read asks for all of them.
 */
export function selectEpochRoutes(s: BridgeConfigSnapshot): EpochRoute[] {
  return Object.values(s.config?.supportedEvmChains ?? {}).flatMap(chain => {
    const address = chain.bridges.epoch?.tokens.USDC?.contractAddress;
    return address ? [{ chainId: chain.chainId, usdc: getAddress(address) }] : [];
  });
}

export function selectSwapTokenFaucetId(s: BridgeConfigSnapshot, ticker: string): string | null {
  return selectSwapPairs(s)?.tokens.find(token => token.ticker === ticker)?.faucetId ?? null;
}

export function selectEvmUsdc(s: BridgeConfigSnapshot, chainId?: number): EvmUsdc | null {
  const chain = selectEpochChain(s, chainId);
  const address = chain?.bridges.epoch?.tokens.USDC?.contractAddress;
  const token = okValue(chain ? s.derived?.chains[chain.chainId]?.epoch.evmUsdc : undefined);
  return address && chain && token ? { address: getAddress(address), chainId: chain.chainId, ...token } : null;
}

/** Read the market returned by the Epoch positions service. */
export function selectEarnMarket(s: BridgeConfigSnapshot): EarnMarket | null {
  return okValue(s.derived?.epoch.market);
}

/**
 * The Earn vault catalogue the derivation read (`derived.epoch.vaults`): the listed vaults the service serves, in the
 * document's order. Null while no derivation holds one, or while its read failed or was skipped.
 */
export function selectEarnVaultCatalog(s: BridgeConfigSnapshot): EarnVaultInfo[] | null {
  return okValue(s.derived?.epoch.vaults);
}

const NO_EARN_VAULTS: readonly EarnVaultConfig[] = [];

/**
 * The Earn vaults the document lists (`earn.vaults`), in picker order: the only markets the wallet offers, and the
 * names it shows for them. Empty while no document is accepted, or when Earn is off.
 */
export function selectEarnVaults(s: BridgeConfigSnapshot): readonly EarnVaultConfig[] {
  return s.config?.earn?.vaults ?? NO_EARN_VAULTS;
}

/**
 * The Arcade GC sale the accepted document names (`arcade.sale`): the account whose public PSWAP note sells Game
 * Coins. Null while no document is accepted, or while `features.arcadeGcPurchase` is off; a document that turns the
 * purchase off is the kill switch, and `getGcSaleConfig` (`lib/miden/arcade/gc-sale.ts`) tells the two apart.
 */
export function selectGcSale(s: BridgeConfigSnapshot): { seller: string } | null {
  return s.config?.features.arcadeGcPurchase === true ? (s.config.arcade?.sale ?? null) : null;
}

/**
 * The absolute URL of a listed vault's `logo`: the path resolved against the base URL the network's document is
 * fetched from (`bridgeConfigBaseUrl`). Null when the entry names no logo. Draw it only through an `<img>`, so an SVG
 * never runs.
 */
export function selectEarnVaultLogoUrl(s: BridgeConfigSnapshot, listing: EarnVaultConfig): string | null {
  const { logo } = listing;
  return logo !== undefined && EARN_VAULT_LOGO.test(logo) ? `${bridgeConfigBaseUrl(s.network)}/${logo}` : null;
}

/** The listed Earn vault of `marketUid` (in any case), or null when the document lists none for it. */
export function selectEarnVault(s: BridgeConfigSnapshot, marketUid: string): EarnVaultConfig | null {
  const key = marketUid.toLowerCase();
  return selectEarnVaults(s).find(vault => vault.marketUid === key) ?? null;
}

/**
 * The mainnet launch moment the document sets (`mainnetCountdown.launchAt`, epoch milliseconds, UTC). Null
 * while the countdown is off, names no moment, or no document is accepted yet. Before the moment the
 * wallet counts down to it; from the moment on, mainnet has launched (`hasMainnetLaunched`).
 */
export function selectMainnetLaunchAt(s: BridgeConfigSnapshot): number | null {
  const countdown = s.config?.mainnetCountdown;
  if (!countdown?.enabled || countdown.launchAt === undefined) return null;
  return countdown.launchAt;
}

/**
 * Whether mainnet has launched for this network at `now`: the countdown is on and its moment has passed.
 * This is the one switch behind the invite-only Welcome, the recover-only reset and the switch-to-mainnet
 * banner, so the document's moment is what moves every wallet, not a flag of its own.
 */
export function hasMainnetLaunched(s: BridgeConfigSnapshot, now: number): boolean {
  const launchAt = selectMainnetLaunchAt(s);
  return launchAt !== null && now >= launchAt;
}

/**
 * The registered token whose origin is native ETH on network 0: its faucet mints bridged ETH and sends its deliveries,
 * each a deposit of `w` wei arriving as `floor(w / 10^scale)` of the faucet's units.
 */
/**
 * The most the receiving account may hold in US dollars once a bridge-in lands (`limits.bridgeInMaxBalanceUsd`), or
 * null when the document sets no ceiling.
 */
export function selectBridgeInMaxBalanceUsd(s: BridgeConfigSnapshot): number | null {
  return s.config?.limits?.bridgeInMaxBalanceUsd ?? null;
}

export function selectNativeEthToken(s: BridgeConfigSnapshot, chainId?: number): BridgeToken | null {
  const tokens = okValue(agglayerReads(s, chainId)?.tokens) ?? [];
  return tokens.find(token => token.originToken === NATIVE_ETH && token.originNetwork === 0) ?? null;
}

/** The native-ETH token's faucet: it mints bridged ETH and sends its deliveries. */
export function selectNativeEthFaucet(s: BridgeConfigSnapshot, chainId?: number): string | null {
  return selectNativeEthToken(s, chainId)?.midenFaucetId ?? null;
}

/** Every listed AggLayer chain's native-ETH faucet, each once: any of them can send a delivery. */
export function selectNativeEthFaucets(s: BridgeConfigSnapshot): string[] {
  const chains = Object.values(s.config?.supportedEvmChains ?? {}).filter(chain => chain.bridges.agglayer);
  const faucets = chains.flatMap(chain => selectNativeEthFaucet(s, chain.chainId) ?? []);
  return [...new Set(faucets)];
}

export type { AgglayerDepositToken };

/**
 * The ERC-20s the deposit picker offers on `chainId`, as the derivation verified them against the bridge registry
 * (see probeDepositTokens): an empty list when there is nothing to offer, null while the read failed or has not
 * landed, which the picker reports rather than showing a shorter list.
 */
export function selectAgglayerDepositTokens(s: BridgeConfigSnapshot, chainId?: number): AgglayerDepositToken[] | null {
  const probe = agglayerReads(s, chainId)?.depositTokens;
  switch (probe?.state) {
    case 'ok':
      return probe.value;
    case 'absent':
    case 'skipped':
      return [];
    default:
      return null;
  }
}

/**
 * The registry entry for `originToken` (lowercase) on `chainId`: the faucet that mints its deliveries and the scale
 * it mints at. The same address registered from another network is another bridged token, so the entry must be from
 * `originNetwork` (a saved row's deposit network), else from the chain's read network id. Null while the registry
 * read is not ok, while neither network is known, or while the registry holds no faucet for the token there.
 */
export function selectAgglayerRegistryToken(
  s: BridgeConfigSnapshot,
  originToken: string,
  chainId?: number,
  originNetwork?: number
): BridgeToken | null {
  const reads = agglayerReads(s, chainId);
  const networkId = originNetwork ?? okValue(reads?.evmNetworkId);
  if (networkId === null) return null;
  const tokens = okValue(reads?.tokens) ?? [];
  return registeredToken(tokens, originToken, networkId);
}

/** The entry for `originToken` registered from `networkId` in a registry read, or null. */
export function registeredToken(tokens: BridgeToken[], originToken: string, networkId: number): BridgeToken | null {
  return tokens.find(token => token.originToken === originToken && token.originNetwork === networkId) ?? null;
}

/**
 * Every faucet the bridge registry of any listed AggLayer chain holds, each once: each mints one bridged token and
 * sends its deliveries, so a note from any of them is a bridge delivery.
 */
export function selectAgglayerDeliveryFaucets(s: BridgeConfigSnapshot): string[] {
  const chains = Object.values(s.config?.supportedEvmChains ?? {}).filter(chain => chain.bridges.agglayer);
  const faucets = chains.flatMap(chain =>
    (okValue(agglayerReads(s, chain.chainId)?.tokens) ?? []).map(token => token.midenFaucetId)
  );
  return [...new Set(faucets)];
}

// Read synchronously: each realm hydrates its snapshot at startup, and an entry point stays greyed until its values are
// in it, so code past one only reaches a null through a deep link or a document that changed under it.
function getValue<T>(value: string, select: (s: BridgeConfigSnapshot) => T | null): T {
  const found = select(getBridgeConfigSnapshot());
  if (found === null) throw new BridgeConfigUnavailableError(value);
  return found;
}

export function getEpochAllocatorUrl(): string {
  return getValue('epoch.allocatorUrl', s => s.config?.['bridge-providers'].epoch.allocatorUrl ?? null);
}

export function getEpochPositionsUrl(): string {
  return getValue('epoch.positionsUrl', s => s.config?.['bridge-providers'].epoch.positionsUrl ?? null);
}

export function getEvmChainId(): number {
  return getValue('evm.chainId', selectEvmChainId);
}

export function getMidenUsdc(): MidenUsdc {
  return getValue('Earn collateral faucet', selectMidenUsdc);
}

export function getEvmUsdc(chainId?: number): EvmUsdc {
  return getValue('EVM USDC', s => selectEvmUsdc(s, chainId));
}

/** The EVM USDC address from the document alone, checksummed: a recovery action never waits on the token's read. */
export function getEvmUsdcAddress(): `0x${string}` {
  return getValue('epoch.evmUsdc', s => {
    const address = selectEpochChain(s)?.bridges.epoch?.tokens.USDC?.contractAddress;
    return address ? getAddress(address) : null;
  });
}

/** The EVM USDC on `chainId` (else the first Epoch chain) with symbol and decimals, or null until that read works. */
export function findEvmUsdc(chainId?: number): EvmUsdc | null {
  return selectEvmUsdc(getBridgeConfigSnapshot(), chainId);
}

/** Every Epoch route the accepted document names (`selectEpochRoutes`); empty with no document. Never throws. */
export function getEpochRoutes(): EpochRoute[] {
  return selectEpochRoutes(getBridgeConfigSnapshot());
}

/** The Epoch USDC contract the document names on `chainId`, whether or not its token read succeeded. */
export function findEpochUsdcAddress(chainId: number): string | null {
  return selectEpochChain(getBridgeConfigSnapshot(), chainId)?.bridges.epoch?.tokens.USDC?.contractAddress ?? null;
}

export function getEarnMarket(): EarnMarket {
  return getValue('Earn market', selectEarnMarket);
}

/** This realm's `selectEarnVaults`: an empty list, never a throw, when the document lists none. */
export function getEarnVaults(): readonly EarnVaultConfig[] {
  return selectEarnVaults(getBridgeConfigSnapshot());
}

export function getAgglayerMidenBridge(chainId?: number): string {
  return getValue(
    'agglayer.midenBridge',
    s => selectAgglayerChain(s, chainId)?.bridges.agglayer?.midenBridgeId ?? null
  );
}

/** The indexer, while the AggLayer chain `chainId` (or any, when none is given) is listed. */
export function getAgglayerIndexerUrl(chainId?: number): string {
  return getValue('agglayer.indexerUrl', s =>
    selectAgglayerChain(s, chainId) ? (s.config?.['bridge-providers'].agglayer.indexerUrl ?? null) : null
  );
}

export function getAgglayerL1Bridge(chainId?: number): `0x${string}` {
  return getValue('agglayer.l1Bridge', s => selectAgglayerChain(s, chainId)?.bridges.agglayer?.contractAddress ?? null);
}

/** The Miden rollup id: a deposit's destination network, and the network the indexer files every Miden exit under. */
export function getAgglayerRollupId(chainId?: number): number {
  return getValue('Agglayer rollup id', s => okValue(agglayerReads(s, chainId)?.rollupId));
}

/** The L1 bridge's networkID(): the destination of every bridge-out note, and of the exit the indexer files for it. */
export function getAgglayerEvmNetworkId(chainId?: number): number {
  return getValue('Agglayer L1 network id', s => okValue(agglayerReads(s, chainId)?.evmNetworkId));
}

/** What a bridge-out note carries: the Miden bridge it targets and the L1 bridge's networkID() as its destination. */
export function getAgglayerBridgeOut(chainId?: number): {
  midenBridge: string;
  evmNetworkId: number;
  recovery: AgglayerRecoveryConfig;
} {
  return getValue('Agglayer bridge-out values', s => {
    const midenBridge = selectAgglayerChain(s, chainId)?.bridges.agglayer?.midenBridgeId;
    const evmNetworkId = okValue(agglayerReads(s, chainId)?.evmNetworkId);
    const recovery = selectAgglayerRecoveryConfig(s, chainId);
    return midenBridge && evmNetworkId !== null && recovery ? { midenBridge, evmNetworkId, recovery } : null;
  });
}

/** What an L1 deposit calls: the L1 bridge, with the Miden rollup id as the destination network. */
export function getAgglayerDeposit(chainId?: number): { l1Bridge: `0x${string}`; rollupId: number } {
  return getValue('Agglayer deposit values', s => {
    const l1Bridge = selectAgglayerChain(s, chainId)?.bridges.agglayer?.contractAddress;
    const rollupId = okValue(agglayerReads(s, chainId)?.rollupId);
    return l1Bridge && rollupId !== null ? { l1Bridge, rollupId } : null;
  });
}

export function selectAgglayerRecoveryConfig(
  s: BridgeConfigSnapshot,
  chainId?: number
): AgglayerRecoveryConfig | undefined {
  const chain = selectAgglayerChain(s, chainId);
  const route = chain?.bridges.agglayer;
  const indexerUrl = s.config?.['bridge-providers'].agglayer.indexerUrl;
  const reads = agglayerReads(s, chainId);
  const rollupId = okValue(reads?.rollupId);
  const evmNetworkId = okValue(reads?.evmNetworkId);
  if (!chain || !route || !indexerUrl || rollupId === null || evmNetworkId === null) return undefined;
  // Saved with the row, so its delivery still matches once the document drops the chain.
  const nativeEth = selectNativeEthToken(s, chain.chainId);
  return {
    chainId: chain.chainId,
    ...route,
    indexerUrl,
    rollupId,
    evmNetworkId,
    ...(nativeEth ? { nativeEthFaucetId: nativeEth.midenFaucetId, nativeEthScale: nativeEth.scale } : {})
  };
}
