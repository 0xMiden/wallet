import {
  BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL
} from 'lib/epoch/bridgeable-token';
import type { BridgeRoute } from 'screens/send-flow/types';

/** Assets the derived deposit address accepts on Sepolia. */
export type DepositTokenId = 'ETH' | 'USDC';

export interface DepositTokenConfig {
  id: DepositTokenId;
  symbol: string;
  decimals: number;
  /** ERC-20 contract; `undefined` marks the native asset. */
  address?: string;
  /** The only route that can bridge this token today. */
  route: BridgeRoute;
  /**
   * Miden faucet the bridged asset credits. Empty for AggLayer ETH — the native
   * faucet is learned on delivery (the WC deposit path records `''` too).
   */
  midenFaucetId: string;
  /**
   * Balances/deltas below this are ignored: they are rounding residue or gas
   * dust, never a deposit worth prompting about.
   */
  dustFloor: bigint;
}

/** Miden-side faucet the Epoch route credits for USDC deposits. */
export const MIDEN_USDC_FAUCET_ID = '0x2458e5446128e6b150b75b8ebd9ce1';

export const ETH_SYMBOL = 'ETH';
export const ETH_DECIMALS = 18;

const ETH_CONFIG: DepositTokenConfig = {
  id: 'ETH',
  symbol: ETH_SYMBOL,
  decimals: ETH_DECIMALS,
  route: 'agglayer',
  midenFaucetId: '',
  dustFloor: 100_000_000_000_000n // 1e14 wei
};

const USDC_CONFIG: DepositTokenConfig = {
  id: 'USDC',
  symbol: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL,
  // Epoch's mock USDC uses the 18-decimal convention, NOT the 6 of real USDC.
  decimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
  address: BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
  route: 'epoch',
  midenFaucetId: MIDEN_USDC_FAUCET_ID,
  dustFloor: 10_000_000_000_000_000n // 1e16 (0.01 at 18 decimals)
};

export const DEPOSIT_TOKENS: Record<DepositTokenId, DepositTokenConfig> = {
  ETH: ETH_CONFIG,
  USDC: USDC_CONFIG
};

export const DEPOSIT_TOKEN_IDS: readonly DepositTokenId[] = ['ETH', 'USDC'];

export function getDepositToken(id: DepositTokenId): DepositTokenConfig {
  return DEPOSIT_TOKENS[id];
}

export function isDepositTokenId(value: unknown): value is DepositTokenId {
  return value === 'ETH' || value === 'USDC';
}

/**
 * Routes a deposited token can take. USDC is Epoch-only (gasless; AggLayer USDC
 * needs a relayer that hasn't shipped) and ETH is AggLayer-only (Epoch's fast
 * route would have to wrap to WETH).
 */
export function availableRoutes(id: DepositTokenId): BridgeRoute[] {
  return [DEPOSIT_TOKENS[id].route];
}
