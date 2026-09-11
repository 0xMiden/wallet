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

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, ...rest }: { title: string; onClick?: () => void; 'data-testid'?: string }) => (
    <button type="button" data-testid={rest['data-testid']} onClick={onClick}>
      {title}
    </button>
  )
}));

describe('NetworkNoticeScreen', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
  });

  it('names Testnet, lists the three notices and acknowledges with a primary button', () => {
    const onSubmit = jest.fn();

    render(<NetworkNoticeScreen onSubmit={onSubmit} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('networkModeBanner:testnet');
    expect(screen.getByText('networkNoticeChip:testnet')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('networkNoticeResetTitle')).toBeInTheDocument();

    const button = screen.getByTestId('onboarding-network-notice-acknowledge');
    expect(button).toHaveTextContent('iUnderstand');
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
