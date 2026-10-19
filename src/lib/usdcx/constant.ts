import { Address, Chain, formatUnits, getAddress } from 'viem';
import { arc, mainnet, sepolia } from 'viem/chains';

import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { SupportedEvmChainConfig } from 'lib/remote-config/schema';
import { walletRaised } from 'lib/telemetry/bridge-receive-failure';
import { ARC_TESTNET, copyPlainData, EVM_CHAIN_DEFINITIONS, getChain } from 'lib/walletconnect/config';

import { USDCX_DECIMALS } from './protocol';

export * from './protocol';

// E2E-only: an E2E build with MIDEN_E2E_USDCX_CHAIN=sepolia opens a USDCx bridge-in on Sepolia through its
// xReserve, the route a local Anvil fork of Sepolia can run (Arc's USDC calls chain precompiles that Anvil does
// not have). No CI suite sets it. Inert in production: the flag is baked in only by the e2e build, and only when
// `MIDEN_E2E_TEST` is also on.
const E2E_USDCX_CHAIN = process.env.MIDEN_E2E_TEST === 'true' ? (process.env.MIDEN_E2E_USDCX_CHAIN ?? '').trim() : '';

/** What every source chain shares: the USDC burned or deposited there, and Circle's domain of the chain. */
interface UsdcxSourceChainBase {
  midenDomain?: number;
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
}

/**
 * The Arc side of an executor route: the CCTP message mints to Circle's Generic Executor on Arc, whose
 * DepositFor handler deposits into Arc's xReserve for Miden. The attestation for the xReserve deposit is
 * keyed by the Arc transaction that executed the message.
 */
export interface UsdcxExecutorTarget {
  midenDomain?: number;
  chain: Chain;
  domain: number;
  executor: Address;
  handler: Address;
  xReserve: Address;
  usdc: Address;
  attestationApi: string;
  irisApi: string;
}

/**
 * A source with CCTP only (Base, Arbitrum): the deposit is a CCTP burn to the executor on Arc carrying the
 * xReserve deposit as hook data. The burn goes through the fee entry point with a signed fee quote and
 * Circle's forwarder executes it on Arc; without a quote the deposit is refused, since a burn through the
 * plain token messenger is not forwarded and would stop at the executor.
 */
export interface UsdcxExecutorSource extends UsdcxSourceChainBase {
  route: 'cctp-executor';
  /** `TokenMessengerWithFees`, for a burn with a signed quote that Circle forwards and executes. */
  tokenMessengerWithFees: Address;
  /** Circle's Iris API for this network family, which attests the CCTP leg. */
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

/**
 * Circle deducts its payout fee from the burned amount. Observed on the sandbox: at most about 0.04 USDC
 * for a direct payout, and a flat fee of about 1 USDC on Ethereum. No Circle API reports the fee of one
 * burn, so arrival is judged against these ceilings.
 */
const USDCX_PAYOUT_FEE_ALLOWANCE = 100_000n;
const USDCX_ETHEREUM_PAYOUT_FEE_ALLOWANCE = 1_500_000n;

function configuredChain(chainId: number): Chain | undefined {
  const chain = EVM_CHAIN_DEFINITIONS.find(chain => chain.id === chainId);
  const rpcUrl = getChain(chainId)?.rpcUrl;
  if (!chain || !rpcUrl) return undefined;
  // A route is stored on its bridge row, so it shares no object with the chain definition other code holds.
  return {
    id: chain.id,
    name: chain.name,
    nativeCurrency: copyPlainData(chain.nativeCurrency),
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: copyPlainData(chain.blockExplorers),
    testnet: chain.testnet
  };
}

/** A chain is usable only inside the effective network's family: testnet chains on testnet, mainnet chains otherwise. */
function inEffectiveFamily(chain: Chain): boolean {
  return (chain.testnet ?? false) === (getEffectiveNetworkName() !== 'mainnet');
}

function sourceChain(entry: SupportedEvmChainConfig): UsdcxSourceChain | undefined {
  const config = getBridgeConfigSnapshot().config;
  const provider = config?.['bridge-providers'].usdcx;
  const route = entry.bridges.usdcx;
  const chain = configuredChain(entry.chainId);
  const tokenAddress = route?.tokens.USDC?.contractAddress;
  const usdc = tokenAddress ? getAddress(tokenAddress) : undefined;
  if (!config || !provider?.attestationUrl || !provider.irisUrl || !route || !chain || !usdc || !route.deposit)
    return undefined;
  if (!inEffectiveFamily(chain)) return undefined;
  const base = { chain, usdc, domain: route.domain, midenDomain: provider.midenDomain };
  switch (route.deposit.route) {
    case 'xreserve':
      return {
        ...base,
        route: 'xreserve',
        xReserve: getAddress(route.deposit.xReserve),
        attestationApi: provider.attestationUrl
      };
    case 'executor': {
      const targetConfig = config.supportedEvmChains[route.deposit.executorChain];
      const targetRoute = targetConfig?.bridges.usdcx;
      const targetChain = targetConfig ? configuredChain(targetConfig.chainId) : undefined;
      const targetUsdc = targetRoute?.tokens.USDC?.contractAddress;
      if (!targetChain || !targetRoute?.executor || targetRoute.deposit?.route !== 'xreserve' || !targetUsdc)
        return undefined;
      if (!inEffectiveFamily(targetChain)) return undefined;
      return {
        ...base,
        route: 'cctp-executor',
        tokenMessengerWithFees: getAddress(route.deposit.tokenMessengerWithFees),
        irisApi: provider.irisUrl,
        target: {
          midenDomain: provider.midenDomain,
          chain: targetChain,
          domain: targetRoute.domain,
          executor: getAddress(targetRoute.executor.address),
          handler: getAddress(targetRoute.executor.handler),
          xReserve: getAddress(targetRoute.deposit.xReserve),
          usdc: getAddress(targetUsdc),
          attestationApi: provider.attestationUrl,
          irisApi: provider.irisUrl
        }
      };
    }
  }
}

function destination(entry: SupportedEvmChainConfig): UsdcxDestination | undefined {
  const route = entry.bridges.usdcx;
  const chain = configuredChain(entry.chainId);
  const tokenAddress = route?.tokens.USDC?.contractAddress;
  const usdc = tokenAddress ? getAddress(tokenAddress) : undefined;
  if (!route || !chain || !usdc || !inEffectiveFamily(chain)) return undefined;
  return {
    chain,
    domain: route.domain,
    usdc,
    payoutFeeAllowance: route.domain === 0 ? USDCX_ETHEREUM_PAYOUT_FEE_ALLOWANCE : USDCX_PAYOUT_FEE_ALLOWANCE
  };
}

export function usdcxSourceChains(snapshot = getBridgeConfigSnapshot()): ReadonlyMap<number, UsdcxSourceChain> {
  const sources = new Map<number, UsdcxSourceChain>();
  for (const entry of Object.values(snapshot.config?.supportedEvmChains ?? {})) {
    const source = sourceChain(entry);
    if (source) sources.set(entry.chainId, source);
  }
  return sources;
}

export function usdcxDestinations(): ReadonlyMap<number, UsdcxDestination> {
  const destinations = new Map<number, UsdcxDestination>();
  for (const entry of Object.values(getBridgeConfigSnapshot().config?.supportedEvmChains ?? {})) {
    const target = destination(entry);
    if (target) destinations.set(entry.chainId, target);
  }
  return destinations;
}

/**
 * The least USDC a burn of `amount` is expected to pay out on `chainId`: the amount minus the chain's fee allowance.
 * It is not positive when the allowance takes the whole amount. Any unrelated credit meets such a floor, so the wallet
 * refuses that burn (`usdcxPayoutFeeShortfall`) and never confirms an older one by balance.
 */
export function minimumUsdcxPayout(chainId: number, amount: bigint): bigint {
  return amount - (usdcxDestinations().get(chainId)?.payoutFeeAllowance ?? 0n);
}

/**
 * The fee allowance a burn of `amount` to `chainId` fails to exceed, in USDCx, and the chain's name, as the refusal
 * names them; undefined once the amount exceeds it, and for no amount or an unknown chain, which other checks refuse.
 */
export function usdcxPayoutFeeShortfall(
  chainId: number,
  amount: bigint
): { amount: string; network: string } | undefined {
  const destination = usdcxDestinations().get(chainId);
  if (!destination || amount <= 0n || minimumUsdcxPayout(chainId, amount) > 0n) return undefined;
  return { amount: formatUnits(destination.payoutFeeAllowance, USDCX_DECIMALS), network: destination.chain.name };
}

/**
 * The i18n key of a USDCx deposit's arrival time for its source chain: Arc (testnet or mainnet) reads ~1 min, every
 * other source ~20 min. On Arc, Circle attests the deposit in seconds and the relayer mints within a minute.
 */
export function usdcxArrivalKey(sourceChainId: number): 'usdcxArrivalArc' | 'usdcxArrival' {
  return sourceChainId === ARC_TESTNET.id || sourceChainId === arc.id ? 'usdcxArrivalArc' : 'usdcxArrival';
}

/**
 * The EVM chain the USDCx surfaces open on, per Miden network, keyed as `MIDEN_NETWORK_ENDPOINTS` keys the RPCs:
 * Ethereum on mainnet, Arc Testnet on the test networks.
 */
export const DEFAULT_USDCX_CHAIN_IDS = new Map<string, number>([
  [MIDEN_NETWORK_NAME.MAINNET, mainnet.id],
  [MIDEN_NETWORK_NAME.TESTNET, ARC_TESTNET.id],
  [MIDEN_NETWORK_NAME.DEVNET, ARC_TESTNET.id],
  [MIDEN_NETWORK_NAME.LOCALNET, ARC_TESTNET.id]
]);

/**
 * The chain a USDCx bridge-in opens on and a withdrawal pre-selects, for the effective network: Sepolia when an E2E
 * build asks for it (MIDEN_E2E_USDCX_CHAIN), else the network's entry above. A caller falls through to the document's first
 * chain when the document does not list this one.
 */
export function defaultUsdcxChainId(): number {
  if (E2E_USDCX_CHAIN === 'sepolia') return sepolia.id;
  return DEFAULT_USDCX_CHAIN_IDS.get(getEffectiveNetworkName()) ?? ARC_TESTNET.id;
}

export function getUsdcxSourceChain(chainId: number): UsdcxSourceChain {
  const source = usdcxSourceChains().get(chainId);
  if (!source) throw new Error(`USDCx bridge-in is not configured for chain ${chainId}`);
  return source;
}

/** The source entry of a chain with a local xReserve; throws for an executor source or an unknown chain. */
export function getUsdcxXReserveSource(chainId: number): UsdcxXReserveSource {
  const source = getUsdcxSourceChain(chainId);
  if (source.route !== 'xreserve') throw new Error(`USDCx chain ${chainId} has no local xReserve`);
  return source;
}

/** The source entry of a chain that reaches Arc's xReserve through the executor; throws otherwise. */
export function getUsdcxExecutorSource(chainId: number): UsdcxExecutorSource {
  const source = getUsdcxSourceChain(chainId);
  if (source.route !== 'cctp-executor') throw new Error(`USDCx chain ${chainId} is not an executor source`);
  return source;
}

/** Whether `chainId` deposits through Circle's executor on Arc. Unknown chains read as false. */
export function isUsdcxExecutorSource(chainId: number | undefined): boolean {
  return chainId !== undefined && usdcxSourceChains().get(chainId)?.route === 'cctp-executor';
}

export function getUsdcxDestination(chainId: number): UsdcxDestination {
  const entry = usdcxDestinations().get(chainId);
  if (!entry) throw new Error(`USDCx withdrawal is not configured for chain ${chainId}`);
  return entry;
}

/** The source chains offered on the effective network's family: testnet chains on testnet, mainnet chains otherwise. */
export function listUsdcxSourceChains(): UsdcxSourceChain[] {
  return [...usdcxSourceChains().values()].filter(entry => isUsdcxRouteEnabled(entry.chain.id, 'deposit'));
}

/** The destinations offered on the effective network's family: testnet chains on testnet, mainnet chains otherwise. */
export function listUsdcxDestinations(): UsdcxDestination[] {
  return [...usdcxDestinations().values()].filter(entry => isUsdcxRouteEnabled(entry.chain.id, 'withdrawal'));
}

/**
 * Circle's remote-domain id for Miden. Circle assigned 10007 for testnet and
 * mainnet. A deposit to an unregistered domain reverts with `RemoteDomainNotRegistered`.
 */
export function getUsdcxRemoteDomain(): number {
  const domain = getBridgeConfigSnapshot().config?.['bridge-providers'].usdcx.midenDomain;
  if (domain === undefined) throw walletRaised(new Error('USDCx Miden domain is not configured'));
  return domain;
}

export function getUsdcxAttestationUrl(): string {
  const url = getBridgeConfigSnapshot().config?.['bridge-providers'].usdcx.attestationUrl;
  if (!url) throw new Error('USDCx attestation service is not configured');
  return url;
}

export function isUsdcxRouteEnabled(chainId: number, direction: 'deposit' | 'withdrawal'): boolean {
  const entry = Object.values(getBridgeConfigSnapshot().config?.supportedEvmChains ?? {}).find(
    chain => chain.chainId === chainId
  );
  switch (direction) {
    case 'deposit':
      return entry?.bridges.usdcx?.depositEnabled === true;
    case 'withdrawal':
      return entry?.bridges.usdcx?.withdrawalEnabled === true;
  }
}
