import React from 'react';

import { render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

describe('NetworkModeBanner', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('names Testnet on a testnet build', () => {
    jest.doMock('utils/brand-colors', () => ({ isDevnet: false }));
    const { NetworkModeBanner } = require('./NetworkModeBanner');

    render(<NetworkModeBanner />);

    expect(screen.getByTestId('network-mode-banner')).toHaveTextContent('networkModeBanner:testnet');
  });

  it('names Devnet on a devnet build', () => {
    jest.doMock('utils/brand-colors', () => ({ isDevnet: true }));
    const { NetworkModeBanner } = require('./NetworkModeBanner');

    render(<NetworkModeBanner />);

    expect(screen.getByTestId('network-mode-banner')).toHaveTextContent('networkModeBanner:devnet');
  });
});
