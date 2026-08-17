import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { ConfirmationScreen } from './Confirmation';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime. Stub `useTranslation` so
// `t(key)` echoes the key back, and additionally append the interpolated
// `count` (used by `biometricAttemptsRemaining`) so the computed
// "attempts remaining" value can be asserted. `Trans` renders its `i18nKey`.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts && opts.count !== undefined ? `${key}:${opts.count}` : key)
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>
}));

// `Spinner` — replace the animated CircularProgress atom with a simple marker
// so the "creating" branch can be asserted without pulling in its rendering.
jest.mock('app/atoms/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => <div data-testid="spinner" />
}));

// `Button` — render the title and forward the click so each handler wiring,
// the chosen variant, the loading state, and the forwarded `data-testid` can
// all be verified. Falls back to a `btn-<title>` test id when no explicit
// `data-testid` is provided (the password-fallback buttons).
jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    variant,
    isLoading,
    tabIndex,
    ...rest
  }: {
    title: string;
    onClick?: () => void;
    variant?: string;
    isLoading?: boolean;
    tabIndex?: number;
    'data-testid'?: string;
  }) => (
    <button
      data-testid={rest['data-testid'] ?? `btn-${title}`}
      data-variant={variant ?? 'default'}
      data-loading={isLoading ? 'true' : 'false'}
      data-tabindex={String(tabIndex)}
      onClick={onClick}
    >
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderComponent = (props: Partial<React.ComponentProps<typeof ConfirmationScreen>> = {}) =>
  render(<ConfirmationScreen {...props} />);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfirmationScreen', () => {
  describe('creating (side-panel handoff) branch', () => {
    it('renders the spinner and creating copy while creating', () => {
      renderComponent({ creating: true });

      expect(screen.getByTestId('spinner')).toBeInTheDocument();
      expect(screen.getByText('creatingYourWallet')).toBeInTheDocument();
    });

    it('does not render the ready-state confirmation container while creating', () => {
      renderComponent({ creating: true });

      expect(screen.queryByTestId('onboarding-confirmation')).not.toBeInTheDocument();
      expect(screen.queryByTestId('onboarding-confirmation-submit')).not.toBeInTheDocument();
    });

    it('forwards extra props onto the inner div while creating', () => {
      renderComponent({ creating: true, id: 'creating-panel' });

      expect(document.getElementById('creating-panel')).toBeInTheDocument();
    });
  });

  describe('ready state (default, no error)', () => {
    it('renders the confirmation container with its test id', () => {
      renderComponent();
      expect(screen.getByTestId('onboarding-confirmation')).toBeInTheDocument();
    });

    it('renders the hero illustration svg with the fixed width sizing', () => {
      const { container } = renderComponent();
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveStyle({ width: '240px' });
    });

    it('renders the translated ready heading and reminder copy', () => {
      renderComponent();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('yourWalletIsReady');
      expect(screen.getByText('recoveryPhraseSevenDayReminder')).toBeInTheDocument();
      expect(screen.getByText('recoveryPhraseDailyReminder')).toBeInTheDocument();
    });

    it('renders a single primary submit button titled "openWallet"', () => {
      renderComponent();
      const button = screen.getByTestId('onboarding-confirmation-submit');
      expect(button).toHaveTextContent('openWallet');
      expect(button).toHaveAttribute('data-variant', 'default');
      expect(button).toHaveAttribute('data-tabindex', '0');
    });

    it('does not render the error block when there is no biometric error', () => {
      renderComponent();
      expect(screen.queryByText('biometricFailed')).not.toBeInTheDocument();
    });

    it('does not render the password-fallback buttons in the default state', () => {
      renderComponent();
      expect(screen.queryByTestId('btn-continueWithPassword')).not.toBeInTheDocument();
      expect(screen.queryByTestId('btn-tryBiometricAgain')).not.toBeInTheDocument();
    });

    it('invokes onSubmit when the submit button is clicked', () => {
      const onSubmit = jest.fn();
      renderComponent({ onSubmit });

      fireEvent.click(screen.getByTestId('onboarding-confirmation-submit'));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('does not throw when clicked without an onSubmit handler', () => {
      renderComponent();
      expect(() => fireEvent.click(screen.getByTestId('onboarding-confirmation-submit'))).not.toThrow();
    });

    it('forwards the isLoading flag to the submit button', () => {
      renderComponent({ isLoading: true });
      expect(screen.getByTestId('onboarding-confirmation-submit')).toHaveAttribute('data-loading', 'true');
    });

    it('reflects a non-loading submit button by default', () => {
      renderComponent();
      expect(screen.getByTestId('onboarding-confirmation-submit')).toHaveAttribute('data-loading', 'false');
    });

    it('forwards extra props onto the confirmation container', () => {
      renderComponent({ id: 'confirmation-root' });
      expect(document.getElementById('confirmation-root')).toBe(screen.getByTestId('onboarding-confirmation'));
    });
  });

  describe('hasError branch (error present, attempts below fallback threshold)', () => {
    it('shows the biometric failure message and remaining-attempts count', () => {
      renderComponent({ biometricError: 'boom', biometricAttempts: 1 });

      expect(screen.getByText('biometricFailed')).toBeInTheDocument();
      // MAX_BIOMETRIC_ATTEMPTS (3) - 1 = 2 remaining.
      expect(screen.getByText('biometricAttemptsRemaining:2')).toBeInTheDocument();
    });

    it('titles the primary button "retry" when in an error state', () => {
      renderComponent({ biometricError: 'boom', biometricAttempts: 2 });

      const button = screen.getByTestId('onboarding-confirmation-submit');
      expect(button).toHaveTextContent('retry');
      // 3 - 2 = 1 remaining.
      expect(screen.getByText('biometricAttemptsRemaining:1')).toBeInTheDocument();
    });

    it('does NOT treat biometricError as an error while attempts is still 0', () => {
      renderComponent({ biometricError: 'boom', biometricAttempts: 0 });

      expect(screen.queryByText('biometricFailed')).not.toBeInTheDocument();
      expect(screen.getByTestId('onboarding-confirmation-submit')).toHaveTextContent('openWallet');
    });

    it('does NOT show the error block when biometricError is null despite attempts > 0', () => {
      renderComponent({ biometricError: null, biometricAttempts: 2 });

      expect(screen.queryByText('biometricFailed')).not.toBeInTheDocument();
      expect(screen.getByTestId('onboarding-confirmation-submit')).toHaveTextContent('openWallet');
    });
  });

  describe('password-fallback branch (attempts reached the max)', () => {
    it('renders the continue-with-password and try-again buttons', () => {
      renderComponent({ biometricAttempts: 3 });

      const passwordBtn = screen.getByTestId('btn-continueWithPassword');
      const tryAgainBtn = screen.getByTestId('btn-tryBiometricAgain');

      expect(passwordBtn).toBeInTheDocument();
      expect(passwordBtn).toHaveAttribute('data-variant', 'default');
      expect(tryAgainBtn).toBeInTheDocument();
      expect(tryAgainBtn).toHaveAttribute('data-variant', 'secondary');
    });

    it('does not render the single submit button when the fallback is shown', () => {
      renderComponent({ biometricAttempts: 3 });
      expect(screen.queryByTestId('onboarding-confirmation-submit')).not.toBeInTheDocument();
    });

    it('shows the failure message but hides the remaining-attempts count at the threshold', () => {
      renderComponent({ biometricError: 'boom', biometricAttempts: 3 });

      expect(screen.getByText('biometricFailed')).toBeInTheDocument();
      expect(screen.queryByText(/biometricAttemptsRemaining/)).not.toBeInTheDocument();
    });

    it('invokes onSwitchToPassword when the continue-with-password button is clicked', () => {
      const onSwitchToPassword = jest.fn();
      renderComponent({ biometricAttempts: 3, onSwitchToPassword });

      fireEvent.click(screen.getByTestId('btn-continueWithPassword'));
      expect(onSwitchToPassword).toHaveBeenCalledTimes(1);
    });

    it('invokes onSubmit when the try-biometric-again button is clicked', () => {
      const onSubmit = jest.fn();
      renderComponent({ biometricAttempts: 3, onSubmit });

      fireEvent.click(screen.getByTestId('btn-tryBiometricAgain'));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('forwards the isLoading flag onto the try-again button only', () => {
      renderComponent({ biometricAttempts: 4, isLoading: true });

      expect(screen.getByTestId('btn-tryBiometricAgain')).toHaveAttribute('data-loading', 'true');
      expect(screen.getByTestId('btn-continueWithPassword')).toHaveAttribute('data-loading', 'false');
    });

    it('does not throw when fallback buttons are clicked without handlers', () => {
      renderComponent({ biometricAttempts: 3 });

      expect(() => {
        fireEvent.click(screen.getByTestId('btn-continueWithPassword'));
        fireEvent.click(screen.getByTestId('btn-tryBiometricAgain'));
      }).not.toThrow();
    });

    describe('recovery error (#630)', () => {
      it('renders the failure reason so a wiped wallet is explained, not silent', () => {
        renderComponent({ recoveryError: 'guardian not found' });

        // The reset that precedes registration is destructive; the reason must be
        // on screen rather than console-only, and selectable so it can be reported.
        expect(screen.getByText('guardian not found')).toBeInTheDocument();
      });

      it('offers Retry rather than Open Wallet while a recovery error is showing', () => {
        renderComponent({ recoveryError: 'boom' });

        expect(screen.queryByText('openWallet')).not.toBeInTheDocument();
      });

      it('renders nothing extra when there is no recovery error', () => {
        renderComponent({});

        expect(screen.queryByText('guardian not found')).not.toBeInTheDocument();
      });
    });
  });
});
