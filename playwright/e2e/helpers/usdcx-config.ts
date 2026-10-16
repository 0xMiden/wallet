import type { Address } from 'viem';

import document from '../../../src/lib/remote-config/testing/testnet.json';
import type { UsdcxEvmDestination, UsdcxXReserveSource } from '../../../src/lib/usdcx/constant';
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
export const USDCX_DESTINATIONS: ReadonlyMap<number, UsdcxEvmDestination> = new Map<number, UsdcxEvmDestination>(
  Object.values(document.supportedEvmChains).flatMap<[number, UsdcxEvmDestination]>(entry => {
    const chain = EVM_CHAIN_DEFINITIONS.find(chain => chain.id === entry.chainId);
    return chain
      ? [
          [
            entry.chainId,
            {
              family: 'evm',
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
