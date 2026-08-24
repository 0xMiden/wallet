import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import RotateGuardian from './RotateGuardian';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockIsMobile = jest.fn(() => false);
let mockCurrentEndpoint = 'https://old.example';
let mockHistoryPosition = 1;
// Captured so the hardware-back path can be exercised: on mobile this is the
// only back affordance, and the screen hides PageLayout's toolbar, so nothing
// else registers one.
let mobileBackHandler: (() => boolean | void) | undefined;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/hooks/useCurrentGuardianEndpoint', () => ({
  useCurrentGuardianEndpoint: () => ({ endpoint: mockCurrentEndpoint, refresh: jest.fn() })
}));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({ children, hideToolbar }: { children: React.ReactNode; hideToolbar?: boolean }) => (
    <div data-testid="page-layout" data-hide-toolbar={String(Boolean(hideToolbar))}>
      {children}
    </div>
  )
}));

jest.mock('screens/onboarding/common/ChooseGuardian', () => ({
  ChooseGuardianScreen: ({
    onSubmit,
    currentEndpoint,
    allowCustomEndpoint,
    error
  }: {
    onSubmit: (payload: { guardianId: string; guardianEndpoint: string }) => void;
    currentEndpoint?: string;
    allowCustomEndpoint?: boolean;
    error?: string | null;
  }) => (
    <div data-testid="choose-guardian" data-current={currentEndpoint} data-allow-custom={String(allowCustomEndpoint)}>
      {error ? <span role="alert">{error}</span> : null}
      <button
        data-testid="pick-new"
        onClick={() => onSubmit({ guardianId: 'g2', guardianEndpoint: 'https://new.example' })}
      >
        new
      </button>
      <button
        data-testid="pick-same"
        onClick={() => onSubmit({ guardianId: 'g1', guardianEndpoint: mockCurrentEndpoint })}
      >
        same
      </button>
    </div>
  )
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mobileBackHandler = handler;
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

jest.mock('lib/woozie', () => ({
  useLocation: () => ({ historyPosition: mockHistoryPosition }),
  navigate: (...args: unknown[]) => mockNavigate(...args),
  goBack: () => mockGoBack(),
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentEndpoint = 'https://old.example';
  mockHistoryPosition = 1;
  mobileBackHandler = undefined;
});

it('hands the picker the endpoint the account is actually on, and allows a custom one', () => {
  render(<RotateGuardian />);

  const picker = screen.getByTestId('choose-guardian');
  // Without this the picker badges nothing as current and the same-endpoint
  // guard below has nothing to compare against.
  expect(picker).toHaveAttribute('data-current', 'https://old.example');
  expect(picker).toHaveAttribute('data-allow-custom', 'true');
  expect(screen.getByRole('heading', { name: 'rotateGuardian' })).toBeInTheDocument();
  // The screen owns its header, so PageLayout's toolbar must stay hidden or the
  // page renders two.
  expect(screen.getByTestId('page-layout')).toHaveAttribute('data-hide-toolbar', 'true');
});

it('routes a genuinely different endpoint to review, url-encoded', () => {
  render(<RotateGuardian />);

  fireEvent.click(screen.getByTestId('pick-new'));

  expect(mockNavigate).toHaveBeenCalledWith({
    pathname: '/rotate-guardian/review',
    search: '?endpoint=https%3A%2F%2Fnew.example'
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('refuses to queue a switch onto the Guardian the account already uses', () => {
  render(<RotateGuardian />);

  fireEvent.click(screen.getByTestId('pick-same'));

  expect(screen.getByRole('alert')).toHaveTextContent('guardianEndpointUnchanged');
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('clears the same-endpoint error once a different Guardian is picked', () => {
  render(<RotateGuardian />);

  fireEvent.click(screen.getByTestId('pick-same'));
  expect(screen.getByRole('alert')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('pick-new'));
  expect(screen.queryByRole('alert')).toBeNull();
});

describe('back navigation', () => {
  it('pops one entry when there is history to pop', () => {
    render(<RotateGuardian />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('lands on Settings, not the wallet home, when opened cold', () => {
    mockHistoryPosition = 0;
    render(<RotateGuardian />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    // Replace rather than push: the entry being left is the one the user
    // cannot return to.
    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('hardware back agrees with the chevron and consumes the press', () => {
    render(<RotateGuardian />);

    expect(mobileBackHandler).toBeDefined();
    // Returning true is what stops the global bridge from also handling this
    // press and sending the user to the wallet home.
    expect(mobileBackHandler!()).toBe(true);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('hardware back on a cold open falls back to Settings too', () => {
    mockHistoryPosition = 0;
    render(<RotateGuardian />);

    expect(mobileBackHandler!()).toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
  });
});
