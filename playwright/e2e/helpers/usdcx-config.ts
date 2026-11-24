import type { Address } from 'viem';

import document from '../../../src/lib/remote-config/testing/testnet.json';
import type { UsdcxDestination, UsdcxExecutorSource, UsdcxXReserveSource } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET, EVM_CHAIN_DEFINITIONS } from '../../../src/lib/walletconnect/config';

const provider = document['bridge-providers'].usdcx;
const arc = document.supportedEvmChains['arc-testnet'].bridges.usdcx;
const sepolia = document.supportedEvmChains.sepolia.bridges.usdcx;
const address = (value: string): Address => `0x${value.slice(2)}`;

export const USDCX_REMOTE_DOMAIN = provider.midenDomain;
export const CIRCLE_USDC_ADDRESS = new Map<number, Address>(
  Object.values(document.supportedEvmChains).map(entry => [
    entry.chainId,
    address(entry.bridges.usdcx.tokens.USDC.contractAddress)
  ])
);
export const XRESERVE_ADDRESS = new Map<number, Address>([
  [ARC_TESTNET.id, address(arc.deposit.xReserve)],
  [11155111, address(arc.deposit.xReserve)]
]);
export const USDCX_DESTINATIONS: ReadonlyMap<number, UsdcxDestination> = new Map(
  Object.values(document.supportedEvmChains).flatMap(entry => {
    const chain = EVM_CHAIN_DEFINITIONS.find(chain => chain.id === entry.chainId);
    return chain
      ? [
          [
            entry.chainId,
            {
              chain,
              usdc: address(entry.bridges.usdcx.tokens.USDC.contractAddress),
              domain: entry.bridges.usdcx.domain,
              payoutFeeAllowance: entry.bridges.usdcx.domain === 0 ? 1_500_000n : 100_000n
            }
          ]
        ]
      : [];
  })
);
export function getUsdcxXReserveSource(chainId: number): UsdcxXReserveSource {
  const chain = EVM_CHAIN_DEFINITIONS.find(chain => chain.id === chainId);
  const route = chainId === 11155111 ? sepolia : arc;
  if (!chain) throw new Error('The harness chain is not configured');
  return {
    route: 'xreserve',
    chain,
    usdc: address(route.tokens.USDC.contractAddress),
    domain: route.domain,
    xReserve: address(arc.deposit.xReserve),
    attestationApi: provider.attestationUrl
  };
}

/** The payout floor used by the E2E oracle for its configured destination. */
export function minimumUsdcxPayout(chainId: number, amount: bigint): bigint {
  return amount - (USDCX_DESTINATIONS.get(chainId)?.payoutFeeAllowance ?? 0n);
}

/** The executor route the fixture names for `chainId`, built as the wallet's usdcxSourceChains builds it. */
export function getUsdcxExecutorSource(chainId: number): UsdcxExecutorSource {
  const chain = EVM_CHAIN_DEFINITIONS.find(candidate => candidate.id === chainId);
  const route = Object.values(document.supportedEvmChains).find(entry => entry.chainId === chainId)?.bridges.usdcx;
  const deposit = route?.deposit;
  if (!chain || !route || !deposit || !('tokenMessengerWithFees' in deposit)) {
    throw new Error(`chain ${chainId} is no executor source in the testnet fixture`);
  }
  return {
    route: 'cctp-executor',
    chain,
    usdc: address(route.tokens.USDC.contractAddress),
    domain: route.domain,
    midenDomain: provider.midenDomain,
    tokenMessengerWithFees: address(deposit.tokenMessengerWithFees),
    irisApi: provider.irisUrl,
    target: {
      midenDomain: provider.midenDomain,
      chain: ARC_TESTNET,
      domain: arc.domain,
      executor: address(arc.executor.address),
      handler: address(arc.executor.handler),
      xReserve: address(arc.deposit.xReserve),
      usdc: address(arc.tokens.USDC.contractAddress),
      attestationApi: provider.attestationUrl,
      irisApi: provider.irisUrl
    }
  };
}
