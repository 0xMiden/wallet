import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, ...rest }: { title: string; onClick?: () => void; 'data-testid'?: string }) => (
    <button type="button" data-testid={rest['data-testid']} onClick={onClick}>
      {title}
    </button>
  )
}));

describe('NetworkNoticeScreen', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('names Testnet, lists the three notices and acknowledges with a primary button', () => {
    jest.doMock('utils/brand-colors', () => ({ isDevnet: false }));
    const { NetworkNoticeScreen } = require('./NetworkNotice');
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

  it('names Devnet on a devnet build', () => {
    jest.doMock('utils/brand-colors', () => ({ isDevnet: true }));
    const { NetworkNoticeScreen } = require('./NetworkNotice');

    render(<NetworkNoticeScreen />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('networkModeBanner:devnet');
  });
});
