import { getAddress, type Address, type Chain } from 'viem';

import { LOOP_USDC, type MainnetBridgeChain, type UsdcxLoop } from './mainnet-bridge-plan';
import type { L2BridgeInSource, PayoutChain } from './usdcx-constants';
import { evmChainSlug } from '../../../src/lib/remote-config/chains';
import type { UsdcxExecutorSource, UsdcxXReserveSource } from '../../../src/lib/usdcx/constant';
import { EVM_CHAIN_DEFINITIONS } from '../../../src/lib/walletconnect/config';

export const MAINNET_RPCS: Record<number, string> = {
  1: 'https://ethereum.publicnode.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  5042: 'https://rpc.mainnet.arc.io'
};

export const CEDAR_ROLLUP_ID = 30;
export const AGGLAYER_LOOP_WEI = 1_000_000_000_000n;

export interface MainnetUsdcxDocument {
  'bridge-providers': {
    usdcx: { midenDomain: number; attestationUrl: string; irisUrl: string };
    agglayer: { indexerUrl: string };
  };
  supportedEvmChains: Record<
    string,
    MainnetBridgeChain & {
      bridges: MainnetBridgeChain['bridges'] & {
        usdcx?: MainnetBridgeChain['bridges']['usdcx'] & {
          deposit?: {
            route: string;
            xReserve?: string;
            tokenMessengerWithFees?: string;
            executorChain?: string;
          };
          executor?: { address: string; handler: string };
          tokens: { USDC: { contractAddress: string } };
        };
        agglayer?: { contractAddress: string };
      };
    }
  >;
}

export function mainnetRpc(chainId: number): string {
  const rpc = MAINNET_RPCS[chainId];
  if (!rpc) throw new Error(`chain ${chainId} has no mainnet rpc`);
  return rpc;
}

export function mainnetChain(chainId: number): Chain {
  const chain = EVM_CHAIN_DEFINITIONS.find(item => item.id === chainId);
  if (!chain) throw new Error(`chain ${chainId} is not in the wallet`);
  return chain;
}

function payout(chainId: number, usdc: Address, domain: number): PayoutChain {
  const chain = mainnetChain(chainId);
  const slug = evmChainSlug(chainId);
  const rpc = mainnetRpc(chainId);
  if (!slug || !rpc) throw new Error(`chain ${chainId} has no mainnet payout endpoint`);
  return {
    chainId,
    chain,
    label: chain.name,
    rpcUrls: [rpc],
    usdc,
    burnDomain: domain,
    attestationSourceDomain: 26,
    logChunk: () => 100,
    reviewNetwork: slug,
    networkName: chain.name,
    explorer: chain.blockExplorers?.default.url ?? '',
    walletRpcUrl: rpc,
    walletRpcName: chain.name,
    burnUnits: LOOP_USDC
  };
}

export function xreserveSource(doc: MainnetUsdcxDocument, loop: UsdcxLoop): UsdcxXReserveSource {
  const entry = Object.values(doc.supportedEvmChains).find(chain => chain.chainId === loop.chainId);
  const route = entry?.bridges.usdcx;
  const deposit = route?.deposit;
  if (!entry || !route || deposit?.route !== 'xreserve' || !deposit.xReserve) {
    throw new Error(`${loop.name} is not an xReserve source`);
  }
  return {
    route: 'xreserve',
    chain: mainnetChain(loop.chainId),
    usdc: getAddress(route.tokens.USDC.contractAddress),
    domain: route.domain,
    midenDomain: doc['bridge-providers'].usdcx.midenDomain,
    xReserve: getAddress(deposit.xReserve),
    attestationApi: doc['bridge-providers'].usdcx.attestationUrl
  };
}

export function executorSource(doc: MainnetUsdcxDocument, loop: UsdcxLoop): L2BridgeInSource {
  const entry = Object.values(doc.supportedEvmChains).find(chain => chain.chainId === loop.chainId);
  const route = entry?.bridges.usdcx;
  const deposit = route?.deposit;
  const arc = doc.supportedEvmChains.arc?.bridges.usdcx;
  if (
    !entry ||
    !route ||
    !deposit ||
    deposit.route !== 'executor' ||
    !deposit.tokenMessengerWithFees ||
    !arc?.executor
  ) {
    throw new Error(`${loop.name} is not an executor source`);
  }
  const usdc = getAddress(route.tokens.USDC.contractAddress);
  const source: UsdcxExecutorSource = {
    route: 'cctp-executor',
    chain: mainnetChain(loop.chainId),
    usdc,
    domain: route.domain,
    midenDomain: doc['bridge-providers'].usdcx.midenDomain,
    tokenMessengerWithFees: getAddress(deposit.tokenMessengerWithFees),
    irisApi: doc['bridge-providers'].usdcx.irisUrl,
    target: {
      midenDomain: doc['bridge-providers'].usdcx.midenDomain,
      chain: mainnetChain(5042),
      domain: arc.domain,
      executor: getAddress(arc.executor.address),
      handler: getAddress(arc.executor.handler),
      xReserve: getAddress(arc.deposit?.xReserve ?? ''),
      usdc: getAddress(arc.tokens.USDC.contractAddress),
      attestationApi: doc['bridge-providers'].usdcx.attestationUrl,
      irisApi: doc['bridge-providers'].usdcx.irisUrl
    }
  };
  return { payout: payout(loop.chainId, usdc, route.domain), source };
}
