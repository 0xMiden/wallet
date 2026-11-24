import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { FeatureAvailability } from 'lib/remote-config/availability';

import { HomeMoveActions } from './HomeMoveActions';

const AVAILABLE: FeatureAvailability = { state: 'available' };
const SERVICE_DOWN: FeatureAvailability = { state: 'unavailable', reason: 'service-down', detail: 'timeout' };
const NOT_CONFIGURED: FeatureAvailability = { state: 'unavailable', reason: 'not-configured', detail: 'no route' };

let mockAvailability: FeatureAvailability = AVAILABLE;
let mockHasDocument = true;
const mockNavigate = jest.fn();
const mockUseBridgeInAvailability = jest.fn(
  (_options?: { hold?: boolean | ((availability: FeatureAvailability) => boolean) }) => mockAvailability
);

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: { BridgeIn: 'BridgeIn', BridgeOut: 'BridgeOut' } }));
jest.mock('components/ui/Card', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    CardButton: ({
      children,
      onClick,
      disabled,
      'data-testid': testId
    }: {
      children: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      'data-testid'?: string;
    }) => ReactActual.createElement('button', { onClick, disabled, 'data-testid': testId }, children)
  };
});
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({ config: mockHasDocument ? {} : null })
}));
jest.mock('lib/usdcx/use-bridge-in-availability', () => {
  const actual = jest.requireActual<typeof import('lib/usdcx/use-bridge-in-availability')>(
    'lib/usdcx/use-bridge-in-availability'
  );
  return {
    isBridgeInOfferedOnNetwork: actual.isBridgeInOfferedOnNetwork,
    useBridgeInAvailability: (options: { hold?: boolean | ((availability: FeatureAvailability) => boolean) }) =>
      mockUseBridgeInAvailability(options)
  };
});
jest.mock('lib/woozie', () => ({ navigate: (path: string) => mockNavigate(path) }));

const expectBridgeInHold = (expected: boolean) => {
  const call = mockUseBridgeInAvailability.mock.calls[mockUseBridgeInAvailability.mock.calls.length - 1];
  const hold = call?.[0]?.hold;
  expect(hold).toEqual(expect.any(Function));
  if (typeof hold === 'function') expect(hold(mockAvailability)).toBe(expected);
};

beforeEach(() => {
  mockAvailability = AVAILABLE;
  mockHasDocument = true;
  mockNavigate.mockClear();
  mockUseBridgeInAvailability.mockClear();
});

describe('HomeMoveActions', () => {
  it('hides home deposit and releases the fast poll for an accepted network with no bridge-in route', () => {
    mockAvailability = NOT_CONFIGURED;
    render(<HomeMoveActions />);

    expect(screen.queryByTestId('home-deposit')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-withdraw')).toBeInTheDocument();
    expectBridgeInHold(false);
  });

  it('keeps home deposit disabled and holding while no document has been accepted', () => {
    mockHasDocument = false;
    mockAvailability = NOT_CONFIGURED;
    render(<HomeMoveActions />);

    expect(screen.getByTestId('home-deposit')).toBeDisabled();
    expect(screen.getByTestId('home-withdraw')).toBeInTheDocument();
    expectBridgeInHold(true);
  });

  it('keeps home deposit disabled and holding during a service outage', () => {
    mockAvailability = SERVICE_DOWN;
    render(<HomeMoveActions />);

    expect(screen.getByTestId('home-deposit')).toBeDisabled();
    expect(screen.getByTestId('home-withdraw')).toBeInTheDocument();
    expectBridgeInHold(true);
  });

  it('enables home deposit and opens Bridge Deposit when available', () => {
    render(<HomeMoveActions />);

    const deposit = screen.getByTestId('home-deposit');
    expect(deposit).toBeEnabled();
    expect(screen.getByTestId('home-withdraw')).toBeInTheDocument();
    expectBridgeInHold(true);
    fireEvent.click(deposit);
    expect(mockNavigate).toHaveBeenCalledWith('/bridge/deposit');
  });
});
