import { formatUnits } from 'viem';

import {
  evmPaymentLinksOf,
  trustCoinOfEvmChain,
  trustPaymentLink,
  type WalletPaymentLink
} from 'lib/evm/payment-links';
import type { IOneClickTrackingData } from 'lib/miden/db/types';

import { isValidNearIntentsRefundAddress, normalizeNearIntentsAddress } from './address';

export type { PaymentWalletId, WalletPaymentLink } from 'lib/evm/payment-links';

interface EvmPaymentChain {
  chainId: number;
  trustCoin: number;
}

/** The EVM chain id of a 1Click blockchain name, with its Trust coin id (`trustCoinOfEvmChain`). */
function evmChain(blockchain: string): EvmPaymentChain | undefined {
  const chainId = evmChainIdOf(blockchain);
  if (chainId === undefined) return undefined;
  const trustCoin = trustCoinOfEvmChain(chainId);
  return trustCoin === undefined ? undefined : { chainId, trustCoin };
}

function evmChainIdOf(blockchain: string): number | undefined {
  switch (blockchain) {
    case 'eth':
      return 1;
    case 'base':
      return 8453;
    case 'arb':
      return 42161;
    case 'op':
      return 10;
    default:
      return undefined;
  }
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
    if (!isValidNearIntentsRefundAddress('evm', address)) return [];
    if (origin.chainId !== undefined && origin.chainId !== chain.chainId) return [];
    if (token !== undefined && !isValidNearIntentsRefundAddress('evm', token)) return [];
    // An asset with no contract must be the native coin, not a token with missing metadata.
    if (token === undefined && (origin.symbol !== 'ETH' || origin.decimals !== 18)) return [];
    return evmPaymentLinksOf({ ...chain, token, to: address, units, amount, memo });
  }
  switch (origin.blockchain) {
    case 'btc': {
      if (token !== undefined || origin.symbol !== 'BTC' || origin.decimals !== 8 || memo) return [];
      const bitcoinAddress = normalizeNearIntentsAddress('bitcoin', address);
      return isValidNearIntentsRefundAddress('bitcoin', bitcoinAddress)
        ? [trustPaymentLink('c0', bitcoinAddress, amount)]
        : [];
    }
    case 'sol': {
      if (!isValidNearIntentsRefundAddress('solana', address)) return [];
      if (token !== undefined && !isValidNearIntentsRefundAddress('solana', token)) return [];
      if (token === undefined && (origin.symbol !== 'SOL' || origin.decimals !== 9)) return [];
      const query = new URLSearchParams({ amount });
      if (token) query.set('spl-token', token);
      if (memo) query.set('memo', memo);
      return [
        trustPaymentLink(token ? `c501_t${token}` : 'c501', address, amount, memo),
        { wallet: 'phantom', url: `solana:${address}?${query}` }
      ];
    }
    case 'near':
      if (token !== undefined || origin.symbol !== 'NEAR' || origin.decimals !== 24) return [];
      return isValidNearIntentsRefundAddress('near', address) ? [trustPaymentLink('c397', address, amount, memo)] : [];
    default:
      return [];
  }
}
