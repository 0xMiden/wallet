import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { Route } from './Route';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const hapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({ hapticLight: () => hapticLight() }));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    disabled,
    onClick,
    ...rest
  }: {
    title: string;
    disabled?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button data-testid={rest['data-testid']} disabled={disabled} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

const baseProps = {
  route: 'epoch' as const,
  onRouteChange: jest.fn(),
  fastQuoteLoading: false,
  slowEnabled: true,
  onConfirm: jest.fn()
};

describe('Route', () => {
  beforeEach(() => {
    baseProps.onRouteChange.mockClear();
    baseProps.onConfirm.mockClear();
    hapticLight.mockClear();
  });

  it('renders the shared ETA copy and no provider captions by default (send-flow call site)', () => {
    render(<Route {...baseProps} />);
    expect(screen.getByTestId('bridge-route-fast').textContent).toContain('fastArrival');
    expect(screen.getByTestId('bridge-route-slow').textContent).toContain('slowArrival');
    expect(screen.getByTestId('bridge-route-fast').textContent).not.toContain('via');
    expect(screen.getByTestId('bridge-route-fast').hasAttribute('disabled')).toBe(false);
  });

  it('renders provider captions and deposit ETAs when given', () => {
    render(
      <Route
        {...baseProps}
        providerLabels={{ fast: 'viaEpoch', slow: 'viaAgglayer' }}
        etaLabels={{ fast: 'depositFastArrival', slow: 'depositSlowArrival' }}
      />
    );
    const fast = screen.getByTestId('bridge-route-fast');
    const slow = screen.getByTestId('bridge-route-slow');
    expect(fast.textContent).toContain('viaEpoch');
    expect(fast.textContent).toContain('depositFastArrival');
    expect(fast.textContent).not.toContain('fastArrival');
    expect(slow.textContent).toContain('viaAgglayer');
    expect(slow.textContent).toContain('depositSlowArrival');
  });

  it('disables the Fast card when fastEnabled is false (deposit ETH is AggLayer-only)', () => {
    render(<Route {...baseProps} route="agglayer" fastEnabled={false} />);
    expect(screen.getByTestId('bridge-route-fast').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('bridge-route-slow').hasAttribute('disabled')).toBe(false);
  });

  it('selects a route with haptic feedback and blocks Confirm when told to', () => {
    render(<Route {...baseProps} confirmDisabled />);
    fireEvent.click(screen.getByTestId('bridge-route-slow'));
    expect(baseProps.onRouteChange).toHaveBeenCalledWith('agglayer');
    expect(hapticLight).toHaveBeenCalled();
    expect(screen.getByTestId('bridge-route-confirm').hasAttribute('disabled')).toBe(true);
  });
});
