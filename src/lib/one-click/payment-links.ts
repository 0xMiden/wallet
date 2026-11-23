import { formatUnits } from 'viem';

import type { IOneClickTrackingData } from 'lib/miden/db/types';

import { isValidNearIntentsAddress } from './address';

export type PaymentWalletId = 'trust' | 'metamask' | 'rainbow' | 'phantom';

export interface WalletPaymentLink {
  wallet: PaymentWalletId;
  url: string;
}

interface EvmPaymentChain {
  chainId: number;
  trustCoin: number;
}

// Trust coin IDs are not EVM chain IDs. See trustwallet/wallet-core/registry.json.
function evmChain(blockchain: string): EvmPaymentChain | undefined {
  switch (blockchain) {
    case 'eth':
      return { chainId: 1, trustCoin: 60 };
    case 'base':
      return { chainId: 8453, trustCoin: 8453 };
    case 'arb':
      return { chainId: 42161, trustCoin: 10042221 };
    case 'op':
      return { chainId: 10, trustCoin: 10000070 };
    default:
      return undefined;
  }
}

function trustLink(asset: string, address: string, amount: string, memo?: string): WalletPaymentLink {
  const query = new URLSearchParams({ asset, address, amount });
  if (memo) query.set('memo', memo);
  return { wallet: 'trust', url: `trust://send?${query}` };
}

/** Build payment URLs only for known source chains. Amounts come from the saved quote in base units. */
export function depositPaymentLinks(tracking: IOneClickTrackingData, now = Date.now()): WalletPaymentLink[] {
  if (tracking.network !== 'mainnet') return [];
  if (tracking.phase !== 'depositing' && tracking.phase !== 'pending-deposit') return [];
  const deadline = Date.parse(tracking.fundingDeadline ?? tracking.quote.quote.deadline ?? tracking.request.deadline);
  if (!Number.isFinite(deadline) || deadline <= now) return [];
  const address = tracking.depositAddress;
  const units = tracking.quote.quote.amountIn;
  const origin = tracking.originAsset;
  if (!address || !/^[0-9]{1,78}$/.test(units) || BigInt(units) <= 0n) return [];
  if (!Number.isInteger(origin.decimals) || origin.decimals < 0 || origin.decimals > 38) return [];
  const amount = formatUnits(BigInt(units), origin.decimals);
  const memo = tracking.depositMemo;
  const token = origin.contractAddress;
  const chain = evmChain(origin.blockchain);
  if (chain) {
    if (!isValidNearIntentsAddress('evm', address)) return [];
    if (origin.chainId !== undefined && origin.chainId !== chain.chainId) return [];
    if (token !== undefined && !isValidNearIntentsAddress('evm', token)) return [];
    // An asset with no contract must be the native coin, not a token with missing metadata.
    if (token === undefined && (origin.symbol !== 'ETH' || origin.decimals !== 18)) return [];
    const trust = trustLink(token ? `c${chain.trustCoin}_t${token}` : `c${chain.trustCoin}`, address, amount, memo);
    if (memo) return [trust];
    const path = token
      ? `${token}@${chain.chainId}/transfer?${new URLSearchParams({ address, uint256: units })}`
      : `${address}@${chain.chainId}?${new URLSearchParams({ value: units })}`;
    return [
      trust,
      { wallet: 'metamask', url: `metamask://send/${path}` },
      { wallet: 'rainbow', url: `ethereum:${path}` }
    ];
  }
  switch (origin.blockchain) {
    case 'btc':
      if (token !== undefined || origin.symbol !== 'BTC' || origin.decimals !== 8 || memo) return [];
      return isValidNearIntentsAddress('bitcoin', address) ? [trustLink('c0', address, amount)] : [];
    case 'sol': {
      if (!isValidNearIntentsAddress('solana', address)) return [];
      if (token !== undefined && !isValidNearIntentsAddress('solana', token)) return [];
      if (token === undefined && (origin.symbol !== 'SOL' || origin.decimals !== 9)) return [];
      const query = new URLSearchParams({ amount });
      if (token) query.set('spl-token', token);
      if (memo) query.set('memo', memo);
      return [
        trustLink(token ? `c501_t${token}` : 'c501', address, amount, memo),
        { wallet: 'phantom', url: `solana:${address}?${query}` }
      ];
    }
    case 'near':
      if (token !== undefined || origin.symbol !== 'NEAR' || origin.decimals !== 24) return [];
      return isValidNearIntentsAddress('near', address) ? [trustLink('c397', address, amount, memo)] : [];
    default:
      return [];
  }
}
