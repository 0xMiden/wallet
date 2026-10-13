import { Address, Chain, getAddress } from 'viem';
import { arbitrum, arbitrumSepolia, arc, base, baseSepolia, mainnet, sepolia } from 'viem/chains';

import {
  isUsdcxDepositSource,
  type UsdcxChainConfig,
  type UsdcxConfig,
  usdcxExecutorChain
} from 'lib/remote-config/schema';
import { ARC_TESTNET } from 'lib/walletconnect/config';

/** What every source chain shares: the USDC burned or deposited there, and Circle's domain of the chain. */
interface UsdcxSourceChainBase {
  chain: Chain;
  usdc: Address;
  /** Circle's domain of the source chain. */
  domain: number;
}

/** A source with a local xReserve: the deposit is one `depositToRemote` on the source chain. */
export interface UsdcxXReserveSource extends UsdcxSourceChainBase {
  route: 'xreserve';
  xReserve: Address;
  /** The attestation service that signs deposits made on this chain. */
  attestationApi: string;
  /** Circle's remote-domain id for Miden, the deposit's `remoteDomain`. */
  midenDomain: number;
}

/**
 * The Arc side of an executor route: the CCTP message mints to Circle's Generic Executor on Arc, whose
 * DepositFor handler deposits into Arc's xReserve for Miden. The attestation for the xReserve deposit is
 * keyed by the Arc transaction that executed the message.
 */
export interface UsdcxExecutorTarget {
  chain: Chain;
  domain: number;
  executor: Address;
  handler: Address;
  xReserve: Address;
  usdc: Address;
  attestationApi: string;
  irisApi: string;
  /** Circle's remote-domain id for Miden, the `remoteDomain` of the deposit the handler makes. */
  midenDomain: number;
}

/**
 * A source with CCTP only (Base, Arbitrum): the deposit is a CCTP burn to the executor on Arc carrying the
 * xReserve deposit as hook data. With a signed fee quote the burn goes through the fee entry point and
 * Circle's forwarder executes it on Arc; without one it goes through the plain token messenger and the
 * wallet asks the connected EVM wallet to execute the attested message on Arc itself.
 */
export interface UsdcxExecutorSource extends UsdcxSourceChainBase {
  route: 'cctp-executor';
  /** The plain `TokenMessengerV2`, for a burn the wallet executes itself. */
  tokenMessenger: Address;
  /** `TokenMessengerWithFees`, for a burn with a signed quote that Circle forwards and executes. */
  tokenMessengerWithFees: Address;
  /** Circle's Iris API, which attests the CCTP leg. */
  irisApi: string;
  target: UsdcxExecutorTarget;
}

/** A chain a USDCx bridge-in can start from, on one of the two routes. */
export type UsdcxSourceChain = UsdcxXReserveSource | UsdcxExecutorSource;

/** A chain a USDCx burn can pay out to: a direct-payout domain of Circle's withdrawal API. */
export interface UsdcxDestination {
  chain: Chain;
  /** The domain word of the burn note's withdrawal attachment. */
  domain: number;
  /** The USDC the recipient's balance is read from, in six-decimal units. */
  usdc: Address;
  /** The most Circle is expected to deduct from a payout on this chain, in six-decimal USDC units. */
  payoutFeeAllowance: bigint;
}

/** The USDCx routes of one network, as its config document lists them. */
export interface UsdcxRoutes {
  /** Circle's remote-domain id for Miden. */
  midenDomain: number;
  /** Circle's xReserve attestation service. */
  attestationApi: string;
  /** Every chain a bridge-in can start from, keyed by EVM chain id, in the document's order. */
  sources: ReadonlyMap<number, UsdcxSourceChain>;
  /** Every chain a burn can pay out to, keyed by EVM chain id, in the document's order. */
  destinations: ReadonlyMap<number, UsdcxDestination>;
}

/**
 * Circle deducts its payout fee from the burned amount. Observed on the sandbox: at most about 0.04 USDC
 * for a direct payout, and a flat fee of about 1 USDC on Ethereum. No Circle API reports the fee of one
 * burn, so arrival is judged against these ceilings.
 */
const USDCX_PAYOUT_FEE_ALLOWANCE = 100_000n;
const USDCX_ETHEREUM_PAYOUT_FEE_ALLOWANCE = 1_500_000n;

/** The viem definitions of the chains a document can list. A chain that is not here has no route. */
const KNOWN_CHAINS: ReadonlyMap<number, Chain> = new Map<number, Chain>(
  [ARC_TESTNET, sepolia, baseSepolia, arbitrumSepolia, arc, mainnet, base, arbitrum].map(chain => [chain.id, chain])
);

function executorTarget(config: UsdcxConfig): UsdcxExecutorTarget | undefined {
  const entry = usdcxExecutorChain(config);
  const chain = entry && KNOWN_CHAINS.get(entry.chainId);
  if (!entry?.executor || entry.deposit?.route !== 'xreserve' || !chain || config.irisUrl === undefined) {
    return undefined;
  }
  return {
    chain,
    domain: entry.domain,
    executor: getAddress(entry.executor.address),
    handler: getAddress(entry.executor.handler),
    xReserve: getAddress(entry.deposit.xReserve),
    usdc: getAddress(entry.usdc),
    attestationApi: config.attestationUrl,
    irisApi: config.irisUrl,
    midenDomain: config.midenDomain
  };
}

function sourceChain(
  config: UsdcxConfig,
  chain: Chain,
  entry: UsdcxChainConfig,
  target: UsdcxExecutorTarget | undefined
): UsdcxSourceChain | undefined {
  if (!isUsdcxDepositSource(config, entry)) return undefined;
  const base = { chain, usdc: getAddress(entry.usdc), domain: entry.domain };
  switch (entry.deposit?.route) {
    case 'xreserve':
      return {
        ...base,
        route: 'xreserve',
        xReserve: getAddress(entry.deposit.xReserve),
        attestationApi: config.attestationUrl,
        midenDomain: config.midenDomain
      };
    case 'executor':
      return (
        target && {
          ...base,
          route: 'cctp-executor',
          tokenMessenger: getAddress(entry.deposit.tokenMessenger),
          tokenMessengerWithFees: getAddress(entry.deposit.tokenMessengerWithFees),
          irisApi: target.irisApi,
          target
        }
      );
    default:
      return undefined;
  }
}

function destination(chain: Chain, entry: UsdcxChainConfig): UsdcxDestination {
  // Ethereum is Circle domain 0 on both network families.
  const payoutFeeAllowance = entry.domain === 0 ? USDCX_ETHEREUM_PAYOUT_FEE_ALLOWANCE : USDCX_PAYOUT_FEE_ALLOWANCE;
  return { chain, domain: entry.domain, usdc: getAddress(entry.usdc), payoutFeeAllowance };
}

/**
 * The routes a document's `usdcx` section gives. Every listed chain is a destination, since all are direct-payout
 * domains and the attester needs no forwarding. A chain with a local xReserve deposits into it; an `executor` chain
 * reaches the xReserve of the executor's chain through Circle's executor, and is a destination only while the
 * document names no executor or no Iris API. Addresses come back checksummed.
 */
export function buildUsdcxRoutes(config: UsdcxConfig): UsdcxRoutes {
  const target = executorTarget(config);
  const sources = new Map<number, UsdcxSourceChain>();
  const destinations = new Map<number, UsdcxDestination>();
  for (const entry of config.chains) {
    const chain = KNOWN_CHAINS.get(entry.chainId);
    if (!chain) continue;
    destinations.set(chain.id, destination(chain, entry));
    const source = sourceChain(config, chain, entry, target);
    if (source) sources.set(chain.id, source);
  }
  return { midenDomain: config.midenDomain, attestationApi: config.attestationUrl, sources, destinations };
}

/** The source chain a bridge-in starts from until the user picks one: the document's first source. */
export function defaultUsdcxSource(routes: UsdcxRoutes | null): UsdcxSourceChain | undefined {
  const [first] = routes ? [...routes.sources.values()] : [];
  return first;
}

/** The destination pre-selected for a USDCx withdrawal: the document's first chain. */
export function defaultUsdcxDestination(routes: UsdcxRoutes | null): UsdcxDestination | undefined {
  const [first] = routes ? [...routes.destinations.values()] : [];
  return first;
}

/**
 * The least USDC a burn of `amount` is expected to pay out on `chainId`: the amount minus the chain's fee allowance.
 * It is not positive when the allowance takes the whole amount. Any unrelated credit meets such a floor, so the wallet
 * refuses that burn (`usdcxPayoutFeeShortfall`) and never confirms an older one by balance.
 */
export function minimumPayout(
  destinations: ReadonlyMap<number, UsdcxDestination>,
  chainId: number,
  amount: bigint
): bigint {
  return amount - (destinations.get(chainId)?.payoutFeeAllowance ?? 0n);
}
