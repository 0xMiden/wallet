import type { IOneClickTrackingData } from 'lib/miden/db/types';

import { depositPaymentLinks } from './payment-links';
import { PAYMENT_NOW, paymentTracking } from './testing/payment-tracking';
import type { OneClickAsset } from './types';

const ADDRESS = '0x7a3f09d1000000000000000000000000c91e2b4a';
const CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SOL_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function trackedAsset(asset: OneClickAsset, overrides: Partial<IOneClickTrackingData> = {}) {
  return paymentTracking({ originAsset: asset, ...overrides });
}

const usdc: OneClickAsset = {
  assetId: 'eth-usdc',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: CONTRACT
};

describe('deposit payment links', () => {
  it('sets the token, recipient, network and exact token units without floating point conversion', () => {
    const tracking = trackedAsset(usdc);
    tracking.quote.quote.amountIn = '123456789012345678901234';
    tracking.quote.quote.amountInFormatted = 'wrong display value';
    const links = depositPaymentLinks(tracking, PAYMENT_NOW);
    expect(links.map(link => link.wallet)).toEqual(['trust', 'metamask', 'rainbow']);
    expect(links[0]?.url).toContain('amount=123456789012345678.901234');
    expect(links[0]?.url).toContain(`asset=c60_t${CONTRACT}`);
    expect(links[1]?.url).toBe(
      `metamask://send/${CONTRACT}@1/transfer?address=${ADDRESS}&uint256=123456789012345678901234`
    );
    expect(links[2]?.url).toBe(`ethereum:${CONTRACT}@1/transfer?address=${ADDRESS}&uint256=123456789012345678901234`);
  });

  it('uses wei for native ETH and decimal ETH for Trust', () => {
    const tracking = trackedAsset({ assetId: 'eth', blockchain: 'eth', symbol: 'ETH', decimals: 18 });
    tracking.quote.quote.amountIn = '100000000000000001';
    const links = depositPaymentLinks(tracking, PAYMENT_NOW);
    expect(links[0]?.url).toContain('amount=0.100000000000000001');
    expect(links[1]?.url).toBe(`metamask://send/${ADDRESS}@1?value=100000000000000001`);
  });

  it.each([
    ['base', 8453, 8453],
    ['arb', 42161, 10042221],
    ['op', 10, 10000070]
  ])('maps %s to its EVM and Trust IDs', (blockchain, chainId, trustCoin) => {
    const links = depositPaymentLinks(trackedAsset({ ...usdc, blockchain: String(blockchain) }), PAYMENT_NOW);
    expect(links[0]?.url).toContain(`asset=c${trustCoin}_t`);
    expect(links[1]?.url).toContain(`@${chainId}/transfer`);
  });

  it('offers only Trust for Bitcoin', () => {
    const tracking = trackedAsset(
      { assetId: 'btc', blockchain: 'btc', symbol: 'BTC', decimals: 8 },
      { depositAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' }
    );
    expect(depositPaymentLinks(tracking, PAYMENT_NOW)).toEqual([
      { wallet: 'trust', url: 'trust://send?asset=c0&address=bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh&amount=0.46' }
    ]);
  });

  it('offers Trust and Phantom for a Solana token and preserves its memo', () => {
    const tracking = trackedAsset(
      { ...usdc, blockchain: 'sol', contractAddress: SOL_ADDRESS },
      { depositAddress: SOL_ADDRESS, depositMemo: 'deposit & 123' }
    );
    const links = depositPaymentLinks(tracking, PAYMENT_NOW);
    expect(links.map(link => link.wallet)).toEqual(['trust', 'phantom']);
    const phantom = new URL(links[1]?.url ?? '');
    expect(phantom.searchParams.get('amount')).toBe('46');
    expect(phantom.searchParams.get('spl-token')).toBe(SOL_ADDRESS);
    expect(phantom.searchParams.get('memo')).toBe('deposit & 123');
  });

  it('omits a token mint for native SOL', () => {
    const tracking = trackedAsset(
      { assetId: 'sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
      { depositAddress: SOL_ADDRESS }
    );
    expect(depositPaymentLinks(tracking, PAYMENT_NOW)[1]?.url).toBe(`solana:${SOL_ADDRESS}?amount=0.046`);
  });

  it('offers Trust only for native NEAR, and no NEAR token without verified link support', () => {
    const asset: OneClickAsset = { assetId: 'near', blockchain: 'near', symbol: 'NEAR', decimals: 24 };
    const tracking = trackedAsset(asset, { depositAddress: 'deposit.near' });
    expect(depositPaymentLinks(tracking, PAYMENT_NOW).map(link => link.wallet)).toEqual(['trust']);
    tracking.originAsset = { ...asset, contractAddress: 'token.near' };
    expect(depositPaymentLinks(tracking, PAYMENT_NOW)).toEqual([]);
  });

  it('does not send an EVM memo to a wallet whose link cannot preserve it', () => {
    const links = depositPaymentLinks(trackedAsset(usdc, { depositMemo: 'required memo' }), PAYMENT_NOW);
    expect(links.map(link => link.wallet)).toEqual(['trust']);
    expect(links[0]?.url).toContain('memo=required+memo');
  });

  it.each<IOneClickTrackingData['phase']>([
    'incomplete-deposit',
    'known-deposit-tx',
    'processing',
    'arriving',
    'delivered',
    'refunded',
    'failed',
    'expired'
  ])('does not offer a fresh full payment for %s', phase => {
    expect(depositPaymentLinks(trackedAsset(usdc, { phase }), PAYMENT_NOW)).toEqual([]);
  });

  it('accepts pending deposits but refuses an expired deadline, invalid deadline or non-mainnet row', () => {
    expect(depositPaymentLinks(trackedAsset(usdc, { phase: 'pending-deposit' }), PAYMENT_NOW)).toHaveLength(3);
    expect(depositPaymentLinks(trackedAsset(usdc), PAYMENT_NOW + 10 * 60_000)).toEqual([]);
    expect(depositPaymentLinks(trackedAsset(usdc, { fundingDeadline: 'invalid' }), PAYMENT_NOW)).toEqual([]);
    expect(depositPaymentLinks(trackedAsset(usdc, { network: 'testnet' }), PAYMENT_NOW)).toEqual([]);
  });

  it.each(['0', '-1', '1.5', '1e18', '', '1&address=other'])('refuses an invalid amount %s', amount => {
    const tracking = trackedAsset(usdc);
    tracking.quote.quote.amountIn = amount;
    expect(depositPaymentLinks(tracking, PAYMENT_NOW)).toEqual([]);
  });

  it('refuses unknown chains, bad addresses, conflicting chain IDs and missing token metadata', () => {
    expect(depositPaymentLinks(trackedAsset({ ...usdc, blockchain: 'arc' }), PAYMENT_NOW)).toEqual([]);
    expect(depositPaymentLinks(trackedAsset(usdc, { depositAddress: 'bad' }), PAYMENT_NOW)).toEqual([]);
    expect(depositPaymentLinks(trackedAsset({ ...usdc, chainId: 8453 }), PAYMENT_NOW)).toEqual([]);
    expect(depositPaymentLinks(trackedAsset({ ...usdc, contractAddress: undefined }), PAYMENT_NOW)).toEqual([]);
    expect(depositPaymentLinks(trackedAsset({ ...usdc, contractAddress: 'bad' }), PAYMENT_NOW)).toEqual([]);
  });
});
