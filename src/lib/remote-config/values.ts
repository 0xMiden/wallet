import { getAddress } from 'viem';

import type { BridgeToken, Probe, TokenMetadata } from './derive';
import { getE2eOverrides, type MidenUsdc } from './e2e-overrides';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import { type AgglayerRecoveryConfig, epochCollateralFaucetId, type SupportedEvmChainConfig } from './schema';

/** Thrown by a `get*` getter while the accepted document or its derivation cannot supply the value. */
export class BridgeConfigUnavailableError extends Error {
  constructor(readonly value: string) {
    super(`The bridge config has no usable ${value}.`);
    this.name = 'BridgeConfigUnavailableError';
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

/** The faucet the document lists a swap token under `symbol` at ('0x' + 30 lowercase hex), or null when it lists none. */
export function selectSwapTokenFaucetId(s: BridgeConfigSnapshot, symbol: string): string | null {
  return s.config?.swap?.tokens.find(token => token.symbol === symbol)?.faucetId ?? null;
}

export function selectEvmUsdc(s: BridgeConfigSnapshot, chainId?: number): EvmUsdc | null {
  const chain = selectEpochChain(s, chainId);
  const address = chain?.bridges.epoch?.tokens.USDC?.contractAddress;
  const token = okValue(chain ? s.derived?.chains?.[chain.chainId]?.epoch.evmUsdc : undefined);
  return address && chain && token ? { address: getAddress(address), chainId: chain.chainId, ...token } : null;
}

/** Read the market returned by the Epoch positions service. */
export function selectEarnMarket(s: BridgeConfigSnapshot): EarnMarket | null {
  return okValue(s.derived?.epoch.market);
}

/**
 * The registered token whose origin is native ETH on network 0: its faucet mints bridged ETH and sends its deliveries,
 * each a deposit of `w` wei arriving as `floor(w / 10^scale)` of the faucet's units.
 */
export function selectNativeEthToken(s: BridgeConfigSnapshot): BridgeToken | null {
  const tokens = okValue(s.derived?.agglayer.tokens) ?? [];
  return tokens.find(token => token.originToken === NATIVE_ETH && token.originNetwork === 0) ?? null;
}

/** The native-ETH token's faucet: it mints bridged ETH and sends its deliveries. */
export function selectNativeEthFaucet(s: BridgeConfigSnapshot): string | null {
  return selectNativeEthToken(s)?.midenFaucetId ?? null;
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

/** The EVM USDC with its symbol and decimals, or null while that read has not succeeded. */
export function findEvmUsdc(): EvmUsdc | null {
  return selectEvmUsdc(getBridgeConfigSnapshot());
}

export function getEarnMarket(): EarnMarket {
  return getValue('Earn market', selectEarnMarket);
}

export function getAgglayerMidenBridge(chainId?: number): string {
  return getValue(
    'agglayer.midenBridge',
    s => selectAgglayerChain(s, chainId)?.bridges.agglayer?.midenBridgeId ?? null
  );
}

export function getAgglayerIndexerUrl(): string {
  return getValue('agglayer.indexerUrl', s => s.config?.['bridge-providers'].agglayer.indexerUrl ?? null);
}

export function getAgglayerL1Bridge(chainId?: number): `0x${string}` {
  return getValue('agglayer.l1Bridge', s => selectAgglayerChain(s, chainId)?.bridges.agglayer?.contractAddress ?? null);
}

/** The Miden rollup id: a deposit's destination network, and the network the indexer files every Miden exit under. */
export function getAgglayerRollupId(): number {
  return getValue('Agglayer rollup id', s => okValue(s.derived?.agglayer.rollupId));
}

/** The L1 bridge's networkID(): the destination of every bridge-out note, and of the exit the indexer files for it. */
export function getAgglayerEvmNetworkId(): number {
  return getValue('Agglayer L1 network id', s => okValue(s.derived?.agglayer.evmNetworkId));
}

/** What a bridge-out note carries: the Miden bridge it targets and the L1 bridge's networkID() as its destination. */
export function getAgglayerBridgeOut(chainId?: number): {
  midenBridge: string;
  evmNetworkId: number;
  recovery: AgglayerRecoveryConfig;
} {
  return getValue('Agglayer bridge-out values', s => {
    const midenBridge = selectAgglayerChain(s, chainId)?.bridges.agglayer?.midenBridgeId;
    const chain = selectAgglayerChain(s, chainId);
    const evmNetworkId = okValue(chain ? s.derived?.chains?.[chain.chainId]?.agglayer.evmNetworkId : undefined);
    const recovery = selectAgglayerRecoveryConfig(s, chainId);
    return midenBridge && evmNetworkId !== null && recovery ? { midenBridge, evmNetworkId, recovery } : null;
  });
}

/** What an L1 deposit calls: the L1 bridge, with the Miden rollup id as the destination network. */
export function getAgglayerDeposit(chainId?: number): { l1Bridge: `0x${string}`; rollupId: number } {
  return getValue('Agglayer deposit values', s => {
    const l1Bridge = selectAgglayerChain(s, chainId)?.bridges.agglayer?.contractAddress;
    const chain = selectAgglayerChain(s, chainId);
    const rollupId = okValue(chain ? s.derived?.chains?.[chain.chainId]?.agglayer.rollupId : undefined);
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
  const reads = chain ? s.derived?.chains?.[chain.chainId]?.agglayer : undefined;
  const rollupId = okValue(reads?.rollupId);
  const evmNetworkId = okValue(reads?.evmNetworkId);
  if (!chain || !route || !indexerUrl || rollupId === null || evmNetworkId === null) return undefined;
  return { chainId: chain.chainId, ...route, indexerUrl, rollupId, evmNetworkId };
}
