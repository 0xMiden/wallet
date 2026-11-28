import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { EvmBridgeUsdcxRoute } from './EvmBridgeUsdcxRoute';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// RouteCard has its own suite; this one checks the estimate the step hands it.
jest.mock('screens/send-flow/Route', () => ({
  RouteCard: ({
    eta,
    testId,
    description,
    payout,
    selected
  }: {
    eta: string;
    testId?: string;
    description?: React.ReactNode;
    payout?: { amount: string };
    selected: boolean;
  }) => (
    <div data-testid={testId} data-selected={selected}>
      {eta}
      {description}
      {payout?.amount}
    </div>
  ),
  RouteSort: ({ onChange }: { onChange: (value: 'fastest') => void }) => (
    <button type="button" onClick={() => onChange('fastest')}>
      Fastest
    </button>
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
  it('sorts comparable Circle and Epoch payouts without changing the selected provider', () => {
    const payout = { assetId: 'usdcx', symbol: 'USDCx', amount: '2.5' };
    const fast = {
      selected: false,
      onSelect: jest.fn(),
      availability: { state: 'available' as const },
      loading: false,
      payout: { ...payout, amount: '1.5' }
    };
    const props = { payout, fast };
    render(<EvmBridgeUsdcxRoute {...props} sourceChainId={84532} onConfirm={jest.fn()} />);

    const circle = screen.getByTestId('bridge-route-usdcx');
    const epoch = screen.getByTestId('bridge-route-fast');
    expect(circle).toHaveTextContent('2.5');
    expect(epoch).toHaveTextContent('1.5');
    expect(circle.compareDocumentPosition(epoch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fastest' }));
    expect(epoch.compareDocumentPosition(circle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(circle).toHaveAttribute('data-selected', 'true');
    expect(epoch).toHaveAttribute('data-selected', 'false');
    expect(fast.onSelect).not.toHaveBeenCalled();
  });
  it('passes route help into the card instead of rendering it below', () => {
    render(<EvmBridgeUsdcxRoute sourceChainId={11155111} notice="fixture balance hint" onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toContainElement(screen.getByText('fixture balance hint'));
    expect(screen.queryByText('usdcxRouteNotice')).not.toBeInTheDocument();
  });

  it('reads about a minute for a deposit from Arc Testnet', () => {
    render(<EvmBridgeUsdcxRoute sourceChainId={5042002} onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent('usdcxArrivalArc');
  });

  it.each([11155111, 84532, 421614])('reads ~2 min for a deposit from chain %i', sourceChainId => {
    render(<EvmBridgeUsdcxRoute sourceChainId={sourceChainId} onConfirm={jest.fn()} />);
    const card = screen.getByTestId('bridge-route-usdcx');
    expect(card).toHaveTextContent('usdcxArrival');
    expect(card).not.toHaveTextContent('usdcxArrivalArc');
  });
});
