import { getAddress, keccak256, toBytes } from 'viem';

import type { Probe, TokenMetadata } from './derive';
import { getE2eOverrides, type MidenUsdc } from './e2e-overrides';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import type { EarnProtocol } from './schema';

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

// dummyLendingMarketUid in @epoch-protocol/epoch-commons-sdk 0.1.20, which the wallet does not depend on directly
// and epoch-intents-sdk does not re-export.
const MARKET_UID_PREFIX: Record<EarnProtocol, string> = { 'dummy-lending': 'DUMMY_LENDING' };
const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

const okValue = <T>(probe: Probe<T> | undefined): T | null => (probe?.state === 'ok' ? probe.value : null);

export function selectEvmChainId(s: BridgeConfigSnapshot): number | null {
  return s.config?.evm.chainId ?? null;
}

/** The Earn collateral faucet: the E2E override first, else the document's, whether or not its read succeeded. */
export function selectMidenUsdcFaucetId(s: BridgeConfigSnapshot): string | null {
  return getE2eOverrides().earnCollateralFaucet?.faucetId ?? s.config?.epoch.midenUsdcFaucet ?? null;
}

export function selectMidenUsdc(s: BridgeConfigSnapshot): MidenUsdc | null {
  const override = getE2eOverrides().earnCollateralFaucet;
  if (override) return override;
  const faucetId = s.config?.epoch.midenUsdcFaucet;
  const metadata = okValue(s.derived?.epoch.midenUsdcFaucet);
  return faucetId && metadata ? { faucetId, ...metadata } : null;
}

export function selectEvmUsdc(s: BridgeConfigSnapshot): EvmUsdc | null {
  const address = s.config?.epoch.evmUsdc;
  const chainId = s.config?.evm.chainId;
  const token = okValue(s.derived?.epoch.evmUsdc);
  return address && chainId !== undefined && token ? { address: getAddress(address), chainId, ...token } : null;
}

/** From the document alone: the market uid and protocol hash are pure functions of its values. */
export function selectEarnMarket(s: BridgeConfigSnapshot): EarnMarket | null {
  const protocol = s.config?.epoch.earnProtocol;
  const underlying = s.config?.epoch.evmUsdc;
  const chainId = s.config?.evm.chainId;
  if (!protocol || !underlying || chainId === undefined) return null;
  return {
    marketUid: `${MARKET_UID_PREFIX[protocol]}:${chainId}:${underlying}`,
    protocolHash: keccak256(toBytes(protocol)),
    underlying: getAddress(underlying),
    chainId
  };
}

/** The registered faucet whose origin is native ETH on network 0: it mints bridged ETH and sends its deliveries. */
export function selectNativeEthFaucet(s: BridgeConfigSnapshot): string | null {
  const tokens = okValue(s.derived?.agglayer.tokens) ?? [];
  return tokens.find(token => token.originToken === NATIVE_ETH && token.originNetwork === 0)?.midenFaucetId ?? null;
}

// Read synchronously: each realm hydrates its snapshot at startup, and an entry point stays greyed until its values are
// in it, so code past one only reaches a null through a deep link or a document that changed under it.
function getValue<T>(value: string, select: (s: BridgeConfigSnapshot) => T | null): T {
  const found = select(getBridgeConfigSnapshot());
  if (found === null) throw new BridgeConfigUnavailableError(value);
  return found;
}

export function getEpochAllocatorUrl(): string {
  return getValue('epoch.allocatorUrl', s => s.config?.epoch.allocatorUrl ?? null);
}

export function getEpochPositionsUrl(): string {
  return getValue('epoch.positionsUrl', s => s.config?.epoch.positionsUrl ?? null);
}

export function getEvmChainId(): number {
  return getValue('evm.chainId', selectEvmChainId);
}

export function getMidenUsdc(): MidenUsdc {
  return getValue('Earn collateral faucet', selectMidenUsdc);
}

export function getEvmUsdc(): EvmUsdc {
  return getValue('EVM USDC', selectEvmUsdc);
}

export function getEarnMarket(): EarnMarket {
  return getValue('Earn market', selectEarnMarket);
}

export function getAgglayerMidenBridge(): string {
  return getValue('agglayer.midenBridge', s => s.config?.agglayer.midenBridge ?? null);
}

export function getAgglayerIndexerUrl(): string {
  return getValue('agglayer.indexerUrl', s => s.config?.agglayer.indexerUrl ?? null);
}

export function getAgglayerL1Bridge(): `0x${string}` {
  return getValue('agglayer.l1Bridge', s => s.config?.agglayer.l1Bridge ?? null);
}

/** What a bridge-out note carries: the Miden bridge it targets and the L1 bridge's networkID() as its destination. */
export function getAgglayerBridgeOut(): { midenBridge: string; evmNetworkId: number } {
  return getValue('Agglayer bridge-out values', s => {
    const midenBridge = s.config?.agglayer.midenBridge;
    const evmNetworkId = okValue(s.derived?.agglayer.evmNetworkId);
    return midenBridge && evmNetworkId !== null ? { midenBridge, evmNetworkId } : null;
  });
}

/** What an L1 deposit calls: the L1 bridge, with the Miden rollup id as the destination network. */
export function getAgglayerDeposit(): { l1Bridge: `0x${string}`; rollupId: number } {
  return getValue('Agglayer deposit values', s => {
    const l1Bridge = s.config?.agglayer.l1Bridge;
    const rollupId = okValue(s.derived?.agglayer.rollupId);
    return l1Bridge && rollupId !== null ? { l1Bridge, rollupId } : null;
  });
}
