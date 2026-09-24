import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { NetworkNoticeScreen } from './NetworkNotice';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

describe('NetworkNoticeScreen', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
  });

  it('names Testnet on a network chip and the step title, on the step layout', () => {
    render(<NetworkNoticeScreen />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('networkModeBanner:testnet');
    expect(screen.getByText('networkNoticeChip:testnet')).toBeInTheDocument();
    expect(screen.getByText('networkNoticeBody')).toHaveClass('text-muted');
    const root = screen.getByTestId('onboarding-network-notice');
    expect(root.querySelector('[data-slot="step-heading"]')).not.toBeNull();
    expect(screen.getByTestId('onboarding-network-notice-acknowledge').closest('[data-slot="footer"]')).not.toBeNull();
  });

  it('lists the three facts as plain rows, nothing to tick', () => {
    render(<NetworkNoticeScreen />);

    expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual([
      'networkNoticeNoValueTitlenetworkNoticeNoValueBody',
      'networkNoticeNoRealFundsTitlenetworkNoticeNoRealFundsBody',
      'networkNoticeResetTitlenetworkNoticeResetBody'
    ]);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('acknowledges on the first tap of I understand', () => {
    const onSubmit = jest.fn();
    render(<NetworkNoticeScreen onSubmit={onSubmit} />);
    const button = screen.getByTestId('onboarding-network-notice-acknowledge');
    expect(button).toHaveTextContent('iUnderstand');
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('names the effective network, e.g. a devnet override', () => {
    mockNetworkKey = 'devnet';

    render(<NetworkNoticeScreen />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('networkModeBanner:devnet');
    expect(screen.getByText('networkNoticeChip:devnet')).toBeInTheDocument();
  });

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;

    const { container } = render(<NetworkNoticeScreen />);

    expect(container).toBeEmptyDOMElement();
  });
});
