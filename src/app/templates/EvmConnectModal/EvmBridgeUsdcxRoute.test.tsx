import React from 'react';

import { render, screen } from '@testing-library/react';

import { EvmBridgeUsdcxRoute } from './EvmBridgeUsdcxRoute';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// RouteCard has its own suite; this one checks the estimate the step hands it.
jest.mock('screens/send-flow/Route', () => ({
  RouteCard: ({ eta, testId }: { eta: string; testId?: string }) => <div data-testid={testId}>{eta}</div>
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({
    title,
    onClick,
    'data-testid': testId
  }: {
    title: string;
    onClick: () => void;
    'data-testid'?: string;
  }) => (
    <button type="button" onClick={onClick} data-testid={testId}>
      {title}
    </button>
  )
}));

describe('EvmBridgeUsdcxRoute', () => {
  it('reads about a minute for a deposit from Arc Testnet', () => {
    render(<EvmBridgeUsdcxRoute sourceChainId={5042002} onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent('usdcxArrivalArc');
  });

  it.each([11155111, 84532, 421614])('reads ~2 min for a deposit from chain %i', sourceChainId => {
    render(<EvmBridgeUsdcxRoute sourceChainId={sourceChainId} onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent(/^usdcxArrival$/);
  });
});
