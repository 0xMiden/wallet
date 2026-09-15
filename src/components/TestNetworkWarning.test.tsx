import React from 'react';

import { render, screen } from '@testing-library/react';

import { TestNetworkWarning } from './TestNetworkWarning';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { WarningFill: 'WarningFill' }
}));

describe('TestNetworkWarning (#875)', () => {
  it('interpolates its values into both the title and the body', () => {
    render(<TestNetworkWarning titleKey="title" bodyKey="body" values={{ network: 'Devnet' }} data-testid="warning" />);

    const warning = screen.getByTestId('warning');
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning).toHaveTextContent('title:Devnet');
    expect(warning).toHaveTextContent('body:Devnet');
  });

  it('renders the plain keys when it has no values', () => {
    render(<TestNetworkWarning titleKey="title" bodyKey="body" data-testid="warning" />);

    expect(screen.getByTestId('warning')).toHaveTextContent('titlebody');
  });
});
