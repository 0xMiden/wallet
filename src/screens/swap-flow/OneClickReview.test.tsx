import React from 'react';

import { render, screen, within } from '@testing-library/react';

import type { OneClickAsset, OneClickQuoteResponse } from 'lib/one-click/types';

import { OneClickReview } from './OneClickReview';
import type { OneClickReviewProps } from './OneClickReview';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('components/NetworkModeBanner', () => ({ NetworkModeBanner: () => null }));
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({ useHideNavbarWhileOpen: jest.fn() }));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));

const ethAsset: OneClickAsset = {
  assetId: 'nep141:eth.omft.near',
  blockchain: 'eth',
  symbol: 'ETH',
  decimals: 18,
  chainId: 1
};

const usdcAsset: OneClickAsset = {
  assetId: 'miden:usdc',
  blockchain: 'miden',
  symbol: 'USDC',
  decimals: 6,
  faucetId: `0x${'12'.repeat(15)}`
};

const quote: OneClickQuoteResponse = {
  correlationId: 'review-amount-formatting',
  timestamp: '2026-10-22T12:00:00.000Z',
  signature: 'ed25519:signature',
  quoteRequest: {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: ethAsset.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: usdcAsset.assetId,
    amount: '1250000000000000000',
    refundTo: '0x1111111111111111111111111111111111111111',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'miden-account',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-10-22T12:15:00.000Z'
  },
  quote: {
    amountIn: '1250000000000000000',
    amountInFormatted: '1250000000000000000',
    amountInUsd: '2500',
    minAmountIn: '1250000000000000000',
    amountOut: '2500000',
    amountOutFormatted: '0.0000025',
    amountOutUsd: '2500',
    minAmountOut: '2490000',
    timeEstimate: 60
  }
};

function reviewProps(overrides: Partial<OneClickReviewProps> = {}): OneClickReviewProps {
  return {
    quote,
    originAsset: ethAsset,
    destinationAsset: usdcAsset,
    recipient: 'miden-account',
    refundTo: '0x1111111111111111111111111111111111111111',
    fees: [],
    onBack: jest.fn(),
    onRefresh: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides
  };
}

describe('OneClickReview quote amount display', () => {
  it('formats both hero amounts from quote base units using the selected assets decimals', () => {
    render(<OneClickReview {...reviewProps()} />);

    const hero = screen.getByTestId('one-click-review-hero');
    expect(within(hero).getByText('1.25 ETH')).toBeInTheDocument();
    expect(within(hero).getByText('2.5 USDC')).toBeInTheDocument();
    expect(within(hero).queryByText('1250000000000000000 ETH')).not.toBeInTheDocument();
    expect(within(hero).queryByText('0.0000025 USDC')).not.toBeInTheDocument();
    expect(screen.getByTestId('one-click-minimum-row')).toHaveTextContent('2.49 USDC');
  });
});
