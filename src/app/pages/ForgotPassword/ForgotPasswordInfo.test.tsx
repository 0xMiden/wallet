import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import ForgotPasswordInfo from './ForgotPasswordInfo';

// `lib/woozie`'s real `navigate` depends on the woozie history/location stack
// and analytics side effects. Stub it so we can assert the exact route each
// callback pushes without touching that machinery.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

// The presentational screen pulls in react-i18next, icons, and the shared
// NavigationHeader/Message/Button chrome — none of which this container owns.
// Replace it with a lightweight stand-in that surfaces the two callbacks
// (`onClose`, `onSignOut`) as buttons so we can drive them directly and verify
// the wiring `ForgotPasswordInfo` provides.
jest.mock('screens/onboarding/forgot-password-flow/ForgotPasswordInfo', () => ({
  __esModule: true,
  default: ({ onClose, onSignOut }: { onClose: () => void; onSignOut: () => void }) => (
    <div data-testid="forgot-password-info-screen">
      <button type="button" data-testid="close" onClick={onClose}>
        close
      </button>
      <button type="button" data-testid="sign-out" onClick={onSignOut}>
        sign out
      </button>
    </div>
  )
}));

const mockNavigate = navigate as jest.Mock;

describe('ForgotPasswordInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the ForgotPasswordInfo screen', () => {
    render(<ForgotPasswordInfo />);

    expect(screen.getByTestId('forgot-password-info-screen')).toBeInTheDocument();
    // No navigation happens on mount — only in response to the callbacks.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to /unlock when the screen requests close', () => {
    render(<ForgotPasswordInfo />);

    fireEvent.click(screen.getByTestId('close'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/unlock');
  });

  it('navigates to /forgot-password when the screen requests sign out', () => {
    render(<ForgotPasswordInfo />);

    fireEvent.click(screen.getByTestId('sign-out'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/forgot-password');
  });

  it('keeps the two callbacks independent (close does not trigger sign out and vice versa)', () => {
    render(<ForgotPasswordInfo />);

    fireEvent.click(screen.getByTestId('close'));
    fireEvent.click(screen.getByTestId('sign-out'));

    expect(mockNavigate).toHaveBeenCalledTimes(2);
    expect(mockNavigate).toHaveBeenNthCalledWith(1, '/unlock');
    expect(mockNavigate).toHaveBeenNthCalledWith(2, '/forgot-password');
  });
});
