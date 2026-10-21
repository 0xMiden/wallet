import { USDCX_MIN_BURN } from '../../../src/lib/usdcx/protocol';

/** Same budget as `L2_BRIDGE_IN_GAS`: one approve plus one forwarded burn. */
const DEPOSIT_GAS = 1_100_000n;

/** The burn minimum. The deposit sends this and the burn sends it back, so only fees leave the address. */
export const LOOP_USDC = USDCX_MIN_BURN;
/** The approve covers twice the quoted forward fee, matching the L2 deposit helper. */
export const FORWARD_FEE_MULTIPLE = 2n;
export const NIGHTS = 2n;
/** Two AggLayer transactions: claim on Ethereum, then bridge the same amount back. */
export const AGGLAYER_TXS_PER_NIGHT = 2n;
export const AGGLAYER_TX_GAS = 600_000n;

export const ETHEREUM_PAYOUT_ALLOWANCE = 1_500_000n;
export const DIRECT_PAYOUT_ALLOWANCE = 100_000n;
/** The wallet's own cap: a transaction costs at most 30 base fees. Observed ones land near 17. */
export const TX_FEE_MULTIPLE = 30n;
/** A measured mainnet USDCx burn was 36 base fees. The wallet adds 25% headroom. */
export const BURN_FEE_MULTIPLE = 45n;

const CHAIN_NAMES: Record<number, string> = { 5042: 'arc', 1: 'ethereum', 8453: 'base', 42161: 'arbitrum' };
const CHAIN_ORDER = [5042, 8453, 42161, 1];

export type UsdcxRouteKind = 'xreserve' | 'executor';

export interface UsdcxLoop {
  kind: 'usdcx';
  name: string;
  chainId: number;
  route: UsdcxRouteKind;
  /** Circle domain. Ethereum is 0 and carries the larger payout allowance. */
  domain: number;
}

export interface AgglayerLoop {
  kind: 'agglayer';
  name: 'ethereum';
  chainId: 1;
}

export type BridgeLoop = UsdcxLoop | AgglayerLoop;

export interface MainnetBridgeChain {
  chainId: number;
  bridges: {
    agglayer?: { contractAddress?: string };
    usdcx?: {
      domain: number;
      deposit?: { route: string };
      depositEnabled?: boolean;
      withdrawalEnabled?: boolean;
    };
  };
}

/** USDC that must sit on the chain before any send: one deposit, and tomorrow's deposit after tonight's fees. */
export function usdcReserve(quotedForwardFee: bigint, payoutAllowance: bigint): bigint {
  const deposit = LOOP_USDC + FORWARD_FEE_MULTIPLE * quotedForwardFee;
  const consumed = quotedForwardFee + payoutAllowance;
  return deposit + consumed;
}

/** Native base units for two nights. Burns cost more than an ordinary transaction. */
export function midenFeeReserve(baseFee: bigint, burns: bigint, otherTxs: bigint): bigint {
  return NIGHTS * (burns * BURN_FEE_MULTIPLE + otherTxs * TX_FEE_MULTIPLE) * baseFee;
}

export function payoutAllowance(domain: number): bigint {
  return domain === 0 ? ETHEREUM_PAYOUT_ALLOWANCE : DIRECT_PAYOUT_ALLOWANCE;
}

/** Native gas (wei, or Arc's 18-decimal USDC) for two nights of one deposit. */
export function depositGasReserve(maxFeePerGas: bigint): bigint {
  return NIGHTS * DEPOSIT_GAS * maxFeePerGas;
}

/** ETH for two nights of an AggLayer claim and the bridge back. */
export function agglayerGasReserve(maxFeePerGas: bigint): bigint {
  return NIGHTS * AGGLAYER_TXS_PER_NIGHT * AGGLAYER_TX_GAS * maxFeePerGas;
}

export function usdcxShortfall(args: {
  name: string;
  address: string;
  usdc: bigint;
  quotedForwardFee: bigint;
  domain: number;
  native: bigint;
  maxFeePerGas: bigint;
}): string | undefined {
  const needUsdc = usdcReserve(args.quotedForwardFee, payoutAllowance(args.domain));
  if (args.usdc < needUsdc) {
    return `${args.name} ${args.address} holds ${args.usdc} USDC base units, short of ${needUsdc} for two nights`;
  }
  const needNative = depositGasReserve(args.maxFeePerGas);
  if (args.native < needNative) {
    return `${args.name} ${args.address} holds ${args.native} native units, short of ${needNative} gas for two nights`;
  }
  return undefined;
}

export function agglayerShortfall(args: { address: string; wei: bigint; maxFeePerGas: bigint }): string | undefined {
  const need = agglayerGasReserve(args.maxFeePerGas);
  if (args.wei < need) {
    return `ethereum ${args.address} holds ${args.wei} wei, short of ${need} for two AggLayer nights`;
  }
  return undefined;
}

/** Every funded mainnet route, USDCx first (Arc, then the executor chains), AggLayer last. */
export function bridgeLoops(chains: readonly MainnetBridgeChain[]): BridgeLoop[] {
  const loops: BridgeLoop[] = [];
  const usdcx = chains
    .filter(chain => chain.bridges.usdcx?.depositEnabled !== false && chain.bridges.usdcx?.deposit)
    .map(chain => ({
      kind: 'usdcx' as const,
      name: CHAIN_NAMES[chain.chainId] ?? String(chain.chainId),
      chainId: chain.chainId,
      route: (chain.bridges.usdcx?.deposit?.route === 'xreserve' ? 'xreserve' : 'executor') as UsdcxRouteKind,
      domain: chain.bridges.usdcx?.domain ?? 0
    }));
  usdcx.sort((left, right) => CHAIN_ORDER.indexOf(left.chainId) - CHAIN_ORDER.indexOf(right.chainId));
  loops.push(...usdcx);
  if (chains.some(chain => chain.chainId === 1 && chain.bridges.agglayer?.contractAddress)) {
    loops.push({ kind: 'agglayer', name: 'ethereum', chainId: 1 });
  }
  return loops;
}
