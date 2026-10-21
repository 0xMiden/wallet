import React from 'react';

import { render, screen } from '@testing-library/react';

import { EvmBridgeUsdcxRoute } from './EvmBridgeUsdcxRoute';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// RouteCard has its own suite; this one checks the estimate the step hands it.
jest.mock('screens/send-flow/Route', () => ({
  RouteCard: ({ eta, testId, description }: { eta: string; testId?: string; description?: React.ReactNode }) => (
    <div data-testid={testId}>
      {eta}
      {description}
    </div>
  )
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
  it('passes route help into the card instead of rendering it below', () => {
    render(<EvmBridgeUsdcxRoute sourceChainId={11155111} notice="fixture balance hint" onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toContainElement(screen.getByText('fixture balance hint'));
    expect(screen.queryByText('usdcxRouteNotice')).not.toBeInTheDocument();
  });

  it('reads about a minute for a deposit from Arc Testnet', () => {
    render(<EvmBridgeUsdcxRoute sourceChainId={5042002} onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent('usdcxArrivalArc');
  });

  it.each([11155111, 84532, 421614])('reads ~20 min for a deposit from chain %i', sourceChainId => {
    render(<EvmBridgeUsdcxRoute sourceChainId={sourceChainId} onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent('usdcxArrival');
  });
});
